/**
 * Round 24b (item 2) — project embedding registration + automatic compartment
 * embedding on DSH (OpenCode/Pi parity, adapter-only).
 *
 * Before: the tools' `ensureProjectRegistered` seam was declared but never
 * filled, and nothing called core `maybeAutoEmbedSessionBackfill`, so on DSH
 * no project ever had a registered embedding provider and no compartment was
 * ever embedded (only `/ctx-embed start` could try, and it found "no
 * provider"). ctx_search's compartment (semantic) lane was therefore always
 * empty on DSH.
 *
 * Now:
 *  - `ensureDshProjectRegistered` reuses core
 *    `ensureProjectRegisteredFromOpenCodeDirectory` (same config loader as the
 *    rest of the DSH agent plane: the shared magic-context.jsonc, user +
 *    project tier, with the core's untrusted-load handling) and is wired into
 *    the ctx_* tools and /ctx-* commands by the agent plugin.
 *  - `scheduleDshAutoEmbed` is called by the context-plane pre-step for the
 *    active session (core defers registration off the step and backs off on
 *    provider failure; fail-open).
 *  - `semanticUnavailableNote` is the VISIBLE degrade diagnostic ctx_search
 *    appends when a query embedding could not be produced (no model / provider
 *    down — the CI case): the full-text (FTS) lanes still answer.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import { maybeAutoEmbedSessionBackfill } from "@magic-context/core/hooks/magic-context/auto-embed-session";
import { getProjectEmbeddingSnapshot } from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "@magic-context/core/plugin/embedding-bootstrap";
import type { Database } from "@magic-context/core/shared/sqlite";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";

/** Register (or refresh) the project's embedding provider from the shared config. */
export async function ensureDshProjectRegistered(
  directory: string,
  db: Database,
  options: { preflightLocalPooling?: boolean } = {},
): Promise<void> {
  await ensureProjectRegisteredFromOpenCodeDirectory(directory, db, options);
}

/**
 * Start (once per session, core-throttled) the automatic compartment-embedding
 * backfill for the active session. Never throws, never blocks the step.
 */
export function scheduleDshAutoEmbed(
  db: Database,
  sessionKey: string,
  agent: Agent,
  fallbackDirectory: string | undefined,
  log?: (message: string) => void,
  allowHomeProject?: boolean,
): void {
  try {
    const directory = agent.session?.header?.cwd ?? fallbackDirectory;
    if (!directory) return;
    const projectIdentity = resolveProjectIdentityForSession(directory, allowHomeProject);
    if (!projectIdentity) return;
    // Chunk text is built from core's message-history FTS index (round 24a
    // feeds it from this same pre-step, asynchronously). Starting the backfill
    // before the index covers the last compartment makes core defer every
    // compartment and back off for 60 s; wait for the index instead (the next
    // pre-step re-checks). Nothing to embed without compartments.
    const coverage = messageIndexCoverage(db, sessionKey);
    if (!coverage.covered) {
      // Round 27b (C5): a deferral is normal async lag for a step or two; a
      // stall is not — diagnose it once (log + /ctx-status), never silently.
      if (coverage.compartmentEnd >= 1) noteEmbedDeferral(db, sessionKey, coverage, log);
      // Register the provider now anyway (once per directory per DB), so
      // ctx_search / auto-search see the project's embedding config from the
      // first turn; the tools' seam refreshes it on config changes.
      registerOnce(db, directory, log);
      return;
    }
    clearEmbedDeferral(db, sessionKey);
    maybeAutoEmbedSessionBackfill(
      {
        db,
        projectIdentity,
        ensureRegistered: () => ensureDshProjectRegistered(directory, db, { preflightLocalPooling: true }),
      },
      sessionKey,
    );
  } catch (error) {
    log?.(`[magic-context] auto-embed scheduling failed (fail-open): ${error instanceof Error ? error.message : String(error)}`);
  }
}

const registeredDirectories = new WeakMap<object, Set<string>>();

function registerOnce(db: Database, directory: string, log?: (message: string) => void): void {
  let seen = registeredDirectories.get(db);
  if (!seen) {
    seen = new Set();
    registeredDirectories.set(db, seen);
  }
  if (seen.has(directory)) return;
  seen.add(directory);
  setTimeout(() => {
    ensureDshProjectRegistered(directory, db).catch((error: unknown) => {
      seen?.delete(directory);
      log?.(`[magic-context] embedding registration failed (fail-open): ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 0);
}

interface IndexCoverage {
  readonly covered: boolean;
  readonly compartmentEnd: number;
  readonly indexed: number;
}

function messageIndexCoverage(db: Database, sessionKey: string): IndexCoverage {
  const lastEnd = getLastCompartmentEndMessage(db, sessionKey);
  if (lastEnd < 1) return { covered: false, compartmentEnd: lastEnd, indexed: 0 };
  const row = db
    .prepare("SELECT last_indexed_ordinal AS n FROM message_history_index WHERE session_id = ?")
    .get(sessionKey) as { n: number } | null;
  const indexed = row?.n ?? 0;
  return { covered: indexed >= lastEnd, compartmentEnd: lastEnd, indexed };
}

/* ─────────────── round 27b (C5): auto-embed deferral diagnostic ─────────────── */

/**
 * Consecutive coverage deferrals (one per context-plane pre-step) before the
 * stall is diagnosed. The DSH indexer runs asynchronously from the same
 * pre-step and normally catches up within one or two steps, so 10 in a row is
 * a stall, not lag.
 */
export const EMBED_DEFERRAL_DIAGNOSTIC_AFTER = 10;

export interface EmbedDeferralRecord {
  readonly count: number;
  readonly indexed: number;
  readonly compartmentEnd: number;
  readonly firstAt: number;
  readonly at: number;
}

const DEFERRAL_META_PREFIX = "embed-deferral:";
interface DeferralState {
  count: number;
  firstAt: number;
  recorded: boolean;
  logged: boolean;
}
/** In-memory consecutive counter per DB per session (a DB write only at N, 2N, 4N, …). */
const deferralState = new WeakMap<object, Map<string, DeferralState>>();

function stateMap(db: Database): Map<string, DeferralState> {
  let map = deferralState.get(db);
  if (!map) {
    map = new Map();
    deferralState.set(db, map);
  }
  return map;
}

function noteEmbedDeferral(db: Database, sessionKey: string, coverage: IndexCoverage, log?: (message: string) => void): void {
  const map = stateMap(db);
  const now = Date.now();
  let st = map.get(sessionKey);
  if (!st) {
    st = { count: 0, firstAt: now, recorded: false, logged: false };
    map.set(sessionKey, st);
  }
  st.count += 1;
  if (st.count < EMBED_DEFERRAL_DIAGNOSTIC_AFTER) return;
  // Geometric durable updates: N, 2N, 4N, … (bounded writes on a long stall).
  const ratio = st.count / EMBED_DEFERRAL_DIAGNOSTIC_AFTER;
  if (Number.isInteger(ratio) && (ratio & (ratio - 1)) === 0) {
    const record: EmbedDeferralRecord = {
      count: st.count,
      indexed: coverage.indexed,
      compartmentEnd: coverage.compartmentEnd,
      firstAt: st.firstAt,
      at: now,
    };
    try {
      db.prepare(
        "INSERT INTO dsh_adapter_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(`${DEFERRAL_META_PREFIX}${sessionKey}`, JSON.stringify(record));
      st.recorded = true;
    } catch {
      // diagnostic only (fail-open)
    }
  }
  if (!st.logged) {
    st.logged = true;
    log?.(
      `[magic-context] auto-embed deferred ${st.count}× in a row for ${sessionKey}: message-history FTS index indexed ${coverage.indexed}, compartments end at ${coverage.compartmentEnd} — compartments are not embedded until the index covers them (ctx_search's semantic lane stays empty); check the message-index log lines`,
    );
  }
}

function clearEmbedDeferral(db: Database, sessionKey: string): void {
  const map = deferralState.get(db);
  const st = map?.get(sessionKey);
  if (!st) return;
  map!.delete(sessionKey);
  if (!st.recorded) return;
  try {
    db.prepare("DELETE FROM dsh_adapter_meta WHERE key = ?").run(`${DEFERRAL_META_PREFIX}${sessionKey}`);
  } catch {
    // diagnostic only
  }
}

/** The durable deferral record for /ctx-status (null when none / unreadable). */
export function readEmbedDeferral(db: Database, sessionKey: string): EmbedDeferralRecord | null {
  try {
    const row = db.prepare("SELECT value FROM dsh_adapter_meta WHERE key = ?").get(`${DEFERRAL_META_PREFIX}${sessionKey}`) as
      | { value: string }
      | null
      | undefined;
    return row ? (JSON.parse(row.value) as EmbedDeferralRecord) : null;
  } catch {
    return null;
  }
}

/** /ctx-status block ('' when auto-embed is not stalled). */
export function embedDeferralStatusBlock(record: EmbedDeferralRecord | null): string {
  if (record === null) return "";
  const iso = (t: number) => new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return (
    `\n\n### Auto-embed: deferred (≥ ${record.count} consecutive steps since ${iso(record.firstAt)})\n` +
    `- message index at ordinal ${record.indexed}, compartments end at ${record.compartmentEnd} (last check ${iso(record.at)})\n` +
    "- compartments are embedded only once the message-history FTS index covers them; until then ctx_search answers from full-text matches only. Every step re-checks; /ctx-embed start forces a pass"
  );
}

const warnedProjects = new Set<string>();

/**
 * The visible ctx_search note when the query embedding could not be produced,
 * plus a one-time log line per project. `null` when semantic search ran.
 */
export function semanticUnavailableNote(
  projectIdentity: string,
  reason: string,
  log?: (message: string) => void,
): string {
  const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
  const provider = snapshot ? `${snapshot.provider}${snapshot.model ? ` (${snapshot.model})` : ""}` : "not registered";
  if (!warnedProjects.has(projectIdentity)) {
    warnedProjects.add(projectIdentity);
    log?.(`[magic-context] semantic search unavailable for ${projectIdentity}: embedding provider ${provider} — ${reason}; ctx_search falls back to full-text (FTS) results`);
  }
  return `Note: semantic search unavailable (embedding provider ${provider}: ${reason}); the results above are full-text (FTS) matches only — summarized history (compartments) is not searched semantically. Check the embedding settings or run /ctx-embed.`;
}

