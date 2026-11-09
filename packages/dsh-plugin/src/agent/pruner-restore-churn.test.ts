/**
 * Round 37 phase 2 — investigation of `max_completion_tokens: 1` (run
 * 42459290880, main request #426, finish=length, turn 9 turn_end max-tokens).
 * RED only — documented as `it.failing` (the defect is NOT fixed here, by
 * instruction); when it is fixed this test starts passing and bun reports the
 * `it.failing` as a failure, which is the signal to flip it to `it`.
 *
 * Chain (evidence in docs/dsh/e2e/evidence-round37/phase2-i4-isolation-integration.md §7):
 *   1. `1` is pi-ai 1.4.0 `clampMaxTokensToContext` (via @deepseek-ai/dsh-llm-pi-ai
 *      0.2.1-rc.5): min(maxTokens 32768, max(1, window 200 000 − estimateContextTokens − 4096)).
 *   2. `estimateContextTokens` anchors on the last assistant usage only while no
 *      earlier message is newer than that response; otherwise it counts the whole
 *      request at 3.5 chars/token (here ≥ 195 903 for a 179 522-token prompt).
 *   3. Between request 424 and 426 the log holds tool/result replaces (seq
 *      6224–6240) of nodes BEFORE the last assistant message, newer than it.
 *   4. Those replaces are a ping-pong on the same nodes: DSH's
 *      compaction-tool-result-pruner shortens a >8192-char result (head 4096 +
 *      "[... tool result middle pruned ...]" + tail 1024; 603 shrinking replaces
 *      in the run) and the Magic native tool rewrite writes the tagged ORIGINAL
 *      text back on the next pre-step (943 growing replaces; e.g. seq 4805 →
 *      6240 alternates 10 096 / 5 159 chars every step).
 *
 * This test pins step 4 (the plugin part): after the DSH pruner shortened a
 * tagged tool result, a plain Magic pre-step must not rewrite that node back to
 * the full text.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createAssistantMessage, createToolResultMessage, createUserMessage, sessionEvents } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { NATIVE_ROLES_ENV } from "./tag-scheme";

/** DSH 0.2.1-rc.5 dsh-compaction-tool-result-pruner (lib/index.js): marker + default budgets. */
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
const PRUNE = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };

let savedEnv: string | undefined;
beforeAll(() => {
  savedEnv = process.env[NATIVE_ROLES_ENV];
  delete process.env[NATIVE_ROLES_ENV];
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env[NATIVE_ROLES_ENV];
  else process.env[NATIVE_ROLES_ENV] = savedEnv;
});

type Ev = { type: string; seq: number; data?: { message?: { content?: Array<{ type?: string; text?: string }>; toolCallId?: string } }; sourceEventSeqs?: number[] };
const textOf = (e: Ev | undefined) => (e?.data?.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");

/** The pruner's own replace (compaction/prune shadow price + tool/result replace citing the node). */
function dshPrune(session: Session): number {
  let pruned = 0;
  for (const seq of [...session.surface.nodes]) {
    const event = (session as unknown as { eventAt(s: number): Ev }).eventAt(Number(seq));
    if (event?.type !== "tool/result") continue;
    const text = textOf(event);
    if (text.length <= PRUNE.thresholdChars) continue;
    const next = text.slice(0, PRUNE.headChars) + PRUNE_MARKER + text.slice(text.length - PRUNE.tailChars);
    (session.append as unknown as (t: string, d: unknown) => unknown).call(session, "compaction/prune", {
      shadowedRange: { start: Number(seq), end: Number(seq) },
      shadowedSeqs: [Number(seq)],
      shadowedTokenCount: Math.ceil(text.length / 4),
    });
    const data = structuredClone(event.data) as { message: { content: Array<{ type?: string; text?: string }> } };
    data.message.content = [{ type: "text", text: next }];
    session.append("tool/result", data as never, { surfaceOp: { op: "replace", startSeq: Number(seq), endSeq: Number(seq) }, sourceEventSeqs: [Number(seq)] } as never);
    pruned += 1;
  }
  return pruned;
}

describe("round 37 phase 2: Magic native tool rewrite vs the DSH tool-result pruner (max_completion_tokens 1 chain)", () => {
  it.failing("P1 a tool result the DSH pruner shortened is not rewritten back to its full text by the next pre-step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-prune-churn-"));
    const db: Database = await createTestDb(join(dir, "c.db"));
    try {
      const sid = `sess-prune-churn-${Date.now()}`;
      const header = { id: SessionId(sid), version: 4, createdAt: Date.now(), isSeeded: false, cwd: dir };
      const session = Session.create(SessionId(sid), undefined, header as never);
      const host = {
        ready: Promise.resolve({ kind: "ok" as const, db, storageDir: dir, livenessPath: "" }),
        canonicalKey: (id: string) => `dsh:prune0001:${id}`,
      };
      const deps = {
        host,
        config: { protectedTokens: 500 },
        historian: { config: { enabled: false, executeThresholdPercentage: 65 }, readPressure: () => ({ projectedTokens: 20_000, contextWindow: 200_000 }), fire: () => {} },
        cacheTtl: "5m",
        log: () => {},
      } as unknown as ContextPlaneDeps;
      const state = createContextPlaneState();
      const agent = { id: session.id, session, options: { provider: "d", model: "m" } };
      const preStep = async (batch: unknown[]) => {
        await runContextPlaneStep(state, deps, { agent: agent as never, messages: batch as never }, async () => ({ reject: false, messages: batch }) as never);
        for (const m of batch) session.append("user/message", m as never, { surfaceOp: "append" });
      };
      const src = { kind: "model", provider: "d", model: "m" };
      const big = Array.from({ length: 200 }, (_, i) => `conans/model/conf.py:${i}: line ${i} of a long grep result`).join("\n");
      expect(big.length).toBeGreaterThan(PRUNE.thresholdChars);
      for (let turn = 1; turn <= 4; turn += 1) {
        await preStep([createUserMessage({ content: [{ type: "text", text: `question ${turn}` }], source: { kind: "user" } })]);
        session.append("assistant/message", { turn, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: "reasoning", text: `r${turn}` }, { type: "tool-call", id: `call-${turn}`, name: "grep", arguments: "{}" }], provider: "d", model: "m", source: src } as never) } as never, { surfaceOp: "append" });
        session.append("tool/result", { turn, step: 1, message: createToolResultMessage({ callId: `call-${turn}` as never, content: [{ type: "text", text: turn === 1 ? big : `small ${turn}` }], isError: false }) } as never, { surfaceOp: "append" });
        await preStep([]); // tags the new result (native rewrite)
        session.append("assistant/message", { turn, step: 2, stream: [], message: createAssistantMessage({ content: [{ type: "reasoning", text: `w${turn}` }, { type: "text", text: `answer ${turn}` }], provider: "d", model: "m", source: src } as never) } as never, { surfaceOp: "append" });
        if (turn === 2) expect(dshPrune(session)).toBe(1); // DSH pruner shortens the big result (now tagged)
      }
      // After the prune: every later replace of call-1's node must keep it pruned.
      const events = sessionEvents(session) as unknown as Ev[];
      const call1 = events.filter((e) => e.type === "tool/result" && e.data?.message?.toolCallId === "call-1");
      const prunedAt = call1.findIndex((e) => textOf(e).includes(PRUNE_MARKER));
      expect(prunedAt).toBeGreaterThanOrEqual(0);
      const restored = call1.slice(prunedAt + 1).filter((e) => !textOf(e).includes(PRUNE_MARKER));
      expect(restored.map((e) => ({ seq: e.seq, chars: textOf(e).length }))).toEqual([]);
      // and the live node is still the pruned one
      const live = [...session.surface.nodes].map((s) => (session as unknown as { eventAt(x: number): Ev }).eventAt(Number(s)));
      const liveCall1 = live.find((e) => e.type === "tool/result" && e.data?.message?.toolCallId === "call-1");
      expect(textOf(liveCall1)).toContain(PRUNE_MARKER);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
