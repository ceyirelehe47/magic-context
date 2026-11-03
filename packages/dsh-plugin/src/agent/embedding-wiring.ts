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
    if (!messageIndexCoversCompartments(db, sessionKey)) {
      // Register the provider now anyway (once per directory per DB), so
      // ctx_search / auto-search see the project's embedding config from the
      // first turn; the tools' seam refreshes it on config changes.
      registerOnce(db, directory, log);
      return;
    }
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

function messageIndexCoversCompartments(db: Database, sessionKey: string): boolean {
  const lastEnd = getLastCompartmentEndMessage(db, sessionKey);
  if (lastEnd < 1) return false;
  const row = db
    .prepare("SELECT last_indexed_ordinal AS n FROM message_history_index WHERE session_id = ?")
    .get(sessionKey) as { n: number } | null;
  return (row?.n ?? 0) >= lastEnd;
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
