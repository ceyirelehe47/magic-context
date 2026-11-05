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
import { linkSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/** Does anything (file, directory, dangling symlink) exist at `path`? */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    // Only "really gone" counts as released; any other stat error (EACCES on
    // the directory, EIO) is an unreadable lock, not a free one.
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
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
  opts: { readonly maxWaitMs?: number } = {},
): Promise<() => void> {
  const path = dshOpenLockPath(dbPath);
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const started = Date.now();
  const mine = JSON.stringify({ pid: process.pid, acquiredAt: started });
  let waitedFor: number | null = null;
  // The very first open on a machine has no storage dir yet; create it (core's
  // own storage-dir helper, same permissions as the open would use).
  ensureStorageDirectorySync(dirname(path));
  sweepOpenLockResidue(path, log);
  for (;;) {
    if (createExclusive(path, mine)) break;
    const now = Date.now();
    const held = readLock(path);
    if (held === null) {
      if (!pathExists(path)) continue; // released between our attempt and the read
      // Round 35 (F1): the path exists but cannot be read (a directory, a file
      // without read permission, an I/O error). Retrying at once without an
      // await spun synchronously forever and hung the DSH boot with no log.
      // Treat it as a live holder we cannot identify: log once, poll, and open
      // without the lock after the max wait. Never removed here.
      if (waitedFor === null) {
        waitedFor = -1;
        log(`[magic-context] dsh open lock: ${path} exists but cannot be read; waiting up to ${maxWaitMs} ms`);
      }
      if (now - started > maxWaitMs) {
        log(`[magic-context] dsh open lock: ${path} still unreadable after ${maxWaitMs} ms; opening without the lock`);
        return () => {};
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
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
      // Round 35 (F1b): the takeover mutex is busy. A mutex that can never be
      // taken (an unreadable / non-file `.takeover`, which no stale rule can
      // remove) kept this branch polling forever; it is bounded like any wait.
      if (now - started > maxWaitMs) {
        log(`[magic-context] dsh open lock: stale lock (${stale}) not taken over after ${maxWaitMs} ms (takeover mutex busy); opening without the lock`);
        return () => {};
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    if (waitedFor === null) waitedFor = typeof held.record.pid === "number" ? held.record.pid : -1;
    if (now - started > maxWaitMs) {
      log(`[magic-context] dsh open lock: holder pid ${waitedFor} still live after ${maxWaitMs} ms; opening without the lock`);
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

/**
 * Round 28: a temp file of {@link createExclusive} lives for microseconds
 * (write → link → rm, all synchronous); one older than this was left by a
 * process killed in between.
 */
const TMP_RESIDUE_MS = 60_000;
/** A dead writer's temp is removed sooner, but never one younger than this. */
const TMP_DEAD_WRITER_MS = 1_000;

/**
 * Round 28 (task 2): remove what a crash inside the open lock's critical
 * sections leaves behind — `<lock>.<pid>.<rand>.tmp`,
 * `<lock>.takeover.<pid>.<rand>.tmp` (killed between createExclusive's write
 * and its rm) and `<lock>.takeover` (killed inside the takeover mutex; before
 * this it was removed only lazily, when a later process needed the mutex).
 *
 * Safety: the lock file itself is never touched here (it keeps its own stale
 * rules in the acquire loop). A temp is removed only when older than
 * TMP_RESIDUE_MS, or older than TMP_DEAD_WRITER_MS with its writer pid dead.
 * No temp of THIS process can be in flight (createExclusive is synchronous and
 * the sweep runs synchronously before it), and a temp that was hard-linked
 * into place shares the lock's inode, so unlinking it never removes a live
 * lock. `.takeover` is removed by the same rule withTakeoverMutex applies
 * (dead pid, or older than TAKEOVER_STALE_MS), exact record. Best effort:
 * never throws.
 */
export function sweepOpenLockResidue(lockPath: string, log: (message: string) => void): number {
  let removed = 0;
  const dir = dirname(lockPath);
  const base = basename(lockPath);
  const takeoverBase = basename(dshOpenLockTakeoverPath(lockPath));
  const tmpPattern = new RegExp(
    `^(?:${escapeRe(base)}|${escapeRe(takeoverBase)})\\.(\\d+)\\.[A-Za-z0-9]+\\.tmp$`,
  );
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const name of names) {
    const match = tmpPattern.exec(name);
    if (match === null) continue;
    const full = join(dir, name);
    const ageMs = fileAgeMs(full, now);
    if (!Number.isFinite(ageMs)) continue;
    const pid = Number(match[1]);
    const writerDead = pid !== process.pid && isPidAlive(pid) === "dead";
    if (ageMs > TMP_RESIDUE_MS || (writerDead && ageMs > TMP_DEAD_WRITER_MS)) {
      try {
        rmSync(full, { force: true });
        removed += 1;
      } catch {
        // best effort
      }
    }
  }
  const takeover = dshOpenLockTakeoverPath(lockPath);
  const held = readLock(takeover);
  if (held !== null) {
    const pid = typeof held.record.pid === "number" ? held.record.pid : null;
    const at = typeof held.record.acquiredAt === "number" ? held.record.acquiredAt : null;
    const stale =
      (pid !== null && pid !== process.pid && isPidAlive(pid) === "dead") ||
      (at === null && fileAgeMs(takeover, now) > TAKEOVER_STALE_MS) ||
      (at !== null && now - at > TAKEOVER_STALE_MS);
    if (stale) {
      const again = readLock(takeover);
      if (again !== null && again.raw === held.raw) {
        try {
          rmSync(takeover, { force: true });
          removed += 1;
        } catch {
          // best effort
        }
      }
    }
  }
  if (removed > 0) log(`[magic-context] dsh open lock: removed ${removed} crash residue file(s) next to ${base}`);
  return removed;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
