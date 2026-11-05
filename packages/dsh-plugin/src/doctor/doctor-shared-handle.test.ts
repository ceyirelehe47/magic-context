/**
 * Round 30 — doctor must not leave a CLOSED handle in core's per-path DB cache.
 *
 * push checks 41974187111 (code identical to the green 41972435035): bun ran
 * magic-settings (boots the DEFAULT DB path, creating context.db) → … →
 * doctor.test (runDshDoctor with no dbPathOverride opens that default path
 * through core openDatabaseAsync, which caches the handle per path, then did a
 * bare `db.close()`) → … → host-unload-release, whose host boot got the cached
 * closed handle: "RangeError: Cannot use a closed database" in
 * enforceSchemaFence. The round 27 fix (magic-settings closes through
 * closeDatabase()) removed one source; doctor's shared-DB check was the other.
 * Production: doctor runs only as the CLI (own process), so the bare close was
 * harmless there — this is test isolation, fixed by closing through core.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";
import { runDshDoctor } from "./doctor";
import { fakeDshInstall } from "./fake-dsh";

describe("doctor shared-DB check leaves core's DB cache usable (round 30)", () => {
  it("a later open of the same path after doctor returns a usable handle", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-magic-doctor-handle-"));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "config");
    try {
      const storage = join(root, "storage");
      mkdirSync(storage, { recursive: true });
      const dbPath = join(storage, "context.db");
      const first = await openDatabaseAsync({ dbPath });
      expect(first).not.toBeNull();
      const report = await runDshDoctor([], {
        dshHome: join(root, "dsh-home"),
        dshInstallDir: fakeDshInstall(join(root, "install"), {}),
        directory: join(root, "work"),
        storageDirOverride: storage,
        dbPathOverride: dbPath,
      } as never);
      expect(report.checks.find((check) => check.id === "shared-db")?.status).toBe("ok");
      const again = await openDatabaseAsync({ dbPath });
      expect(again).not.toBeNull();
      expect(() => again!.prepare("SELECT 1 AS one").get()).not.toThrow();
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
