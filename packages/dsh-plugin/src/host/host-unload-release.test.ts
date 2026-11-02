import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapDshStorage } from "./bootstrap";
import * as hostEntry from "../index";
import type { MagicContextHostService } from "../index";

/**
 * Round 15 scan (plugin unload/reload): the host entry registered no disposer,
 * so unloading the host plugin while the process keeps running (profile
 * switch, Magic Context disabled in a long-lived web process) left this pid's
 * liveness marker behind — the core migration guard then kept refusing other
 * processes' migrations as if Magic Context were still live here. The marker
 * is now released on dispose, but only while it is still THIS instance's
 * marker (a reload that re-applied first must keep its own).
 */
async function boot(dir: string) {
  const outcome = await bootstrapDshStorage({
    directory: join(dir, "proj"),
    port: 0,
    dbPath: join(dir, "context.db"),
    storageDirOverride: dir,
    homeHash: "a1b2c3d4",
  });
  if (outcome.kind !== "ok") throw new Error(`bootstrap refused: ${outcome.reason}`);
  return outcome;
}

describe("host unload releases the liveness marker (round 15)", () => {
  it("release() removes this instance's marker and leaves a newer instance's marker alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-unload-"));
    try {
      const first = await boot(dir);
      expect(existsSync(first.livenessPath)).toBe(true);
      expect(typeof first.release).toBe("function");
      // Reload where the new host applied before the old one disposed: same
      // pid → same marker path, rewritten by the new instance.
      await new Promise((resolve) => setTimeout(resolve, 2));
      const second = await boot(dir);
      expect(second.livenessPath).toBe(first.livenessPath);
      first.release?.();
      expect(existsSync(second.livenessPath)).toBe(true);
      second.release?.();
      expect(existsSync(second.livenessPath)).toBe(false);
      second.release?.(); // idempotent
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the host entry registers a disposer that releases the marker", async () => {
    const effects: Array<() => unknown> = [];
    const provided: Record<string, unknown> = {};
    const ctx = {
      provide: (name: string, value: unknown) => {
        provided[name] = value;
      },
      effect: (fn: () => unknown) => {
        effects.push(fn);
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-unload-host-"));
    try {
      hostEntry.apply(ctx as never, { directory: dir, homeHash: "abcd1234" } as never);
      const service = provided.magicContextHost as MagicContextHostService;
      const outcome = await service.ready;
      if (outcome.kind !== "ok") return; // refused boots write no marker
      expect(existsSync(outcome.livenessPath)).toBe(true);
      expect(effects.length).toBeGreaterThan(0);
      for (const setup of effects) {
        const dispose = setup();
        if (typeof dispose === "function") await (dispose as () => unknown)();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(existsSync(outcome.livenessPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
