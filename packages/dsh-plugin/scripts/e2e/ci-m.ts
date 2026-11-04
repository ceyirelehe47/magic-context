// Round 26 e2e helper (scenario M, checks M1–M5): a LEGACY Magic DB as the
// dsh ≤ 0.49.35-dsh.3 builds left it (known limitations 19/20), for the BUILT
// CLI (`node dist/cli.js migrate-legacy`) and a real DSH run.
//
//   bun scripts/e2e/ci-m.ts fixture <context.db> <projectDir>   # build it (fresh path only)
//   bun scripts/e2e/ci-m.ts digest  <context.db>                # logical digest (read-only)
//   bun scripts/e2e/ci-m.ts state   <context.db> <projectDir>   # memories / FTS / flags summary
//
// <projectDir> is the directory the DSH process runs in (its raw path is what
// the pre-`8a7864594` historian wrote as project_path). Prints JSON only.
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { insertMemory, updateMemoryStatus } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { Database as CoreDatabase } from "@magic-context/core/shared/sqlite";
import { initializeDshAdapterTables } from "../../src/agent/outbox";
import { databaseDigest } from "../../src/doctor/migrate-legacy";
import { createTestDb } from "../../src/test-utils";

export const M_CODES = {
  live: "ARCH-KESTREL-4127",
  cancelled: "TODO-BISON-9074",
  unique: "RULE-MARMOT-5830",
};
const SESSION = "dsh:e2e00000:sess-legacy-m";
const LIVE = `Every write to the ledger goes through the outbox saga (codeword ${M_CODES.live}).`;
const CANCELLED = `Open todo: add a pruning job for stale historian leases (codeword ${M_CODES.cancelled}).`;
const UNIQUE = `User constraint: never run database migrations from a background worker (codeword ${M_CODES.unique}).`;
const M0 = `<session-history>\n<compartment start="1" end="8" title="facts">Saved.</compartment>\n</session-history>\n<project-memory>\n- [16] ${LIVE}\n</project-memory>`;
const HINT = "\n\n<ctx-search-hint>\nYour memory may contain 2 related fragments:\n- Every write to ledger goes through outbox saga…\nIf the fragments above seem relevant to the current request, you may run ctx_search. Otherwise ignore.\n</ctx-search-hint>";

const [cmd, dbPath, projectDir] = process.argv.slice(2);

async function fixture(): Promise<void> {
  if (existsSync(dbPath!)) throw new Error(`fixture: ${dbPath} exists (refusing to touch a real DB)`);
  const db = await createTestDb(dbPath!);
  initializeDshAdapterTables(db);
  const identity = resolveProjectIdentityForSession(projectDir!) as string;
  const mem = (path: string, category: string, content: string, extra: Record<string, unknown> = {}) =>
    insertMemory(db, { projectPath: path, category: category as never, content, sourceType: "historian", ...extra } as never).id;
  const ids: Record<string, number> = {};
  ids.live = mem(identity, "ARCHITECTURE_DECISIONS", LIVE, { sourceType: "agent" });
  ids.cancelled = mem(identity, "WORKFLOW_RULES", CANCELLED, { sourceType: "agent" });
  updateMemoryStatus(db, ids.cancelled, "archived");
  // raw-path rows (historian before 8a7864594)
  ids.rawDuplicate = mem(projectDir!, "ARCHITECTURE_DECISIONS", LIVE);
  ids.rawCancelledCopy = mem(projectDir!, "WORKFLOW_RULES", CANCELLED);
  ids.rawUnique = mem(projectDir!, "CONSTRAINTS", UNIQUE);
  const fts = (ordinal: number, content: string) => {
    const res = db
      .prepare("INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)")
      .run(SESSION, ordinal, `m${ordinal}`, "user", content) as { lastInsertRowid: number | bigint };
    db.prepare("INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms) VALUES (?, ?, ?, ?)").run(
      SESSION, ordinal, Number(res.lastInsertRowid), ordinal * 1000);
  };
  fts(1, "Fact 1 of 4 about this project: remember it.");
  fts(9, M0);
  fts(11, HINT);
  fts(12, `Read src/agent/outbox.ts and name its first export.${HINT}`);
  appendCompartments(db, SESSION, [
    { sequence: 0, startMessage: 1, endMessage: 8, startMessageId: "m1", endMessageId: "m8", title: "Persisted four codeword-tagged facts", content: "Saved the facts." },
    { sequence: 1, startMessage: 9, endMessage: 12, startMessageId: "m9", endMessageId: "m12", title: "Received a pasted session-history/project-memory block", content: "The user pasted the project-memory block listing all four facts." },
  ] as never);
  db.close();
  console.log(JSON.stringify({ dbPath, projectDir, identity, ids }));
}

function digest(): void {
  const db = new CoreDatabase(dbPath!, { readonly: true });
  try {
    console.log(JSON.stringify(databaseDigest(db)));
  } finally {
    db.close();
  }
}

function state(): void {
  const identity = resolveProjectIdentityForSession(projectDir!) as string;
  const db = new Database(dbPath!, { readonly: true });
  const rows = db.query("select id, project_path, status, content from memories order by id").all() as Array<{
    id: number; project_path: string; status: string; content: string;
  }>;
  const code = (c: string) => Object.entries(M_CODES).find(([, v]) => c.includes(v))?.[0] ?? "other";
  const tables = (db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name);
  const count = (t: string) => (tables.includes(t) ? (db.query(`select count(*) n from "${t}"`).get() as { n: number }).n : null);
  const ftsInjected = (db.query("select count(*) n from message_history_fts where content like '%<ctx-search-hint>%' or content like '%<session-history>%'").get() as { n: number }).n;
  console.log(
    JSON.stringify({
      identity,
      memories: rows.map((r) => ({ id: r.id, code: code(r.content), scope: r.project_path === identity ? "identity" : r.project_path === projectDir ? "raw" : "other", status: r.status })),
      activeUnderIdentity: rows.filter((r) => r.project_path === identity && (r.status === "active" || r.status === "permanent")).map((r) => code(r.content)),
      memoryCount: rows.length,
      compartmentCount: count("compartments"),
      ftsInjected,
      legacyFlags: count("dsh_legacy_flags"),
      migrationLog: count("dsh_legacy_migration_log"),
    }),
  );
}

if (cmd === "fixture" && dbPath && projectDir) await fixture();
else if (cmd === "digest" && dbPath) digest();
else if (cmd === "state" && dbPath && projectDir) state();
else {
  console.error("usage: ci-m.ts fixture|digest|state <context.db> [projectDir]");
  process.exit(2);
}
