/**
 * Round 35 scan (F1): an open-lock path that EXISTS but cannot be read.
 *
 * `acquireDshOpenLock` loops on `createExclusive` (EEXIST) → `readLock`. When
 * the read failed it assumed "released between our attempt and the read" and
 * looped again at once, without awaiting and without the MAX_WAIT check. A
 * lock path that stays unreadable — a directory left at
 * `<db>.dsh-open.lock`, a file another user created without read permission
 * (shared storage dir), an I/O error — turned that into a synchronous busy
 * loop: the DSH process hung at plugin boot forever, at 100 % CPU, with no log
 * line (the event loop never ran again).
 *
 * Fix: a failed read of a path that still exists is an unidentifiable live
 * holder — log it once, poll, and open without the lock after MAX_WAIT_MS like
 * any other holder (core still fails closed on a real open error). A path that
 * is really gone keeps the immediate retry. The lock is never removed here.
 */
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dshOpenLockPath } from "./open-lock";

const FIXTURE = join(import.meta.dir, "open-lock-unreadable.fixture.ts");

async function runChild(db: string, maxWaitMs: number, deadlineMs: number): Promise<{ code: number | null; out: string; killed: boolean }> {
  const child = Bun.spawn({ cmd: [process.execPath, "run", FIXTURE, db, String(maxWaitMs)], stdout: "pipe", stderr: "pipe" });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, deadlineMs);
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  clearTimeout(timer);
  return { code: child.exitCode, out, killed };
}

function env(): { db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-open-lock-unreadable-"));
  return { db: join(dir, "context.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("dsh open lock: lock path exists but cannot be read (round 35 F1)", () => {
  it("a directory at the lock path: bounded wait, logged, then opens without the lock (no spin)", async () => {
    const e = env();
    try {
      mkdirSync(dshOpenLockPath(e.db));
      const r = await runChild(e.db, 400, 15_000);
      expect(r.killed).toBe(false);
      expect(r.code).toBe(0);
      expect(r.out).toContain("cannot be read");
      expect(r.out).toContain("opening without the lock");
      expect(r.out).toMatch(/acquired \d+/);
      // never removed by the acquire path
      expect(statSync(dshOpenLockPath(e.db)).isDirectory()).toBe(true);
    } finally {
      e.cleanup();
    }
  }, 30_000);

  it.skipIf(process.getuid?.() === 0)("a lock file without read permission: same bounded wait (non-root only)", async () => {
    const e = env();
    try {
      writeFileSync(dshOpenLockPath(e.db), JSON.stringify({ pid: 1, acquiredAt: Date.now() }));
      chmodSync(dshOpenLockPath(e.db), 0o000);
      const r = await runChild(e.db, 400, 15_000);
      expect(r.killed).toBe(false);
      expect(r.code).toBe(0);
      expect(r.out).toContain("cannot be read");
      expect(existsSync(dshOpenLockPath(e.db))).toBe(true);
    } finally {
      try { chmodSync(dshOpenLockPath(e.db), 0o600); } catch {}
      e.cleanup();
    }
  }, 30_000);
});
