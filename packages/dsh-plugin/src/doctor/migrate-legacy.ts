/**
 * doctor/migrate-legacy — round 26 (P0-1): repair data written by earlier
 * dsh-magic-context builds (known limitations 19/20).
 *
 * What earlier builds left behind:
 *   1. Orphan memories under the RAW directory path. Before `8a7864594`
 *      (round 25) the DSH historian promoted facts with
 *      `project_path = <raw directory>` instead of the resolved project
 *      identity (`git:…` / `dir:…`). Those rows are never injected and never
 *      seen by core's exact-hash dedup (which also matches ARCHIVED rows, so a
 *      cancelled fact is not re-activated).
 *   2. Message-history FTS rows holding Magic's OWN injected text (m0
 *      `<session-history>` / `<project-memory>`, `<ctx-search-hint>`, …),
 *      indexed before `a529b7846` (round 24c). Core reconciles incrementally
 *      and never re-checks old rows.
 *   3. Compartments the historian wrote while it still read the injected text
 *      (it summarised m0 / hints into unrelated turns).
 *
 * Modes (CLI `dsh-magic-context migrate-legacy`):
 *   scan (default)  read-only; opens the DB read-only and never writes.
 *   --backup        `VACUUM INTO` a timestamped copy + `PRAGMA integrity_check`
 *                   + a `.meta.json` with the logical digest of the copy.
 *   --dry-run       scan + the exact list of operations `--apply` would run.
 *   --apply         backup first (always), then every operation in ONE
 *                   IMMEDIATE transaction. Nothing is deleted from `memories`
 *                   or `compartments`:
 *                     unique orphan          → moved under the project identity
 *                     exact duplicate        → status archived +
 *                                              superseded_by_memory_id (kept)
 *                     similar to an archived → moved, kept archived (a cancelled
 *                                              fact's paraphrase must not come
 *                                              back; `--keep-similar-active`)
 *                     polluted FTS row       → re-indexed in place: the injected
 *                                              blocks are stripped (= what the
 *                                              current indexer writes); a row
 *                                              that was only injected text is
 *                                              removed from the index (+ its
 *                                              rowid map entry)
 *                     polluted compartment   → flagged in `dsh_legacy_flags`,
 *                                              never rewritten; the report gives
 *                                              the `/ctx-recomp <a>-<b>` to run
 *                   Every operation is journaled (before/after) in
 *                   `dsh_legacy_migration_log`. Idempotent: handled rows carry
 *                   `metadata_json.dshLegacyMigration`, stripped FTS rows no
 *                   longer match, flagged compartments are not re-flagged.
 *   --restore <f>   copy a backup back over the DB (live DSH/OpenCode/Pi
 *                   processes refuse it unless `--force`), keep a pre-restore
 *                   safety copy, and verify the restored digest equals the
 *                   backup's recorded digest.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Database as SqliteDatabase, type Database } from "@magic-context/core/shared/sqlite";
import { isPidAlive } from "@magic-context/core/shared/rpc-utils";

/* ─────────────────────────────── markers ─────────────────────────────── */

/** Block tags Magic injects (m0 baseline, auto-search hint). */
export const INJECTED_BLOCK_TAGS = [
  "session-history",
  "project-memory",
  "project-docs",
  "user-profile",
  "key-files",
  "ctx-search-hint",
] as const;

const BLOCK_OPEN_RE = new RegExp(`<(${INJECTED_BLOCK_TAGS.join("|")})(\\s[^>]*)?>`, "i");
/**
 * Compartments rarely hold the literal tags: the historian PARAPHRASED the
 * injected blocks ("received a pasted session-history/project-memory block").
 * The hyphenated block names are distinctive enough; the hint's fixed sentence
 * too. Heuristic — a compartment that restates a fact without naming the block
 * is not detectable (documented limit).
 */
const COMPARTMENT_MARKER_RE = new RegExp(
  `<\\/?(${INJECTED_BLOCK_TAGS.join("|")})\\b|\\b(session-history|project-memory|ctx-search-hint|search-hint)\\b|memory may contain \\d+ related fragments`,
  "i",
);

export function injectedMarkersIn(text: string | null | undefined): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const found = new Set<string>();
  const re = new RegExp(`<(${INJECTED_BLOCK_TAGS.join("|")})(\\s[^>]*)?>`, "gi");
  for (const match of text.matchAll(re)) found.add(`<${match[1]!.toLowerCase()}>`);
  return [...found];
}

/** Remove every injected block (unclosed → to the end of the text). */
export function stripInjectedBlocks(text: string): string {
  let out = text;
  for (const tag of INJECTED_BLOCK_TAGS) {
    out = out.replace(new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?(</${tag}\\s*>|$(?![\\s\\S]))`, "gi"), "");
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function compartmentMarkers(row: Record<string, unknown>): string[] {
  const found = new Set<string>();
  for (const col of ["title", "content", "p1", "p2", "p3", "p4"]) {
    const value = row[col];
    if (typeof value !== "string") continue;
    const m = value.match(COMPARTMENT_MARKER_RE);
    if (m !== null) found.add(`${col}:${m[0].toLowerCase()}`);
  }
  return [...found];
}

/* ─────────────────────────────── scan ─────────────────────────────── */

export type OrphanClass =
  | "duplicate" // same category + normalized_hash active/permanent under identity
  | "archived-duplicate" // … archived under identity (a cancelled fact)
  | "similar-to-archived" // paraphrase of an archived identity memory
  | "unique"
  | "unresolvable"
  | "already-migrated";

export interface OrphanMemory {
  readonly id: number;
  readonly rawPath: string;
  readonly identity: string | null;
  readonly identitySource: "resolve" | "session_projects" | null;
  readonly category: string;
  readonly status: string;
  readonly content: string;
  readonly classification: OrphanClass;
  /** Identity row it duplicates / resembles. */
  readonly targetId?: number;
}

export interface PollutedFtsRow {
  readonly rowid: number;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly role: string;
  readonly markers: string[];
  readonly sample: string;
  /** Content after stripping; empty → the row was only injected text. */
  readonly cleaned: string;
}

export interface PollutedCompartment {
  readonly id: number;
  readonly sessionId: string;
  readonly start: number;
  readonly end: number;
  readonly title: string;
  readonly markers: string[];
  readonly alreadyFlagged: boolean;
}

export interface PollutedMemory {
  readonly id: number;
  readonly projectPath: string;
  readonly markers: string[];
  readonly sample: string;
}

export interface LegacyScan {
  readonly dbPath: string | null;
  readonly orphans: OrphanMemory[];
  readonly pollutedFts: PollutedFtsRow[];
  readonly pollutedCompartments: PollutedCompartment[];
  readonly pollutedMemories: PollutedMemory[];
  readonly counts: Record<string, number>;
}

export interface ScanOptions {
  /** raw directory → project identity (default: core's resolver, then session_projects). */
  readonly resolveIdentity?: (rawPath: string) => string | null;
}

function tableExists(db: Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table','view')").get(name) != null;
}

function columnNames(db: Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

function isIdentity(path: string): boolean {
  return path.startsWith("git:") || path.startsWith("dir:");
}

function defaultResolveIdentity(rawPath: string): string | null {
  try {
    // core's resolver hashes a MISSING directory into a fresh `dir:` identity
    // (round 26 test: a deleted checkout got an unrelated `dir:` key) — moving
    // memories there would orphan them again. Missing → session_projects / none.
    if (!existsSync(rawPath) || !statSync(rawPath).isDirectory()) return null;
    // Injected (CLI: core's resolveProjectIdentityForSession) so tests and
    // read paths that never need git probes do not load it.
    const resolved = resolveIdentityImpl?.(rawPath);
    return typeof resolved === "string" && isIdentity(resolved) ? resolved : null;
  } catch {
    return null;
  }
}
let resolveIdentityImpl: ((raw: string) => string | undefined) | undefined;
/** Wired by the CLI entry (core's `resolveProjectIdentityForSession`). */
export function setLegacyIdentityResolver(fn: (raw: string) => string | undefined): void {
  resolveIdentityImpl = fn;
}

function migrationMeta(row: { metadata_json?: unknown }): Record<string, unknown> | null {
  if (typeof row.metadata_json !== "string" || row.metadata_json === "") return null;
  try {
    const parsed = JSON.parse(row.metadata_json) as Record<string, unknown>;
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff_-]+/)
      .filter((w) => w.length >= 3),
  );
}

export function jaccard(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  return inter / (wa.size + wb.size - inter);
}

/** Paraphrase threshold for "similar to an archived identity memory". */
export const SIMILAR_THRESHOLD = 0.6;

function sample(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function scanLegacyData(db: Database, opts: ScanOptions = {}, dbPath: string | null = null): LegacyScan {
  const resolve = opts.resolveIdentity ?? defaultResolveIdentity;
  const orphans: OrphanMemory[] = [];
  const pollutedFts: PollutedFtsRow[] = [];
  const pollutedCompartments: PollutedCompartment[] = [];
  const pollutedMemories: PollutedMemory[] = [];

  if (tableExists(db, "memories")) {
    const sessionProject = tableExists(db, "session_projects")
      ? db.prepare("SELECT project_path FROM session_projects WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1")
      : null;
    const rows = db
      .prepare(
        "SELECT id, project_path, category, content, normalized_hash, status, source_session_id, metadata_json FROM memories WHERE project_path NOT LIKE 'git:%' AND project_path NOT LIKE 'dir:%' ORDER BY id",
      )
      .all() as Array<{
      id: number;
      project_path: string;
      category: string;
      content: string;
      normalized_hash: string;
      status: string | null;
      source_session_id: string | null;
      metadata_json: string | null;
    }>;
    const identityCache = new Map<string, { identity: string | null; source: OrphanMemory["identitySource"] }>();
    const byHash = db.prepare(
      "SELECT id, status FROM memories WHERE project_path = ? AND category = ? AND normalized_hash = ? LIMIT 1",
    );
    const archivedOf = db.prepare(
      "SELECT id, content FROM memories WHERE project_path = ? AND category = ? AND status = 'archived' ORDER BY id",
    );
    // Planned moves: identity|category|hash → raw row id, so two raw paths of
    // one project (or a raw row repeated) never plan two rows into one UNIQUE slot.
    const planned = new Map<string, number>();
    for (const row of rows) {
      const status = row.status ?? "active";
      const meta = migrationMeta(row);
      let resolved = identityCache.get(row.project_path);
      if (resolved === undefined) {
        const identity = resolve(row.project_path);
        resolved = { identity, source: identity === null ? null : "resolve" };
        identityCache.set(row.project_path, resolved);
      }
      let { identity, source } = resolved;
      if (identity === null && sessionProject !== null && row.source_session_id) {
        const sp = sessionProject.get(row.source_session_id) as { project_path?: string } | null;
        if (sp?.project_path && isIdentity(sp.project_path)) {
          identity = sp.project_path;
          source = "session_projects";
        }
      }
      const base = {
        id: row.id,
        rawPath: row.project_path,
        identity,
        identitySource: source,
        category: row.category,
        status,
        content: row.content,
      };
      if (meta?.dshLegacyMigration !== undefined) {
        orphans.push({ ...base, classification: "already-migrated" });
        continue;
      }
      if (identity === null) {
        orphans.push({ ...base, classification: "unresolvable" });
        continue;
      }
      const key = `${identity}\u0000${row.category}\u0000${row.normalized_hash}`;
      const existing = byHash.get(identity, row.category, row.normalized_hash) as { id: number; status: string | null } | null;
      if (existing != null) {
        orphans.push({
          ...base,
          classification: (existing.status ?? "active") === "archived" ? "archived-duplicate" : "duplicate",
          targetId: existing.id,
        });
        continue;
      }
      const plannedId = planned.get(key);
      if (plannedId !== undefined) {
        orphans.push({ ...base, classification: "duplicate", targetId: plannedId });
        continue;
      }
      planned.set(key, row.id);
      if (status !== "archived") {
        const archived = archivedOf.all(identity, row.category) as Array<{ id: number; content: string }>;
        let best: { id: number; score: number } | null = null;
        for (const candidate of archived) {
          const score = jaccard(row.content, candidate.content);
          if (score >= SIMILAR_THRESHOLD && (best === null || score > best.score)) best = { id: candidate.id, score };
        }
        if (best !== null) {
          orphans.push({ ...base, classification: "similar-to-archived", targetId: best.id });
          continue;
        }
      }
      orphans.push({ ...base, classification: "unique" });
    }

    // Identity-scope memories whose content IS an injected block (historian
    // promoted the pasted block itself). Already-handled rows are skipped.
    const polluted = db
      .prepare(
        `SELECT id, project_path, content, status, metadata_json FROM memories WHERE status != 'archived' AND (${INJECTED_BLOCK_TAGS.map(() => "content LIKE ?").join(" OR ")}) ORDER BY id`,
      )
      .all(...INJECTED_BLOCK_TAGS.map((t) => `%<${t}%`)) as Array<{ id: number; project_path: string; content: string; metadata_json: string | null }>;
    for (const row of polluted) {
      const markers = injectedMarkersIn(row.content);
      if (markers.length === 0) continue;
      if (migrationMeta(row)?.dshLegacyMigration !== undefined) continue;
      pollutedMemories.push({ id: row.id, projectPath: row.project_path, markers, sample: sample(row.content) });
    }
  }

  if (tableExists(db, "message_history_fts")) {
    const rows = db
      .prepare(
        `SELECT rowid AS rowid, session_id, message_ordinal, role, content FROM message_history_fts WHERE ${INJECTED_BLOCK_TAGS.map(() => "content LIKE ?").join(" OR ")} ORDER BY rowid`,
      )
      .all(...INJECTED_BLOCK_TAGS.map((t) => `%<${t}%`)) as Array<{
      rowid: number;
      session_id: string;
      message_ordinal: number | string;
      role: string;
      content: string;
    }>;
    for (const row of rows) {
      const markers = injectedMarkersIn(row.content);
      if (markers.length === 0 || !BLOCK_OPEN_RE.test(row.content)) continue;
      pollutedFts.push({
        rowid: Number(row.rowid),
        sessionId: row.session_id,
        ordinal: Number(row.message_ordinal),
        role: row.role,
        markers,
        sample: sample(row.content),
        cleaned: stripInjectedBlocks(row.content),
      });
    }
  }

  if (tableExists(db, "compartments")) {
    const flagged = tableExists(db, "dsh_legacy_flags")
      ? new Set(
          (db.prepare("SELECT target_id FROM dsh_legacy_flags WHERE kind = 'compartment-polluted'").all() as Array<{ target_id: number }>).map(
            (r) => Number(r.target_id),
          ),
        )
      : new Set<number>();
    const rows = db
      .prepare("SELECT id, session_id, start_message, end_message, title, content, p1, p2, p3, p4 FROM compartments ORDER BY session_id, sequence")
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const markers = compartmentMarkers(row);
      if (markers.length === 0) continue;
      pollutedCompartments.push({
        id: Number(row.id),
        sessionId: String(row.session_id),
        start: Number(row.start_message),
        end: Number(row.end_message),
        title: String(row.title ?? ""),
        markers,
        alreadyFlagged: flagged.has(Number(row.id)),
      });
    }
  }

  const counts: Record<string, number> = {
    orphans: orphans.length,
    pollutedFts: pollutedFts.length,
    pollutedCompartments: pollutedCompartments.length,
    pollutedCompartmentsUnflagged: pollutedCompartments.filter((c) => !c.alreadyFlagged).length,
    pollutedMemories: pollutedMemories.length,
  };
  for (const o of orphans) counts[`orphan:${o.classification}`] = (counts[`orphan:${o.classification}`] ?? 0) + 1;
  return { dbPath, orphans, pollutedFts, pollutedCompartments, pollutedMemories, counts };
}

/* ─────────────────────────────── plan ─────────────────────────────── */

export type LegacyOp =
  | { kind: "memory-move"; id: number; from: string; to: string; keepStatus: string; reason: "unique" }
  | { kind: "memory-move-archived"; id: number; from: string; to: string; similarTo: number }
  | { kind: "memory-archive-duplicate"; id: number; supersededBy: number; reason: "duplicate" | "archived-duplicate" }
  | { kind: "memory-archive-polluted"; id: number }
  | { kind: "fts-strip"; rowid: number; sessionId: string; ordinal: number; removed: boolean }
  | { kind: "compartment-flag"; id: number; sessionId: string; start: number; end: number };

export interface PlanOptions {
  /** Move "similar to archived" orphans with their own status instead of archiving them. */
  readonly keepSimilarActive?: boolean;
}

export function planLegacyMigration(scan: LegacyScan, opts: PlanOptions = {}): LegacyOp[] {
  const ops: LegacyOp[] = [];
  for (const o of scan.orphans) {
    if (o.identity === null) continue;
    switch (o.classification) {
      case "unique":
        ops.push({ kind: "memory-move", id: o.id, from: o.rawPath, to: o.identity, keepStatus: o.status, reason: "unique" });
        break;
      case "similar-to-archived":
        if (opts.keepSimilarActive === true) {
          ops.push({ kind: "memory-move", id: o.id, from: o.rawPath, to: o.identity, keepStatus: o.status, reason: "unique" });
        } else {
          ops.push({ kind: "memory-move-archived", id: o.id, from: o.rawPath, to: o.identity, similarTo: o.targetId! });
        }
        break;
      case "duplicate":
      case "archived-duplicate":
        ops.push({ kind: "memory-archive-duplicate", id: o.id, supersededBy: o.targetId!, reason: o.classification });
        break;
      default:
        break;
    }
  }
  for (const m of scan.pollutedMemories) ops.push({ kind: "memory-archive-polluted", id: m.id });
  for (const f of scan.pollutedFts) {
    ops.push({ kind: "fts-strip", rowid: f.rowid, sessionId: f.sessionId, ordinal: f.ordinal, removed: f.cleaned.length === 0 });
  }
  for (const c of scan.pollutedCompartments) {
    if (!c.alreadyFlagged) ops.push({ kind: "compartment-flag", id: c.id, sessionId: c.sessionId, start: c.start, end: c.end });
  }
  return ops;
}

export function describeOp(op: LegacyOp): string {
  switch (op.kind) {
    case "memory-move":
      return `memory #${op.id}: move ${op.from} → ${op.to} (status ${op.keepStatus} kept)`;
    case "memory-move-archived":
      return `memory #${op.id}: move ${op.from} → ${op.to}, set archived (paraphrase of archived #${op.similarTo})`;
    case "memory-archive-duplicate":
      return `memory #${op.id}: set archived, superseded_by #${op.supersededBy} (${op.reason}; row kept)`;
    case "memory-archive-polluted":
      return `memory #${op.id}: set archived (content is an injected block; row kept)`;
    case "fts-strip":
      return op.removed
        ? `fts row ${op.rowid} (${op.sessionId} #${op.ordinal}): only injected text → removed from the index`
        : `fts row ${op.rowid} (${op.sessionId} #${op.ordinal}): strip injected blocks, re-index in place`;
    case "compartment-flag":
      return `compartment #${op.id} (${op.sessionId} ${op.start}-${op.end}): flag for /ctx-recomp (not rewritten)`;
  }
}

/** `/ctx-recomp <a>-<b>` per session covering every flagged compartment. */
export function recompSuggestions(db: Database): Array<{ sessionId: string; dshSessionId: string; range: string; compartments: number }> {
  if (!tableExists(db, "dsh_legacy_flags")) return [];
  const rows = db
    .prepare(
      "SELECT c.session_id AS session_id, MIN(c.start_message) AS a, MAX(c.end_message) AS b, COUNT(*) AS n FROM dsh_legacy_flags f JOIN compartments c ON c.id = f.target_id WHERE f.kind = 'compartment-polluted' GROUP BY c.session_id ORDER BY c.session_id",
    )
    .all() as Array<{ session_id: string; a: number; b: number; n: number }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    dshSessionId: r.session_id.split(":").slice(2).join(":") || r.session_id,
    range: `${r.a}-${r.b}`,
    compartments: Number(r.n),
  }));
}

/* ─────────────────────────────── apply ─────────────────────────────── */

export function ensureLegacyTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dsh_legacy_migration_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      op TEXT NOT NULL,
      target_table TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      before_json TEXT,
      after_json TEXT,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dsh_legacy_flags (
      kind TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      session_id TEXT,
      reason TEXT,
      run_id TEXT NOT NULL,
      flagged_at INTEGER NOT NULL,
      PRIMARY KEY(kind, target_id)
    );
  `);
}

export interface ApplyResult {
  readonly runId: string;
  readonly applied: Record<LegacyOp["kind"], number>;
  readonly ops: LegacyOp[];
}

function withMigrationMeta(raw: unknown, entry: Record<string, unknown>): string {
  let meta: Record<string, unknown> = {};
  if (typeof raw === "string" && raw !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
      else meta = { previousMetadata: parsed };
    } catch {
      meta = { previousMetadata: raw };
    }
  }
  return JSON.stringify({ ...meta, dshLegacyMigration: entry });
}

export function applyLegacyMigration(
  db: Database,
  ops: readonly LegacyOp[],
  opts: { runId?: string; now?: number } = {},
): ApplyResult {
  const runId = opts.runId ?? `mig-${new Date(opts.now ?? Date.now()).toISOString().replace(/[:.]/g, "-")}`;
  const now = opts.now ?? Date.now();
  const applied: Record<LegacyOp["kind"], number> = {
    "memory-move": 0,
    "memory-move-archived": 0,
    "memory-archive-duplicate": 0,
    "memory-archive-polluted": 0,
    "fts-strip": 0,
    "compartment-flag": 0,
  };
  const memCols = tableExists(db, "memories") ? columnNames(db, "memories") : new Set<string>();
  if (ops.some((op) => op.kind.startsWith("memory-")) && (!memCols.has("metadata_json") || !memCols.has("superseded_by_memory_id"))) {
    throw new Error("memories table lacks metadata_json / superseded_by_memory_id — open the DB once with the current build first");
  }
  ensureLegacyTables(db);
  const log = db.prepare(
    "INSERT INTO dsh_legacy_migration_log (run_id, op, target_table, target_id, before_json, after_json, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const readMemory = db.prepare("SELECT * FROM memories WHERE id = ?");
  const run = (): void => {
    for (const op of ops) {
      switch (op.kind) {
        case "memory-move":
        case "memory-move-archived": {
          const before = readMemory.get(op.id) as Record<string, unknown> | null;
          if (before == null || before.project_path !== op.from) throw new Error(`memory #${op.id} changed since the scan`);
          const status = op.kind === "memory-move-archived" ? "archived" : String(before.status ?? "active");
          const meta = withMigrationMeta(before.metadata_json, {
            runId,
            action: op.kind === "memory-move" ? "moved" : "moved-archived",
            fromProjectPath: op.from,
            ...(op.kind === "memory-move-archived" ? { similarTo: op.similarTo, previousStatus: before.status ?? "active" } : {}),
            at: now,
          });
          db.prepare(
            `UPDATE memories SET project_path = ?, status = ?, metadata_json = ?${op.kind === "memory-move-archived" ? ", superseded_by_memory_id = ?" : ""} WHERE id = ? AND project_path = ?`,
          ).run(...(op.kind === "memory-move-archived" ? [op.to, status, meta, op.similarTo, op.id, op.from] : [op.to, status, meta, op.id, op.from]));
          log.run(runId, op.kind, "memories", op.id, JSON.stringify(before, blobSafe), JSON.stringify({ project_path: op.to, status }), now);
          break;
        }
        case "memory-archive-duplicate":
        case "memory-archive-polluted": {
          const before = readMemory.get(op.id) as Record<string, unknown> | null;
          if (before == null) throw new Error(`memory #${op.id} vanished since the scan`);
          const meta = withMigrationMeta(before.metadata_json, {
            runId,
            action: op.kind === "memory-archive-duplicate" ? op.reason : "polluted",
            previousStatus: before.status ?? "active",
            ...(op.kind === "memory-archive-duplicate" ? { duplicateOf: op.supersededBy } : {}),
            at: now,
          });
          if (op.kind === "memory-archive-duplicate") {
            db.prepare("UPDATE memories SET status = 'archived', superseded_by_memory_id = ?, metadata_json = ? WHERE id = ?").run(
              op.supersededBy,
              meta,
              op.id,
            );
          } else {
            db.prepare("UPDATE memories SET status = 'archived', metadata_json = ? WHERE id = ?").run(meta, op.id);
          }
          log.run(runId, op.kind, "memories", op.id, JSON.stringify(before, blobSafe), JSON.stringify({ status: "archived" }), now);
          break;
        }
        case "fts-strip": {
          const before = db
            .prepare("SELECT rowid AS rowid, session_id, message_ordinal, message_id, role, content FROM message_history_fts WHERE rowid = ?")
            .get(op.rowid) as Record<string, unknown> | null;
          if (before == null) throw new Error(`fts row ${op.rowid} vanished since the scan`);
          const cleaned = stripInjectedBlocks(String(before.content ?? ""));
          if (cleaned.length === 0) {
            db.prepare("DELETE FROM message_history_fts WHERE rowid = ?").run(op.rowid);
            if (tableExists(db, "message_fts_rowid_map")) {
              db.prepare("DELETE FROM message_fts_rowid_map WHERE fts_rowid = ?").run(op.rowid);
            }
          } else {
            db.prepare("UPDATE message_history_fts SET content = ? WHERE rowid = ?").run(cleaned, op.rowid);
          }
          log.run(runId, op.kind, "message_history_fts", op.rowid, JSON.stringify(before), JSON.stringify({ content: cleaned, removed: cleaned.length === 0 }), now);
          break;
        }
        case "compartment-flag": {
          const res = db
            .prepare("INSERT OR IGNORE INTO dsh_legacy_flags (kind, target_id, session_id, reason, run_id, flagged_at) VALUES ('compartment-polluted', ?, ?, ?, ?, ?)")
            .run(op.id, op.sessionId, `injected text summarised (range ${op.start}-${op.end}); rebuild with /ctx-recomp`, runId, now) as { changes?: number };
          if ((res.changes ?? 0) === 0) continue;
          log.run(runId, op.kind, "compartments", op.id, null, JSON.stringify({ flagged: true }), now);
          break;
        }
      }
      applied[op.kind] += 1;
    }
  };
  db.transaction(run).immediate();
  return { runId, applied, ops: [...ops] };
}

function blobSafe(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { blobSha256: createHash("sha256").update(value).digest("hex"), bytes: value.byteLength };
  if (typeof value === "bigint") return value.toString();
  return value;
}

/* ─────────────────────────────── digest / backup / restore ─────────────────────────────── */

/**
 * Logical digest of the DB: every ordinary table's rows (FTS shadow `_data`/
 * `_idx`/`_docsize`/`_config` excluded — internal b-tree pages that a VACUUM
 * may lay out differently — but `_content` included), row order independent.
 */
export function databaseDigest(db: Database): { digest: string; tables: Record<string, number> } {
  const tables = (
    db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string | null }>
  ).filter((t) => !/^CREATE VIRTUAL TABLE/i.test(t.sql ?? "") && !/_(data|idx|docsize|config)$/.test(t.name));
  const outer = createHash("sha256");
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const hashes: string[] = [];
    for (const row of db.prepare(`SELECT * FROM "${t.name.replace(/"/g, '""')}"`).all() as Array<Record<string, unknown>>) {
      hashes.push(createHash("sha1").update(JSON.stringify(row, blobSafe)).digest("hex"));
    }
    hashes.sort();
    counts[t.name] = hashes.length;
    outer.update(`${t.name}\u0000${hashes.length}\u0000${hashes.join(",")}\n`);
  }
  return { digest: outer.digest("hex"), tables: counts };
}

export function integrityCheck(db: Database): string {
  const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
  return rows.map((r) => String(Object.values(r)[0])).join("; ");
}

export interface BackupResult {
  readonly path: string;
  readonly metaPath: string;
  readonly integrity: string;
  readonly digest: string;
  readonly bytes: number;
}

export function timestampTag(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function backupDatabase(db: Database, dbPath: string, outPath?: string, now = new Date()): BackupResult {
  const target = outPath ?? join(dirname(dbPath), "backups", `${basename(dbPath, ".db")}-${timestampTag(now)}.db`);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) throw new Error(`backup target exists: ${target}`);
  db.prepare("VACUUM INTO ?").run(target);
  const copy = new SqliteDatabase(target, { readonly: true });
  let integrity: string;
  let digest: string;
  try {
    integrity = integrityCheck(copy);
    digest = databaseDigest(copy).digest;
  } finally {
    copy.close();
  }
  if (integrity !== "ok") throw new Error(`backup integrity_check failed: ${integrity}`);
  const metaPath = `${target}.meta.json`;
  const bytes = readFileSync(target).byteLength;
  writeFileSync(metaPath, `${JSON.stringify({ source: dbPath, createdAt: now.toISOString(), integrity, digest, bytes }, null, 2)}\n`);
  return { path: target, metaPath, integrity, digest, bytes };
}

/** Live DSH/OpenCode/Pi processes holding a liveness marker under `<storage>/rpc`. */
export function liveHolders(storageDir: string): Array<{ pid: number; path: string }> {
  const out: Array<{ pid: number; path: string }> = [];
  const rpc = join(storageDir, "rpc");
  if (!existsSync(rpc)) return out;
  for (const dir of readdirSync(rpc, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(rpc, dir.name))) {
      const m = /^port-(\d+)\.json$/.exec(file);
      if (m === null) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      if (isPidAlive(pid) !== "dead") out.push({ pid, path: join(rpc, dir.name, file) });
    }
  }
  return out;
}

export interface RestoreResult {
  readonly restoredFrom: string;
  readonly safetyCopy: string | null;
  readonly expectedDigest: string;
  readonly actualDigest: string;
  readonly integrity: string;
  readonly ok: boolean;
}

export function restoreDatabase(backupPath: string, dbPath: string, now = new Date()): RestoreResult {
  if (!existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`);
  let expected: string;
  const metaPath = `${backupPath}.meta.json`;
  {
    const src = new SqliteDatabase(backupPath, { readonly: true });
    try {
      const integrity = integrityCheck(src);
      if (integrity !== "ok") throw new Error(`backup integrity_check failed: ${integrity}`);
      expected = databaseDigest(src).digest;
    } finally {
      src.close();
    }
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { digest?: string };
      if (typeof meta.digest === "string" && meta.digest !== expected) {
        throw new Error(`backup ${backupPath} does not match its recorded digest (modified after the backup?)`);
      }
    }
  }
  let safetyCopy: string | null = null;
  if (existsSync(dbPath)) {
    const current = new SqliteDatabase(dbPath);
    try {
      safetyCopy = join(dirname(dbPath), "backups", `${basename(dbPath, ".db")}-pre-restore-${timestampTag(now)}.db`);
      mkdirSync(dirname(safetyCopy), { recursive: true });
      current.prepare("VACUUM INTO ?").run(safetyCopy);
      current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      current.close();
    }
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  copyFileSync(backupPath, dbPath);
  const restored = new SqliteDatabase(dbPath, { readonly: true });
  try {
    const integrity = integrityCheck(restored);
    const actual = databaseDigest(restored).digest;
    return { restoredFrom: backupPath, safetyCopy, expectedDigest: expected, actualDigest: actual, integrity, ok: integrity === "ok" && actual === expected };
  } finally {
    restored.close();
  }
}

/* ─────────────────────────────── CLI ─────────────────────────────── */

export interface MigrateCliIo {
  readonly out: (line: string) => void;
  readonly storageDir: () => string;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(`${name}=`));
  return pref?.slice(name.length + 1);
}

export async function runMigrateLegacy(argv: readonly string[], io: MigrateCliIo): Promise<number> {
  const storageDir = flag(argv, "--storage-dir") ?? io.storageDir();
  const dbPath = flag(argv, "--db") ?? join(storageDir, "context.db");
  const json = argv.includes("--json");
  const force = argv.includes("--force");
  const keepSimilarActive = argv.includes("--keep-similar-active");
  const restoreFrom = flag(argv, "--restore");
  const mode = restoreFrom !== undefined ? "restore" : argv.includes("--apply") ? "apply" : argv.includes("--dry-run") ? "dry-run" : argv.includes("--backup") ? "backup" : "scan";
  const emit = (obj: unknown, lines: string[]): void => {
    if (json) io.out(JSON.stringify(obj, null, 2));
    else for (const l of lines) io.out(l);
  };

  if (mode === "restore") {
    const holders = liveHolders(storageDir);
    if (holders.length > 0 && !force) {
      emit({ mode, refused: "live-processes", holders }, [`refused: ${holders.length} live process(es) use this storage (${holders.map((h) => h.pid).join(", ")}); stop DSH/OpenCode/Pi or pass --force`]);
      return 3;
    }
    const result = restoreDatabase(restoreFrom!, dbPath);
    emit({ mode, ...result }, [
      `restored ${dbPath} from ${result.restoredFrom}`,
      `pre-restore safety copy: ${result.safetyCopy ?? "(no previous DB)"}`,
      `integrity_check: ${result.integrity}`,
      `digest: expected ${result.expectedDigest} actual ${result.actualDigest} → ${result.ok ? "MATCH" : "MISMATCH"}`,
    ]);
    return result.ok ? 0 : 1;
  }

  if (!existsSync(dbPath)) {
    emit({ mode, dbPath, empty: true }, [`no database at ${dbPath} — nothing to migrate`]);
    return 0;
  }

  const readonly = mode === "scan" || mode === "dry-run";
  const db = new SqliteDatabase(dbPath, readonly ? { readonly: true } : {});
  try {
    if (!readonly) db.exec("PRAGMA busy_timeout = 5000");
    if (mode === "backup") {
      const b = backupDatabase(db, dbPath);
      emit({ mode, ...b }, [`backup: ${b.path} (${b.bytes} bytes)`, `integrity_check: ${b.integrity}`, `digest: ${b.digest}`, `meta: ${b.metaPath}`]);
      return 0;
    }
    const scan = scanLegacyData(db, {}, dbPath);
    const ops = planLegacyMigration(scan, { keepSimilarActive });
    const lines = renderScan(scan);
    if (mode === "scan") {
      lines.push("", `${ops.length} operation(s) would run — see --dry-run; nothing was written.`);
      emit({ mode, scan, plannedOps: ops.length }, lines);
      return 0;
    }
    if (mode === "dry-run") {
      lines.push("", `Dry run — ${ops.length} operation(s), in order (nothing written):`);
      for (const op of ops) lines.push(`  - ${describeOp(op)}`);
      emit({ mode, scan, ops }, lines);
      return 0;
    }
    // apply
    const holders = liveHolders(storageDir);
    if (holders.length > 0 && !force) {
      emit({ mode, refused: "live-processes", holders }, [`refused: ${holders.length} live process(es) use this storage (${holders.map((h) => h.pid).join(", ")}); stop DSH/OpenCode/Pi or pass --force`]);
      return 3;
    }
    if (ops.length === 0) {
      lines.push("", "Nothing to apply (already migrated or no legacy data). No backup taken.");
      const sugg = recompSuggestions(db);
      for (const s of sugg) lines.push(`  flagged: session ${s.dshSessionId} → /ctx-recomp ${s.range} (${s.compartments} compartment(s))`);
      emit({ mode, scan, ops, applied: null, recomp: sugg }, lines);
      return 0;
    }
    const backup = backupDatabase(db, dbPath);
    const result = applyLegacyMigration(db, ops);
    const sugg = recompSuggestions(db);
    const integrity = integrityCheck(db);
    lines.push(
      "",
      `backup: ${backup.path} (integrity ${backup.integrity}, digest ${backup.digest})`,
      `applied run ${result.runId} in one transaction: ${Object.entries(result.applied).map(([k, v]) => `${k}=${v}`).join(" ")}`,
      `integrity_check after apply: ${integrity}`,
      `rollback: dsh-magic-context migrate-legacy --restore ${backup.path}${flag(argv, "--db") ? ` --db ${dbPath}` : ""}`,
    );
    if (sugg.length > 0) {
      lines.push("Compartments flagged (not rewritten). In each DSH session, run:");
      for (const s of sugg) lines.push(`  session ${s.dshSessionId}: /ctx-recomp ${s.range}   (${s.compartments} compartment(s))`);
    }
    emit({ mode, scan, ops, applied: result.applied, runId: result.runId, backup, integrity, recomp: sugg }, lines);
    return integrity === "ok" ? 0 : 1;
  } finally {
    db.close();
  }
}

export function renderScan(scan: LegacyScan, maxSamples = 5): string[] {
  const lines: string[] = [];
  lines.push(`Legacy data scan${scan.dbPath ? ` of ${scan.dbPath}` : ""} (read-only)`);
  const byClass = (c: OrphanClass) => scan.orphans.filter((o) => o.classification === c);
  lines.push(`Orphan memories under a raw directory path: ${scan.orphans.length}`);
  for (const c of ["unique", "duplicate", "archived-duplicate", "similar-to-archived", "unresolvable", "already-migrated"] as OrphanClass[]) {
    const list = byClass(c);
    if (list.length === 0) continue;
    lines.push(`  ${c}: ${list.length}`);
    for (const o of list.slice(0, maxSamples)) {
      lines.push(
        `    #${o.id} [${o.category}/${o.status}] ${o.rawPath} → ${o.identity ?? "?"}${o.targetId !== undefined ? ` (target #${o.targetId})` : ""}: ${sample(o.content, 100)}`,
      );
    }
  }
  lines.push(`Message-history FTS rows with injected blocks: ${scan.pollutedFts.length}`);
  for (const f of scan.pollutedFts.slice(0, maxSamples)) {
    lines.push(`    row ${f.rowid} ${f.sessionId} #${f.ordinal} ${f.role} ${f.markers.join(",")}${f.cleaned.length === 0 ? " (only injected text)" : ""}: ${f.sample}`);
  }
  lines.push(`Compartments with injected text: ${scan.pollutedCompartments.length} (${scan.pollutedCompartments.filter((c) => c.alreadyFlagged).length} already flagged)`);
  for (const c of scan.pollutedCompartments.slice(0, maxSamples)) {
    lines.push(`    #${c.id} ${c.sessionId} ${c.start}-${c.end} "${sample(c.title, 80)}" ${c.markers.join(",")}`);
  }
  lines.push(`Memories whose content is an injected block: ${scan.pollutedMemories.length}`);
  for (const m of scan.pollutedMemories.slice(0, maxSamples)) lines.push(`    #${m.id} ${m.projectPath} ${m.markers.join(",")}: ${m.sample}`);
  return lines;
}
