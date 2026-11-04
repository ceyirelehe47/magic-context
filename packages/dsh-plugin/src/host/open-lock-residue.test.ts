/**
 * Round 28 (task 2, open-lock leftovers): a DSH process killed inside the open
 * lock's critical sections leaves files nobody removes.
 *
 * `createExclusive` writes `<lock>.<pid>.<rand>.tmp` and hard-links it into
 * place; a SIGKILL between the write and its `finally` rm leaves the temp file
 * (same for the takeover mutex's `<lock>.takeover.<pid>.<rand>.tmp`). A kill
 * inside the takeover mutex leaves `<lock>.takeover`; that one is only removed
 * lazily, when a later process needs a takeover or a release finds it busy.
 * Each crash adds a file to the storage dir for good.
 *
 * Fix: acquire sweeps these residues first — a temp file only once it is older
 * than a threshold or its writer pid is dead, a `.takeover` only by the
 * existing stale rule (dead pid / older than its 5 s window), exact record. The
 * lock itself is never touched by the sweep (it keeps its own stale rules), and
 * a hard-linked temp shares the lock's inode, so removing a temp never removes
 * a live lock.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { acquireDshOpenLock, dshOpenLockPath, dshOpenLockTakeoverPath } from "./open-lock";

function env(): { db: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-open-lock-residue-"));
  return { db: join(dir, "context.db"), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const residues = (dir: string, lock: string) =>
  readdirSync(dir).filter((f) => f.startsWith(`${basename(lock)}.`) && (f.endsWith(".tmp") || f.endsWith(".takeover")));

function age(path: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  utimesSync(path, t, t);
}

/** A pid that is certainly dead: a child that already exited. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn({ cmd: ["true"] });
  await p.exited;
  return p.pid;
}

describe("dsh open lock: crash residues are swept at acquire (round 28)", () => {
  it("repro: SIGKILL during acquire/release loops leaves .tmp / .takeover files, and the next acquire removes them", async () => {
    const e = env();
    const lock = dshOpenLockPath(e.db);
    try {
      const fixture = join(dirname(new URL(import.meta.url).pathname), "open-lock-residue.fixture.ts");
      let left: string[] = [];
      for (let attempt = 0; attempt < 40 && left.length === 0; attempt += 1) {
        const child = Bun.spawn({ cmd: [process.execPath, "run", fixture, e.db], stdout: "pipe" });
        const reader = child.stdout.getReader();
        await reader.read(); // "ready"
        await Bun.sleep(20 + Math.floor(Math.random() * 40));
        child.kill("SIGKILL");
        await child.exited;
        left = residues(e.dir, lock);
      }
      // Reproduced: the crash left at least one residue file behind.
      expect(left.length).toBeGreaterThan(0);
      // The holder is dead; age everything past the sweep threshold. The lock
      // is touched FIRST: a kill between createExclusive's link and its rm
      // leaves the temp hard-linked to the lock (one inode, one mtime), so
      // touching the lock last reset that temp to age 0 and it survived this
      // acquire (push CI 41840580191: `….lock.3083.1lwg3eahl0c.tmp` left; the
      // next acquire, > 1 s later with the writer dead, sweeps it — test order
      // bug, not a product one).
      if (existsSync(lock)) age(lock, 0);
      for (const f of left) age(join(e.dir, f), 10 * 60_000);
      const release = await acquireDshOpenLock(e.db, () => {});
      release();
      expect(residues(e.dir, lock)).toEqual([]);
      expect(existsSync(lock)).toBe(false);
    } finally {
      e.cleanup();
    }
  }, 60_000);

  it("dead-writer temp files and a dead holder's .takeover are removed; the lock is acquired", async () => {
    const e = env();
    const lock = dshOpenLockPath(e.db);
    try {
      const dead = await deadPid();
      writeFileSync(lock.replace(/$/, ".x"), ""); // unrelated sibling, must stay
      const tmp1 = `${lock}.${dead}.abc123.tmp`;
      const tmp2 = `${dshOpenLockTakeoverPath(lock)}.${dead}.def456.tmp`;
      writeFileSync(tmp1, JSON.stringify({ pid: dead, acquiredAt: Date.now() - 3_000 }));
      writeFileSync(tmp2, JSON.stringify({ pid: dead, acquiredAt: Date.now() - 3_000 }));
      age(tmp1, 3_000);
      age(tmp2, 3_000);
      writeFileSync(dshOpenLockTakeoverPath(lock), JSON.stringify({ pid: dead, acquiredAt: Date.now() - 3_000, n: 1 }));
      const logs: string[] = [];
      const release = await acquireDshOpenLock(e.db, (m) => logs.push(m));
      expect(residues(e.dir, lock)).toEqual([]);
      expect(existsSync(`${lock}.x`)).toBe(true);
      expect(logs.join("\n")).toMatch(/removed 3 crash residue/);
      release();
    } finally {
      e.cleanup();
    }
  });

  it("never removes a live writer's fresh temp, a live .takeover, or a live lock", async () => {
    const e = env();
    const lock = dshOpenLockPath(e.db);
    const live = Bun.spawn({ cmd: ["sleep", "30"] });
    try {
      await Bun.sleep(100);
      const freshTmp = `${lock}.${live.pid}.fresh01.tmp`;
      writeFileSync(freshTmp, "{}");
      const takeover = dshOpenLockTakeoverPath(lock);
      const takeoverRecord = JSON.stringify({ pid: live.pid, acquiredAt: Date.now(), n: 2 });
      writeFileSync(takeover, takeoverRecord);
      const lockRecord = JSON.stringify({ pid: live.pid, acquiredAt: Date.now() });
      writeFileSync(lock, lockRecord);
      // A live holder: acquire must wait, and the sweep must not touch any of it.
      const pending = acquireDshOpenLock(e.db, () => {});
      const raced = await Promise.race([pending, Bun.sleep(800).then(() => "timeout" as const)]);
      expect(raced).toBe("timeout");
      expect(readFileSync(lock, "utf8")).toBe(lockRecord);
      expect(existsSync(freshTmp)).toBe(true);
      expect(readFileSync(takeover, "utf8")).toBe(takeoverRecord);
      rmSync(lock, { force: true }); // holder releases
      rmSync(takeover, { force: true });
      const release = (await pending) as () => void;
      release();
      // A live writer's temp older than the threshold IS residue (temps live microseconds).
      age(freshTmp, 10 * 60_000);
      const release2 = await acquireDshOpenLock(e.db, () => {});
      release2();
      expect(existsSync(freshTmp)).toBe(false);
    } finally {
      live.kill();
      e.cleanup();
    }
  });
});
