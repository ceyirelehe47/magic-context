/**
 * Round 24 — R10: the MC main pressure backstop re-compacted a region holding
 * ONLY the previous native checkpoint (its Magic op copy) and compaction-basic
 * rejected the result: "summary is not smaller than the shadowed content".
 *
 * Fixtures are the real scenario-L `lock-session.jsonl` logs of the two failing
 * e2e runs, cut right before the failed `compaction/start` (tool schemas of all
 * but the last request header stubbed):
 *   A  41642823892 (seq ≤ 64): region = surface node 64 (`§9§` checkpoint copy,
 *      473 route tokens); compartments 1-1, 2-5, 6-7 published (texts from the
 *      run's next summary) — real error "819 >= 475", replayed "820 >= 473".
 *   B  41640093586 (seq ≤ 62): region = node 62 (`§8§` copy); only compartment
 *      1-5 published, the checkpoint also stands for ordinals 6-7 (first
 *      compaction's uncovered tail) → the mini-historian runs, adds 6-7, and the
 *      render (real "423 >= 239") is again not smaller.
 * The engine is the production MagicCompactionEngine over the REAL
 * compaction-basic transaction, the REAL DSH TokenMeter and Session, the real
 * Magic summarize hook and transcript provider, a file DB.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { appendCompartments, getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { Database } from "@magic-context/core/shared/sqlite";
import { MagicCompactionEngine } from "../compat/dsh-0.1/compaction";
import { createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { backstopSkipStatusBlock, createBackstopGuard, readBackstopSkip } from "./backstop-guard";
import { createMagicSummarizeHook, type DshSummarizeCall } from "./historian";
import { transcriptRawMessageProvider } from "./historian-wiring";
import { initializeDshAdapterTables } from "./outbox";

const FIX = join(import.meta.dir, "fixtures");
const ROUTE = { provider: "opencode-go-40k", model: "deepseek-v4.1-flash" };
// scenario L's explicit per-route backstop (scripts/e2e/patch-r22-lock.yml)
const LOCK_POLICY = { ...ROUTE, headroomTokens: 0, thresholdRatio: 0.36, retainTokens: 4000, maxTokens: 4096 };

interface Comp { start: number; end: number; title: string; content: string }
type Event = { type: string; seq: number; data: Record<string, unknown> };

function xmlFor(c: Comp, chunk: { startIndex: number; endIndex: number }): string {
  return `<output>
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
}

async function rig(fixture: string, compartmentsFile: string, stage: (c: Comp) => boolean, llm?: (chunk: { startIndex: number; endIndex: number; text: string }) => string) {
  const lines = readFileSync(join(FIX, fixture), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const session = Session.create(SessionId(lines[0].id), lines.slice(1) as never);
  const sid = `dsh:7114782d:${lines[0].id}`;
  const agent = { id: lines[0].id, session, options: ROUTE } as unknown as Agent;
  const dir = mkdtempSync(join(tmpdir(), "dsh-r10-"));
  const db: Database = await createTestDb(join(dir, "context.db"));
  initializeDshAdapterTables(db);
  const view = transcriptRawMessageProvider(agent, sid).readMessages();
  const idAt = (o: number) => view.find((m) => m.ordinal === o)!.id;
  const comps = JSON.parse(readFileSync(join(FIX, compartmentsFile), "utf8")) as Comp[];
  appendCompartments(
    db,
    sid,
    comps.filter(stage).map((c, sequence) => ({
      sequence, startMessage: c.start, endMessage: c.end, startMessageId: idAt(c.start), endMessageId: idAt(c.end),
      title: c.title, content: c.content, p1: c.content, p2: c.content, p3: c.content, p4: c.title, importance: 50, episodeType: "design",
    })) as never,
  );
  const llmCalls: number[][] = [];
  const summarize: DshSummarizeCall = async (chunk) => {
    llmCalls.push([chunk.startIndex, chunk.endIndex]);
    if (llm === undefined) throw new Error("historian LLM must not be called");
    return llm(chunk);
  };
  const guard = createBackstopGuard({ db: () => db, canonicalKey: (id) => `dsh:7114782d:${id}` });
  const host = {
    nativePressurePercentage: () => 90,
    // the production wrapper builds the provider per call (snapshot of the transcript)
    summarizeHook: () => (input: never, a: Agent, signal?: AbortSignal) =>
      createMagicSummarizeHook({ db, sessionId: sid, ctx: {}, provider: transcriptRawMessageProvider(a, sid), summarize, directory: dir, leaseHolderId: "r24-r10" } as never)(input, a, signal),
    backstopGuard: () => guard,
  };
  const meterCtx = new Context();
  meterCtx.provide("sessionProjections", { register: () => () => {} } as never);
  const meter = new (TokenMeter as unknown as new (c: Context) => { measure(s: unknown): { totalTokens: number } })(meterCtx);
  const logs: string[] = [];
  const ctx = new Context();
  const engine = new MagicCompactionEngine(ctx as never, { auto: false, modelPolicies: [LOCK_POLICY] } as never);
  Object.defineProperty(engine, "ctx", {
    value: Object.assign(Object.create(ctx), {
      llm: { resolveModelInfo: async () => ({ context: { contextWindow: 40_000 }, defaultMaxTokens: 4096 }) },
      logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`WARN ${m}`) },
      tokenMeter: meter,
      get: (name: string) => (name === "magicContextHost" ? host : undefined),
    }),
    configurable: true,
  });
  const events = (from: number): Event[] => {
    const out: Event[] = [];
    for (let s = from; s < session.seq; s += 1) out.push((session as unknown as { eventAt(s: number): Event }).eventAt(s));
    return out;
  };
  const check = async () => {
    const before = session.seq;
    let error: string | undefined;
    let result: unknown;
    try {
      result = await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const appended = events(before);
    return { result, error, appended, compactionEvents: appended.filter((e) => e.type.startsWith("compaction/")) };
  };
  const cleanup = () => { db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { session, agent, sid, db, logs, llmCalls, check, cleanup, meter };
}

describe("R10: MC main backstop over a region that cannot shrink (real rc.5 logs)", () => {
  it("A (41642823892): region = only the previous checkpoint copy, covered → no compaction/start, no error, visible skip diagnostic", async () => {
    const r = await rig("rc5-r10-backstop-checkpoint-only.session.jsonl", "rc5-r10-compartments.json", (c) => c.end <= 7);
    try {
      const out = await r.check();
      // Pre-fix: compaction/start + compaction/end{error:"summary is not smaller … (820 … >= 473)"}.
      expect(out.compactionEvents.map((e) => [e.type, e.data.error ?? null])).toEqual([]);
      expect(out.error).toBeUndefined();
      expect(out.result).toBeNull();
      expect(r.llmCalls).toEqual([]);
      const warn = r.logs.find((l) => l.startsWith("WARN") && /backstop skipped/.test(l));
      expect(warn).toBeDefined();
      expect(warn).toMatch(/would not shrink/);
      expect(warn).toMatch(/38\.6 % ≥ 36 %/);
      const rec = readBackstopSkip(r.db, r.sid);
      expect(rec).not.toBeNull();
      expect(rec!.regionTokens).toBe(473);
      expect(rec!.rawTokens).toBe(0);
      expect(rec!.summaryTokensAtLeast).toBeGreaterThanOrEqual(473);
      expect(rec!.count).toBe(1);
      expect(backstopSkipStatusBlock(rec)).toMatch(/backstop/i);
      expect(backstopSkipStatusBlock(rec)).toMatch(/38\.6/);
      // a second over-backstop check on the same region is still visible (count), still no compaction
      const again = await r.check();
      expect(again.compactionEvents).toEqual([]);
      expect(readBackstopSkip(r.db, r.sid)!.count).toBe(2);
    } finally {
      r.cleanup();
    }
  });

  it("B (41640093586): checkpoint copy whose tail is uncovered → skipped BEFORE the mini-historian (no LLM call, no compaction/end error)", async () => {
    const comps = JSON.parse(readFileSync(join(FIX, "rc5-r10b-compartments.json"), "utf8")) as Comp[];
    const r = await rig("rc5-r10b-backstop-checkpoint-uncovered.session.jsonl", "rc5-r10b-compartments.json", (c) => c.end <= 5, (chunk) => xmlFor(comps.find((c) => c.start === 6)!, chunk));
    try {
      const out = await r.check();
      // Pre-fix: the mini-historian ran over 6-7 and the commit failed "not smaller".
      expect(out.compactionEvents.map((e) => [e.type, e.data.error ?? null])).toEqual([]);
      expect(out.error).toBeUndefined();
      expect(r.llmCalls).toEqual([]);
      expect(getCompartments(r.db, r.sid).map((c) => [c.startMessage, c.endMessage])).toEqual([[1, 5]]);
      expect(r.logs.some((l) => l.startsWith("WARN") && /backstop skipped/.test(l))).toBe(true);
      expect(readBackstopSkip(r.db, r.sid)?.reason).toMatch(/checkpoint/);
    } finally {
      r.cleanup();
    }
  });

  it("the skip never disables the backstop: new history beyond the retained tail → the next check compacts and clears the diagnostic", async () => {
    const comps = JSON.parse(readFileSync(join(FIX, "rc5-r10-compartments.json"), "utf8")) as Comp[];
    const r = await rig("rc5-r10-backstop-checkpoint-only.session.jsonl", "rc5-r10-compartments.json", (c) => c.end <= 7, (chunk) =>
      xmlFor({ start: chunk.startIndex, end: chunk.endIndex, title: "Listed the workspace and read the pressure fixtures", content: comps[3]!.content }, chunk));
    try {
      expect((await r.check()).compactionEvents).toEqual([]);
      expect(readBackstopSkip(r.db, r.sid)).not.toBeNull();
      // A new ~6k-token input arrives: the retained tail (4000) moves past the old nodes.
      r.session.append(
        "user/message",
        createUserMessage({ content: [{ type: "text", text: "new evidence line. ".repeat(1300) }], source: { kind: "user" } }),
        { surfaceOp: "append" },
      );
      const out = await r.check();
      expect(out.error).toBeUndefined();
      const types = out.compactionEvents.map((e) => e.type);
      expect(types).toEqual(["compaction/start", "compaction/summary", "compaction/end"]);
      expect(out.compactionEvents.at(-1)!.data.error).toBeUndefined();
      expect(r.llmCalls.length).toBe(1);
      expect(readBackstopSkip(r.db, r.sid)).toBeNull();
    } finally {
      r.cleanup();
    }
  });
});
