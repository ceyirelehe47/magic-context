// Round 26 (P1-4) soak probe: one JSON line of DB health after a DSH run.
//
//   bun scripts/e2e/soak-probe.ts <context.db>
//
// Read-only. Live leases (expires_at > now), sessions with the historian
// in-progress flag, outbox/saga rows not settled, pending ops, row counts.
import { Database } from "bun:sqlite";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: soak-probe.ts <context.db>");
  process.exit(2);
}
const db = new Database(dbPath, { readonly: true });
const tables = (db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name);
const one = (sql: string, ...p: (string | number)[]): number => {
  try {
    const r = db.query(sql).get(...p) as Record<string, number> | null;
    return r ? Number(Object.values(r)[0] ?? 0) : 0;
  } catch {
    return -1;
  }
};
const now = Date.now();
const has = (t: string) => tables.includes(t);
console.log(
  JSON.stringify({
    liveLeases: has("compartment_state_lease") ? one("select count(*) from compartment_state_lease where expires_at > ?", now) : 0,
    inProgress: has("session_meta") ? one("select count(*) from session_meta where compartment_in_progress = 1") : 0,
    outboxOpen: has("dsh_context_outbox") ? one("select count(*) from dsh_context_outbox where status in ('pending','applied')") : 0,
    pendingOps: has("pending_ops") ? one("select count(*) from pending_ops") : 0,
    sessions: has("session_meta") ? one("select count(*) from session_meta") : 0,
    compartments: has("compartments") ? one("select count(*) from compartments") : 0,
    tags: has("tags") ? one("select count(*) from tags") : 0,
    ftsRows: has("message_history_fts") ? one("select count(*) from message_history_fts") : 0,
    historianRuns: has("historian_runs") ? one("select count(*) from historian_runs") : 0,
    historianFailed: has("historian_runs") ? one("select count(*) from historian_runs where status = 'failed'") : 0,
  }),
);
