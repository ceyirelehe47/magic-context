// Round 25 scenario S (ci-x.sh, task pack P1-2): multi-session stress dump.
// Read-only; the DB holds no secrets.
//
//   bun scripts/e2e/ci-s.ts <db-path> <session-id,session-id,...>
//
// Per session: compartments (duplicates / overlaps / gaps), tags (duplicate
// numbers), live leases, compartment_in_progress, historian runs by status,
// outbox rows not yet acknowledged, pending ops. Global: integrity_check, file
// sizes (db + wal), page stats, row counts of the big tables.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";

const [dbPath, sidList] = process.argv.slice(2);
if (!dbPath || !sidList) {
  console.error("usage: ci-s.ts <db-path> <sid,sid,...>");
  process.exit(2);
}
const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);
const db = new Database(dbPath, { readonly: true });
const has = (t: string) => db.query("select 1 from sqlite_master where name=?").get(t) !== null;
const q = (sql: string, ...p: unknown[]) => db.query(sql).all(...(p as never[])) as Record<string, unknown>[];
const one = (sql: string, ...p: unknown[]) => db.query(sql).get(...(p as never[])) as Record<string, unknown> | null;
const now = Date.now();
const sessions: Record<string, unknown> = {};
for (const sid of sidList.split(",").filter(Boolean)) {
  const like = `%${sid}`;
  const comps = has("compartments")
    ? (q("select start_message s, end_message e from compartments where session_id like ? order by start_message, end_message", like) as { s: number; e: number }[])
    : [];
  const ranges = new Set<string>();
  let duplicates = 0;
  let overlaps = 0;
  let gaps = 0;
  let expect = 1;
  for (const c of comps) {
    const k = `${c.s}-${c.e}`;
    if (ranges.has(k)) duplicates += 1;
    ranges.add(k);
    if (c.s < expect) overlaps += 1;
    else if (c.s > expect) gaps += 1;
    expect = Math.max(expect, c.e + 1);
  }
  const tagDup = one(
    "select count(*) n from (select tag_number from tags where session_id like ? group by tag_number having count(*) > 1)",
    like,
  );
  const tagCount = one("select count(*) n, sum(case when status='active' then 1 else 0 end) active from tags where session_id like ?", like);
  sessions[sid] = {
    compartments: comps.length,
    lastEnd: comps.length ? comps[comps.length - 1]!.e : 0,
    duplicates,
    overlaps,
    gaps,
    tags: tagCount,
    duplicateTagNumbers: tagDup?.n ?? null,
    liveLeases: has("compartment_state_lease")
      ? q("select holder_id, owner_pid, expires_at from compartment_state_lease where session_id like ? and expires_at > ?", like, now)
      : [],
    meta: has("session_meta")
      ? one("select compartment_in_progress cip, historian_failure_count hf from session_meta where session_id like ?", like)
      : null,
    historianRuns: has("historian_runs")
      ? q("select status, count(*) n from historian_runs where session_id like ? group by status", like)
      : [],
    // round 25b: why passes did not publish (e.g. 'nothing to compact …')
    historianReasons: has("historian_runs")
      ? q("select status, failure_reason reason, count(*) n from historian_runs where session_id like ? and status != 'success' group by status, failure_reason", like)
      : [],
    outboxOpen: has("dsh_context_outbox")
      ? q("select status, count(*) n from dsh_context_outbox where session_id like ? and status in ('pending','applied') group by status", like)
      : [],
    pendingOps: has("pending_ops") ? one("select count(*) n from pending_ops where session_id like ?", like)?.n ?? 0 : 0,
  };
}
const pageSize = Number((one("pragma page_size") as Record<string, number> | null)?.page_size ?? 0);
const pageCount = Number((one("pragma page_count") as Record<string, number> | null)?.page_count ?? 0);
const freelist = Number((one("pragma freelist_count") as Record<string, number> | null)?.freelist_count ?? 0);
const rows: Record<string, number> = {};
for (const t of ["tags", "compartments", "memories", "historian_runs", "dsh_context_outbox", "pending_ops", "message_history_index", "compartment_events"]) {
  if (has(t)) rows[t] = Number(one(`select count(*) n from ${t}`)?.n ?? 0);
}
console.log(
  JSON.stringify({
    at: now,
    integrity: (one("pragma integrity_check") as Record<string, string> | null)?.integrity_check ?? null,
    bytes: { db: size(dbPath), wal: size(`${dbPath}-wal`) },
    pages: { pageSize, pageCount, freelist },
    rows,
    sessions,
  }),
);
