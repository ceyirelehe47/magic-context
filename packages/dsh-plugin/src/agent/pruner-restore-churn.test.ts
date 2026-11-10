/**
 * Round 37 phase 2 — investigation of `max_completion_tokens: 1` (run
 * 42459290880, main request #426, finish=length, turn 9 turn_end max-tokens).
 * P1 was RED as `it.failing` (06c802d28); fixed in round 37 seg 11 (native
 * view keeps the DSH pruner's cut, transcript.ts prunedToolBase) and flipped to
 * `it` with the same assertions.
 *
 * Chain (evidence in docs/dsh/e2e/evidence-round37/phase2-i4-isolation-integration.md §7):
 *   1. `1` is pi-ai 1.4.0 `clampMaxTokensToContext` (via @deepseek-ai/dsh-llm-pi-ai
 *      0.2.1-rc.5): min(maxTokens 32768, max(1, window 200 000 − estimateContextTokens − 4096)).
 *   2. CORRECTED in round 37 seg 11 (was: "the usage anchor is invalidated by
 *      newer replaces"). dsh-llm-pi-ai 0.2.1-rc.5 replays every assistant with
 *      `emptyPiUsage()` and timestamp 0, so pi's usage anchor NEVER applies: the
 *      estimate is always sum(ceil(chars / 3.5)) over the messages + tool
 *      schemas. Recomputing it from the request bodies reproduces every
 *      max_completion_tokens of runs 42459290880 (449 main) and 42805322951
 *      (530 main) within 0.1-0.3 %; #426 = 200 015 → 1.
 *   3. What pushed #426 over: request bodies alternate between the pruned and
 *      the restored results (424: 8 nodes pruned, prompt 165 020; 426: the same
 *      8 restored, prompt 179 522, +14.5k tokens).
 *   4. Those alternations are a ping-pong on the same nodes: DSH's
 *      compaction-tool-result-pruner shortens a >8192-char result (head 4096 +
 *      "[... tool result middle pruned ...]" + tail 1024; 603 shrinking replaces
 *      in the run) and the Magic native tool rewrite writes the tagged ORIGINAL
 *      text back on the next pre-step (943 growing replaces; e.g. seq 4805 →
 *      6240 alternates 10 096 / 5 159 chars every step).
 *
 * P1 pins step 4 (the plugin part): after the DSH pruner shortened a
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
import { readDshHistory } from "./transcript";
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
  it("P1 a tool result the DSH pruner shortened is not rewritten back to its full text by the next pre-step", async () => {
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

/* ───────────── P2/P3: the max_completion_tokens consequence near a 200k window ───────────── */

/**
 * pi-ai 1.4.0 `clampMaxTokensToContext` as DSH 0.2.1-rc.5 drives it
 * (api/simple-options.js + utils/estimate.js, pinned): dsh-llm-pi-ai replays
 * every assistant with `emptyPiUsage()` and timestamp 0, so the usage anchor
 * never applies and the estimate is ALWAYS sum(ceil(chars / 3.5)) over the
 * context messages plus the tool schemas (developer `toolsAdded`). Verified on
 * every main request of runs 42459290880 (449) and 42805322951 (530): the
 * recomputed estimate reproduces max_completion_tokens within 0.1-0.3 %.
 */
const WINDOW = 200_000;
const SAFETY = 4096;
const MAX_TOKENS = 32_768;
const TOOL_SCHEMA_TOKENS = 9_037; // the evo catalog's 29 tool schemas, chars / 3.5
const est35 = (chars: number) => Math.ceil(chars / 3.5);

type Block = { type?: string; text?: string; name?: string; arguments?: string };
function piEstimate(session: Session): number {
  let tokens = TOOL_SCHEMA_TOKENS;
  for (const seq of [...session.surface.nodes]) {
    const event = (session as unknown as { eventAt(s: number): { type: string; data?: { message?: { content?: Block[] }; content?: Block[] } } }).eventAt(Number(seq));
    // a user/message is the message itself (Magic copies too); tool/result and assistant wrap it
    const blocks = (event?.type === "user/message" ? event.data?.content : event?.data?.message?.content) ?? [];
    if (event?.type === "assistant/message") {
      let chars = 0;
      for (const b of blocks) {
        if (b.type === "text" || b.type === "reasoning") chars += (b.text ?? "").length;
        else if (b.type === "tool-call") chars += (b.name ?? "").length + JSON.stringify(JSON.parse(b.arguments || "{}")).length;
      }
      tokens += est35(chars);
    } else if (event?.type === "user/message" || event?.type === "tool/result") {
      tokens += est35(blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").length);
    }
  }
  return tokens;
}
const clamp = (estimate: number) => Math.min(MAX_TOKENS, Math.max(1, WINDOW - estimate - SAFETY));

async function buildNearWindowSession(dir: string, db: Database) {
  const sid = `sess-prune-window-${Date.now()}`;
  const header = { id: SessionId(sid), version: 4, createdAt: Date.now(), isSeeded: false, cwd: dir };
  const session = Session.create(SessionId(sid), undefined, header as never);
  const host = {
    ready: Promise.resolve({ kind: "ok" as const, db, storageDir: dir, livenessPath: "" }),
    canonicalKey: (id: string) => `dsh:prunewin1:${id}`,
  };
  const deps = {
    host,
    config: { protectedTokens: 500 },
    historian: { config: { enabled: false, executeThresholdPercentage: 65 }, readPressure: () => ({ projectedTokens: 20_000, contextWindow: WINDOW }), fire: () => {} },
    cacheTtl: "5m",
    log: () => {},
  } as unknown as ContextPlaneDeps;
  const state = createContextPlaneState();
  const agent = { id: session.id, session, options: { provider: "d", model: "m" } };
  const preStep = async (batch: unknown[]) => {
    await runContextPlaneStep(state, deps, { agent: agent as never, messages: batch as never }, async () => ({ reject: false, messages: batch }) as never);
    for (const m of batch) session.append("user/message", m as never, { surfaceOp: "append" });
  };
  return { session, preStep };
}

describe("round 37 limitation 35: max_completion_tokens near a 200k window with the DSH pruner active", () => {
  it("P2 once the pruner has cut the large results, no later step puts the cut text back (pi clamp stays where the pruned surface puts it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-prune-window-"));
    const db: Database = await createTestDb(join(dir, "c.db"));
    try {
      const { session, preStep } = await buildNearWindowSession(dir, db);
      const src = { kind: "model", provider: "d", model: "m" };
      // ~150k estimated tokens of prose the pruner never touches (user turns),
      // and 6 results of 30 000 chars (8 572 tokens each, 1 494 pruned).
      const prose = (turn: number) => Array.from({ length: 1570 }, (_, i) => `turn ${turn} note ${i}: context the user pasted, kept verbatim`).join("\n");
      const big = (turn: number) => Array.from({ length: 600 }, (_, i) => `src/mod${turn}.py:${i}: match ${i} of a long grep result`).join("\n").padEnd(30_000, "x");
      for (let turn = 1; turn <= 6; turn += 1) {
        await preStep([createUserMessage({ content: [{ type: "text", text: `question ${turn}\n${prose(turn)}` }], source: { kind: "user" } })]);
        session.append("assistant/message", { turn, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: "reasoning", text: `r${turn}` }, { type: "tool-call", id: `call-${turn}`, name: "grep", arguments: "{}" }], provider: "d", model: "m", source: src } as never) } as never, { surfaceOp: "append" });
        session.append("tool/result", { turn, step: 1, message: createToolResultMessage({ callId: `call-${turn}` as never, content: [{ type: "text", text: big(turn) }], isError: false }) } as never, { surfaceOp: "append" });
        await preStep([]); // Magic tags the new result
        session.append("assistant/message", { turn, step: 2, stream: [], message: createAssistantMessage({ content: [{ type: "reasoning", text: `w${turn}` }, { type: "text", text: `answer ${turn}` }], provider: "d", model: "m", source: src } as never) } as never, { surfaceOp: "append" });
      }
      // The pruner's pass (DSH compaction step): every large result cut.
      expect(dshPrune(session)).toBe(6);
      const pruned = piEstimate(session);
      expect(pruned).toBeGreaterThan(160_000); // near the window: Magic's own pressure (actual usage) is below its thresholds here
      expect(clamp(pruned)).toBeGreaterThan(16_384); // the pruned surface leaves room
      // Four more steps, each a DSH compaction pass then a Magic pre-step, then
      // the request. Nothing new is appended, so the estimate must not move.
      const seen: Array<{ step: number; afterPrune: number; atRequest: number; clamp: number }> = [];
      for (let step = 1; step <= 4; step += 1) {
        dshPrune(session);
        const afterPrune = piEstimate(session);
        await preStep([]);
        const atRequest = piEstimate(session);
        seen.push({ step, afterPrune, atRequest, clamp: clamp(atRequest) });
      }
      // Estimate at the request within 1 % of the pruned surface (tag prefixes
      // only), never the restored full text (+42 468 tokens, clamp 1).
      for (const s of seen) {
        expect(Math.abs(s.atRequest - pruned)).toBeLessThanOrEqual(Math.ceil(pruned * 0.01));
        expect(s.clamp).toBeGreaterThan(16_384);
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
  it("P3 the history view (historian / ctx_expand) still reads the ORIGINAL full result after the prune", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-prune-hist-"));
    const db: Database = await createTestDb(join(dir, "c.db"));
    try {
      const { session, preStep } = await buildNearWindowSession(dir, db);
      const src = { kind: "model", provider: "d", model: "m" };
      const big = Array.from({ length: 400 }, (_, i) => `lib/x.py:${i}: hit ${i}`).join("\n").padEnd(20_000, "y");
      await preStep([createUserMessage({ content: [{ type: "text", text: "q" }], source: { kind: "user" } })]);
      session.append("assistant/message", { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: "tool-call", id: "call-h", name: "grep", arguments: "{}" }], provider: "d", model: "m", source: src } as never) } as never, { surfaceOp: "append" });
      session.append("tool/result", { turn: 1, step: 1, message: createToolResultMessage({ callId: "call-h" as never, content: [{ type: "text", text: big }], isError: false }) } as never, { surfaceOp: "append" });
      await preStep([]);
      session.append("assistant/message", { turn: 1, step: 2, stream: [], message: createAssistantMessage({ content: [{ type: "text", text: "a" }], provider: "d", model: "m", source: src } as never) } as never, { surfaceOp: "append" });
      expect(dshPrune(session)).toBe(1);
      await preStep([]);
      const history = readDshHistory({ session: session as never, canonicalSessionId: `dsh:prunewin1:${session.id}` });
      const outputs = history.messages.flatMap((m) => (m.parts as Array<{ type?: string; callID?: string; state?: { output?: string } }>).filter((p) => p.type === "tool" && p.callID === "call-h" && typeof p.state?.output === "string").map((p) => p.state!.output!));
      expect(outputs.length).toBe(1);
      expect(outputs[0]).toBe(big);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("P4 a small result that merely CONTAINS the pruner marker text is tagged once and never treated as a prune", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-prune-lit-"));
    const db: Database = await createTestDb(join(dir, "c.db"));
    try {
      const { session, preStep } = await buildNearWindowSession(dir, db);
      const src = { kind: "model", provider: "d", model: "m" };
      const literal = `head of file${PRUNE_MARKER}tail of file`;
      await preStep([createUserMessage({ content: [{ type: "text", text: "q" }], source: { kind: "user" } })]);
      session.append("assistant/message", { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: "tool-call", id: "call-l", name: "read", arguments: "{}" }], provider: "d", model: "m", source: src } as never) } as never, { surfaceOp: "append" });
      session.append("tool/result", { turn: 1, step: 1, message: createToolResultMessage({ callId: "call-l" as never, content: [{ type: "text", text: literal }], isError: false }) } as never, { surfaceOp: "append" });
      for (let i = 0; i < 3; i += 1) await preStep([]);
      const events = sessionEvents(session) as unknown as Ev[];
      const nodes = events.filter((e) => e.type === "tool/result" && e.data?.message?.toolCallId === "call-l");
      expect(nodes.length).toBe(2); // the original + one tag rewrite, no churn
      expect(textOf(nodes[1])).toMatch(/^§\d+§ /);
      expect(textOf(nodes[1]).endsWith(literal)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
