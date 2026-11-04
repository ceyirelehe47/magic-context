/**
 * Round 27 C5 (static-inference item from round 26: open-lock takeover TOCTOU).
 *
 * acquireDshOpenLock took over a stale lock with "re-read, compare, rmSync".
 * Between the compare and the rm another racer could remove the same stale lock
 * and create its OWN (O_EXCL) — the rm then deleted that fresh lock and two
 * processes held "the" lock at once (the first-open migration race the lock
 * exists for). Reproduced with real processes: 8 racers released in the same
 * millisecond against a lock left by a dead pid — 7 overlaps in 120 acquisitions
 * (5×8 and 10×8 rounds, local, before the fix).
 *
 * Fix: takeovers are serialized through a second O_EXCL file
 * (`<lock>.takeover`), held only around "re-read + still stale + rm"; a creator
 * never deletes, so no fresh lock can be removed by a takeover.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dshOpenLockPath } from "./open-lock";

const FIXTURE = join(import.meta.dir, "open-lock-race.fixture.ts");

describe("dsh open lock: stale-lock takeover race (round 27 C5)", () => {
  it("8 processes taking over the same dead holder's lock never hold it at the same time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-open-lock-race-"));
    const out = join(dir, "out.txt");
    writeFileSync(out, "");
    try {
      const ROUNDS = 6;
      const PROCS = 8;
      for (let round = 1; round <= ROUNDS; round += 1) {
        const dbPath = join(dir, `r${round}.db`);
        // A lock left behind by a dead process (pid far above pid_max defaults).
        writeFileSync(dshOpenLockPath(dbPath), JSON.stringify({ pid: 999_999_999, acquiredAt: 1 }));
        const startAt = Date.now() + 1_500;
        const children = Array.from({ length: PROCS }, () =>
          Bun.spawn([process.execPath, "run", FIXTURE, dbPath, String(startAt), out], { stdout: "ignore", stderr: "pipe" }),
        );
        await Promise.all(children.map((child) => child.exited));
      }
      const lines = readFileSync(out, "utf8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(ROUNDS * PROCS);
      expect(lines.filter((line) => line.endsWith("OVERLAP"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
