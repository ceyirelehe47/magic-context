// bun scripts/e2e/inspect-db.ts [db-path]
// Durable evidence for the e2e runs: harness attribution, compartments, tags.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.env.E2E_ROOT ?? join(process.env.HOME ?? "", "w/e2e");
function find(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile() && entry.name === "context.db") return p;
    if (entry.isDirectory()) {
      const hit = find(p);
      if (hit) return hit;
    }
  }
  return undefined;
}
const dbPath = process.argv[2] ?? find(join(root, "xdg")) ?? find(join(process.env.HOME ?? "", ".local/share/cortexkit"));
if (!dbPath) {
  console.log("no context.db found");
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true });
const tables = new Set(
  (db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name),
);
const q = (sql: string) => {
  try {
    return db.query(sql).all();
  } catch (error) {
    return `ERR ${(error as Error).message}`;
  }
};
console.log("db:", dbPath);
for (const t of ["session_meta", "compartments", "tags", "session_facts", "memories", "session_projects"]) {
  if (!tables.has(t)) continue;
  const cols = (db.query(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  const harness = cols.includes("harness") ? q(`select harness, count(*) n from ${t} group by harness`) : "(no harness col)";
  console.log(`${t}: rows=${JSON.stringify(q(`select count(*) n from ${t}`))} harness=${JSON.stringify(harness)}`);
}
if (tables.has("compartments")) {
  console.log("compartments:", JSON.stringify(q("select session_id, sequence, start_message, end_message, substr(title,1,60) title from compartments order by rowid desc limit 5"), null, 1));
}
if (tables.has("historian_runs")) {
  console.log("historian_runs:", JSON.stringify(q("select * from historian_runs order by id desc limit 5"), null, 1).slice(0, 3000));
}
if (process.env.INSPECT_META === "1" && tables.has("session_meta")) {
  console.log("session_meta:", JSON.stringify(q("select * from session_meta limit 3"), null, 1).slice(0, 1500));
}
