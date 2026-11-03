/**
 * Round 24c (P1-1, scenario H U16/U18) — Magic's OWN injected messages must
 * not become "history".
 *
 * On DSH the knowledge baseline (m0: `<session-history>` / `<project-memory>`)
 * and the `<ctx-search-hint>` are delivered as separate `magic-context`-sourced
 * user messages that DSH appends to the durable log (DSH "inject, don't
 * rewrite"). OpenCode and Pi add the same blocks at transform time only, so
 * their message store — the source of core's message-history FTS index and of
 * the historian's chunk — never contains them. On DSH both read the history
 * view, injected messages included:
 *   - the message lane of ctx_search returned the `<project-memory>` block (all
 *     four facts in one "message") and every hint that quoted a fact, and the
 *     compartment chunks embedded from that index carried them too;
 *   - the historian summarised them into compartments of unrelated turns (real
 *     e2e 41672370986: compartments 23-28, 29-33, 34-37 of session A all carry
 *     the four codewords; one titled "received a pasted session-history/
 *     project-memory block"), so the compartment lane answered a paraphrase
 *     with those instead of the compartment covering the fact.
 *
 * The test drives the PRODUCTION pre-step over a real DSH Session holding the
 * four fact turns, an injected m0 baseline and two injected hints, then checks
 * what the FTS index holds, what ctx_search's message lane returns and what
 * the historian (the provider the pre-step hands to `historian.fire`) reads —
 * through core's own `readSessionChunk`. Ordinals must not move (compartments
 * and ctx_expand number by them).
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
import { readSessionChunk, withRawMessageProvider, type RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createAssistantMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { transcriptRawMessageProvider } from "./historian-wiring";
import { registerCtxTools } from "./tools";

const KEY = (id: string) => `dsh:a1b2c3d4:${id}`;
const CODES = ["ARCH-KESTREL-4127", "RULE-MARMOT-5830", "FILE-HERON-2261", "TODO-BISON-9074"];
const FACTS = [
  `Architecture decision: every write to the ledger goes through the outbox saga, which is the single writer (codeword ${CODES[0]}).`,
  `User constraint: never run database migrations from a background worker (codeword ${CODES[1]}).`,
  `File relation: the quota gauge module src/host/meter.ts takes its figures from src/host/context-details.ts (codeword ${CODES[2]}).`,
  `Open todo: add a pruning job for stale historian leases (codeword ${CODES[3]}).`,
];
const M0 = `<session-history>\n<compartment start="1" end="8" title="Persisted four codeword-tagged facts">Saved the four facts.</compartment>\n</session-history>\n<project-memory>\n${FACTS.map((f, i) => `- [${16 + i}] ${f}`).join("\n")}\n</project-memory>`;
const HINT =
  "\n\n<ctx-search-hint>\nYour memory may contain 2 related fragments:\n- File relation: quota gauge module src/host/meter.ts takes its figures from src/…\n- Architecture decision: every write to ledger goes through outbox saga, which is…\nIf the fragments above seem relevant to the current request, you may run ctx_search to retrieve full context. Otherwise ignore.\n</ctx-search-hint>";
const INJECTED_MARKERS = ["<project-memory>", "<session-history>", "<ctx-search-hint>", "related fragments"];

function scenario(id: string): Session {
  const session = Session.create(SessionId(id), undefined, { id: SessionId(id), version: 4, createdAt: Date.now(), isSeeded: false, cwd: "/tmp/dsh-proj" } as never);
  const user = (text: string, injected = false) =>
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text }],
        source: injected ? { kind: "magic-context", plugin: "magic-context", messageId: `mc-test:${session.seq}` } : { kind: "user" },
      }) as never,
      { surfaceOp: "append" },
    );
  const assistant = (text: string) =>
    session.append(
      "assistant/message",
      { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: "text", text }], provider: "p", model: "m", source: { kind: "model" } as never } as never) } as never,
      { surfaceOp: "append" },
    );
  FACTS.forEach((fact, i) => {
    user(`Fact ${i + 1} of 4 about this project — remember it, I will ask about it in later sessions: ${fact} Then reply with the single word DONE.`);
    assistant("DONE");
  });
  user(M0, true); // 9: knowledge baseline (m0) of the next turn
  user("Read the file src/agent/outbox.ts, then read the file src/agent/nudge.ts. Name the first export of each."); // 10
  user(HINT, true); // 11
  assistant("outbox.ts exports ADAPTER_META_KEY first; nudge.ts exports NUDGE_KIND first."); // 12
  user("Read the file src/agent/pressure-truncation.ts and name its first export."); // 13
  user(HINT, true); // 14
  assistant("pressure-truncation.ts exports PRESSURE_TIER first."); // 15
  user("ok"); // 16
  assistant("ok"); // 17
  return session;
}

async function waitFor(check: () => boolean, ms = 4000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

function partsText(message: { parts: unknown[] }): string {
  return message.parts
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("\n");
}

describe("Magic-injected messages are not history (P1-1, round 24c)", () => {
  it("message index, ctx_search message lane and historian input carry no injected block; ordinals unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-injected-"));
    const db: Database = await createTestDb(join(dir, "context.db"));
    try {
      const sid = "session-r24c-a";
      const session = scenario(sid);
      const agent = { id: sid, session, options: { provider: "p", model: "m" } } as unknown as Agent;
      const view = transcriptRawMessageProvider(agent, KEY(sid)).readMessages();
      expect(view.length).toBe(17);
      // compartments up to the "ok" turn; ordinals 16-17 stay live
      appendCompartments(db, KEY(sid), [{
        sequence: 0, startMessage: 1, endMessage: 15, startMessageId: view[0]!.id, endMessageId: view[14]!.id,
        title: "Facts and reads", content: "x", p1: "x", p2: "x", p3: "x", p4: "x", importance: 50, episodeType: "design",
      }] as never);

      let fired: RawMessageProvider | undefined;
      const deps: ContextPlaneDeps = {
        host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: KEY },
        config: { enabled: false },
        historian: {
          config: { executeThresholdPercentage: 65 },
          readPressure: () => ({ projectedTokens: 90_000, contextWindow: 100_000 }),
          fire: (args) => {
            fired = args.provider;
          },
        },
        log: () => {},
      };
      await runContextPlaneStep(createContextPlaneState(), deps, { agent: agent as never, messages: [] as never }, async () => ({ reject: false, messages: [] }) as never);
      const indexed = await waitFor(() => {
        const row = db.prepare("SELECT last_indexed_ordinal AS n FROM message_history_index WHERE session_id = ?").get(KEY(sid)) as { n: number } | null;
        return (row?.n ?? 0) >= view.length;
      });
      expect(indexed).toBe(true);

      // 1. the FTS index holds no injected block, and every real message keeps its view ordinal
      const rows = db.prepare("SELECT message_ordinal AS o, message_id AS id, role, content FROM message_history_fts WHERE session_id = ? ORDER BY message_ordinal").all(KEY(sid)) as { o: number; id: string; role: string; content: string }[];
      const polluted = rows.filter((row) => INJECTED_MARKERS.some((marker) => row.content.includes(marker))).map((row) => row.o);
      expect(polluted).toEqual([]);
      const realOrdinals = rows.map((row) => row.o);
      expect(realOrdinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 15, 16, 17]);
      for (const row of rows) expect(row.id).toBe(view[row.o - 1]!.id);

      // 2. ctx_search, message lane: the codeword finds ONLY the fact's own user message (ordinal 5)
      const registered: ToolDefinition[] = [];
      const ctx = { get: (name: string) => (name === "tools" ? { register: (d: ToolDefinition) => (registered.push(d), () => {}) } : undefined) } as unknown as Context;
      registerCtxTools(ctx, { db, canonicalKey: KEY, resolveProjectIdentity: () => "git:/tmp/dsh-proj", embeddingEnabled: false, memoryEnabled: true } as never);
      const search = registered.find((d) => d.name === "ctx_search")!;
      const exec = { agent: { id: sid, options: {}, session: { header: { id: sid, cwd: "/tmp/dsh-proj" } } }, signal: new AbortController().signal } as unknown as ToolRunContext;
      const text = ((await search.execute({ query: CODES[2]!, sources: ["message"] }, exec)) as { text: string }).text;
      const blocks = text.split("\n\n").filter((block) => block.startsWith("["));
      const withCode = blocks.filter((block) => block.includes(CODES[2]!));
      expect(withCode.length).toBe(1);
      expect(withCode[0]).toMatch(/^\[1\] \[message\] score=[0-9.]+ ordinal=5 [^\n]*role=user\n/);
      for (const other of CODES.filter((code) => code !== CODES[2])) expect(withCode[0]).not.toContain(other);
      for (const block of blocks) for (const marker of INJECTED_MARKERS) expect(block).not.toContain(marker);

      // 3. the historian (provider handed to historian.fire) reads no injected block, same ordinals/ids
      expect(fired).toBeDefined();
      const historianView = fired!.readMessages();
      expect(historianView.map((m) => `${m.ordinal}:${m.id}`)).toEqual(view.map((m) => `${m.ordinal}:${m.id}`));
      const chunk = withRawMessageProvider(KEY(sid), fired!, () => readSessionChunk(KEY(sid), 100_000, 1, 15));
      for (const marker of INJECTED_MARKERS) expect(chunk.text).not.toContain(marker);
      for (const fact of FACTS) expect(chunk.text).toContain(fact.slice(0, 40));
      expect(partsText(historianView[8]!)).toBe("");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
