/**
 * Round 25 scan (B1): a stale `<db>.dsh-open.lock` whose recorded pid is ALIVE
 * but is not the process that took the lock.
 *
 * The open lock (round 24a, 41e74f26d) is taken over only when the holder pid
 * is confirmed dead (ESRCH) or the record is older than 10 minutes. A DSH
 * process killed during the open (OOM / SIGKILL while a big DB migrates) leaves
 * the file behind; when the next DSH process gets the SAME pid (containers: the
 * CLI is often the same pid on every start) or the pid was reused by any live
 * process, every DSH start for the next 10 minutes waited the full 120 s
 * MAX_WAIT before opening without the lock. A process that started AFTER the
 * lock was written cannot be its holder (core's own pid-reuse rule,
 * `isPidIdentityPlausible`, via `readProcessStartTime`).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessStartTime } from "@magic-context/core/shared/rpc-utils";
import { acquireDshOpenLock, dshOpenLockPath } from "./open-lock";

async function within<T>(ms: number, promise: Promise<T>): Promise<T | "timeout"> {
  return Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
}

function env(): { db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-open-lock-stale-"));
  return { db: join(dir, "context.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("dsh open lock: holder pid alive but not the lock's writer (round 25 B1)", () => {
  it("a lock left by an earlier process with OUR pid is taken over at once", async () => {
    const e = env();
    try {
      const start = readProcessStartTime(process.pid);
      expect(start).not.toBeNull();
      writeFileSync(dshOpenLockPath(e.db), JSON.stringify({ pid: process.pid, acquiredAt: (start as number) - 60_000 }));
      const logs: string[] = [];
      const release = await within(3_000, acquireDshOpenLock(e.db, (m) => logs.push(m)));
      expect(release).not.toBe("timeout");
      expect(JSON.parse(readFileSync(dshOpenLockPath(e.db), "utf8")).acquiredAt).toBeGreaterThanOrEqual(start as number);
      expect(logs.join("\n")).toContain("took over a stale lock");
      (release as () => void)();
      expect(existsSync(dshOpenLockPath(e.db))).toBe(false);
    } finally {
      e.cleanup();
    }
  });

  it("a lock whose pid was reused by a process started later is taken over at once", async () => {
    const e = env();
    const reused = Bun.spawn({ cmd: ["sleep", "30"] });
    try {
      await Bun.sleep(100);
      writeFileSync(dshOpenLockPath(e.db), JSON.stringify({ pid: reused.pid, acquiredAt: Date.now() - 5 * 60_000 }));
      const release = await within(3_000, acquireDshOpenLock(e.db, () => {}));
      expect(release).not.toBe("timeout");
      (release as () => void)();
    } finally {
      reused.kill();
      e.cleanup();
    }
  });

  it("control: a live holder that took the lock after it started is still waited for", async () => {
    const e = env();
    const holder = Bun.spawn({ cmd: ["sleep", "30"] });
    try {
      await Bun.sleep(100);
      writeFileSync(dshOpenLockPath(e.db), JSON.stringify({ pid: holder.pid, acquiredAt: Date.now() }));
      const pending = acquireDshOpenLock(e.db, () => {});
      expect(await within(1_500, pending)).toBe("timeout");
      rmSync(dshOpenLockPath(e.db), { force: true }); // the holder releases
      const release = await within(2_000, pending);
      expect(release).not.toBe("timeout");
      (release as () => void)();
    } finally {
      holder.kill();
      e.cleanup();
    }
  });
});
