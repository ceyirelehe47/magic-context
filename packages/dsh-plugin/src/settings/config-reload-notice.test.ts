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
