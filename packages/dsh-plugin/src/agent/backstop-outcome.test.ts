/**
 * Round 37 phase 2 — the native pressure backstop: what it ACTUALLY did, and
 * on which measurement.
 *
 * L4 (evo bench 42348192506, 200k route): the per-check debug line read
 * `pct=84.2 … 87.9 thresholdPct=83.6 … outcome=none` again and again. `pct` /
 * `thresholdPct` are the PLUGIN's prediction (its probe before the check);
 * compaction-basic then measured with its own meter, ran its tool-result
 * pruner, measured again and returned null — and the line could not say which
 * of those happened, or on what numbers. `outcome=none` is not an execution.
 *
 * Every MC main pressure check now records a classified outcome next to both
 * values (engine.lastPressureCheck(agent); the debug line carries the same):
 *   predicted  { pct, thresholdPct }                  — plugin probe
 *   measured   { tokensBefore, tokensAfter, thresholdTokens, reservedTokens,
 *                window }                              — the backstop's meter / threshold
 *   outcome    compacted | skipped:<reason> | deferred:<reason> | failed:<reason>
 * Reasons: below-threshold (measured under the backstop threshold),
 * pruned-below-threshold (compaction-basic's tool-result pruner brought it
 * under), no-compactable-range, would-not-shrink (round 24 guard),
 * no-routed-request, historian-busy; failed carries the error.
 * The backstop's behaviour (what it compacts, when) is unchanged.
 *
 * Engine: the production MagicCompactionEngine over the REAL compaction-basic
 * transaction, REAL DSH TokenMeter and Session (real rc.5 scenario-L log), the
 * real Magic summarize hook, a file DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { Database } from "@magic-context/core/shared/sqlite";
import { MagicCompactionEngine } from "../compat/dsh-0.1/compaction";
import { createAssistantMessage, createToolResultMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createBackstopGuard } from "./backstop-guard";
import { createMagicSummarizeHook, type DshSummarizeCall } from "./historian";
import { transcriptRawMessageProvider } from "./historian-wiring";
import { initializeDshAdapterTables } from "./outbox";

const FIX = join(import.meta.dir, "fixtures");
const ROUTE = { provider: "opencode-go-40k", model: "deepseek-v4.1-flash" };
const POLICY = { ...ROUTE, headroomTokens: 0, thresholdRatio: 0.36, retainTokens: 4000, maxTokens: 4096 };

interface Comp { start: number; end: number; title: string; content: string }
interface Check {
  outcome: string;
  predicted: { pct?: number; thresholdPct?: number };
  measured: { tokensBefore?: number; tokensAfter?: number; thresholdTokens?: number; reservedTokens?: number; window?: number };
}

const xmlFor = (c: Comp, chunk: { startIndex: number }) => `<output>
<compartments>
<compartment start="${c.start}" end="${c.end}" title="${c.title}" episode_type="design" importance="50">
<p1>${c.content}</p1>
<p2>${c.content}</p2>
<p3>${c.content}</p3>
<p4>${c.title}</p4>
</compartment>
</compartments>
<facts>
</facts>
<meta>
<messages_processed>${chunk.startIndex}-${c.end}</messages_processed>
<unprocessed_from>${c.end + 1}</unprocessed_from>
</meta>
</output>`;

let saved: string | undefined;
let lines: string[] = [];
let origError: typeof console.error;
beforeEach(() => {
  saved = process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN;
  process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN = "1";
  lines = [];
  origError = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
});
afterEach(() => {
  console.error = origError;
  if (saved === undefined) delete process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN;
  else process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN = saved;
});

async function rig(opts: { policy?: typeof POLICY; llm?: DshSummarizeCall; pruner?: (s: Session) => void } = {}) {
  const lines0 = readFileSync(join(FIX, "rc5-r10-backstop-checkpoint-only.session.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const session = Session.create(SessionId(lines0[0].id), lines0.slice(1) as never);
  const sid = `dsh:7114782d:${lines0[0].id}`;
  const agent = { id: lines0[0].id, session, options: ROUTE } as unknown as Agent;
  const dir = mkdtempSync(join(tmpdir(), "dsh-backstop-outcome-"));
  const db: Database = await createTestDb(join(dir, "context.db"));
  initializeDshAdapterTables(db);
  const view = transcriptRawMessageProvider(agent, sid).readMessages();
  const idAt = (o: number) => view.find((m) => m.ordinal === o)!.id;
  const comps = JSON.parse(readFileSync(join(FIX, "rc5-r10-compartments.json"), "utf8")) as Comp[];
  appendCompartments(
    db,
    sid,
    comps.filter((c) => c.end <= 7).map((c, sequence) => ({
      sequence, startMessage: c.start, endMessage: c.end, startMessageId: idAt(c.start), endMessageId: idAt(c.end),
      title: c.title, content: c.content, p1: c.content, p2: c.content, p3: c.content, p4: c.title, importance: 50, episodeType: "design",
    })) as never,
  );
  const llmCalls: number[][] = [];
  const summarize: DshSummarizeCall =
    opts.llm ??
    (async (chunk) => {
      llmCalls.push([chunk.startIndex, chunk.endIndex]);
      return xmlFor({ start: chunk.startIndex, end: chunk.endIndex, title: "Listed the workspace and read the pressure fixtures", content: comps[3]!.content }, chunk);
    });
  const guard = createBackstopGuard({ db: () => db, canonicalKey: (id) => `dsh:7114782d:${id}` });
  const host = {
    nativePressurePercentage: () => 90,
    summarizeHook: () => (input: never, a: Agent, signal?: AbortSignal) =>
      createMagicSummarizeHook({ db, sessionId: sid, ctx: {}, provider: transcriptRawMessageProvider(a, sid), summarize, directory: dir, leaseHolderId: "r37-backstop" } as never)(input, a, signal),
    backstopGuard: () => guard,
  };
  const meterCtx = new Context();
  meterCtx.provide("sessionProjections", { register: () => () => {} } as never);
  const meter = new (TokenMeter as unknown as new (c: Context) => { measure(s: unknown): { totalTokens: number } })(meterCtx);
  const ctx = new Context();
  const engine = new MagicCompactionEngine(ctx as never, { auto: false, modelPolicies: [opts.policy ?? POLICY] } as never);
  const pruner = opts.pruner ? { pruneSession: opts.pruner } : undefined;
  Object.defineProperty(engine, "ctx", {
    value: Object.assign(Object.create(ctx), {
      llm: { resolveModelInfo: async () => ({ context: { contextWindow: 40_000 }, defaultMaxTokens: 4096 }) },
      logger: { info: () => {}, warn: () => {} },
      tokenMeter: meter,
      get: (name: string) => (name === "magicContextHost" ? host : name === "toolResultPruner" ? pruner : undefined),
    }),
    configurable: true,
  });
  const check = async () => {
    const before = session.seq;
    let error: string | undefined;
    let result: unknown;
    try {
      result = await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const appended: string[] = [];
    for (let s = before; s < session.seq; s += 1) appended.push((session as unknown as { eventAt(s: number): { type: string } }).eventAt(s).type);
    const last = (engine as unknown as { lastPressureCheck?: (a: Agent) => Check | undefined }).lastPressureCheck?.(agent);
    return { result, error, compaction: appended.filter((t) => t.startsWith("compaction/")), check: last, line: lines.filter((l) => l.includes("native pressure check")).at(-1) };
  };
  const addEvidence = (tokensish: number) =>
    session.append("user/message", createUserMessage({ content: [{ type: "text", text: "new evidence line. ".repeat(Math.round(tokensish / 4.6)) }], source: { kind: "user" } }), { surfaceOp: "append" });
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { session, agent, check, cleanup, llmCalls, addEvidence };
}

function expectMeasured(c: Check | undefined, thresholdTokens = 14_400) {
  expect(c).toBeDefined();
  expect(typeof c!.predicted.pct).toBe("number");
  expect(typeof c!.predicted.thresholdPct).toBe("number");
  expect(typeof c!.measured.tokensBefore).toBe("number");
  expect(typeof c!.measured.tokensAfter).toBe("number");
  expect(c!.measured.thresholdTokens).toBe(thresholdTokens); // floor(min(40 000 × ratio, 40 000 − 4 096 − 0))
  expect(c!.measured.window).toBe(40_000);
  expect(c!.outcome).not.toBe("none");
}

describe("round 37 phase 2: the native backstop reports what it did and on which measurement", () => {
  it("B1 executed: over the threshold with new history → compacted; the record holds prediction AND the backstop's own before / after measurement", async () => {
    const r = await rig();
    try {
      r.addEvidence(6000);
      const out = await r.check();
      expect(out.error).toBeUndefined();
      expect(out.compaction).toEqual(["compaction/start", "compaction/summary", "compaction/end"]);
      expectMeasured(out.check);
      expect(out.check!.outcome).toBe("compacted");
      expect(out.check!.measured.tokensBefore!).toBeGreaterThanOrEqual(out.check!.measured.thresholdTokens!);
      expect(out.check!.measured.tokensAfter!).toBeLessThan(out.check!.measured.tokensBefore!);
      expect(out.line).toMatch(/outcome=compacted/);
      expect(out.line).toMatch(/backstop=\d+->\d+\/14400/);
    } finally {
      r.cleanup();
    }
  });

  it("B2 the L4 shape: predicted over the threshold, the pruner brings it under → skipped:pruned-below-threshold (not none), both values recorded", async () => {
    let pruned = false;
    // backstop at 42 % (16 800): the log alone (38.6 %) is under it, the big tool output puts it over
    const r = await rig({
      policy: { ...POLICY, thresholdRatio: 0.42 },
      pruner: (s) => {
        // compaction-basic's tool-result pruner: replace the big tool output in place
        const seq = s.surface.nodes.find((n) => (s as unknown as { eventAt(x: number): { type: string; data: { message?: { toolCallId?: string } } } }).eventAt(n).data?.message?.toolCallId === "call-big");
        if (seq === undefined || pruned) return;
        pruned = true;
        const data = structuredClone((s as unknown as { eventAt(x: number): { data: { message: { content: unknown } } } }).eventAt(seq).data);
        data.message.content = [{ type: "text", text: "[pruned]" }];
        s.append("tool/result", data as never, { surfaceOp: { op: "replace", startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] } as never);
      },
    });
    try {
      (r.session.append as unknown as (t: string, d: unknown) => unknown).call(r.session, "step/start", { turn: 2, step: 5 });
      r.session.append(
        "assistant/message",
        { turn: 2, step: 5, stream: [], message: createAssistantMessage({ content: [{ type: "tool-call", id: "call-big", name: "read", arguments: "{}" }], provider: ROUTE.provider, model: ROUTE.model, source: { kind: "model", provider: ROUTE.provider, model: ROUTE.model } } as never) } as never,
        { surfaceOp: "append" },
      );
      r.session.append("tool/result", { turn: 2, step: 5, message: createToolResultMessage({ callId: "call-big" as never, content: [{ type: "text", text: "big tool output line. ".repeat(900) }], isError: false }) } as never, { surfaceOp: "append" });
      (r.session.append as unknown as (t: string, d: unknown) => unknown).call(r.session, "step/end", { turn: 2, step: 5 });
      const out = await r.check();
      expect(out.error).toBeUndefined();
      expect(out.result).toBeNull();
      expect(out.compaction).toEqual([]);
      expect(pruned).toBe(true);
      expectMeasured(out.check, 16_800);
      expect(out.check!.predicted.pct!).toBeGreaterThanOrEqual(out.check!.predicted.thresholdPct!);
      expect(out.check!.measured.tokensBefore!).toBeGreaterThanOrEqual(out.check!.measured.thresholdTokens!);
      expect(out.check!.measured.tokensAfter!).toBeLessThan(out.check!.measured.thresholdTokens!);
      expect(out.check!.outcome).toBe("skipped:pruned-below-threshold");
      expect(out.line).toMatch(/outcome=skipped:pruned-below-threshold/);
      expect(out.line).not.toMatch(/outcome=none/);
    } finally {
      r.cleanup();
    }
  });

  it("B3 under the backstop threshold → skipped:below-threshold; would-not-shrink keeps its own reason", async () => {
    const low = await rig({ policy: { ...POLICY, thresholdRatio: 0.8 } });
    try {
      const out = await low.check();
      expect(out.compaction).toEqual([]);
      expect(out.check?.outcome).toBe("skipped:below-threshold");
      expect(out.check!.measured.tokensBefore!).toBeLessThan(out.check!.measured.thresholdTokens!);
    } finally {
      low.cleanup();
    }
    const stuck = await rig();
    try {
      const out = await stuck.check(); // region = only the previous checkpoint copy (round 24 R10)
      expect(out.compaction).toEqual([]);
      expectMeasured(out.check);
      expect(out.check!.outcome).toBe("skipped:would-not-shrink");
      expect(out.line).toMatch(/outcome=skipped:would-not-shrink/);
    } finally {
      stuck.cleanup();
    }
  });

  it("B4 the summary fails → failed:<reason>, the error still propagates, measurement recorded", async () => {
    const r = await rig({ llm: async () => { throw new Error("historian provider 429"); } });
    try {
      r.addEvidence(6000);
      const out = await r.check();
      expect(out.check).toBeDefined();
      expect(out.check!.outcome).toMatch(/^failed:/);
      expect(typeof out.check!.measured.tokensBefore).toBe("number");
      expect(out.line).toMatch(/outcome=(error|failed):/);
    } finally {
      r.cleanup();
    }
  });
});
