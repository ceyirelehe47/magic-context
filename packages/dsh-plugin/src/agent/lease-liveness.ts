/**
 * Round 23c (P0-2): is a compartment lease held by a pass that can still run?
 *
 * Core's lease row carries the holder's `owner_pid` and a 5-minute TTL, and
 * core's `acquireCompartmentLease` already reclaims a row whose owner pid is
 * confirmed dead. The DSH read-only probes (`isDshHistorianBusy` → backstop
 * deferral, /compact's lease wait, status "running") looked only at the TTL,
 * so after a SIGKILL a dead pass read as busy/running for up to 5 minutes.
 *
 * Same rule as core's reclaim: the owner counts as gone only when the local
 * probe says "dead" (ESRCH). "alive" and "inconclusive" (EPERM in a sandbox)
 * stay busy. The DB is the per-home local SQLite file, so the pid is a pid on
 * this machine. PID reuse can only make a dead owner read "alive" — the old
 * TTL-bounded wait, never a false "free" while the real owner lives.
 */
import { isPidAlive, readProcessStartTime } from "@magic-context/core/shared/rpc-utils";

/**
 * Round 25 (B2): tolerance between a row's `acquired_at` (Date.now() of the
 * writer, same machine) and the owner's start time read from the OS (Linux:
 * /proc btime + start ticks, 10 ms resolution). Kept small: a restart inside
 * this window after the lease was taken falls back to the TTL (5 min).
 */
export const LEASE_PID_REUSE_TOLERANCE_MS = 5_000;

/**
 * Round 25 (B2): the pid is alive but its process started after the record was
 * written (`acquiredAt`, the lease's last acquire/renew) — it cannot be the
 * writer: the pid was reused, or it is this process's own pid inherited from a
 * killed earlier process (containers restart the CLI under the same pid). Same
 * rule as core's `isPidIdentityPlausible` for RPC port files. Unknown start
 * time → false (unchanged behaviour).
 */
export function isPidNewerThan(pid: number, acquiredAt: number | null | undefined): boolean {
  if (typeof acquiredAt !== "number" || !Number.isFinite(acquiredAt) || acquiredAt <= 0) return false;
  const started = cachedStartTime(pid);
  return started !== null && started > acquiredAt + LEASE_PID_REUSE_TOLERANCE_MS;
}

// A process's start time never changes; a short cache bounds the cost where the
// probe spawns `ps` (macOS/BSD) on hot paths (backstop pressure checks).
const START_TIME_CACHE_MS = 2_000;
const startTimes = new Map<number, { at: number; value: number | null }>();
function cachedStartTime(pid: number): number | null {
  const now = Date.now();
  const hit = startTimes.get(pid);
  if (hit !== undefined && now - hit.at < START_TIME_CACHE_MS) return hit.value;
  const value = readProcessStartTime(pid);
  if (startTimes.size > 64) startTimes.clear();
  startTimes.set(pid, { at: now, value });
  return value;
}

export function isLeaseOwnerGone(ownerPid: number | null | undefined, acquiredAt?: number | null): boolean {
  if (ownerPid === null || ownerPid === undefined || ownerPid === 0) return false; // legacy row without a pid: trust the TTL
  if (isPidNewerThan(ownerPid, acquiredAt)) return true;
  if (ownerPid === process.pid) return false;
  return isPidAlive(ownerPid) === "dead";
}
