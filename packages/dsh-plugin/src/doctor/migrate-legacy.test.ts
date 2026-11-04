/**
 * Round 26 (P0-1) — legacy data left by dsh ≤ 0.49.35-dsh.2/.3 builds
 * (known limitations 19/20).
 *
 * The fixture is built the way those builds wrote it:
 *   - the historian (before `8a7864594`) promoted facts with
 *     `project_path = <raw directory>` — exact copies of agent memories, a
 *     re-promotion of a fact the user CANCELLED (archived under the identity),
 *     a paraphrase of it, and genuinely new facts;
 *   - the message-history FTS index (between `4a586cb21` and `a529b7846`)
 *     indexed Magic's own injected messages (m0 baseline, `<ctx-search-hint>`);
 *   - the historian summarised those into compartments ("received a pasted
 *     session-history/project-memory block").
 *
 * Contract: scan is read-only and exact; apply runs in one transaction, never
 * deletes a memory or a compartment, makes unique orphans injectable under the
 * project identity, archives (not deletes) duplicates, never re-activates a
 * cancelled fact, re-indexes polluted FTS rows, flags polluted compartments;
 * apply is idempotent; restore from the backup reproduces the pre-migration DB.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { getMemoriesByProject, insertMemory, updateMemoryStatus } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { Database as SqliteDatabase, type Database } from "@magic-context/core/shared/sqlite";
import { initializeDshAdapterTables } from "../agent/outbox";
import { createTestDb } from "../test-utils";
import {
  applyLegacyMigration,
  backupDatabase,
  databaseDigest,
  integrityCheck,
  planLegacyMigration,
  recompSuggestions,
  restoreDatabase,
  runMigrateLegacy,
  scanLegacyData,
  setLegacyIdentityResolver,
  stripInjectedBlocks,
} from "./migrate-legacy";

const SESSION = "dsh:a1b2c3d4:sess-legacy";
const LIVE = "Every write to the ledger goes through the outbox saga (codeword ARCH-KESTREL-4127).";
const CANCELLED = "Open todo: add a pruning job for stale historian leases (codeword TODO-BISON-9074).";
const PARAPHRASE = "Open todo: add pruning job for stale historian leases soon (codeword TODO-BISON-9074).";
const NEW_FACT = "User constraint: never run database migrations from a background worker (codeword RULE-MARMOT-5830).";
const SP_FACT = "File relation: the quota gauge module src/host/meter.ts reads src/host/context-details.ts (codeword FILE-HERON-2261).";
const LOST_FACT = "Constraint from a deleted checkout nobody can resolve (codeword LOST-OWL-1111).";
const M0 = `<session-history>\n<compartment start="1" end="8" title="facts">Saved.</compartment>\n</session-history>\n<project-memory>\n- [16] ${LIVE}\n</project-memory>`;
const HINT = "\n\n<ctx-search-hint>\nYour memory may contain 2 related fragments:\n- Every write to ledger goes through outbox saga…\nIf the fragments above seem relevant to the current request, you may run ctx_search. Otherwise ignore.\n</ctx-search-hint>";

interface Fixture {
  db: Database;
  root: string;
  storage: string;
  dbPath: string;
  projectDir: string;
  identity: string;
  ids: Record<string, number>;
  resolve: (raw: string) => string | null;
}

function mem(db: Database, projectPath: string, category: string, content: string, extra: Record<string, unknown> = {}): number {
  return insertMemory(db, { projectPath, category: category as never, content, sourceType: "historian", ...extra } as never).id;
}

function ftsRow(db: Database, ordinal: number, role: string, content: string): number {
  const res = db
    .prepare("INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)")
    .run(SESSION, ordinal, `m${ordinal}`, role, content) as { lastInsertRowid: number | bigint };
  const rowid = Number(res.lastInsertRowid);
  db.prepare("INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms) VALUES (?, ?, ?, ?)").run(
    SESSION,
    ordinal,
    rowid,
    ordinal * 1000,
  );
  return rowid;
}

async function legacyFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "dsh-magic-legacy-"));
  const storage = join(root, "storage");
  mkdirSync(storage);
  const projectDir = join(root, "project");
  mkdirSync(projectDir);
  const dbPath = join(storage, "context.db");
  const db = await createTestDb(dbPath);
  initializeDshAdapterTables(db);
  const identity = resolveProjectIdentityForSession(projectDir) as string;
  const goneDir = join(root, "gone-checkout");
  const goneDir2 = join(root, "gone-unknown");
  // A raw dir that no longer exists resolves through session_projects only.
  db.prepare("INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'dsh', ?, ?)").run("dsh:a1b2c3d4:sess-gone", identity, Date.now());
  const ids: Record<string, number> = {};
  // Identity-scope rows (the agent's ctx_memory writes).
  ids.live = mem(db, identity, "ARCHITECTURE_DECISIONS", LIVE, { sourceType: "agent" });
  ids.cancelled = mem(db, identity, "WORKFLOW_RULES", CANCELLED, { sourceType: "agent" });
  updateMemoryStatus(db, ids.cancelled, "archived");
  ids.pollutedIdentity = mem(db, identity, "KNOWN_ISSUES", `Pasted context:\n<project-memory>\n- [16] ${LIVE}\n</project-memory>`);
  // Raw-path rows (historian before 8a7864594).
  ids.rawDuplicate = mem(db, projectDir, "ARCHITECTURE_DECISIONS", LIVE);
  ids.rawCancelledCopy = mem(db, projectDir, "WORKFLOW_RULES", CANCELLED);
  ids.rawParaphrase = mem(db, projectDir, "WORKFLOW_RULES", PARAPHRASE);
  ids.rawUnique = mem(db, projectDir, "CONSTRAINTS", NEW_FACT);
  ids.rawViaSession = mem(db, goneDir, "ARCHITECTURE_DECISIONS", SP_FACT, { sourceSessionId: "dsh:a1b2c3d4:sess-gone" });
  ids.rawUnresolvable = mem(db, goneDir2, "CONSTRAINTS", LOST_FACT);
  // Polluted FTS rows + clean ones.
  ids.ftsClean = ftsRow(db, 1, "user", "Fact 1 of 4 about this project: remember it.");
  ids.ftsM0 = ftsRow(db, 9, "user", M0);
  ids.ftsHint = ftsRow(db, 11, "user", HINT);
  ids.ftsMixed = ftsRow(db, 12, "user", `Read src/agent/outbox.ts and name its first export.${HINT}`);
  // Compartments: one summarising the injected block, one clean.
  appendCompartments(db, SESSION, [
    { sequence: 0, startMessage: 1, endMessage: 8, startMessageId: "m1", endMessageId: "m8", title: "Persisted four codeword-tagged facts", content: "Saved the facts." },
    { sequence: 1, startMessage: 9, endMessage: 12, startMessageId: "m9", endMessageId: "m12", title: "Received a pasted session-history/project-memory block", content: "The user pasted the project-memory block listing all four facts." },
  ] as never);
  const comps = db.prepare("SELECT id, start_message FROM compartments WHERE session_id = ? ORDER BY sequence").all(SESSION) as Array<{ id: number }>;
  ids.compClean = comps[0]!.id;
  ids.compPolluted = comps[1]!.id;
  const resolve = (raw: string): string | null => (raw === projectDir ? identity : null);
  return { db, root, storage, dbPath, projectDir, identity, ids, resolve };
}

function cleanup(f: Fixture): void {
  try {
    f.db.close();
  } catch {
    /* closed */
  }
  rmSync(f.root, { recursive: true, force: true });
}

function activeContents(db: Database, identity: string): string[] {
  return getMemoriesByProject(db, identity, ["active", "permanent"]).map((m) => m.content);
}

describe("migrate-legacy (round 26 P0-1)", () => {
  it("scan is read-only and classifies every legacy row exactly", async () => {
    const f = await legacyFixture();
    try {
      const before = databaseDigest(f.db).digest;
      const scan = scanLegacyData(f.db, { resolveIdentity: f.resolve });
      const cls = Object.fromEntries(scan.orphans.map((o) => [o.id, o.classification]));
      expect(cls).toEqual({
        [f.ids.rawDuplicate!]: "duplicate",
        [f.ids.rawCancelledCopy!]: "archived-duplicate",
        [f.ids.rawParaphrase!]: "similar-to-archived",
        [f.ids.rawUnique!]: "unique",
        [f.ids.rawViaSession!]: "unique",
        [f.ids.rawUnresolvable!]: "unresolvable",
      });
      expect(scan.orphans.find((o) => o.id === f.ids.rawDuplicate)?.targetId).toBe(f.ids.live);
      expect(scan.orphans.find((o) => o.id === f.ids.rawCancelledCopy)?.targetId).toBe(f.ids.cancelled);
      expect(scan.orphans.find((o) => o.id === f.ids.rawViaSession)?.identitySource).toBe("session_projects");
      expect(scan.pollutedFts.map((r) => r.rowid).sort()).toEqual([f.ids.ftsM0!, f.ids.ftsHint!, f.ids.ftsMixed!].sort());
      expect(scan.pollutedFts.find((r) => r.rowid === f.ids.ftsMixed)?.cleaned).toBe("Read src/agent/outbox.ts and name its first export.");
      expect(scan.pollutedFts.find((r) => r.rowid === f.ids.ftsM0)?.cleaned).toBe("");
      expect(scan.pollutedCompartments.map((c) => c.id)).toEqual([f.ids.compPolluted!]);
      expect(scan.pollutedMemories.map((m) => m.id)).toEqual([f.ids.pollutedIdentity!]);
      expect(databaseDigest(f.db).digest).toBe(before);
      // The new fact is NOT injectable before the migration (limitation 20).
      expect(activeContents(f.db, f.identity)).not.toContain(NEW_FACT);
    } finally {
      cleanup(f);
    }
  });

  it("apply: one transaction, nothing deleted, unique facts injectable, cancelled fact stays cancelled, FTS re-indexed, compartments flagged", async () => {
    const f = await legacyFixture();
    try {
      const memCount = (f.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
      const compBefore = f.db.prepare("SELECT * FROM compartments ORDER BY id").all();
      const ops = planLegacyMigration(scanLegacyData(f.db, { resolveIdentity: f.resolve }));
      const result = applyLegacyMigration(f.db, ops, { runId: "test-run" });
      expect(result.applied).toEqual({
        "memory-move": 2,
        "memory-move-archived": 1,
        "memory-archive-duplicate": 2,
        "memory-archive-polluted": 1,
        "fts-strip": 3,
        "compartment-flag": 1,
      });
      expect((f.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n).toBe(memCount);
      expect(f.db.prepare("SELECT * FROM compartments ORDER BY id").all()).toEqual(compBefore);
      const active = activeContents(f.db, f.identity);
      expect(active).toContain(NEW_FACT);
      expect(active).toContain(SP_FACT);
      expect(active).toContain(LIVE);
      expect(active).not.toContain(CANCELLED);
      expect(active).not.toContain(PARAPHRASE);
      expect(active.filter((c) => c === LIVE)).toHaveLength(1);
      const row = (id: number) => f.db.prepare("SELECT project_path, status, superseded_by_memory_id, metadata_json FROM memories WHERE id = ?").get(id) as Record<string, unknown>;
      expect(row(f.ids.rawDuplicate!)).toMatchObject({ status: "archived", superseded_by_memory_id: f.ids.live });
      expect(row(f.ids.rawCancelledCopy!)).toMatchObject({ status: "archived", superseded_by_memory_id: f.ids.cancelled });
      expect(row(f.ids.rawParaphrase!)).toMatchObject({ project_path: f.identity, status: "archived" });
      expect(row(f.ids.rawUnresolvable!)).toMatchObject({ status: "active", metadata_json: null });
      expect(JSON.parse(String(row(f.ids.rawUnique!).metadata_json)).dshLegacyMigration).toMatchObject({ action: "moved", fromProjectPath: f.projectDir });
      // FTS: injected blocks gone, real text still searchable, map consistent.
      const hits = (q: string) => (f.db.prepare("SELECT rowid AS rowid FROM message_history_fts WHERE message_history_fts MATCH ?").all(q) as Array<{ rowid: number }>).map((r) => Number(r.rowid)).sort();
      expect(hits('"ARCH-KESTREL-4127"')).toEqual([]);
      expect(hits('"related fragments"')).toEqual([]);
      expect(hits("outbox")).toEqual([f.ids.ftsMixed!]);
      expect(hits("remember")).toEqual([f.ids.ftsClean!]);
      const mapped = (f.db.prepare("SELECT fts_rowid FROM message_fts_rowid_map WHERE session_id = ? ORDER BY fts_rowid").all(SESSION) as Array<{ fts_rowid: number }>).map((r) => r.fts_rowid);
      expect(mapped).toEqual([f.ids.ftsClean!, f.ids.ftsMixed!].sort((a, b) => a - b));
      expect(recompSuggestions(f.db)).toEqual([{ sessionId: SESSION, dshSessionId: "sess-legacy", range: "9-12", compartments: 1 }]);
      expect((f.db.prepare("SELECT COUNT(*) AS n FROM dsh_legacy_migration_log WHERE run_id = 'test-run'").get() as { n: number }).n).toBe(10);
      expect(integrityCheck(f.db)).toBe("ok");
    } finally {
      cleanup(f);
    }
  });

  it("apply is idempotent", async () => {
    const f = await legacyFixture();
    try {
      applyLegacyMigration(f.db, planLegacyMigration(scanLegacyData(f.db, { resolveIdentity: f.resolve })));
      const after1 = databaseDigest(f.db).digest;
      const scan2 = scanLegacyData(f.db, { resolveIdentity: f.resolve });
      const ops2 = planLegacyMigration(scan2);
      expect(ops2).toEqual([]);
      expect(scan2.pollutedFts).toEqual([]);
      expect(scan2.pollutedCompartments.every((c) => c.alreadyFlagged)).toBe(true);
      applyLegacyMigration(f.db, ops2);
      expect(databaseDigest(f.db).digest).toBe(after1);
    } finally {
      cleanup(f);
    }
  });

  it("an aborted apply rolls back completely (single transaction)", async () => {
    const f = await legacyFixture();
    try {
      const before = databaseDigest(f.db).digest;
      const ops = planLegacyMigration(scanLegacyData(f.db, { resolveIdentity: f.resolve }));
      // The last op refers to a row that changed after the scan.
      const broken = [...ops, { kind: "memory-move" as const, id: 999_999, from: "/nope", to: f.identity, keepStatus: "active", reason: "unique" as const }];
      expect(() => applyLegacyMigration(f.db, broken)).toThrow(/changed since the scan/);
      // ensureLegacyTables runs before the transaction (DDL, empty tables); data unchanged.
      f.db.exec("DROP TABLE IF EXISTS dsh_legacy_migration_log; DROP TABLE IF EXISTS dsh_legacy_flags;");
      expect(databaseDigest(f.db).digest).toBe(before);
    } finally {
      cleanup(f);
    }
  });

  it("backup → apply → restore reproduces the pre-migration DB", async () => {
    const f = await legacyFixture();
    try {
      const pre = databaseDigest(f.db).digest;
      const backup = backupDatabase(f.db, f.dbPath);
      expect(backup.integrity).toBe("ok");
      expect(backup.digest).toBe(pre);
      applyLegacyMigration(f.db, planLegacyMigration(scanLegacyData(f.db, { resolveIdentity: f.resolve })));
      expect(databaseDigest(f.db).digest).not.toBe(pre);
      f.db.close();
      const restored = restoreDatabase(backup.path, f.dbPath);
      expect(restored).toMatchObject({ ok: true, integrity: "ok", expectedDigest: pre, actualDigest: pre });
      expect(restored.safetyCopy !== null && existsSync(restored.safetyCopy)).toBe(true);
      const reopened = new SqliteDatabase(f.dbPath, { readonly: true });
      try {
        expect(databaseDigest(reopened).digest).toBe(pre);
      } finally {
        reopened.close();
      }
    } finally {
      cleanup(f);
    }
  });

  it("empty DB and missing DB: no error, nothing to do", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-magic-legacy-empty-"));
    try {
      const db = await createTestDb(join(root, "context.db"));
      try {
        const scan = scanLegacyData(db);
        expect(scan.orphans).toEqual([]);
        expect(planLegacyMigration(scan)).toEqual([]);
        expect(applyLegacyMigration(db, []).applied["memory-move"]).toBe(0);
        expect(integrityCheck(db)).toBe("ok");
      } finally {
        db.close();
      }
      const out: string[] = [];
      const code = await runMigrateLegacy(["--db", join(root, "missing.db")], { out: (l) => out.push(l), storageDir: () => root });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("nothing to migrate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CLI: scan/dry-run write nothing; --apply backs up, migrates and prints the rollback; --restore verifies", async () => {
    const f = await legacyFixture();
    try {
      setLegacyIdentityResolver((raw) => resolveProjectIdentityForSession(raw));
      const pre = databaseDigest(f.db).digest;
      f.db.close();
      const run = async (...args: string[]) => {
        const out: string[] = [];
        const code = await runMigrateLegacy(["--storage-dir", f.storage, ...args], { out: (l) => out.push(l), storageDir: () => f.storage });
        return { code, text: out.join("\n") };
      };
      const digestNow = () => {
        const d = new SqliteDatabase(f.dbPath, { readonly: true });
        try {
          return databaseDigest(d).digest;
        } finally {
          d.close();
        }
      };
      const scan = await run();
      expect(scan.code).toBe(0);
      expect(scan.text).toContain("unique: 2");
      expect(scan.text).toContain("Compartments with injected text: 1");
      const dry = await run("--dry-run");
      expect(dry.text).toContain("flag for /ctx-recomp");
      expect(digestNow()).toBe(pre);
      const apply = await run("--apply");
      expect(apply.code).toBe(0);
      expect(apply.text).toContain("/ctx-recomp 9-12");
      const backupPath = /rollback: dsh-magic-context migrate-legacy --restore (\S+)/.exec(apply.text)?.[1];
      expect(backupPath && existsSync(backupPath)).toBeTruthy();
      expect(digestNow()).not.toBe(pre);
      const again = await run("--apply");
      expect(again.text).toContain("Nothing to apply");
      const restore = await run("--restore", backupPath as string);
      expect(restore.code).toBe(0);
      expect(restore.text).toContain("MATCH");
      expect(digestNow()).toBe(pre);
    } finally {
      cleanup(f);
    }
  });

  it("stripInjectedBlocks keeps real text and drops unclosed blocks to the end", () => {
    expect(stripInjectedBlocks(`hello${HINT}`)).toBe("hello");
    expect(stripInjectedBlocks("a <project-memory>\n- x")).toBe("a");
    expect(stripInjectedBlocks("no blocks here")).toBe("no blocks here");
  });
});
