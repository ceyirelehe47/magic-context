import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { createTestDb } from "../test-utils";
import { isDshHistorianBusy } from "./historian";
import { isLeaseOwnerGone } from "./lease-liveness";
import { initializeDshAdapterTables } from "./outbox";

const KEY = "dsh:h:lease-liveness";

function deadPid(): number {
  const r = Bun.spawnSync({ cmd: [process.execPath, "-e", "0"] });
  expect(r.exitCode).toBe(0);
  return r.pid;
}

describe("lease liveness (round 23c P0-2)", () => {
  it("only a confirmed-dead owner counts as gone; own pid, live pid and pid-less rows stay held", () => {
    expect(isLeaseOwnerGone(process.pid)).toBe(false);
    expect(isLeaseOwnerGone(null)).toBe(false);
    expect(isLeaseOwnerGone(undefined)).toBe(false);
    expect(isLeaseOwnerGone(0)).toBe(false);
    const live = Bun.spawn({ cmd: ["sleep", "5"] });
    try {
      expect(isLeaseOwnerGone(live.pid)).toBe(false);
    } finally {
      live.kill();
    }
    expect(isLeaseOwnerGone(deadPid())).toBe(true);
  });

  it("isDshHistorianBusy: live owner (this or another process) busy; dead owner not busy; lease row kept for core's reclaim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-lease-"));
    const db = await createTestDb(join(dir, "context.db"));
    initializeDshAdapterTables(db);
    expect(acquireCompartmentLease(db, KEY, "bg")).not.toBeNull();
    expect(isDshHistorianBusy(db, KEY)).toBe(true); // own pid
    const live = Bun.spawn({ cmd: ["sleep", "5"] });
    try {
      db.prepare("UPDATE compartment_state_lease SET owner_pid = ? WHERE session_id = ?").run(live.pid, KEY);
      expect(isDshHistorianBusy(db, KEY)).toBe(true); // another live process
    } finally {
      live.kill();
    }
    db.prepare("UPDATE compartment_state_lease SET owner_pid = ? WHERE session_id = ?").run(deadPid(), KEY);
    expect(isDshHistorianBusy(db, KEY)).toBe(false); // dead owner
    // read-only probe: the row is still there (core's acquire reclaims it)
    expect((db.prepare("SELECT COUNT(*) AS n FROM compartment_state_lease WHERE session_id = ?").get(KEY) as { n: number }).n).toBe(1);
    expect(acquireCompartmentLease(db, KEY, "next")).not.toBeNull();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
