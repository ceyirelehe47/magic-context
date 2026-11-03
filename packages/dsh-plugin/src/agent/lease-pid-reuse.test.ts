/**
 * Round 25 scan (B2): a compartment lease whose owner pid is ALIVE but is not
 * the process that took the lease.
 *
 * Round 23c made the DSH probes treat a lease of a confirmed-dead pid (ESRCH)
 * as gone, and core's acquire reclaims such a row. A pass killed mid-run
 * (SIGKILL / OOM / container stop) whose pid is then reused — in containers the
 * restarted DSH CLI usually gets the SAME pid — read as "alive": for the rest
 * of the 5-minute TTL the new process could not run the historian ("compartment
 * lease busy"), the 90 % backstop deferred as "historian busy" and /compact
 * waited and failed. A process that started after the lease was taken (or last
 * renewed) cannot be its owner (core's pid-reuse rule in isPidIdentityPlausible,
 * via readProcessStartTime).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { readProcessStartTime } from "@magic-context/core/shared/rpc-utils";
import { createTestDb } from "../test-utils";
import { isDshHistorianBusy, reclaimDshLeaseOfGoneOwner } from "./historian";
import { isLeaseOwnerGone } from "./lease-liveness";
import { initializeDshAdapterTables } from "./outbox";

const KEY = "dsh:h:lease-pid-reuse";

function plantLease(db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }, pid: number, acquiredAt: number): void {
  db.prepare(
    "INSERT INTO compartment_state_lease (session_id, holder_id, owner_pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(KEY, `dsh-historian:${KEY}:${pid}:deadbeef`, pid, acquiredAt, Date.now() + 4 * 60_000);
}

describe("lease owner pid reused (round 25 B2)", () => {
  it("isLeaseOwnerGone: an owner that started after the lease was taken is gone; the real owner is not", () => {
    const ownStart = readProcessStartTime(process.pid) as number;
    expect(ownStart).not.toBeNull();
    expect(isLeaseOwnerGone(process.pid, ownStart - 60_000)).toBe(true); // earlier incarnation, same pid
    expect(isLeaseOwnerGone(process.pid, Date.now())).toBe(false); // our own live lease
    expect(isLeaseOwnerGone(process.pid)).toBe(false); // no acquiredAt: unchanged rule
    const other = Bun.spawn({ cmd: ["sleep", "10"] });
    try {
      Bun.sleepSync(100);
      expect(isLeaseOwnerGone(other.pid, Date.now() - 60_000)).toBe(true); // reused pid
      expect(isLeaseOwnerGone(other.pid, Date.now())).toBe(false); // live owner
    } finally {
      other.kill();
    }
  });

  it("a lease left by an earlier process with our pid: not busy, reclaimed (exact row), the next acquire succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-lease-reuse-"));
    const db = await createTestDb(join(dir, "context.db"));
    try {
      initializeDshAdapterTables(db);
      plantLease(db as never, process.pid, (readProcessStartTime(process.pid) as number) - 60_000);
      expect(isDshHistorianBusy(db, KEY)).toBe(false);
      expect(reclaimDshLeaseOfGoneOwner(db, KEY, () => {})).toBe(true);
      expect(acquireCompartmentLease(db, KEY, "next")).not.toBeNull();
      // a live lease of this process is never reclaimed
      expect(reclaimDshLeaseOfGoneOwner(db, KEY, () => {})).toBe(false);
      expect(isDshHistorianBusy(db, KEY)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
