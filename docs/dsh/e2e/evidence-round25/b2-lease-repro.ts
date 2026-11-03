// Round 25 B2 repro (run from packages/dsh-plugin: cp here, `bun r25-lease-repro.ts`).
// Plants the lease row an earlier DSH process with OUR pid would leave after a
// SIGKILL (acquired 60 s before this process started, TTL 4 min left) and asks
// the DSH probes and the acquire path the adapter uses.
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { acquireCompartmentLease, getCompartmentLeaseBlocker } from "@magic-context/core/features/magic-context/compartment-lease";
import { readProcessStartTime } from "@magic-context/core/shared/rpc-utils";
import { createTestDb } from "./src/test-utils";
import * as historian from "./src/agent/historian";
import { isLeaseOwnerGone } from "./src/agent/lease-liveness";
import { initializeDshAdapterTables } from "./src/agent/outbox";
const KEY = "dsh:h:repro"; const db = await createTestDb(join(mkdtempSync(join(tmpdir(), "r25-")), "c.db")); initializeDshAdapterTables(db);
const start = readProcessStartTime(process.pid)!;
(db as any).prepare("INSERT INTO compartment_state_lease (session_id, holder_id, owner_pid, acquired_at, expires_at) VALUES (?,?,?,?,?)").run(KEY, "dsh-historian:prev-incarnation", process.pid, start - 60000, Date.now() + 240000);
const b = getCompartmentLeaseBlocker(db, KEY)!;
const gone = (isLeaseOwnerGone as (p: number, a?: number) => boolean)(b.ownerPid as number, b.acquiredAt);
const busy = historian.isDshHistorianBusy(db, KEY);
const reclaim = (historian as Record<string, unknown>).reclaimDshLeaseOfGoneOwner as undefined | ((d: unknown, k: string, l: (m: string) => void) => boolean);
const reclaimed = reclaim ? reclaim(db, KEY, () => {}) : "n/a (no adapter reclaim)";
const acquired = acquireCompartmentLease(db, KEY, "new") === null ? "null (busy)" : "acquired";
console.log(JSON.stringify({ case: "lease of an earlier incarnation with the same pid (acquired 60 s before this process started, TTL 4 min left)", isLeaseOwnerGone: gone, isDshHistorianBusy: busy, adapterReclaim: reclaimed, acquireAfterReclaim: acquired }));
