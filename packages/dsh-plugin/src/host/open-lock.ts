/**
 * Round 24 — cross-process mutual exclusion around the shared DB's first open.
 *
 * Core's `openDatabaseAsync` runs pending migrations on a worker thread with
 * its own connection; several migrations are check-then-create outside one
 * write transaction (v95 `temporal_decisions`, the message-FTS rowid-map
 * index). Two DSH processes opening a FRESH file at the same moment can both
 * see "missing" and the loser fails with "... already exists" → storage
 * unavailable, Magic disabled for that run. The migration-on-open guard does
 * not help: liveness markers are written only after a successful open.
 *
 * The DSH bootstrap therefore holds an exclusive lock file
 * (`<dbPath>.dsh-open.lock`, created with O_EXCL) for the duration of the open.
 * A second DSH process waits until the first has migrated and then opens an
 * already-migrated DB (nothing pending, no worker). A lock whose holder pid is
 * confirmed dead (ESRCH), whose pid now belongs to a process started after
 * the lock was written (round 25: reused pid / same pid after a restart), or
 * that is older than STALE_MS is taken over; after
 * MAX_WAIT_MS of a live holder we log and open anyway (core still fails closed
 * on a real error). Only DSH processes honour this lock: a concurrent first
 * open by an OpenCode/Pi process is still core's race (documented).
 */
import { linkSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPidAlive } from "@magic-context/core/shared/rpc-utils";
import { isPidNewerThan } from "../agent/lease-liveness";
import { ensureStorageDirectorySync } from "@magic-context/core/shared/storage-permissions";

const POLL_MS = 50;
const MAX_WAIT_MS = 120_000;
const STALE_MS = 10 * 60_000;

export function dshOpenLockPath(dbPath: string): string {
  return `${dbPath}.dsh-open.lock`;
}

interface LockRecord { pid?: unknown; acquiredAt?: unknown }

function readLock(path: string): { raw: string; record: LockRecord } | null {
  try {
    const raw = readFileSync(path, "utf8");
    try { return { raw, record: JSON.parse(raw) as LockRecord }; } catch { return { raw, record: {} }; }
  } catch {
    return null;
  }
}

/**
 * Round 27 C5: create `path` holding `content`, atomically and exclusively.
 * `writeFileSync(path, …, {flag: "wx"})` creates the file EMPTY and writes
 * after: a racer reading in between saw an unreadable record, judged it stale
 * and removed a live lock. The record is now written to a private temp file
 * and hard-linked into place (link fails with EEXIST, never exposes a partial
 * file). File systems without hard links fall back to the O_EXCL write.
 */
function createExclusive(path: string, content: string): boolean {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, content);
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw error;
    try {
      writeFileSync(path, content, { flag: "wx" });
      return true;
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw fallback;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Age of the file in ms (Infinity when it cannot be read). */
function fileAgeMs(path: string, now: number): number {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** An unreadable record counts as stale only once it is this old (a torn write from the hard-link fallback). */
const UNREADABLE_STALE_MS = 5_000;

function staleReason(record: LockRecord, now: number, path?: string): string | null {
  const pid = typeof record.pid === "number" ? record.pid : null;
  const at = typeof record.acquiredAt === "number" ? record.acquiredAt : null;
  if (pid !== null && pid !== process.pid && isPidAlive(pid) === "dead") return `holder pid ${pid} is dead`;
  // Round 25 (B1): the pid is alive but its process started after the lock was
  // written — a reused pid, or our own pid inherited from a DSH process killed
  // during its open (containers restart the CLI under the same pid). It cannot
  // be the holder. Without this every start waited MAX_WAIT_MS for 10 minutes.
  if (pid !== null && isPidNewerThan(pid, at)) return `holder pid ${pid} started after the lock was taken (pid reused)`;
  if (at !== null && now - at > STALE_MS) return `held for ${Math.round((now - at) / 1000)} s`;
  if (pid === null && at === null && (path === undefined || fileAgeMs(path, now) > UNREADABLE_STALE_MS)) return "unreadable record";
  return null;
}

/**
 * Acquire the open lock. Resolves with a release function (idempotent; only
 * removes the file while it is still ours).
 */
export async function acquireDshOpenLock(
  dbPath: string,
  log: (message: string) => void,
): Promise<() => void> {
  const path = dshOpenLockPath(dbPath);
  const started = Date.now();
  const mine = JSON.stringify({ pid: process.pid, acquiredAt: started });
  let waitedFor: number | null = null;
  // The very first open on a machine has no storage dir yet; create it (core's
  // own storage-dir helper, same permissions as the open would use).
  ensureStorageDirectorySync(dirname(path));
  for (;;) {
    if (createExclusive(path, mine)) break;
    const now = Date.now();
    const held = readLock(path);
    if (held === null) continue; // released between our attempt and the read
    const stale = staleReason(held.record, now, path);
    if (stale !== null) {
      // Round 27 C5: remove only the exact record we judged stale, and only
      // while holding the takeover mutex. "Re-read, compare, rm" alone raced:
      // another racer could rm the same stale lock and create its own between
      // our compare and our rm, and we deleted that fresh lock (two holders,
      // reproduced with 8 processes). Creators never delete; takeovers are
      // serialized, so a takeover only ever removes the record it re-read.
      if (withTakeoverMutex(path, () => {
        const again = readLock(path);
        if (again !== null && again.raw === held.raw && staleReason(again.record, Date.now(), path) !== null) {
          rmSync(path, { force: true });
          log(`[magic-context] dsh open lock: took over a stale lock (${stale})`);
        }
      })) continue;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    if (waitedFor === null) waitedFor = typeof held.record.pid === "number" ? held.record.pid : -1;
    if (now - started > MAX_WAIT_MS) {
      log(`[magic-context] dsh open lock: holder pid ${waitedFor} still live after ${MAX_WAIT_MS} ms; opening without the lock`);
      return () => {};
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  if (waitedFor !== null) {
    log(`[magic-context] dsh open lock: waited ${Date.now() - started} ms for pid ${waitedFor}`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const removeIfMine = () => {
      const held = readLock(path);
      if (held !== null && held.raw === mine) rmSync(path, { force: true });
    };
    // Under the takeover mutex when it is free (a takeover of OUR lock — only
    // after STALE_MS — cannot interleave); never block the release on it.
    if (!withTakeoverMutex(path, removeIfMine)) removeIfMine();
  };
}

/** Takeover mutex: held for microseconds; one left by a crash is stale after this. */
const TAKEOVER_STALE_MS = 5_000;

export function dshOpenLockTakeoverPath(lockPath: string): string {
  return `${lockPath}.takeover`;
}

/**
 * Run `fn` while holding `<lock>.takeover` (O_EXCL). Returns false without
 * running it when another process holds the mutex (the caller polls). A mutex
 * left by a process that died inside it (dead pid, or older than
 * TAKEOVER_STALE_MS) is removed by exact record; that removal itself is not
 * serialized — the remaining window needs a crash inside the microsecond
 * critical section AND two racers judging it stale at once.
 */
function withTakeoverMutex(lockPath: string, fn: () => void): boolean {
  const mutex = dshOpenLockTakeoverPath(lockPath);
  const mine = JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), n: Math.random() });
  if (!createExclusive(mutex, mine)) {
    const held = readLock(mutex);
    if (held !== null) {
      const pid = typeof held.record.pid === "number" ? held.record.pid : null;
      const at = typeof held.record.acquiredAt === "number" ? held.record.acquiredAt : null;
      const dead =
        (pid !== null && pid !== process.pid && isPidAlive(pid) === "dead") ||
        (at === null && fileAgeMs(mutex, Date.now()) > TAKEOVER_STALE_MS) ||
        (at !== null && Date.now() - at > TAKEOVER_STALE_MS);
      if (dead) {
        const again = readLock(mutex);
        if (again !== null && again.raw === held.raw) rmSync(mutex, { force: true });
      }
    }
    return false;
  }
  try {
    fn();
  } finally {
    const held = readLock(mutex);
    if (held !== null && held.raw === mine) rmSync(mutex, { force: true });
  }
  return true;
}
