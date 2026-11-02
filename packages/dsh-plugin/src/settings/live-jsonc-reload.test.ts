import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveSettings } from "../agent/index";

/**
 * Round 15 scan (config hot reload): the agent plane read magic-context.jsonc
 * ONCE at apply time, while the settings page (magicContext/settings) re-reads
 * it every few seconds. After editing the jsonc, the page showed the new
 * effective value with source "jsonc" but the agent kept using the old one
 * until the process restarted. The live view now re-reads the jsonc with a
 * short TTL (same cadence as the page).
 */
describe("createLiveSettings re-reads magic-context.jsonc (round 15)", () => {
  it("a jsonc edit reaches the agent plane's effective settings after the TTL", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-live-jsonc-"));
    try {
      mkdirSync(join(dir, ".cortexkit"), { recursive: true });
      const file = join(dir, ".cortexkit", "magic-context.jsonc");
      // Project jsonc may only RAISE the threshold above the user/default
      // value (core hardening; default 65), so use values above it.
      writeFileSync(file, JSON.stringify({ execute_threshold_percentage: 72 }));
      let now = 1_000_000;
      const live = createLiveSettings({ overrides: () => ({}) } as never, dir, { now: () => now });
      expect(live.effective().executeThreshold.value).toBe(72);
      writeFileSync(file, JSON.stringify({ execute_threshold_percentage: 84 }));
      // Inside the TTL: cached (no per-step file reads).
      now += 1_000;
      expect(live.effective().executeThreshold.value).toBe(72);
      expect(live.thresholdFor({})).toBe(72);
      now += 10_000;
      expect(live.effective().executeThreshold.value).toBe(84);
      expect(live.thresholdFor({})).toBe(84);
      // A deleted file falls back to the core default on the next read.
      rmSync(file);
      now += 10_000;
      expect(live.effective().executeThreshold.value).toBe(65);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
