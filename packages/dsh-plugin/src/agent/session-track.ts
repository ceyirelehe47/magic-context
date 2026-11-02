/**
 * agent/session-track — session → project attribution (Phase 2 slice A).
 *
 * Writes the `session_projects` row (harness-scoped, keyed by the canonical
 * Magic session key) so the project-scoped memory / compartment machinery can
 * attribute a DSH session to its workspace. Mirrors Pi's
 * `trackSessionForProject` storage call: the DSH side reuses the core storage
 * function `recordSessionProjectIdentity` (features/magic-context/
 * session-project-storage) instead of copying any Pi code.
 *
 * The bulk backfill (`runSessionProjectBackfill`, which Pi runs at boot over
 * every historical session) is intentionally NOT wired here — slice A tracks
 * live sessions only; backfill lands with the session-query phase.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { recordSessionProjectIdentity } from "@magic-context/core/features/magic-context/session-project-storage";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { DshStorageBootstrap } from "../host/bootstrap";
import { isMagicChildSession } from "./worker";

/** The host-service slice session tracking needs (structural view). */
export interface SessionTrackHostView {
  /** Settles once the storage bootstrap finishes (ok or refused). */
  readonly ready: Promise<DshStorageBootstrap>;
  /** Canonical Magic session key for a DSH session. */
  canonicalKey(dshSessionId: string): string;
}

export interface SessionTrackOptions {
  readonly enabled?: boolean;
}

export interface SessionTrackDeps {
  readonly host: SessionTrackHostView;
  /** Workspace directory used when the session header carries no cwd. */
  readonly directory?: string;
  readonly config?: SessionTrackOptions;
  readonly log?: (message: string) => void;
}

/**
 * Persist the session → project binding exactly once per (session, project)
 * observation. The core upsert is itself idempotent (WHERE project_path <>
 * excluded.project_path), so the Set only avoids the per-pass read.
 */
export function trackSessionProjectOnce(
  trackedSessions: Set<string>,
  db: Database,
  magicSessionId: string,
  projectPath: string | undefined,
): void {
  if (!projectPath || projectPath.length === 0) return;
  if (trackedSessions.has(magicSessionId)) return;
  try {
    recordSessionProjectIdentity(db, magicSessionId, projectPath);
  } catch {
    // Best-effort (the bulk backfill re-records on demand); never break the
    // pre-step chain over a session-projects write.
  }
  trackedSessions.add(magicSessionId);
}

/**
 * Register session→project tracking on `agent/created` (DSH 0.1: `agent/session-start`). The listener
 * awaits the host bootstrap (fire-and-forget) and records the binding once per
 * session. `clear`/`compact` re-fires are no-ops via the per-session Set.
 */
export function registerSessionProjectTracking(
  ctx: Context,
  deps: SessionTrackDeps,
): void {
  if (deps.config?.enabled === false) return;
  const trackedSessions = new Set<string>();
  // DSH 0.2: `agent/session-start` was folded into `agent/created` (serial,
  // awaited before creation resolves). Keep the listener non-blocking so the
  // bootstrap wait never delays agent creation.
  ctx.on("agent/created", (payload: { agent: Agent }) => {
    const { agent } = payload;
    void (async () => {
      try {
        // Recursion isolation (PLAN §9): child sessions are not attributed to
        // projects (the parent owns the workspace row).
        if (isMagicChildSession(agent)) return;
        const bootstrap = await deps.host.ready;
        if (bootstrap.kind !== "ok") return;
        const magicSessionId = deps.host.canonicalKey(agent.id);
        // The resolved identity, never the raw cwd (round 14: the raw path
        // overwrote the knowledge gate's identity on every process start).
        const projectPath = resolveSessionProjectIdentity(sessionProjectPath(agent, deps.directory));
        trackSessionProjectOnce(trackedSessions, bootstrap.db, magicSessionId, projectPath);
      } catch (error) {
        deps.log?.(
          `[magic-context] session-project tracking failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return undefined;
  });
}

/**
 * The project identity (`git:<root-commit>` / `dir:<hash>`) of a workspace
 * directory — the value `session_projects.project_path` holds for every
 * harness. Undefined when it cannot be resolved. Both writers (agent/created
 * tracking and the knowledge gate) go through this, so a session never
 * flips between a raw path and its identity.
 */
export function resolveSessionProjectIdentity(directory: string | undefined): string | undefined {
  if (!directory || directory.length === 0) return undefined;
  try {
    return resolveProjectIdentityForSession(directory) || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the per-session workspace directory (header cwd wins). */
export function sessionProjectPath(
  agent: { session: { header: { cwd?: string } } },
  fallbackDirectory?: string,
): string | undefined {
  const cwd = agent.session.header.cwd;
  return cwd && cwd.length > 0 ? cwd : fallbackDirectory;
}
