// Round 23b scenario X (ci-x.sh): dump the rows the extreme-pressure checks
// need. Read-only; the DB holds no secrets.
//
//   bun scripts/e2e/ci-x.ts <db-path> <session-id>
//
// truncations (tag, head/tail, original chars + sha256, basis seq, created_at),
// tool tags (tag → message id, status), outbox status counts, pending ops,
// compartments (range), leases (holder pid), historian state, integrity_check.
import { Database } from "bun:sqlite";

const [dbPath, sid] = process.argv.slice(2);
if (!dbPath || !sid) {
  console.error("usage: ci-x.ts <db-path> <session-id>");
  process.exit(2);
}
const db = new Database(dbPath, { readonly: true });
const like = `%${sid}`;
const has = (t: string) => db.query("select 1 from sqlite_master where type='table' and name=?").get(t) !== null;
const q = (sql: string, ...p: unknown[]) => db.query(sql).all(...(p as never[]));
const out: Record<string, unknown> = { sid };
out.truncations = has("dsh_pressure_truncations")
  ? q("select tag_number, head_chars, tail_chars, original_chars, original_sha, basis_usage_seq, created_at from dsh_pressure_truncations where session_id like ? order by tag_number", like)
  : [];
out.tags = q("select tag_number, message_id, type, status, tool_owner_message_id from tags where session_id like ? order by tag_number", like);
out.outbox = has("dsh_context_outbox") ? q("select status, count(*) n from dsh_context_outbox where session_id like ? group by status", like) : [];
out.pendingOps = has("pending_ops") ? q("select operation, count(*) n from pending_ops where session_id like ? group by operation", like) : [];
out.compartments = has("compartments") ? q("select id, start_message, end_message from compartments where session_id like ? order by start_message", like) : [];
out.leases = has("compartment_state_lease")
  ? q("select holder_id, owner_pid, expires_at, ? as now from compartment_state_lease where session_id like ?", Date.now(), like)
  : [];
out.meta = has("session_meta")
  ? db.query("select compartment_in_progress, historian_failure_count, last_context_percentage from session_meta where session_id like ?").get(like)
  : null;
// round 23c scenario Y (kill -9): whole-file integrity + every session's row counts
out.integrity = (db.query("pragma integrity_check").get() as Record<string, string>)?.integrity_check ?? null;
out.historianRuns = has("historian_runs")
  ? q("select id, status, failure_reason, compartments_produced, created_at from historian_runs where session_id like ? order by id", like)
  : [];
out.allSessions = q(
  "select session_id, count(*) as tags, sum(case when status='active' then 1 else 0 end) as active from tags group by session_id order by session_id",
);
console.log(JSON.stringify(out));
