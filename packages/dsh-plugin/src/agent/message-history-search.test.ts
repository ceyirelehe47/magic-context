/**
 * Round 24 (P1-1) — ctx_search must find early facts in the DSH message
 * history. Round 21's U1 "PASS" returned "No results found": the DSH adapter
 * never fed core's message-history FTS index (Pi/OpenCode call core
 * `scheduleReconciliation` from their context pass; DSH did not), so the
 * message lane of `unifiedSearch` had no rows on DSH, ever. (Compartments are
 * searchable only through embeddings, which DSH never registers — separate.)
 *
 * The test drives the PRODUCTION pre-step (runContextPlaneStep) over a real DSH
 * Session, publishes compartments over the early messages (ctx_search searches
 * history up to the last compartment end; the live tail is visible anyway) and
 * calls the real ctx_search tool → core unifiedSearch.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createAssistantMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { transcriptRawMessageProvider } from "./historian-wiring";
import { registerCtxTools } from "./tools";

const KEY = (id: string) => `dsh:a1b2c3d4:${id}`;
const FACTS = [
  "Architecture decision: the outbox saga is the single writer, codeword ARCH-ORCA-5521.",
  "User constraint: never touch the tag table from a worker, codeword RULE-LYNX-7730.",
  "File relation: meter.ts reads its numbers from context-details.ts, codeword FILE-WREN-2049.",
  "Open todo: add a pruning job for stale leases, codeword TODO-IBIS-6618.",
];

function conversation(id: string): Session {
  const session = Session.create(SessionId(id), undefined, { id: SessionId(id), version: 4, createdAt: Date.now(), isSeeded: false, cwd: "/tmp/dsh-proj" } as never);
  const say = (role: "user" | "assistant", text: string) =>
    session.append(
      role === "user" ? "user/message" : "assistant/message",
      role === "user"
        ? (createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }) as never)
        : ({ turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: "text", text }], provider: "p", model: "m", source: { kind: "model" } as never } as never) } as never),
      { surfaceOp: "append" },
    );
  for (const fact of FACTS) {
    say("user", `Please remember this. ${fact}`);
    say("assistant", "Noted.");
  }
  say("user", "Now something unrelated: list the files.");
  say("assistant", "Listing.");
  return session;
}

function toolsCtx(): { ctx: Context; registered: ToolDefinition[] } {
  const registered: ToolDefinition[] = [];
  const ctx = { get: (name: string) => (name === "tools" ? { register: (d: ToolDefinition) => (registered.push(d), () => {}) } : undefined) };
  return { ctx: ctx as unknown as Context, registered };
}

async function waitFor(check: () => boolean, ms = 4000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

describe("ctx_search over DSH message history (P1-1)", () => {
  it("finds each early fact by its codeword with the right ordinal (source) after the pre-step ran", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-msg-search-"));
    const db: Database = await createTestDb(join(dir, "context.db"));
    try {
      const sid = "session-p11-a";
      const session = conversation(sid);
      const agent = { id: sid, session, options: { provider: "p", model: "m" } } as unknown as Agent;
      const view = transcriptRawMessageProvider(agent, KEY(sid)).readMessages();
      // compartments over the 8 fact messages (ordinals 1..8); the tail (9, 10) stays live
      appendCompartments(db, KEY(sid), [{
        sequence: 0, startMessage: 1, endMessage: 8, startMessageId: view[0]!.id, endMessageId: view[7]!.id,
        title: "Facts", content: "Recorded four facts.", p1: "Recorded four facts.", p2: "Four facts.", p3: "Facts.", p4: "Facts", importance: 50, episodeType: "design",
      }] as never);
      const deps: ContextPlaneDeps = {
        host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: KEY },
        config: { enabled: false },
        log: () => {},
      };
      await runContextPlaneStep(createContextPlaneState(), deps, { agent: agent as never, messages: [] as never }, async () => ({ reject: false, messages: [] }) as never);
      const indexed = await waitFor(() => {
        const row = db.prepare("SELECT last_indexed_ordinal AS n FROM message_history_index WHERE session_id = ?").get(KEY(sid)) as { n: number } | null;
        return (row?.n ?? 0) >= view.length;
      });
      expect(indexed).toBe(true);

      const { ctx, registered } = toolsCtx();
      registerCtxTools(ctx, { db, canonicalKey: KEY, resolveProjectIdentity: () => "git:/tmp/dsh-proj", embeddingEnabled: false, memoryEnabled: true } as never);
      const search = registered.find((d) => d.name === "ctx_search")!;
      const exec = { agent: { id: sid, options: { provider: "p", model: "m" }, session: { header: { id: sid, cwd: "/tmp/dsh-proj" } } }, signal: new AbortController().signal } as unknown as ToolRunContext;
      for (const [i, code] of ["ARCH-ORCA-5521", "RULE-LYNX-7730", "FILE-WREN-2049", "TODO-IBIS-6618"].entries()) {
        const text = ((await search.execute({ query: code }, exec)) as { text: string }).text;
        expect(text).not.toContain("No results found");
        // the hit is the user message that carried the fact: ordinal 2i+1
        const hit = new RegExp(`\\[message\\] score=[0-9.]+ ordinal=${2 * i + 1} [^\\n]*role=user\\n[^\\n]*${code}`);
        expect(text).toMatch(hit);
        // no other fact's codeword in the first hit (no cross-fact mixing)
        const first = text.split("\n\n")[1] ?? "";
        for (const other of ["ARCH-ORCA-5521", "RULE-LYNX-7730", "FILE-WREN-2049", "TODO-IBIS-6618"].filter((c) => c !== code)) {
          expect(first).not.toContain(other);
        }
      }
      // a never-recorded codeword finds nothing
      const none = ((await search.execute({ query: "ZEBU-NEVER-0000" }, exec)) as { text: string }).text;
      expect(none).toContain("No results found");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not leak another session's history (search scope = the canonical session)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-msg-search-"));
    const db: Database = await createTestDb(join(dir, "context.db"));
    try {
      const a = "session-p11-x";
      const session = conversation(a);
      const agent = { id: a, session, options: { provider: "p", model: "m" } } as unknown as Agent;
      const view = transcriptRawMessageProvider(agent, KEY(a)).readMessages();
      appendCompartments(db, KEY(a), [{ sequence: 0, startMessage: 1, endMessage: 8, startMessageId: view[0]!.id, endMessageId: view[7]!.id, title: "Facts", content: "x", p1: "x", p2: "x", p3: "x", p4: "x", importance: 50, episodeType: "design" }] as never);
      const deps: ContextPlaneDeps = { host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: KEY }, config: { enabled: false }, log: () => {} };
      await runContextPlaneStep(createContextPlaneState(), deps, { agent: agent as never, messages: [] as never }, async () => ({ reject: false, messages: [] }) as never);
      await waitFor(() => ((db.prepare("SELECT last_indexed_ordinal AS n FROM message_history_index WHERE session_id = ?").get(KEY(a)) as { n: number } | null)?.n ?? 0) >= view.length);
      const { ctx, registered } = toolsCtx();
      registerCtxTools(ctx, { db, canonicalKey: KEY, resolveProjectIdentity: () => "git:/tmp/dsh-proj", embeddingEnabled: false, memoryEnabled: true } as never);
      const search = registered.find((d) => d.name === "ctx_search")!;
      const own = ((await search.execute({ query: "ARCH-ORCA-5521" }, { agent: { id: a, options: {}, session: { header: { id: a, cwd: "/tmp/dsh-proj" } } }, signal: new AbortController().signal } as never)) as { text: string }).text;
      expect(own).toMatch(/\[message\][^\n]*\n[^\n]*ARCH-ORCA-5521/);
      const other = ((await search.execute({ query: "ARCH-ORCA-5521" }, { agent: { id: "session-p11-y", options: {}, session: { header: { id: "session-p11-y", cwd: "/tmp/dsh-proj" } } }, signal: new AbortController().signal } as never)) as { text: string }).text;
      expect(other).toContain("No results found");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
