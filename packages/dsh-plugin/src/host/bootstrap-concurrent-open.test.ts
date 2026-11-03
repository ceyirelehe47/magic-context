/**
 * Round 24 — concurrent FIRST open of a fresh shared DB by several DSH
 * processes. Core's migrations are not safe against two processes migrating a
 * never-migrated file at the same moment (v95 `CREATE TABLE temporal_decisions`
 * and the message-FTS rowid-map index are check-then-create; repro
 * docs/dsh/e2e/evidence-round24/repro-concurrent-bootstrap.*: 8 of 48 pairs lost
 * one process to "... already exists" → storage unavailable, Magic disabled for
 * that run). The DSH bootstrap serializes the open (incl. migration) across DSH
 * processes with an exclusive lock file next to the DB.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDshLivenessMarker } from "../compat/dsh-0.1/liveness";
import { bootstrapDshStorage } from "./bootstrap";
import { dshOpenLockPath } from "./open-lock";

const FIX = join(import.meta.dir, "bootstrap-open.fixture.ts");

describe("dsh bootstrap: concurrent first open of a fresh DB", () => {
  it("waits while another live DSH process holds the open lock, then opens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-open-lock-"));
    const holder = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      const dbPath = join(dir, "context.db");
      writeFileSync(dshOpenLockPath(dbPath), JSON.stringify({ pid: holder.pid, acquiredAt: Date.now() }));
      const logs: string[] = [];
      let settled = false;
      const opening = bootstrapDshStorage({
        directory: join(dir, "proj"), port: 0, dbPath, storageDirOverride: dir, homeHash: "a1b2c3d4",
        log: (m) => logs.push(m),
      }).finally(() => { settled = true; });
      await Bun.sleep(700);
      // A live holder (another DSH process mid-migration) must keep us out.
      expect(settled).toBe(false);
      expect(existsSync(dbPath)).toBe(false);
      rmSync(dshOpenLockPath(dbPath), { force: true }); // holder finished
      const outcome = await opening;
      expect(outcome.kind).toBe("ok");
      expect(logs.some((m) => m.includes("open lock") && m.includes("waited"))).toBe(true);
      expect(existsSync(dshOpenLockPath(dbPath))).toBe(false); // released after open
      if (outcome.kind === "ok") { outcome.db.close(); removeDshLivenessMarker(outcome.livenessPath); }
    } finally {
      holder.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes over a lock whose holder process is dead (no wait for a crashed opener)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-open-lock-"));
    try {
      const dead = Bun.spawn({ cmd: ["true"] });
      await dead.exited;
      const dbPath = join(dir, "context.db");
      writeFileSync(dshOpenLockPath(dbPath), JSON.stringify({ pid: dead.pid, acquiredAt: Date.now() }));
      const logs: string[] = [];
      const started = Date.now();
      const outcome = await bootstrapDshStorage({
        directory: join(dir, "proj"), port: 0, dbPath, storageDirOverride: dir, homeHash: "a1b2c3d4",
        log: (m) => logs.push(m),
      });
      expect(outcome.kind).toBe("ok");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(logs.some((m) => m.includes("open lock") && m.includes("stale"))).toBe(true);
      expect(existsSync(dshOpenLockPath(dbPath))).toBe(false);
      if (outcome.kind === "ok") { outcome.db.close(); removeDshLivenessMarker(outcome.livenessPath); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("three real processes opening one fresh DB at once all succeed (6 rounds)", async () => {
    for (let round = 0; round < 6; round += 1) {
      const dir = mkdtempSync(join(tmpdir(), "dsh-open-race-"));
      try {
        const children = [0, 1, 2].map((k) =>
          Bun.spawn({ cmd: [process.execPath, "run", FIX, dir, join(dir, `proj-${k}`)], stdout: "pipe", stderr: "pipe" }),
        );
        const codes = await Promise.all(children.map((c) => c.exited));
        const errs = await Promise.all(children.map((c) => new Response(c.stderr).text()));
        const outs = await Promise.all(children.map((c) => new Response(c.stdout).text()));
        expect({ round, codes, errs: errs.map((e) => e.split("\n").filter((l) => l.includes("open failed") || l.includes("open refused"))) })
          .toEqual({ round, codes: [0, 0, 0], errs: [[], [], []] });
        for (const o of outs) expect(o).toMatch(/open ok v\d+/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
