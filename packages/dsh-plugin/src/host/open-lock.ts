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
 * confirmed dead (ESRCH) or that is older than STALE_MS is taken over; after
 * MAX_WAIT_MS of a live holder we log and open anyway (core still fails closed
 * on a real error). Only DSH processes honour this lock: a concurrent first
 * open by an OpenCode/Pi process is still core's race (documented).
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPidAlive } from "@magic-context/core/shared/rpc-utils";
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

function staleReason(record: LockRecord, now: number): string | null {
  const pid = typeof record.pid === "number" ? record.pid : null;
  const at = typeof record.acquiredAt === "number" ? record.acquiredAt : null;
  if (pid !== null && pid !== process.pid && isPidAlive(pid) === "dead") return `holder pid ${pid} is dead`;
  if (at !== null && now - at > STALE_MS) return `held for ${Math.round((now - at) / 1000)} s`;
  if (pid === null && at === null) return "unreadable record";
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
    try {
      writeFileSync(path, mine, { flag: "wx" });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
    const now = Date.now();
    const held = readLock(path);
    if (held === null) continue; // released between our attempt and the read
    const stale = staleReason(held.record, now);
    if (stale !== null) {
      // Remove only the exact record we judged stale.
      const again = readLock(path);
      if (again !== null && again.raw === held.raw) rmSync(path, { force: true });
      log(`[magic-context] dsh open lock: took over a stale lock (${stale})`);
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
    const held = readLock(path);
    if (held !== null && held.raw === mine) rmSync(path, { force: true });
  };
}
