/**
 * agent/tag-scheme — per-session view scheme (round 36 line G, plan N).
 *
 * Two ways to map a DSH surface onto core's transcript:
 *
 *   - `fold`   (every session before round 36 G; since round 37 only sessions
 *              already worked on in it, or new sessions with the explicit
 *              opt-out): a tool-call assistant node and its tool results fold
 *              into the following user / synthetic user message and every
 *              rewrite is ONE user replace over that range (known limitation 1);
 *   - `native` (plan N; round 37 I3: the DEFAULT for sessions Magic has not
 *              worked on yet): every surface node keeps its own role. Rewrites
 *              go back per SOURCE node, like pi-plugin's `transcript-pi.ts`
 *              commit: user text through a single-node `user/message` replace,
 *              tool results through a single-node, content-only `tool/result`
 *              replace, each preceded by a `compaction/prune` shadow price.
 *              Assistant nodes are never written and their text is never
 *              tagged, so their tool calls, reasoning blocks and replay
 *              metadata reach the provider as DSH recorded them.
 *
 * The scheme changes the core text-tag keys (`${viewMessageId}:pN`) and the
 * tool-tag owner ids, so it is FROZEN per session when the session is first
 * seen with the switch on (default), like pi's `pi_stable_id_scheme`:
 *   - a fresh session (no Magic tag rows, no Magic surface copy) → `native`;
 *   - a session Magic already worked on → `fold` (kept forever, no migration,
 *     never mixed: its tag keys, message identities and write rules stay fold).
 * With the explicit opt-out nothing is written (new sessions get the fold
 * view); a session already frozen as `native` stays native (its surface holds
 * per-node rewrites a fold view would misread).
 *
 * The decision lives in an adapter-owned table (`dsh_session_tag_scheme`,
 * created on first use), and in a process registry keyed by the canonical
 * session id so every reader of the session's view (context plane,
 * coordinator CAS, nudges, historian provider, ctx_* tools) uses one scheme.
 */
import type { Database } from "@magic-context/core/shared/sqlite";

export type DshTagScheme = "fold" | "native";

/**
 * Environment override: `0` / `false` / `off` / `no` opts new sessions out
 * (legacy fold view); `1` / `true` / `on` / `yes` keeps the default (native).
 */
export const NATIVE_ROLES_ENV = "MAGIC_CONTEXT_DSH_NATIVE_ROLES";

/**
 * Whether a session Magic sees for the first time may start on the native
 * view: explicit row config wins, else the environment variable, else the
 * default. Round 37 (I3): the default is ON — the fold view rewrote every
 * finished tool step into a user message without the assistant tool_calls,
 * tool results and reasoning, and on the real 1M route the model re-derived
 * its state every step (reasoning median 10 704 vs 120 tokens per request,
 * every turn timed out). Sessions already worked on stay as they were frozen
 * (see {@link resolveSessionTagScheme}); this only decides fresh sessions.
 */
export function nativeRolesRequested(config?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof config === "boolean") return config;
  const raw = env[NATIVE_ROLES_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return true;
  const value = raw.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off" || value === "no") return false;
  return true;
}

const MAX_REGISTRY = 1024;
const registry = new Map<string, DshTagScheme>();
let lookupDb: Database | undefined;
const tableReady = new WeakSet<object>();

function remember(sessionId: string, scheme: DshTagScheme): void {
  registry.delete(sessionId);
  registry.set(sessionId, scheme);
  while (registry.size > MAX_REGISTRY) {
    const oldest = registry.keys().next().value as string;
    registry.delete(oldest);
  }
}

function initTable(db: Database): void {
  if (tableReady.has(db as object)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS dsh_session_tag_scheme (
      session_id TEXT PRIMARY KEY,
      scheme     TEXT NOT NULL,
      decided_at INTEGER NOT NULL
    );
  `);
  tableReady.add(db as object);
}

function readStored(db: Database, sessionId: string): DshTagScheme | undefined {
  try {
    const row = db.prepare("SELECT scheme FROM dsh_session_tag_scheme WHERE session_id = ?").get(sessionId) as
      | { scheme: string }
      | null
      | undefined;
    if (row?.scheme === "native" || row?.scheme === "fold") return row.scheme;
  } catch {
    // table not created (switch never used): fold
  }
  return undefined;
}

/**
 * The scheme of one session for this pass. `isFresh` is consulted only when
 * the switch is on and nothing is stored yet. Never throws (fold on error).
 */
export function resolveSessionTagScheme(
  db: Database,
  sessionId: string,
  requested: boolean,
  isFresh: () => boolean,
): DshTagScheme {
  try {
    lookupDb = db;
    const cached = registry.get(sessionId);
    if (cached === "native") return cached;
    const stored = readStored(db, sessionId);
    if (stored !== undefined) {
      remember(sessionId, stored);
      return stored;
    }
    if (!requested) {
      // Switch off and never frozen: the legacy fold view (nothing written).
      return "fold";
    }
    initTable(db);
    let fresh = false;
    try {
      fresh = isFresh();
    } catch {
      fresh = false;
    }
    const scheme: DshTagScheme = fresh ? "native" : "fold";
    db.prepare(
      "INSERT OR IGNORE INTO dsh_session_tag_scheme (session_id, scheme, decided_at) VALUES (?, ?, ?)",
    ).run(sessionId, scheme, Date.now());
    const final = readStored(db, sessionId) ?? scheme;
    remember(sessionId, final);
    return final;
  } catch {
    return "fold";
  }
}

/** True when the session's view is the plan-N native one (registry, then the last DB seen). */
export function isNativeRolesSession(sessionId: string | undefined): boolean {
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  const cached = registry.get(sessionId);
  if (cached !== undefined) return cached === "native";
  if (lookupDb === undefined) return false;
  const stored = readStored(lookupDb, sessionId);
  if (stored !== undefined) remember(sessionId, stored);
  return stored === "native";
}

/**
 * A session Magic has not touched yet: no tag rows and no Magic surface copy
 * in its log. Such a session has no core keys to keep, so it may start native.
 */
export function isFreshMagicSession(db: Database, sessionId: string, events: readonly unknown[]): boolean {
  const row = db.prepare("SELECT 1 AS hit FROM tags WHERE session_id = ? LIMIT 1").get(sessionId) as
    | { hit: number }
    | null
    | undefined;
  if (row !== null && row !== undefined) return false;
  for (const raw of events) {
    if (raw === null || typeof raw !== "object") continue;
    const data = (raw as { data?: { source?: { messageId?: unknown } } }).data;
    const messageId = data?.source?.messageId;
    if (typeof messageId === "string" && messageId.startsWith("mc-op:")) return false;
  }
  return true;
}

/** Tests only: forget every cached decision (the DB rows stay). */
export function resetTagSchemeRegistryForTest(): void {
  registry.clear();
  lookupDb = undefined;
}
