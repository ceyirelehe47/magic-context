import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { MagicCompactionEngine } from "../compat/dsh-0.1/compaction";
import { createAssistantMessage, createUserMessage } from "../compat/dsh-0.1/session";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createTestDb } from "../test-utils";
import { initializeDshAdapterTables } from "./outbox";
import { readDshTranscript } from "./transcript";
import { registerMagicHistorianPlane } from "./historian-wiring";

// Round 16 (upstream parity): core never runs the historian for subagent
// sessions (event-handler: an overflow in a subagent only records
// reportedLimit). In DSH the stock compaction-basic engine is replaced by
// MagicCompactionEngine, whose summarize() always called the MC historian hook
// — so a child (subagent / delegationDepth ≥ 1) session that hit its limit ran
// the historian and wrote compartments / marker / lease rows for an unmarked
// session. A child compaction must fall back to the stock summarizer and leave
// every MC table untouched; the main session is unchanged.

type Hook = (input: unknown, agent: unknown, signal?: AbortSignal) => Promise<{ summary: { text: string }[]; model?: string }>;

function appendTurn(session: Session, turn: number): void {
  session.append(
    "user/message",
    createUserMessage({ content: [{ type: "text", text: `question ${turn}` }], source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
  session.append(
    "assistant/message",
    {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: "text", text: `answer ${turn}` }],
        provider: "deepseek",
        model: "deepseek-chat",
        source: { kind: "model" } as never,
      }),
    } as never,
    { surfaceOp: "append" },
  );
}

/** Row count of EVERY table in the DB (MC core + DSH adapter tables). */
function rowCounts(db: Database): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    out[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
  }
  return out;
}

/** Valid historian XML for messages 1..6 (what a real historian would return). */
const HISTORIAN_XML = `<output>
<compartments>
<compartment start="1" end="6" title="child work" episode_type="design" importance="50">
<p1>Narrative summary of 1-6.</p1>
<p2>Condensed 1-6.</p2>
<p3>Outcome 1-6.</p3>
<p4>Anchor 1-6.</p4>
</compartment>
</compartments>
<facts>
<ARCHITECTURE>
* Use the magic pattern.
</ARCHITECTURE>
</facts>
<meta>
<messages_processed>1-6</messages_processed>
<unprocessed_from>7</unprocessed_from>
</meta>
</output>`;

/**
 * LLM stub. The stock compaction-basic summarizer streams with no `system`
 * (it replays the conversation); the MC historian call sets the compartment
 * agent system prompt — answer it with valid historian XML so that, without
 * the fix, the historian really persists rows for the child.
 */
function stubLlm() {
  const calls: { purpose?: string; model?: string; historian: boolean }[] = [];
  return {
    calls,
    stream: async function* (opts: { purpose?: string; model?: string; system?: string }) {
      const historian = typeof opts.system === "string" && opts.system.length > 0;
      calls.push({ purpose: opts.purpose, model: opts.model, historian });
      yield { type: "text-delta", text: historian ? HISTORIAN_XML : "STOCK SUMMARY" };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}

async function setup(childHeader: Record<string, unknown> | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-child-compact-"));
  const db = await createTestDb(join(dir, "context.db"));
  initializeDshAdapterTables(db);
  const llm = stubLlm();
  let registered: Hook | undefined;
  const wiringCtx = { get: (name: string) => (name === "llm" ? llm : undefined) } as unknown as Context;
  registerMagicHistorianPlane(wiringCtx, {
    host: {
      ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: join(dir, "l") }),
      canonicalKey: (id: string) => `dsh:abc:${id}`,
      registerSummarizeHook: (fn: Hook) => {
        registered = fn;
      },
    } as never,
  });
  let hookCalls = 0;
  const spy: Hook = (input, agent, signal) => {
    hookCalls += 1;
    return registered!(input, agent, signal);
  };
  const ctx = new Context();
  const engine = new MagicCompactionEngine(ctx as never, { auto: false });
  // Production path: the engine reads the hook from the host service
  // (`magicContextHost.summarizeHook()`); the stock summarizer streams through
  // `this.ctx.llm`.
  const host = { summarizeHook: () => spy };
  Object.defineProperty(engine, "ctx", {
    value: Object.assign(Object.create(ctx), {
      llm,
      get: (name: string) => (name === "magicContextHost" ? host : name === "llm" ? llm : undefined),
    }),
    configurable: true,
  });
  const id = "sess-child";
  const header = {
    id: SessionId(id),
    version: 4,
    createdAt: Date.now(),
    isSeeded: false,
    ...(childHeader ?? {}),
  };
  const session = Session.create(SessionId(id), undefined, header as never);
  for (let t = 1; t <= 3; t += 1) appendTurn(session, t);
  const agent = { id, session, options: { provider: "deepseek", model: "deepseek-chat" } } as unknown as Agent;
  const messages = readDshTranscript({
    session: { events: session.snapshotEvents(), surface: session.surface, header: {} },
    canonicalSessionId: `dsh:abc:${id}`,
  }).messages;
  return {
    db,
    llm,
    engine,
    agent,
    messages,
    hookCalls: () => hookCalls,
    wrapper: () => registered!,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const INPUT = {
  messages: [
    createUserMessage({ content: [{ type: "text", text: "question 1" }], source: { kind: "user" } }),
  ],
};

describe("child-session compaction (upstream parity: no historian for subagents)", () => {
  for (const [label, childHeader] of [
    ["origin=subagent", { origin: "subagent", delegationDepth: 1 }],
    ["delegationDepth=2 only", { delegationDepth: 2 }],
  ] as const) {
    it(`${label}: falls back to the stock summarizer and writes no MC rows`, async () => {
      const t = await setup(childHeader);
      try {
        const before = rowCounts(t.db);
        // The child's own transcript ids: before the fix the MC historian
        // resolved them and ran a mini-historian pass for the child.
        const result = await t.engine.summarize(
          { messages: t.messages.map((m) => ({ ...INPUT.messages[0]!, id: m.id })) } as never,
          t.agent,
        );
        expect(rowCounts(t.db)).toEqual(before);
        expect(t.hookCalls()).toBe(0);
        expect(result.summary.map((b) => (b as { text: string }).text).join("")).toContain("STOCK SUMMARY");
        expect(t.llm.calls).toHaveLength(1);
        expect(t.llm.calls[0]!.purpose).toBe("compaction");
        expect(t.llm.calls[0]!.historian).toBe(false);
        // No compartment / marker / lease / historian state for that session.
        const key = "dsh:abc:sess-child";
        expect((t.db.prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?").get(key) as { n: number }).n).toBe(0);
      } finally {
        t.cleanup();
      }
    });
  }

  it("the registered historian hook refuses a child session directly and writes nothing", async () => {
    const t = await setup({ origin: "subagent", delegationDepth: 1 });
    try {
      const before = rowCounts(t.db);
      await expect(t.wrapper()({ messages: t.messages.map((m) => ({ id: m.id })) }, t.agent)).rejects.toThrow(
        /child \(subagent\) session/,
      );
      expect(t.llm.calls).toHaveLength(0);
      expect(rowCounts(t.db)).toEqual(before);
    } finally {
      t.cleanup();
    }
  });

  it("a main (top-level) session still compacts through the MC historian hook", async () => {
    const t = await setup(undefined);
    try {
      const key = "dsh:abc:sess-child";
      appendCompartments(t.db, key, [
        {
          sequence: 0,
          startMessage: 1,
          endMessage: 6,
          startMessageId: t.messages[0]!.id,
          endMessageId: t.messages[5]!.id,
          title: "c0",
          content: "Narrative summary of 1-6.",
          p1: "Narrative summary of 1-6.",
          p2: "p2",
          p3: "p3",
          p4: "p4",
          importance: 50,
          episodeType: "design",
        } as never,
      ]);
      const result = await t.engine.summarize(
        { messages: t.messages.map((m) => ({ id: m.id })) } as never,
        t.agent,
      );
      expect(t.hookCalls()).toBe(1);
      expect(result.summary.map((b) => (b as { text: string }).text).join("")).toContain("Narrative summary of 1-6.");
      expect(t.llm.calls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });
});
