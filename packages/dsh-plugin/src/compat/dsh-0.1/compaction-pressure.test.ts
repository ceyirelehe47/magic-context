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
        source: { kind: "model" },
      }),
    },
    { surfaceOp: "append" },
  );
}

interface Rig {
  /** true when compaction-basic decided the session is over its pressure threshold. */
  fired: boolean;
  compactRegionCalls: number;
}

async function probe(opts: {
  window: number;
  maxTokens: number;
  pct: number;
  child?: boolean;
  config?: Record<string, unknown>;
  /** host pressure hook: undefined = no hook registered; function = registered. */
  hook?: (agent: unknown, window: number) => number | undefined;
}): Promise<Rig> {
  const rig: Rig = { fired: false, compactRegionCalls: 0 };
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
  };
  const ctx = new Context();
  const engine = new MagicCompactionEngine(ctx as never, { auto: false, ...(opts.config ?? {}) } as never);
  Object.defineProperty(engine, "ctx", {
    value: Object.assign(Object.create(ctx), {
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: opts.window }, defaultMaxTokens: opts.maxTokens }),
      },
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
                },
              }
            : undefined,
    }),
    configurable: true,
  });
  (engine as unknown as { compactRegion: () => Promise<unknown> }).compactRegion = async () => {
    rig.compactRegionCalls += 1;
    total = 0;
    return { shadowedSeqs: [], shadowedRange: { start: 0, end: 0 }, shadowedTokenCount: 0 };
  };
  const agent = { id: "s", session, options: { provider: "p", model: "m" } } as unknown as Agent;
  await engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
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
    const p = effectivePressurePolicy({ auto: true } as never);
    expect(p.main).toEqual({ thresholdRatio: 0.9, headroomTokens: 0, source: "magic" });
    expect(thresholdPercent(131_072, 8_192, p.main)).toBe(90);
    expect(thresholdPercent(24_576, 2_048, p.main)).toBe(90);
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
