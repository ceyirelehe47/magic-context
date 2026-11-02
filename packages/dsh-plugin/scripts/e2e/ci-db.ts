// CI e2e helper (dsh-ci.yml): dump the Magic rows the e2e checks need as JSON.
//
//   bun scripts/e2e/ci-db.ts <db-path> <session-id>[,<session-id>...]
//
// For every DSH session id (bare `session-…` or child uuid) it prints the
// `tags` rows (tag_number, message_id, type, status) and, for every table with
// a `session_id` column, the row count. Core stores DSH sessions as
// `dsh:<project>:<id>`, so ids are matched by suffix. Read-only; prints no
// secrets (the DB holds none).
import { Database } from "bun:sqlite";

const [dbPath, idsArg] = process.argv.slice(2);
if (!dbPath || !idsArg) {
  console.error("usage: ci-db.ts <db-path> <session-id>[,<session-id>...]");
  process.exit(2);
}
const db = new Database(dbPath, { readonly: true });
const tables = (db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map(
  (r) => r.name,
);
const sessionTables = tables.filter((t) =>
  (db.query(`pragma table_info(${t})`).all() as { name: string }[]).some((c) => c.name === "session_id"),
);
const out: Record<string, unknown> = {};
for (const id of idsArg.split(",").filter(Boolean)) {
  const like = `%${id}`;
  const counts: Record<string, number> = {};
  for (const t of sessionTables) {
    const n = (db.query(`select count(*) n from ${t} where session_id = ? or session_id like ?`).get(id, like) as {
      n: number;
    }).n;
    if (n > 0) counts[t] = n;
  }
  const tags = db
    .query(
      "select tag_number, message_id, type, status from tags where session_id = ? or session_id like ? order by tag_number",
    )
    .all(id, like);
  const markers = sessionTables.includes("dsh_context_compaction_marker")
    ? db
        .query(
          "select ordinal, status, published_at from dsh_context_compaction_marker where session_id = ? or session_id like ? order by ordinal",
        )
        .all(id, like)
    : [];
  out[id] = { counts, tags, markers };
}
console.log(JSON.stringify(out));
