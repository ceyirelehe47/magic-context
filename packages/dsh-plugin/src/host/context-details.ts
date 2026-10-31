/**
 * host/context-details — per-session Magic Context state for the composer
 * indicator popover (`magicContext/context`).
 *
 * The ring itself is fed live by the `magicContextPressure` session projection
 * (pure fold over session events). Everything Magic keeps in SQLite instead of
 * the session log — compartments, historian state, queued drops, injected
 * knowledge, nudges — is read here on demand (popover open), every query
 * fail-open so an older schema or a missing table degrades to absent fields.
 */
type Database = { prepare(sql: string): { get(...params: unknown[]): unknown } };
import type { EffectiveMagicSettings, MagicThresholds } from "../settings/magic-settings";

export interface MagicSessionContextDetails {
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly storage: "ok" | "unavailable";
  readonly thresholds: MagicThresholds;
  readonly protectedTokens?: number;
  readonly compartments: number;
  readonly historian: {
    readonly inProgress: boolean;
    readonly failureCount: number;
    readonly lastError?: string;
    readonly lastFailureAt?: number;
    readonly lastCompartmentAt?: number;
    readonly model?: string;
    /** idle | running | failed | never — summarised for the badge. */
    readonly state: "idle" | "running" | "failed" | "never";
  };
  readonly pending: {
    /** Queued ctx_reduce drops (core pending_ops) not yet executed. */
    readonly drops: number;
    /** DSH outbox surface rewrites not yet committed. */
    readonly outbox: number;
  };
  readonly tags: { readonly active: number; readonly dropped: number };
  readonly knowledge: {
    /** Heuristic tokens (chars / 4, the token-meter density) of the cached m[0]. */
    readonly m0Tokens: number;
    readonly m1Tokens: number;
    readonly memoryBlocks: number;
  };
  readonly nudge: {
    readonly band?: string;
    readonly level?: string;
    readonly lastTokens?: number;
    readonly channel2?: string;
    readonly notePending: boolean;
  };
  readonly lastContextPercentage?: number;
}

export interface ContextDetailsInput {
  readonly db: Database | undefined;
  readonly canonicalSessionId: string | undefined;
  readonly sessionId: string;
  readonly effective: EffectiveMagicSettings;
  readonly thresholds: MagicThresholds;
}

/** token-meter's fixed density (CHARS_PER_TOKEN). */
const CHARS_PER_TOKEN = 4;

function heuristicTokens(bytes: unknown): number {
  if (bytes === null || bytes === undefined) return 0;
  try {
    const text =
      typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes as Uint8Array);
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

export function readSessionContextDetails(input: ContextDetailsInput): MagicSessionContextDetails {
  const base: MagicSessionContextDetails = {
    sessionId: input.sessionId,
    enabled: input.effective.enabled.value,
    storage: input.db === undefined ? "unavailable" : "ok",
    thresholds: input.thresholds,
    ...(input.effective.protectedTokens.value !== undefined
      ? { protectedTokens: input.effective.protectedTokens.value }
      : {}),
    compartments: 0,
    historian: {
      inProgress: false,
      failureCount: 0,
      state: "never",
      ...(input.effective.historianModel.value !== undefined ? { model: input.effective.historianModel.value } : {}),
    },
    pending: { drops: 0, outbox: 0 },
    tags: { active: 0, dropped: 0 },
    knowledge: { m0Tokens: 0, m1Tokens: 0, memoryBlocks: 0 },
    nudge: { notePending: false },
  };
  const db = input.db;
  const sid = input.canonicalSessionId;
  if (db === undefined || sid === undefined || sid.length === 0) return base;

  const one = <T>(sql: string, ...params: (string | number)[]): T | undefined => {
    try {
      return db.prepare(sql).get(...params) as T | undefined;
    } catch {
      return undefined;
    }
  };
  const count = (sql: string, ...params: (string | number)[]): number =>
    one<{ n: number }>(sql, ...params)?.n ?? 0;

  const compartments = count("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?", sid);
  const lastCompartment = one<{ at: number | null }>(
    "SELECT MAX(created_at) AS at FROM compartments WHERE session_id = ?",
    sid,
  )?.at;
  const meta =
    one<Record<string, unknown>>(
      `SELECT compartment_in_progress, historian_failure_count, historian_last_error,
              historian_last_failure_at, last_nudge_band, last_nudge_level, last_nudge_tokens,
              channel2_nudge_state, note_nudge_trigger_pending, last_context_percentage,
              memory_block_count, cached_m0_bytes, cached_m1_bytes
         FROM session_meta WHERE session_id = ?`,
      sid,
    ) ??
    // Older schemas without the cached m0/m1 columns.
    one<Record<string, unknown>>(
      `SELECT compartment_in_progress, historian_failure_count, historian_last_error,
              historian_last_failure_at, last_nudge_band, last_nudge_level, last_nudge_tokens,
              channel2_nudge_state, note_nudge_trigger_pending, last_context_percentage
         FROM session_meta WHERE session_id = ?`,
      sid,
    ) ??
    {};

  const inProgress = Number(meta.compartment_in_progress ?? 0) > 0;
  const failureCount = Number(meta.historian_failure_count ?? 0) || 0;
  const lastFailureAt = typeof meta.historian_last_failure_at === "number" ? meta.historian_last_failure_at : undefined;
  const lastCompartmentAt = typeof lastCompartment === "number" ? lastCompartment : undefined;
  const failedRecently =
    failureCount > 0 && lastFailureAt !== undefined && (lastCompartmentAt === undefined || lastFailureAt > lastCompartmentAt);
  const state: MagicSessionContextDetails["historian"]["state"] = inProgress
    ? "running"
    : failedRecently
      ? "failed"
      : compartments > 0
        ? "idle"
        : "never";
  const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);

  return {
    ...base,
    compartments,
    historian: {
      ...base.historian,
      inProgress,
      failureCount,
      state,
      ...(str(meta.historian_last_error) !== undefined ? { lastError: String(meta.historian_last_error).slice(0, 500) } : {}),
      ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
      ...(lastCompartmentAt !== undefined ? { lastCompartmentAt } : {}),
    },
    pending: {
      drops: count(
        "SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ? AND operation = 'drop'",
        sid,
      ),
      outbox: count(
        "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status IN ('pending', 'applied')",
        sid,
      ),
    },
    tags: {
      active: count("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'active'", sid),
      dropped: count("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'dropped'", sid),
    },
    knowledge: {
      m0Tokens: heuristicTokens(meta.cached_m0_bytes),
      m1Tokens: heuristicTokens(meta.cached_m1_bytes),
      memoryBlocks: Number(meta.memory_block_count ?? 0) || 0,
    },
    nudge: {
      ...(str(meta.last_nudge_band) !== undefined ? { band: String(meta.last_nudge_band) } : {}),
      ...(str(meta.last_nudge_level) !== undefined ? { level: String(meta.last_nudge_level) } : {}),
      ...(typeof meta.last_nudge_tokens === "number" && meta.last_nudge_tokens > 0
        ? { lastTokens: meta.last_nudge_tokens }
        : {}),
      ...(str(meta.channel2_nudge_state) !== undefined ? { channel2: String(meta.channel2_nudge_state) } : {}),
      notePending: Number(meta.note_nudge_trigger_pending ?? 0) > 0,
    },
    ...(typeof meta.last_context_percentage === "number" && meta.last_context_percentage > 0
      ? { lastContextPercentage: meta.last_context_percentage }
      : {}),
  };
}
