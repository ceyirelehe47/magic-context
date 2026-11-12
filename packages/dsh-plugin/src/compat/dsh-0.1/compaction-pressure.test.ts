import { describe, expect, it } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { MagicCompactionEngine } from "./compaction";
import { createAssistantMessage, createUserMessage } from "./session";

// Round 19: compaction-basic's pressure threshold is
//   min(window × thresholdRatio(0.8), window − maxTokens − headroomTokens(65 536))
// so (a) a ≤ ~70k window throws TargetPressureConfigError (pressure compaction
// never fires) and (b) a 128k MC main session is natively compacted at ≈ 44 %,
// long before MC's own 65 % execute threshold — MC's historian/drops never get
// to work. MC-managed main sessions must let MC lead (native pressure is only
// a backstop at MC's force-materialization band); child sessions keep the
// native policy but get a legal threshold on small windows; explicit user
// values win.

/**
 * Round 37 seg 12: the S9 fix exports (A: available-window lines; C: doctor
 * view). Typed locally so this file also type-checks on the pre-fix tree (RED).
 */
interface S9PolicyApi {
  magicPressureLines(
    contextWindow: number,
    outputReserveTokens: number,
  ): { available: number; execute: number; force: number; backstop: number | null };
  magicPressurePercent(tokens: number, contextWindow: number, outputReserveTokens: number): number;
  backstopPreemptsForceBand(contextWindow: number, outputReserveTokens: number, policy: { thresholdRatio: number; headroomTokens: number }): boolean;
  thresholdPercentOfWindow(contextWindow: number, maxTokens: number, policy: { thresholdRatio: number; headroomTokens: number }): number | null;
  describePressurePolicy(row: Record<string, unknown>): { text: string; preemptsMagic: boolean; backstopFirst: string[] };
}
const s9Api = async () => (await import("./pressure-policy")) as unknown as S9PolicyApi;

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
        provider: "p",
        model: "m",
        source: { kind: "model" } as never,
      } as never),
    } as never,
    { surfaceOp: "append" },
  );
}

interface Rig {
  /** true when compaction-basic decided the session is over its pressure threshold. */
  fired: boolean;
  compactRegionCalls: number;
  result: unknown;
}

async function probe(opts: {
  window: number;
  maxTokens: number;
  pct: number;
  child?: boolean;
  config?: Record<string, unknown>;
  /** host pressure hook: undefined = no hook registered; function = registered. */
  hook?: (agent: unknown, window: number) => number | undefined;
  /** host historian-busy probe (round 21): undefined = not registered. */
  busy?: (agent: unknown) => boolean;
  logs?: string[];
  /** Round 22: further pressure checks on the SAME engine/session (pct per check). */
  thenPcts?: number[];
  /** Round 22: results of every check, in order (the first is `result`). */
  results?: Array<{ result: unknown; fired: boolean }>;
  /** Round 23: pressure left after each committed compaction (default 0). */
  afterCompactPct?: number;
  /** Round 23: compactRegion calls after this many throw like compaction-basic's shrink guard. */
  regionThrowsAfter?: number;
  /** Round 23: an error thrown by compactIfNeeded is captured here instead of rejecting. */
  errors?: string[];
  /** Round 36 line I (S6): pressure left after compaction-basic's tool-result pruner runs (default: unchanged). */
  pruneToPct?: number;
}): Promise<Rig> {
  const rig: Rig = { fired: false, compactRegionCalls: 0, result: undefined };
  const header = {
    id: SessionId("s"),
    version: 4,
    createdAt: Date.now(),
    isSeeded: false,
    ...(opts.child ? { origin: "subagent", delegationDepth: 1 } : {}),
  };
  const session = Session.create(SessionId("s"), undefined, header as never);
  for (let t = 1; t <= 3; t += 1) appendTurn(session, t);
  (session as unknown as { requestHeader: () => unknown }).requestHeader = () => ({
    config: { provider: "p", model: "m", maxTokens: opts.maxTokens },
  });
  let total = Math.floor(opts.window * opts.pct);
  const host = {
    summarizeHook: () => undefined,
    ...(opts.hook ? { nativePressurePercentage: opts.hook } : {}),
    ...(opts.busy ? { historianBusy: opts.busy } : {}),
  };
  const ctx = new Context();
  const engine = new MagicCompactionEngine(ctx as never, { auto: false, ...(opts.config ?? {}) } as never);
  Object.defineProperty(engine, "ctx", {
    value: Object.assign(Object.create(ctx), {
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: opts.window }, defaultMaxTokens: opts.maxTokens }),
      },
      logger: { info: (m: string) => opts.logs?.push(m), warn: (m: string) => opts.logs?.push(`WARN ${m}`) },
      tokenMeter: {
        measure: () => ({
          totalTokens: total,
          nodes: session.surface.nodes.map((seq) => ({ seq, tokens: Math.ceil(total / session.surface.nodes.length) })),
        }),
      },
      get: (name: string) =>
        name === "magicContextHost"
          ? host
          : name === "toolResultPruner"
            ? {
                pruneSession: () => {
                  rig.fired = true;
                  if (opts.pruneToPct !== undefined) total = Math.floor(opts.window * opts.pruneToPct);
                },
              }
            : undefined,
    }),
    configurable: true,
  });
  (engine as unknown as { compactRegion: () => Promise<unknown> }).compactRegion = async () => {
    rig.compactRegionCalls += 1;
    if (opts.regionThrowsAfter !== undefined && rig.compactRegionCalls > opts.regionThrowsAfter) {
      throw new Error("summary is not smaller than the shadowed content (626 estimated framed tokens >= 626)");
    }
    total = Math.floor(opts.window * (opts.afterCompactPct ?? 0));
    return { shadowedSeqs: [], shadowedRange: { start: 0, end: 0 }, shadowedTokenCount: 0 };
  };
  const agent = { id: "s", session, options: { provider: "p", model: "m" } } as unknown as Agent;
  try {
    rig.result = await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
  } catch (error) {
    if (opts.errors === undefined) throw error;
    opts.errors.push(error instanceof Error ? error.message : String(error));
    rig.result = undefined;
  }
  opts.results?.push({ result: rig.result, fired: rig.fired });
  for (const pct of opts.thenPcts ?? []) {
    total = Math.floor(opts.window * pct);
    rig.fired = false;
    const result = await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
    opts.results?.push({ result, fired: rig.fired });
  }
  return rig;
}

describe("native pressure threshold: MC leads on main sessions (round 19)", () => {
  it("128k main session at 50 % does NOT trigger native pressure compaction (DSH default fires at ≈ 44 %)", async () => {
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.5 })).fired).toBe(false);
    expect((await probe({ window: 128_000, maxTokens: 4_096, pct: 0.5 })).fired).toBe(false);
  });

  it("128k main session: still quiet at MC's 65 % / 80 % / 85 % force band, native backstop fires at 90 %", async () => {
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.66 })).fired).toBe(false);
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.8 })).fired).toBe(false);
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.86 })).fired).toBe(false);
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.89 })).fired).toBe(false);
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.91 })).fired).toBe(true);
  });

  it("the agent plane's per-route force percentage drives the backstop", async () => {
    const hook = () => 90;
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.88, hook })).fired).toBe(false);
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.91, hook })).fired).toBe(true);
  });

  it("MC not managing the session (hook says undefined, e.g. live-disabled preset): DSH native defaults", async () => {
    const hook = () => undefined;
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.5, hook })).fired).toBe(true);
  });

  for (const window of [24_576, 40_960]) {
    it(`small main window ${window}: no TargetPressureConfigError, legal threshold`, async () => {
      expect((await probe({ window, maxTokens: 2_048, pct: 0.5 })).fired).toBe(false);
      expect((await probe({ window, maxTokens: 2_048, pct: 0.92 })).fired).toBe(true);
    });

    it(`small child window ${window}: no TargetPressureConfigError, native 0.8 ratio`, async () => {
      expect((await probe({ window, maxTokens: 2_048, pct: 0.5, child: true })).fired).toBe(false);
      expect((await probe({ window, maxTokens: 2_048, pct: 0.81, child: true })).fired).toBe(true);
    });
  }

  it("80k child window (real rc.5 run 41589483637): default retention >= shrunken threshold no longer throws", async () => {
    // DSH default: threshold min(64000, 80000-4096-65536=10368), retain 0.16×75904=12144 ≥ 10368 → error.
    expect((await probe({ window: 80_000, maxTokens: 4_096, pct: 0.5, child: true })).fired).toBe(false);
    expect((await probe({ window: 80_000, maxTokens: 4_096, pct: 0.81, child: true })).fired).toBe(true);
    // An explicit user retention keeps its own error.
    await expect(
      probe({ window: 80_000, maxTokens: 4_096, pct: 0.81, child: true, config: { retainTokens: 70_000 } }),
    ).rejects.toThrow(/retainTokens/);
  });

  it("128k child session keeps the round 16 native policy (DSH default ≈ 44 %)", async () => {
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.5, child: true })).fired).toBe(true);
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.4, child: true })).fired).toBe(false);
  });

  it("explicit user headroomTokens / thresholdRatio are respected on main sessions", async () => {
    const config = { headroomTokens: 65_536, thresholdRatio: 0.8 };
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.5, config })).fired).toBe(true);
    const ratioOnly = { thresholdRatio: 0.6 };
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.62, config: ratioOnly })).fired).toBe(true);
    expect((await probe({ window: 131_072, maxTokens: 8_192, pct: 0.58, config: ratioOnly })).fired).toBe(false);
  });

  it("an explicit per-route modelPolicies entry is respected (and stays legal for a small child route)", async () => {
    const config = {
      modelPolicies: [{ provider: "p", model: "m", headroomTokens: 0, thresholdRatio: 0.7, retainTokens: 3_000, maxTokens: 2_048 }],
    };
    expect((await probe({ window: 24_576, maxTokens: 2_048, pct: 0.71, child: true, config })).fired).toBe(true);
    expect((await probe({ window: 24_576, maxTokens: 2_048, pct: 0.71, config })).fired).toBe(true);
  });

  it("an explicit user headroom that leaves no budget still surfaces the DSH config error (not silently overridden)", async () => {
    await expect(
      probe({ window: 24_576, maxTokens: 2_048, pct: 0.9, child: true, config: { headroomTokens: 65_536 } }),
    ).rejects.toThrow(/no pressure budget/);
  });
});

describe("pressure-policy view for setup/doctor (round 19)", () => {
  it("default magic-compaction row: main MC-led (90 % on 128k, legal on 24k/40k), child DSH native with small-window fallback", async () => {
    const { describePressurePolicy, effectivePressurePolicy, thresholdPercent } = await import("./pressure-policy");
    const { thresholdPercentOfWindow } = await s9Api();
    const p = effectivePressurePolicy({ auto: true } as never);
    expect(p.main).toEqual({ thresholdRatio: 0.9, headroomTokens: 0, source: "magic" });
    // Round 37 seg 12 (S9 fix A): an MC main policy is reported as a percent of
    // the AVAILABLE window (window − maxTokens), MC's own unit — the same
    // 90 %-of-window backstop (117 964 / 22 118 tokens) is 96 % / 98.2 % of it.
    expect(thresholdPercentOfWindow(131_072, 8_192, p.main)).toBe(90);
    expect(thresholdPercentOfWindow(24_576, 2_048, p.main)).toBe(90);
    expect(thresholdPercent(131_072, 8_192, p.main)).toBe(96);
    expect(thresholdPercent(24_576, 2_048, p.main)).toBe(98.2);
    // DSH default on 128k: 131072 − 8192 − 65536 = 57344 → 43.8 %
    expect(thresholdPercent(131_072, 8_192, p.child)).toBe(43.8);
    expect(thresholdPercent(24_576, 2_048, p.child)).toBeNull();
    expect(thresholdPercent(24_576, 2_048, p.child, true)).toBe(80);
    // 80k: DSH default is illegal (retain 12144 >= threshold 10368); fallback → 80 %
    expect(thresholdPercent(80_000, 4_096, p.child)).toBeNull();
    expect(thresholdPercent(80_000, 4_096, p.child, true)).toBe(80);
    // 100k: DSH default legal at 30.4 %
    expect(thresholdPercent(100_000, 4_096, p.child)).toBe(30.4);
    const d = describePressurePolicy({});
    expect(d.preemptsMagic).toBe(false);
    expect(d.text).toContain("128k 90%");
  });

  it("user-set headroom 65536 is flagged as pre-empting MC", async () => {
    const { describePressurePolicy } = await import("./pressure-policy");
    const d = describePressurePolicy({ headroomTokens: 65_536 });
    expect(d.preemptsMagic).toBe(true);
    expect(d.text).toContain("user-set");
  });
});

describe("nativeBackstopPercentage (user decision 2026-11-03: native at 90 %)", () => {
  it("is 90 at MC's default force band, stays 5 above a higher band, caps at 98", async () => {
    const { nativeBackstopPercentage } = await import("./pressure-policy");
    expect(nativeBackstopPercentage(85)).toBe(90);
    expect(nativeBackstopPercentage(80)).toBe(90);
    expect(nativeBackstopPercentage(88)).toBe(93);
    expect(nativeBackstopPercentage(97)).toBe(98);
  });
});

// Round 36 line I, S9 — FIXED in round 37 seg 12 (user decision "A+C",
// 2026-11-07, test change confirmed 2026-11-12 20:29 CST). compaction-basic
// caps pressure at window − maxTokens − headroom; the MC main backstop sets
// headroom 0 and ratio 0.9, so on a 1M route with request maxTokens 384 000
// the backstop is min(900 000, 616 000) = 616 000. MC used to price its 65 % /
// 85 % lines against the WHOLE window (650 000 / 850 000), so the backstop
// pre-empted the historian. Fix A: MC prices against the available window
// (window − maxTokens = 616 000): execute 400 400, force 523 600, backstop
// 616 000 = 100 % of available. The RED (738e3312a, round 36) asserted
// "no native compaction at 62 % / 64 % of the whole window": those numbers
// encoded the OLD pricing (MC executing at 65 % of the whole window). Under
// the new pricing the same invariant — the native backstop never fires before
// MC's own lines — is stated directly: below MC's force band the backstop does
// not fire, execute < force < backstop (exact values), and MC's own pressure
// reading reaches its force band before the backstop's input. The 200k / 32k
// evo route gets the same assertions.
describe("S9: native backstop vs MC execute threshold on a 1M / 384k route (round 36 line I; fixed round 37 seg 12)", () => {
  it("1M window, route maxTokens 384 000: execute ≈ 400k < force ≈ 524k < backstop 616k; no native compaction below the force band", async () => {
    const { magicPressureLines, magicPressurePercent } = await s9Api();
    const lines = magicPressureLines(1_000_000, 384_000);
    expect(lines).toEqual({ available: 616_000, execute: 400_400, force: 523_600, backstop: 616_000 });
    expect(lines.execute).toBeLessThan(lines.force);
    expect(lines.force).toBeLessThan(lines.backstop!);
    // MC's own reading (the one the historian trigger / drop ride / pressure
    // truncation use) is at its lines at those token counts.
    expect(magicPressurePercent(lines.execute, 1_000_000, 384_000)).toBeCloseTo(65, 2);
    expect(magicPressurePercent(lines.force, 1_000_000, 384_000)).toBeCloseTo(85, 2);
    // below MC's force band (and at MC's execute line) the native backstop does not fire
    expect((await probe({ window: 1_000_000, maxTokens: 384_000, pct: 0.4004 })).fired).toBe(false);
    expect((await probe({ window: 1_000_000, maxTokens: 384_000, pct: 0.5235 })).fired).toBe(false);
    // between force and backstop: still MC's (its force path), not native
    expect((await probe({ window: 1_000_000, maxTokens: 384_000, pct: 0.6155 })).fired).toBe(false);
    // the backstop is still there, above MC's lines
    expect((await probe({ window: 1_000_000, maxTokens: 384_000, pct: 0.617 })).fired).toBe(true);
  });

  it("200k window, route maxTokens 32 768 (evo route): execute < force < backstop; no native compaction below the force band", async () => {
    const { magicPressureLines, magicPressurePercent } = await s9Api();
    const lines = magicPressureLines(200_000, 32_768);
    expect(lines).toEqual({ available: 167_232, execute: 108_700, force: 142_147, backstop: 167_232 });
    expect(lines.execute).toBeLessThan(lines.force);
    expect(lines.force).toBeLessThan(lines.backstop!);
    expect(magicPressurePercent(lines.force, 200_000, 32_768)).toBeCloseTo(85, 2);
    expect((await probe({ window: 200_000, maxTokens: 32_768, pct: 0.5435 })).fired).toBe(false);
    expect((await probe({ window: 200_000, maxTokens: 32_768, pct: 0.7107 })).fired).toBe(false);
    expect((await probe({ window: 200_000, maxTokens: 32_768, pct: 0.836 })).fired).toBe(false);
    expect((await probe({ window: 200_000, maxTokens: 32_768, pct: 0.837 })).fired).toBe(true);
  });

  it("pressure-policy view: the MC main threshold on 1M / 384k is not below the execute threshold", async () => {
    const { effectivePressurePolicy, thresholdPercent } = await import("./pressure-policy");
    const main = effectivePressurePolicy({ auto: true } as never).main;
    expect(thresholdPercent(1_000_000, 384_000, main)).toBeGreaterThanOrEqual(65);
  });

  it("control: the same route with maxTokens 32 768 keeps the 90 % backstop (cap 967 232 not reached)", async () => {
    expect((await probe({ window: 1_000_000, maxTokens: 32_768, pct: 0.64 })).fired).toBe(false);
    expect((await probe({ window: 1_000_000, maxTokens: 32_768, pct: 0.91 })).fired).toBe(true);
  });

  it("doctor view (fix C): the default row never puts the backstop at or below MC's force band; a user headroom that does is flagged", async () => {
    const { describePressurePolicy, backstopPreemptsForceBand } = await s9Api();
    expect(describePressurePolicy({}).backstopFirst).toEqual([]);
    expect(backstopPreemptsForceBand(1_000_000, 384_000, { thresholdRatio: 0.9, headroomTokens: 0 })).toBe(false);
    // user headroom 65 536 on a 1M / 384k route: backstop 550 464 > force 523 600 → not flagged …
    expect(backstopPreemptsForceBand(1_000_000, 384_000, { thresholdRatio: 0.9, headroomTokens: 65_536 })).toBe(false);
    // … ratio 0.5: backstop 500 000 ≤ force 523 600 → flagged
    expect(backstopPreemptsForceBand(1_000_000, 384_000, { thresholdRatio: 0.5, headroomTokens: 0 })).toBe(true);
    const flagged = describePressurePolicy({ headroomTokens: 65_536 });
    expect(flagged.backstopFirst).toContain("128k");
    expect(flagged.text).toContain("Backstop at or below MC's force band");
  });
});

// Round 21: a background historian pass holds the compartment lease; the 90 %
// backstop's summarize would hit "lease busy" and close compaction/end with an
// ERROR. The backstop must skip quietly (no error, accurate status) and the
// next pressure check must retry.
describe("native pressure backstop while a historian pass runs (round 21)", () => {
  it("over the backstop with the historian busy: skips without error, logs a deferral, no compaction", async () => {
    const logs: string[] = [];
    const rig = await probe({ window: 131_072, maxTokens: 8_192, pct: 0.91, busy: () => true, logs });
    expect(rig.fired).toBe(false);
    expect(rig.compactRegionCalls).toBe(0);
    expect(rig.result).toBeNull();
    expect(logs.some((l) => /native pressure backstop deferred/.test(l) && /historian/.test(l))).toBe(true);
    expect(logs.some((l) => l.startsWith("WARN") || /error/i.test(l))).toBe(false);
  });

  it("the next pressure check (historian idle again) retries and fires", async () => {
    let busy = true;
    const first = await probe({ window: 131_072, maxTokens: 8_192, pct: 0.91, busy: () => busy });
    expect(first.fired).toBe(false);
    busy = false;
    const second = await probe({ window: 131_072, maxTokens: 8_192, pct: 0.91, busy: () => busy });
    expect(second.fired).toBe(true);
  });

  // Round 22 (real rc.5, scenario L run 41619627652): with the session above
  // MC's threshold the historian re-fires as soon as a pass publishes, so the
  // lease is held almost continuously and the backstop deferred on EVERY step
  // while the context climbed 36.9 % → 68.9 % (backstop 36 %). One deferral
  // per episode: the next over-backstop check compacts even though the pass
  // still runs (the summarize hook waits ≤ 45 s for its lease, then usually
  // renders what the pass covered).
  it("the deferral is bounded: the next over-backstop check compacts although the historian is still busy", async () => {
    const logs: string[] = [];
    const results: Array<{ result: unknown; fired: boolean }> = [];
    await probe({ window: 131_072, maxTokens: 8_192, pct: 0.91, busy: () => true, logs, thenPcts: [0.93], results });
    expect(results[0]!.fired).toBe(false);
    expect(results[0]!.result).toBeNull();
    expect(results[1]!.fired).toBe(true);
    expect(logs.filter((l) => /native pressure backstop deferred/.test(l))).toHaveLength(1);
    expect(logs.some((l) => /already deferred once/.test(l))).toBe(true);
  });

  // Round 36 line I, S6 (200k stress evo bench 42238241963, native turn 6: 7×
  // "already deferred once … compacting now", every one followed by
  // outcome=none). The line was printed BEFORE compaction-basic ran; its own
  // check prunes tool results first, re-measures, and returns null when the
  // prune alone brought the session under the threshold — nothing was
  // compacted although the log said so. The line must report what happened.
  it("S6: the second over-backstop check logs the real outcome when compaction-basic's prune leaves nothing to compact", async () => {
    const logs: string[] = [];
    const results: Array<{ result: unknown; fired: boolean }> = [];
    const rig = await probe({ window: 131_072, maxTokens: 8_192, pct: 0.91, busy: () => true, logs, thenPcts: [0.93], results, pruneToPct: 0.5 });
    expect(results[1]!.fired).toBe(true); // compaction-basic ran its pruner
    expect(results[1]!.result).toBeNull();
    expect(rig.compactRegionCalls).toBe(0);
    const line = logs.find((l) => /already deferred once/.test(l));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/compacting now/);
    expect(line).toMatch(/nothing compacted/);
  });

  it("S6: when the second check does compact, the line says so", async () => {
    const logs: string[] = [];
    await probe({ window: 131_072, maxTokens: 8_192, pct: 0.91, busy: () => true, logs, thenPcts: [0.93] });
    const line = logs.find((l) => /already deferred once/.test(l));
    expect(line).toMatch(/compacted/);
    expect(line).not.toMatch(/nothing compacted/);
  });

  it("a new episode (pressure back under the backstop in between) may defer again", async () => {
    const logs: string[] = [];
    const results: Array<{ result: unknown; fired: boolean }> = [];
    await probe({ window: 131_072, maxTokens: 8_192, pct: 0.91, busy: () => true, logs, thenPcts: [0.5, 0.92], results });
    expect(results.map((r) => r.fired)).toEqual([false, false, false]);
    expect(logs.filter((l) => /native pressure backstop deferred/.test(l))).toHaveLength(2);
  });

  it("below the backstop with the historian busy: no deferral line (status stays 'nothing to do')", async () => {
    const logs: string[] = [];
    const rig = await probe({ window: 131_072, maxTokens: 8_192, pct: 0.5, busy: () => true, logs });
    expect(rig.fired).toBe(false);
    expect(logs.some((l) => /deferred/.test(l))).toBe(false);
  });

  it("child sessions ignore the probe (stock summarizer, no MC lease)", async () => {
    const rig = await probe({ window: 131_072, maxTokens: 8_192, pct: 0.91, child: true, busy: () => true });
    expect(rig.fired).toBe(true);
  });

  it("a throwing probe never blocks the backstop", async () => {
    const rig = await probe({
      window: 131_072,
      maxTokens: 8_192,
      pct: 0.91,
      busy: () => {
        throw new Error("db closed");
      },
    });
    expect(rig.fired).toBe(true);
  });
});

// Round 21 — diagnostics (e2e evidence lines, MAGIC_CONTEXT_DEBUG_HISTORIAN=1).
// P7: the effective threshold was kept on the shared engine instance, so two
//     sessions checking pressure concurrently printed each other's
//     thresholdPct. P8: the first pressure check of a session (no
//     request/context header yet) printed pct=?.
describe("native pressure diagnostics (round 21: P7 race, P8 first-step pct)", () => {
  function rig(sessions: Array<{ id: string; window: number; delayMs: number; header: boolean; pct: number }>) {
    const ctx = new Context();
    const engine = new MagicCompactionEngine(ctx as never, { auto: false } as never);
    const byModel = new Map(sessions.map((s) => [`m-${s.id}`, s]));
    const agents = sessions.map((s) => {
      const session = Session.create(SessionId(s.id));
      for (let t = 1; t <= 2; t += 1) appendTurn(session, t);
      if (s.header) {
        (session as unknown as { requestHeader: () => unknown }).requestHeader = () => ({
          config: { provider: "p", model: `m-${s.id}`, maxTokens: 8_192 },
        });
      }
      return { id: s.id, session, options: { provider: "p", model: `m-${s.id}`, maxTokens: 8_192 } } as unknown as Agent;
    });
    Object.defineProperty(engine, "ctx", {
      value: Object.assign(Object.create(ctx), {
        llm: {
          resolveModelInfo: async (_p: string, model: string) => {
            const s = byModel.get(model)!;
            await new Promise((resolve) => setTimeout(resolve, s.delayMs));
            return { context: { contextWindow: s.window }, defaultMaxTokens: 8_192 };
          },
        },
        tokenMeter: {
          measure: (session: Session) => {
            const s = sessions.find((x) => x.id === String(session.id))!;
            return { totalTokens: Math.floor(s.window * s.pct), nodes: [] };
          },
        },
        get: (name: string) => (name === "magicContextHost" ? { summarizeHook: () => undefined } : undefined),
      }),
      configurable: true,
    });
    return { engine, agents };
  }

  async function captureLines(fn: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    const env = process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN;
    process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN = "1";
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await fn();
    } finally {
      console.error = original;
      if (env === undefined) delete process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN;
      else process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN = env;
    }
    return lines.filter((l) => l.includes("native pressure check"));
  }

  it("P7: concurrent checks on one engine each print their own thresholdPct", async () => {
    // 1M window → backstop 90 % of window; 32k window (small) → a different % (max-tokens bound).
    const { engine, agents } = rig([
      { id: "big", window: 1_000_000, delayMs: 20, header: true, pct: 0.1 },
      { id: "small", window: 32_768, delayMs: 30, header: true, pct: 0.1 },
    ]);
    const lines = await captureLines(() =>
      Promise.all(agents.map((a) => engine.compactIfNeeded(a, "pressure", new AbortController().signal))),
    );
    expect(lines).toHaveLength(2);
    const big = lines.find((l) => l.includes("window=1000000"))!;
    const small = lines.find((l) => l.includes("window=32768"))!;
    const pctOf = (l: string) => Number(/thresholdPct=([\d.]+)/.exec(l)?.[1]);
    // Each line is priced from its own session: the threshold % recomputed
    // from that line's window must match (different windows → different %).
    expect(Number.isFinite(pctOf(big))).toBe(true);
    expect(Number.isFinite(pctOf(small))).toBe(true);
    expect(pctOf(big)).toBe(90);
    expect(pctOf(small)).toBeLessThan(90);
  });

  it("P8: the first check (no request header yet) still prints pct from the agent's route", async () => {
    const { engine, agents } = rig([{ id: "fresh", window: 131_072, delayMs: 0, header: false, pct: 0.42 }]);
    const lines = await captureLines(() => engine.compactIfNeeded(agents[0]!, "pressure", new AbortController().signal));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("pct=42");
    expect(lines[0]).toContain("window=131072");
    expect(lines[0]).not.toContain("thresholdPct=?");
  });
});

// Round 23 (real rc.5, e2e run 41625463298, scenario L lock-a): compaction-basic
// retries a pressure compaction while the session is still above the threshold.
// For an MC main session the retry's region is the checkpoint the first attempt
// just wrote; Magic renders the same compartments for it (history ordinals are
// stable since round 23), so compaction-basic rejected every retry ("summary is
// not smaller than the shadowed content (626 … >= 626)") and the whole pressure
// check failed although the first compaction had committed — 6 of 7 backstop
// compactions in that run. The backstop now compacts ONCE per check on MC main
// sessions; what stays above it is the retained tail / already-summarized
// history, which MC's own pipeline handles, and the next check retries.
describe("MC main backstop compacts once per pressure check (round 23)", () => {
  it("still above the backstop after a committed compaction: no retry over the fresh checkpoint, no error, the committed result returns", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const rig = await probe({ window: 40_000, maxTokens: 4_096, pct: 0.95, afterCompactPct: 0.93, regionThrowsAfter: 1, hook: () => 90, logs, errors });
    expect(errors).toEqual([]);
    expect(rig.compactRegionCalls).toBe(1);
    expect(rig.result).not.toBeNull();
    expect(rig.result).toBeDefined();
    expect(logs.some((l) => /compacted once/.test(l) && /still above/.test(l))).toBe(true);
  });

  it("a user-set compactionRetries keeps compaction-basic's retry (and its error) on main sessions", async () => {
    const errors: string[] = [];
    const rig = await probe({
      window: 40_000,
      maxTokens: 4_096,
      pct: 0.95,
      afterCompactPct: 0.93,
      regionThrowsAfter: 1,
      config: { compactionRetries: 1 },
      hook: () => 90,
      errors,
    });
    expect(rig.compactRegionCalls).toBe(2);
    expect(errors.some((e) => /not smaller/.test(e))).toBe(true);
  });

  it("child sessions keep the native retry policy", async () => {
    const errors: string[] = [];
    const rig = await probe({ window: 40_000, maxTokens: 4_096, pct: 0.95, child: true, afterCompactPct: 0.93, regionThrowsAfter: 1, hook: () => 90, errors });
    expect(rig.compactRegionCalls).toBe(2);
    expect(errors.some((e) => /not smaller/.test(e))).toBe(true);
  });
});
