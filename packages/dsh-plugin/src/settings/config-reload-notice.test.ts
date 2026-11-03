import { describe, expect, it } from "bun:test";
import { createLiveSettings } from "../agent/index";
import { createQuietConfigLoader } from "./config-load";

/**
 * Round 20 scan.
 *
 * (1) Deprecated-key warnings repeated every ~3 s: the agent plane's live view
 *     and the settings page re-read magic-context.jsonc on a 3 s TTL, and core
 *     `parsePluginConfig` logs `clear_reasoning_age is deprecated …` on EVERY
 *     parse (its `configWarnings` are rebuilt every time too). A long DSH
 *     session wrote the same line to the Magic log every few seconds.
 * (2) Hot reload silently ignored restart-only sections: `memory`, `dreamer`,
 *     `compaction` (and the other sections bridged once by bridgeMagicConfig)
 *     are read at apply time only; an edit was neither applied nor reported.
 */
describe("quiet config loader (round 20)", () => {
  it("forwards each distinct core log line once per process, not once per reload", () => {
    let forwarder: ((line: string) => void) | null = null;
    const written: string[] = [];
    const load = createQuietConfigLoader({
      load: () => {
        forwarder?.(`[2026-11-03T08:00:0${written.length}.000Z] [magic-context] clear_reasoning_age is deprecated and ignored.\n`);
        forwarder?.(`[2026-11-03T08:00:00.000Z] [magic-context] other line\n`);
        return { configWarnings: ["clear_reasoning_age is deprecated and ignored."] } as never;
      },
      setForwarder: (fn) => {
        forwarder = fn;
      },
      write: (line) => written.push(line),
    });
    for (let i = 0; i < 5; i += 1) load("/x");
    expect(written.length).toBe(2);
    expect(written[0]).toContain("clear_reasoning_age is deprecated");
    // The forwarder is uninstalled after every load.
    expect(forwarder).toBeNull();
  });

  it("still restores the forwarder and rethrows when the load throws", () => {
    let forwarder: ((line: string) => void) | null = null;
    const load = createQuietConfigLoader({
      load: () => {
        throw new Error("boom");
      },
      setForwarder: (fn) => {
        forwarder = fn;
      },
      write: () => {},
    });
    expect(() => load("/x")).toThrow("boom");
    expect(forwarder).toBeNull();
  });
});

describe("createLiveSettings restart-only sections (round 20)", () => {
  it("reports a changed memory/dreamer/compaction section once, and config warnings once", () => {
    let now = 1_000_000;
    let current: Record<string, unknown> = {
      memory: { enabled: true },
      dreamer: { inject_docs: true },
      compaction: { enabled: true },
      configWarnings: ["clear_reasoning_age is deprecated and ignored."],
    };
    const warnings: string[] = [];
    const live = createLiveSettings({ overrides: () => ({}) } as never, "/x", {
      now: () => now,
      load: () => current as never,
      warn: (m) => warnings.push(m),
    });
    live.effective();
    // The startup config's own warnings are reported once.
    expect(warnings.filter((w) => w.includes("clear_reasoning_age")).length).toBe(1);
    for (let i = 0; i < 4; i += 1) {
      now += 10_000;
      live.effective();
    }
    expect(warnings.filter((w) => w.includes("clear_reasoning_age")).length).toBe(1);
    expect(warnings.filter((w) => w.includes("restart")).length).toBe(0);

    current = { ...current, memory: { enabled: false }, dreamer: { inject_docs: false } };
    for (let i = 0; i < 3; i += 1) {
      now += 10_000;
      live.effective();
    }
    const restart = warnings.filter((w) => w.includes("restart"));
    expect(restart.length).toBe(1);
    expect(restart[0]).toContain("memory");
    expect(restart[0]).toContain("dreamer");
    expect(restart[0]).not.toContain("compaction");

    // A further change of the same section is reported again; reverting is silent.
    current = { ...current, compaction: { enabled: false } };
    now += 10_000;
    live.effective();
    expect(warnings.filter((w) => w.includes("restart")).length).toBe(2);
    current = { ...current, memory: { enabled: true }, dreamer: { inject_docs: true }, compaction: { enabled: true } };
    now += 10_000;
    live.effective();
    expect(warnings.filter((w) => w.includes("restart")).length).toBe(2);
  });

  it("live keys (execute_threshold_percentage, enabled) do not trigger the restart notice", () => {
    let now = 1_000_000;
    let current: Record<string, unknown> = { execute_threshold_percentage: 70 };
    const warnings: string[] = [];
    const live = createLiveSettings({ overrides: () => ({}) } as never, "/x", {
      now: () => now,
      load: () => current as never,
      warn: (m) => warnings.push(m),
    });
    live.effective();
    current = { execute_threshold_percentage: 80, enabled: false };
    now += 10_000;
    expect(live.effective().executeThreshold.value).toBe(80);
    expect(warnings).toEqual([]);
  });
});

/**
 * Round 21: the settings page showed a jsonc edit to `historian.model` /
 * `protected_tokens` as the effective value at once, while the agent kept the
 * startup value until restart. Both are read per call/step by the runtime, so
 * they now hot-apply; every other restart-only section is surfaced as
 * "running value + pending restart: new value" (settings page + /ctx-status).
 */
describe("hot-applied jsonc keys + pending-restart view (round 21)", () => {
  it("pendingRestartChanges lists restart-only sections with running and new values", async () => {
    const { pendingRestartChanges } = await import("./config-load");
    const running = { memory: { enabled: true }, dreamer: { inject_docs: true }, history_budget_percentage: 0.15 };
    const current = { memory: { enabled: false }, dreamer: { inject_docs: true }, history_budget_percentage: 0.2 };
    const out = pendingRestartChanges(running as never, current as never);
    expect(out.map((c) => c.key)).toEqual(["memory", "history_budget_percentage"]);
    expect(out[0]).toEqual({ key: "memory", running: { enabled: true }, next: { enabled: false } });
    expect(out[1]).toEqual({ key: "history_budget_percentage", running: 0.15, next: 0.2 });
    expect(pendingRestartChanges(undefined, current as never)).toEqual([]);
  });

  it("historian.model and protected_tokens are hot (no pending-restart entry, no restart notice)", async () => {
    const { pendingRestartChanges } = await import("./config-load");
    const running = { historian: { model: "a/b", timeout_ms: 1 }, protected_tokens: 20_000 };
    const hot = { historian: { model: "c/d", timeout_ms: 1 }, protected_tokens: 30_000 };
    expect(pendingRestartChanges(running as never, hot as never)).toEqual([]);
    const opencodeHot = { historian: { opencode: { model: "c/d" }, timeout_ms: 1 }, protected_tokens: 20_000 };
    expect(
      pendingRestartChanges({ historian: { opencode: { model: "a/b" }, timeout_ms: 1 }, protected_tokens: 20_000 } as never, opencodeHot as never),
    ).toEqual([]);
    // Another historian key still needs a restart.
    const cold = { historian: { model: "a/b", timeout_ms: 2 }, protected_tokens: 20_000 };
    expect(pendingRestartChanges(running as never, cold as never).map((c) => c.key)).toEqual(["historian"]);

    let now = 1_000_000;
    let current: Record<string, unknown> = running;
    const warnings: string[] = [];
    const live = createLiveSettings({ overrides: () => ({}) } as never, "/x", {
      now: () => now,
      load: () => current as never,
      warn: (m) => warnings.push(m),
    });
    current = hot;
    now += 10_000;
    live.effective();
    expect(warnings.filter((w) => w.includes("restart"))).toEqual([]);
    expect(live.pendingRestart()).toEqual([]);
    current = cold;
    now += 10_000;
    live.effective();
    expect(live.pendingRestart().map((c) => c.key)).toEqual(["historian"]);
  });

  it("runtime getters read historian.model / protected_tokens from the live jsonc (DSH override and explicit row win)", async () => {
    const { createHotConfigGetters } = await import("../agent/index");
    let now = 1_000_000;
    let current: Record<string, unknown> = { historian: { model: "a/b" }, protected_tokens: 20_000 };
    let overrides: Record<string, unknown> = {};
    const live = createLiveSettings({ overrides: () => overrides } as never, "/x", {
      now: () => now,
      load: () => current as never,
    });
    const hot = createHotConfigGetters(live, {});
    expect(hot.historianModel()).toBe("a/b");
    expect(hot.protectedTokens()).toBe(20_000);
    current = { historian: { opencode: { model: "c/d" } }, protected_tokens: 30_000 };
    now += 10_000;
    expect(hot.historianModel()).toBe("c/d");
    expect(hot.protectedTokens()).toBe(30_000);
    overrides = { historianModel: "x/y", protectedTokens: 40_000 };
    expect(hot.historianModel()).toBe("x/y");
    expect(hot.protectedTokens()).toBe(40_000);
    const explicit = createHotConfigGetters(live, { historianModel: "row/m", protectedTokens: 50_000 });
    overrides = {};
    expect(explicit.historianModel()).toBe("row/m");
    expect(explicit.protectedTokens()).toBe(50_000);
  });
});
