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
import { isPidAlive } from "@magic-context/core/shared/rpc-utils";

export function isLeaseOwnerGone(ownerPid: number | null | undefined): boolean {
  if (ownerPid === null || ownerPid === undefined || ownerPid === 0) return false; // legacy row without a pid: trust the TTL
  if (ownerPid === process.pid) return false;
  return isPidAlive(ownerPid) === "dead";
}
