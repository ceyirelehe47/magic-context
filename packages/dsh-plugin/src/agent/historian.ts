/**
 * agent/historian — the DSH Historian (Phase 3 slice H).
 *
 * Mirrors the REAL Magic architecture (design doc §9.13): publication is ONE
 * atomic transaction straight into the formal tables — `appendCompartments` +
 * `promoteSessionFactsDurable` + `insertCompartmentEvents` +
 * `queueDropsForCompartmentalizedMessages` +
 * `recordProtectedTailPublicationFloor` + `stageDshCompactionMarker` in the
 * same BEGIN IMMEDIATE → COMMIT, with `onPublished` running only after COMMIT.
 * There is NO staged intermediate state for the historian (staged tables
 * belong to recomp only). The "next safe pre-step materializes" half is the
 * DEFERRED-SIGNAL mechanism: `onPublished` only signals history-refresh /
 * materialization, and the next transform pass consumes them.
 *
 * DSH adjustments over the Pi/OpenCode runners:
 *   - no subprocess: the LLM call is an INJECTED {@link DshSummarizeCall}
 *     (production wiring wraps `ctx.llm.stream()`; tests inject stubs). The
 *     prompt assembly (buildCompartmentAgentPrompt + reference blocks) is the
 *     wiring's responsibility, not this slice's.
 *   - the compaction marker lives in the adapter-owned table
 *     `dsh_context_compaction_marker` (outbox.ts) — the Pi marker column
 *     (`session_meta.pending_pi_compaction_marker_state`) is never touched.
 *   - `runDshHistorian` is fire-and-forget: it NEVER throws (any exception is
 *     caught, telemetry'd and logged), and returns `false` on every failure
 *     path. The magicSummarize hook is the fail-closed counterpart: it THROWS
 *     on failure so the official compaction transaction closes with error.
 *
 * Slice boundary: runRecomp / runWrapup seams are Phase 4 — not exported.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  appendCompartments,
  buildCompartmentBlock,
  getCompartments,
  getLastCompartmentEndMessage,
  getSessionFacts,
  type Compartment,
  type SessionFact,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { insertCompartmentEvents } from "@magic-context/core/features/magic-context/compartment-events";
import { acquireCompartmentLease, getCompartmentLeaseBlocker, isCompartmentLeaseHeld, releaseCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { promoteSessionFactsDurable } from "@magic-context/core/features/magic-context/memory/promotion";
import {
  clearHistorianFailureState,
  getHistorianFailureState,
  getOverflowState,
  incrementHistorianFailure,
  recordProtectedTailPublicationFloor,
  updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
  recordHistorianRun,
  summarizeImportance,
  tallyFactsByCategory,
  type HistorianRunInput,
} from "@magic-context/core/features/magic-context/storage-historian-runs";
import { getProactiveCompartmentTriggerPercentage } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import { queueDropsForCompartmentalizedMessages } from "@magic-context/core/hooks/magic-context/compartment-runner-drop-queue";
import type { CandidateCompartment, ValidatedHistorianPassResult } from "@magic-context/core/hooks/magic-context/compartment-runner-types";
import {
  buildHistorianFailureNotice,
  shouldDiscardLastHistorianCompartment,
  validateChunkCoverage,
  validateHistorianOutput,
  validateStoredCompartments,
} from "@magic-context/core/hooks/magic-context/compartment-runner-validation";
import {
  createDefaultBoundarySnapshotForTests,
  hasRunnableCompartmentWindow,
  validateBoundarySnapshot,
  type ProtectedTailBoundarySnapshot,
} from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import {
  readRawSessionMessageOrdinalById,
  readSessionChunk,
  withRawMessageProvider,
  type RawMessageProvider,
  type SessionChunk,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { describeError } from "@magic-context/core/shared/error-message";
import {
  deriveHistorianChunkTokens,
  resolveHistorianContextLimit,
} from "@magic-context/core/hooks/magic-context/derive-budgets";
/** Mirror of the shared derive-budgets fallback (128k, not exported). */
const HISTORIAN_WINDOW_FALLBACK = 128_000;
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { SummarizationInput, SummarizeHook, SummaryResult } from "../compat/dsh-0.1/compaction";
import {
  clearDshCompactionMarkerIf,
  getDshCompactionMarker,
  stageDshCompactionMarker,
  type CompactionMarker,
} from "./outbox";

/* ─────────────────────────── constants & types ───────────────────────────── */

/** Historian chunk token budget when the caller does not supply one. */
export const DEFAULT_HISTORIAN_CHUNK_TOKENS = 16_000;

/** Default compartment-lease holder id prefix (per-session deterministic). */
const DEFAULT_LEASE_HOLDER_PREFIX = "dsh-historian";

/**
 * Round 20: a lease holder id unique per pass. Core's compartment lease
 * re-grants a lease to its OWN holder (`ON CONFLICT … WHERE holder_id =
 * excluded.holder_id`), so the old per-session id (`dsh-historian:<session>`)
 * let every overlapping pass — the trigger fires on each step above the
 * threshold, plus the compaction mini-historian and other DSH processes on the
 * same session — "acquire" the same lease and race to publish the same
 * compartment sequence (real rc.5 e2e 41599626978: UNIQUE constraint failed:
 * compartments.session_id, compartments.sequence → historian failed).
 */
function uniqueLeaseHolderId(sessionId: string): string {
  return `${DEFAULT_LEASE_HOLDER_PREFIX}:${sessionId}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/**
 * The injected historian LLM call (production: wraps `ctx.llm.stream()` with
 * the compartment-agent system prompt; tests: stubs). Receives the chunk and
 * the prior compartments and returns the raw historian XML text.
 */
export type DshSummarizeCall = (
  chunk: SessionChunk,
  priorCompartments: readonly Compartment[],
  signal?: AbortSignal,
  /**
   * Set on the single repair retry (upstream runHistorianPrompt parity): the
   * invalid XML and its validation error, to be wrapped with core's
   * buildHistorianRepairPrompt around the original prompt.
   */
  repair?: DshHistorianRepair,
) => Promise<string> | string;

/** Repair context for the one retry after a validation failure. */
export interface DshHistorianRepair {
  readonly previousOutput: string;
  readonly validationError: string;
}

/** Inputs to a single background historian pass. */
export interface HistorianDeps {
  /** Shared Magic SQLite handle. */
  readonly db: Database;
  /** Canonical Magic session id (`dsh:<home-hash>:<id>`). */
  readonly sessionId: string;
  /** Project working directory (memory promotion scope; omit to disable promotion). */
  readonly directory?: string;
  /** Raw-message source for this session (from the DshTranscriptView). */
  readonly provider: RawMessageProvider;
  /** Injected historian LLM call (see {@link DshSummarizeCall}). */
  readonly summarize: DshSummarizeCall;
  /** Historian model id — informational (telemetry/logs); defaults are the wiring's job. */
  readonly model?: string;
  /** Chunk token budget for `readSessionChunk` (default {@link DEFAULT_HISTORIAN_CHUNK_TOKENS}). */
  readonly chunkTokens?: number;
  /** Protected-tail boundary resolved by the trigger decision. When omitted a
   *  default snapshot is computed from the live provider messages (legacy
   *  5-user-turn tail policy) — sufficient for single-pass tests; production
   *  callers pass their trigger-resolved snapshot. */
  readonly boundarySnapshot?: ProtectedTailBoundarySnapshot;
  /** Optional live boundary resolver used to recover a stale trigger snapshot. */
  readonly refreshBoundarySnapshot?: () => ProtectedTailBoundarySnapshot;
  /** Current resolved context limit used to reject stale snapshots after model switches. */
  readonly currentContextLimit?: number;
  /** Compartment-lease holder id (default: `dsh-historian:<sessionId>`). */
  readonly leaseHolderId?: string;
  /** Surface failure notices (user-facing). Best-effort, never throws. */
  readonly notifyIssue?: (message: string) => void;
  /** Called once after COMMIT (may only signal deferred work). */
  readonly onPublished?: () => void;
  readonly log?: (message: string) => void;
  /** Optional cancellation signal forwarded to the SummarizeCall. */
  readonly signal?: AbortSignal;
  /** Run even inside the failure backoff window (explicit user-triggered passes). */
  readonly ignoreFailureBackoff?: boolean;
}

/**
 * Retry backoff after consecutive historian failures (round 15): 1 min after
 * the first, doubling per further failure, capped at 15 min. The pressure
 * trigger re-fires on every step above the threshold; without this a broken
 * historian model cost one LLM call (and one notice) per step.
 */
export function historianFailureBackoffMs(failureCount: number): number {
  if (!(failureCount > 0)) return 0;
  return Math.min(15 * 60_000, 60_000 * 2 ** Math.min(10, failureCount - 1));
}

/** The compaction marker + coverage gate (contract slice: marker block). */
export type { CompactionMarker };
export { stageDshCompactionMarker, getDshCompactionMarker, clearDshCompactionMarkerIf } from "./outbox";

/* ───────────────────────────── deferred signals ──────────────────────────── */

interface DeferredSignals {
  historyRefresh: boolean;
  materialization: boolean;
}

/** Process-local deferred-signal map (sessionId → flags). NOT persisted. */
const deferredSignalsBySession = new Map<string, DeferredSignals>();

/** Signal the next transform pass to refresh the rendered history (post-COMMIT only). */
export function signalDshDeferredHistoryRefresh(sessionId: string): void {
  const current = deferredSignalsBySession.get(sessionId) ?? { historyRefresh: false, materialization: false };
  current.historyRefresh = true;
  deferredSignalsBySession.set(sessionId, current);
}

/** Signal the next transform pass to materialize the staged compaction marker (post-COMMIT only). */
export function signalDshDeferredMaterialization(sessionId: string): void {
  const current = deferredSignalsBySession.get(sessionId) ?? { historyRefresh: false, materialization: false };
  current.materialization = true;
  deferredSignalsBySession.set(sessionId, current);
}

/** Read and CLEAR the pending deferred signals for a session (consumed by the next pre-step). */
export function consumeDshDeferredSignals(sessionId: string): { historyRefresh: boolean; materialization: boolean } {
  const current = deferredSignalsBySession.get(sessionId) ?? { historyRefresh: false, materialization: false };
  deferredSignalsBySession.delete(sessionId);
  return current;
}

/* ─────────────────────────────── trigger gate ────────────────────────────── */

/** Inputs mirroring `checkCompartmentTrigger`'s parameter parsing. */
export interface HistorianTriggerInputs {
  /** `executeThresholdPercentage` (e.g. 65). */
  readonly executeThresholdPercentage: number;
  /** `triggerBudget` (minimum eligible tokens for a size-based fire). */
  readonly triggerBudget: number;
  /** `contextLimit` (model context window; <= 0 falls back to 128k). */
  readonly contextLimit: number;
}

/**
 * Pure DSH mirror of the trigger's percentage decision (design §9.13: the
 * trigger compares `lastContextPercentage` against the proactive floor =
 * `executeThresholdPercentage - 2`). The full db-aware
 * `checkCompartmentTrigger` (tail-size / commit-cluster / force-band axes,
 * protected-tail boundary resolution) remains the production trigger; this is
 * the cheap scheduler gate for passes that only hold `session_meta.lastContextPercentage`.
 *
 * Input parsing mirrors the shared implementation: non-finite
 * `executeThresholdPercentage` → 65; `contextLimit` <= 0 → 128_000; a missing
 * or non-finite `lastContextPercentage` never fires.
 */
export function checkDshCompartmentTrigger(
  inputs: HistorianTriggerInputs,
  meta: { readonly lastContextPercentage?: number },
): boolean {
  const threshold = Number.isFinite(inputs.executeThresholdPercentage)
    ? Math.max(0, inputs.executeThresholdPercentage)
    : 65;
  const budget = Number.isFinite(inputs.triggerBudget) ? Math.max(0, inputs.triggerBudget) : 0;
  if (budget <= 0) return false; // nothing size-based can fire without a budget
  const percentage = meta.lastContextPercentage;
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) return false;
  const proactiveFloor = getProactiveCompartmentTriggerPercentage(threshold);
  return percentage >= proactiveFloor;
}

/* ───────────────────────────── marker coverage gate ──────────────────────── */

/**
 * Apply the staged compaction marker when the CURRENT pass actually rendered
 * through `marker.ordinal` (the rendered-coverage gate from design §9.13:
 * "模型已看到的内容才允许被裁剪").
 *
 * - no pending marker (or already applied) → `"stale"`;
 * - `readBoundary(marker.ordinal)` false → `"deferred"` (keep waiting);
 * - covered → `appendCompaction(summary, firstKeptOrdinal, tokensBefore)` with
 *   `firstKeptOrdinal = ordinal + 1`, then CAS-clear the marker → `"applied"`.
 *
 * `appendCompaction` is the official DSH surface append (integrator-injected);
 * if the CAS clear fails, a NEWER publish overwrote the marker and owns its
 * own drain — this marker's content was already appended, so still `"applied"`.
 */
export function applyDshCompactionMarkerIfCovered(deps: {
  readonly db: Database;
  readonly sessionId: string;
  readBoundary(ordinal: number): boolean;
  appendCompaction(summary: string, firstKeptOrdinal: number, tokensBefore: number): void;
}): "applied" | "deferred" | "stale" {
  const marker = getDshCompactionMarker(deps.db, deps.sessionId);
  if (marker === null || marker.status === "applied") return "stale";
  if (!deps.readBoundary(marker.ordinal)) return "deferred";
  deps.appendCompaction(marker.summary, marker.ordinal + 1, marker.tokensBefore);
  clearDshCompactionMarkerIf(deps.db, deps.sessionId, {
    ordinal: marker.ordinal,
    endMessageId: marker.endMessageId,
  });
  return "applied";
}

/* ─────────────────────────────── pass core ───────────────────────────────── */

interface HistPassArgs {
  readonly db: Database;
  readonly sessionId: string;
  readonly provider: RawMessageProvider;
  readonly summarize: DshSummarizeCall;
  readonly directory?: string;
  /** Historian model id (used to derive the chunk budget from its window). */
  readonly model?: string;
  readonly chunkTokens?: number;
  readonly boundarySnapshot?: ProtectedTailBoundarySnapshot;
  readonly refreshBoundarySnapshot?: () => ProtectedTailBoundarySnapshot;
  readonly currentContextLimit?: number;
  readonly leaseHolderId: string;
  readonly log: (message: string) => void;
  readonly signal?: AbortSignal;
  /** Mini-historian (magicSummarize): cap the eligible range at this ordinal (EXCLUSIVE). */
  readonly eligibleEndOrdinalOverride?: number;
  /** Mini-historian: skip discard-last healing — the caller-bounded range end
   *  is the compaction boundary, so the last compartment IS fully anchored. */
  readonly keepLastCompartment?: boolean;
}

/** The ok-narrowed validation result (facts/events/... accessible). */
type ValidatedOkPass = Extract<ValidatedHistorianPassResult, { ok: true }>;

interface HistPassResult {
  readonly ok: boolean;
  readonly status: "success" | "noop" | "failed";
  readonly reason?: string;
  readonly chunk?: SessionChunk;
  readonly newCompartments?: CandidateCompartment[];
  readonly lastNewEnd?: number;
  readonly lastNewEndMessageId?: string | null;
  readonly discardedLast?: boolean;
  readonly validated?: ValidatedOkPass;
  /** The raw LLM text that validated (for the hook's rawOutput). */
  readonly llmText?: string;
}

/** One chunk pass: read → summarize → validate → (publish is separate). Never throws. */
async function runHistorianPassCore(args: HistPassArgs): Promise<HistPassResult> {
  const { db, sessionId, provider, summarize } = args;
  const log = args.log;

  const priorCompartments = getCompartments(db, sessionId);
  const existingValidationError = validateStoredCompartments(priorCompartments);
  if (existingValidationError) {
    return {
      ok: false,
      status: "failed",
      reason: `existing compartment state invalid: ${existingValidationError}`,
    };
  }

  const offset =
    priorCompartments.length > 0 ? priorCompartments[priorCompartments.length - 1]!.endMessage + 1 : 1;

  // Protected-tail boundary: prefer the trigger-resolved snapshot; a
  // fingerprint-less snapshot (tests / default) skips the staleness check
  // (mirrors the Pi runner's `rawRangeFingerprint.length > 0` gate). A
  // caller-bounded range (mini-historian) with no snapshot skips boundary
  // resolution entirely.
  const rangeOverride =
    args.eligibleEndOrdinalOverride !== undefined && args.eligibleEndOrdinalOverride > 0
      ? args.eligibleEndOrdinalOverride
      : null;

  let eligibleEndOrdinal: number;
  if (rangeOverride !== null && args.boundarySnapshot === undefined) {
    eligibleEndOrdinal = rangeOverride;
  } else {
    let boundary = args.boundarySnapshot ?? createDefaultBoundarySnapshotForTests(sessionId);
    let boundaryOk = true;
    let boundaryDetail: string | undefined;
    if (boundary.rawRangeFingerprint.length > 0) {
      const validation = validateBoundarySnapshot({
        db,
        snapshot: boundary,
        currentContextLimit: args.currentContextLimit ?? boundary.contextLimit,
      });
      if (!validation.ok && validation.reason === "stale_snapshot" && args.refreshBoundarySnapshot) {
        try {
          const refreshed = args.refreshBoundarySnapshot();
          if (hasRunnableCompartmentWindow(refreshed)) {
            log(`[magic-context] historian: refreshed stale protected-tail snapshot at run time (${validation.detail ?? "stale"})`);
            boundary = refreshed;
          }
        } catch (error) {
          log(`[magic-context] historian: boundary refresh failed: ${describeError(error).brief}`);
        }
      }
      const finalValidation = validateBoundarySnapshot({
        db,
        snapshot: boundary,
        currentContextLimit: args.currentContextLimit ?? boundary.contextLimit,
      });
      if (!finalValidation.ok) {
        boundaryOk = false;
        boundaryDetail = finalValidation.detail ?? finalValidation.reason ?? "unknown";
      }
    }
    if (!boundaryOk) {
      return { ok: false, status: "noop", reason: `stale protected-tail snapshot (${boundaryDetail})` };
    }
    eligibleEndOrdinal = Math.min(
      boundary.eligibleEndOrdinal,
      boundary.protectedTailStart,
      rangeOverride ?? Number.MAX_SAFE_INTEGER,
    );
  }
  if (eligibleEndOrdinal <= offset) {
    return { ok: false, status: "noop", reason: `nothing to compact (eligibleEnd=${eligibleEndOrdinal} <= offset=${offset})` };
  }

  // Pi parity: the chunk budget follows the historian model's context window
  // (deriveHistorianChunkTokens), so low-window models don't overflow the
  // summarize call. When the session window is known (low-context runs), keep
  // a 35% share so the compartment prompt + references fit inside the window;
  // otherwise fall back to the model-derived budget, then the fixed default.
  // 优先用 historian 模型的窗口（Pi parity：chunk 预算跟随 historian 模型）；
  // 未解析时回退到会话窗口的安全比例，再回退固定默认。
  const historianWindow = resolveHistorianContextLimit(args.model);
  const resolvedWindow =
    historianWindow > 0
      ? historianWindow
      : typeof args.currentContextLimit === "number" && args.currentContextLimit > 0
        ? args.currentContextLimit
        : HISTORIAN_WINDOW_FALLBACK;
  const derived = deriveHistorianChunkTokens(resolvedWindow);
  const chunkTokens =
    args.chunkTokens ??
    derived ??
    DEFAULT_HISTORIAN_CHUNK_TOKENS;
  const chunk = readSessionChunk(sessionId, chunkTokens, offset, eligibleEndOrdinal);
  if (!chunk.text || chunk.messageCount === 0) {
    return { ok: false, status: "noop", reason: "chunk empty after filtering" };
  }
  const chunkCoverageError = validateChunkCoverage(chunk);
  if (chunkCoverageError) {
    return { ok: false, status: "failed", reason: `chunk coverage: ${chunkCoverageError}` };
  }

  let text: string;
  try {
    text = await summarize(chunk, priorCompartments, args.signal);
  } catch (error) {
    return { ok: false, status: "failed", reason: `llm call failed: ${describeError(error).brief}` };
  }
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, status: "failed", reason: "historian returned no usable text" };
  }
  text = maybeCorruptHistorianOutputForE2e(text, log);

  const maxExistingSequence = priorCompartments.reduce((max, c) => Math.max(max, c.sequence), -1);
  const sequenceOffset = priorCompartments.length === 0 ? 0 : maxExistingSequence + 1;
  let validated = validateHistorianOutput(text, sessionId, chunk, priorCompartments, sequenceOffset);
  if (!validated.ok && args.signal?.aborted !== true) {
    // Upstream parity (compartment-runner-historian runHistorianPrompt): one
    // repair retry with the validation error before the pass counts as a
    // failure. Real rc.5 round 18: a single "left uncovered messages … without
    // <unprocessed_from>" output put the DSH historian into failure backoff.
    const validationError = validated.error ?? "invalid compartment output";
    log(`[magic-context] historian repair retry: ${validationError}`);
    debugConsole(`[magic-context] historian repair retry: ${validationError}`);
    let repaired: string;
    try {
      repaired = await summarize(chunk, priorCompartments, args.signal, {
        previousOutput: text,
        validationError,
      });
    } catch (error) {
      return { ok: false, status: "failed", reason: `${validationError}; repair llm call failed: ${describeError(error).brief}` };
    }
    if (typeof repaired === "string" && repaired.trim().length > 0) {
      text = repaired;
      validated = validateHistorianOutput(text, sessionId, chunk, priorCompartments, sequenceOffset);
    }
  }
  if (!validated.ok) {
    return { ok: false, status: "failed", reason: validated.error };
  }

  // Discard-last boundary healing (E6 parity): the last compartment of a
  // greedy-consume run was decided without lookahead. Skipped when the range
  // is caller-bounded (mini-historian) and during emergency recovery (space
  // relief takes precedence) — mirrors the Pi runner.
  let newCompartments = validated.compartments;
  let discardedLast = false;
  const inEmergency = getOverflowState(db, sessionId).needsEmergencyRecovery;
  if (!args.keepLastCompartment && !inEmergency && shouldDiscardLastHistorianCompartment(newCompartments, chunk)) {
    const lastEmitted = newCompartments[newCompartments.length - 1]!;
    newCompartments = newCompartments.slice(0, -1);
    discardedLast = true;
    log(
      `[magic-context] historian discard-last: dropped provisional compartment ${lastEmitted.startMessage}-${lastEmitted.endMessage} (lookaheadMargin=${chunk.endIndex - lastEmitted.endMessage}); will re-derive next run`,
    );
  }
  const lastNewEnd = newCompartments[newCompartments.length - 1]?.endMessage ?? 0;
  if (lastNewEnd + 1 <= offset) {
    return {
      ok: false,
      status: "failed",
      reason: `historian returned compartments that did not advance past raw message ${offset - 1}`,
    };
  }

  return {
    ok: true,
    status: "success",
    chunk,
    newCompartments,
    lastNewEnd,
    lastNewEndMessageId: newCompartments[newCompartments.length - 1]?.endMessageId ?? null,
    discardedLast,
    validated,
    llmText: text,
  };
}

/* ─────────────────────────────── publication ─────────────────────────────── */

interface PublishArgs {
  readonly db: Database;
  readonly sessionId: string;
  readonly directory?: string;
  readonly leaseHolderId: string;
  readonly chunk: SessionChunk;
  readonly newCompartments: CandidateCompartment[];
  readonly lastNewEnd: number;
  readonly validated: ValidatedOkPass;
  readonly log: (message: string) => void;
}

interface PublishResult {
  readonly ok: boolean;
  readonly persistedIds: number[];
  readonly eventsPublished: number;
}

/**
 * ATOMIC publication (design §9.13): one BEGIN IMMEDIATE transaction writes
 * compartments + durable facts + events + the drop queue + the publication
 * floor + the staged compaction marker, then COMMITs. Any failure rolls back
 * everything — no staged intermediate state exists for the historian. Returns
 * `{ ok: false }` when the lease was lost or the transaction failed.
 */
function publishHistorianResult(args: PublishArgs): PublishResult {
  const { db, sessionId, leaseHolderId } = args;
  const lastNewEndMessageId = args.newCompartments[args.newCompartments.length - 1]?.endMessageId;
  const markerSummary = buildDshCompactionSummary(args.newCompartments);
  // DSH memory promotion scope: without a directory there is no project
  // identity, so facts are not promoted (mirrors memoryEnabled=false).
  const projectPath = args.directory ?? null;
  const promotionActive = projectPath !== null;
  const publishableEvents = (args.validated.events ?? []).filter((event) => {
    if (typeof event.atCompartment !== "number") return true;
    return event.atCompartment <= args.newCompartments.length;
  });

  let published = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!isCompartmentLeaseHeld(db, sessionId, leaseHolderId)) {
      db.exec("ROLLBACK");
      published = true; // transaction closed; nothing left to roll back
      return { ok: false, persistedIds: [], eventsPublished: 0 };
    }
    appendCompartments(db, sessionId, args.newCompartments);
    // Durable ids of the just-appended tail (used for event anchoring).
    const persistedIds = getCompartments(db, sessionId)
      .slice(-args.newCompartments.length)
      .map((c) => c.id);
    if (promotionActive) {
      // In-transaction promotion: failure propagates and rolls back the whole
      // publish (promoteSessionFactsDurable's documented transaction contract).
      promoteSessionFactsDurable(db, sessionId, projectPath, args.validated.facts ?? []);
    }
    let eventsPublished = 0;
    if (publishableEvents.length > 0) {
      try {
        insertCompartmentEvents(db, sessionId, publishableEvents, persistedIds);
        eventsPublished = publishableEvents.length;
      } catch (error) {
        // Best-effort (mirrors Pi): an events-store failure must not roll back
        // compartment publication.
        args.log(`[magic-context] failed to store compartment events: ${describeError(error).brief}`);
      }
    }
    queueDropsForCompartmentalizedMessages(db, sessionId, args.lastNewEnd);
    recordProtectedTailPublicationFloor(db, sessionId, args.lastNewEnd + 1);
    if (lastNewEndMessageId) {
      stageDshCompactionMarker(db, sessionId, {
        ordinal: args.lastNewEnd,
        endMessageId: lastNewEndMessageId,
        tokensBefore: args.chunk.tokenEstimate,
        summary: markerSummary,
      });
    }
    db.exec("COMMIT");
    published = true;
    return { ok: true, persistedIds, eventsPublished };
  } finally {
    if (!published) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Transaction may already be closed by an early rollback.
      }
    }
  }
}

/** Marker summary text (mirror of buildPiCompactionSummary). */
function buildDshCompactionSummary(
  compartments: ReadonlyArray<{ title: string; startMessage: number; endMessage: number }>,
): string {
  if (compartments.length === 0) return "Magic Context compacted prior history.";
  const titles = compartments
    .map((c) => c.title.trim())
    .filter((title) => title.length > 0);
  if (titles.length === 0) {
    const first = compartments[0];
    const last = compartments[compartments.length - 1];
    return `Magic Context compacted messages ${first?.startMessage ?? "?"}-${last?.endMessage ?? "?"}.`;
  }
  const MAX_SUMMARY_TITLES = 5;
  if (titles.length <= MAX_SUMMARY_TITLES) {
    return `Magic Context compacted: ${titles.join("; ")}`;
  }
  const shown = titles.slice(0, MAX_SUMMARY_TITLES).join("; ");
  return `Magic Context compacted ${titles.length} segments: ${shown}; …and ${titles.length - MAX_SUMMARY_TITLES} more`;
}

/* ────────────────────────────── the runner ───────────────────────────────── */

/**
 * Run one background historian pass. Flow:
 *
 *   acquireCompartmentLease (busy → false)
 *     → transcript-backed provider scope
 *     → readSessionChunk 分块
 *     → SummarizeCall (chunk, priorCompartments) → 摘要文本
 *     → validateHistorianOutput
 *     → atomic publish + stageDshCompactionMarker (same transaction)
 *     → COMMIT → onPublished
 *     → finally: releaseCompartmentLease + recordHistorianRun
 *
 * Failure paths (LLM / validation / publish / exception) never publish, never
 * stage the marker, record the run status, and release the lease. The returned
 * boolean is `true` only when a publication COMMITted.
 */
export async function runDshHistorian(deps: HistorianDeps): Promise<boolean> {
  const { db, sessionId } = deps;
  const log = deps.log ?? (() => {});
  const holderId = deps.leaseHolderId ?? uniqueLeaseHolderId(sessionId);
  if (typeof deps.summarize !== "function") {
    log(`[magic-context] historian: missing summarize call for ${sessionId}`);
    return false;
  }

  if (deps.ignoreFailureBackoff !== true) {
    try {
      const failure = getHistorianFailureState(db, sessionId);
      const backoff = historianFailureBackoffMs(failure.failureCount);
      const at = failure.lastFailureAt ?? 0;
      const now = Date.now();
      if (backoff > 0 && at > 0 && at <= now && now - at < backoff) {
        log(
          `[magic-context] historian: backing off after ${failure.failureCount} failure(s) for ${sessionId} (retry in ${Math.ceil((backoff - (now - at)) / 1000)}s)`,
        );
        return false;
      }
    } catch {
      // A failure-state read must never block the historian (fail-open).
    }
  }

  const lease = acquireCompartmentLease(db, sessionId, holderId);
  if (lease === null) {
    log(`[magic-context] historian: compartment lease busy for ${sessionId}`);
    return false;
  }

  const telemetry: Partial<HistorianRunInput> = { runKind: "incremental", status: "failed" };
  let completedSuccessfully = false;
  // Core failure state (session_meta.historian_failure_count / last_error /
  // last_failure_at), shared with OpenCode/Pi: drives the notice escalation,
  // the MC details popover and the retry backoff above.
  const recordFailure = (reason: string): number => {
    try {
      return incrementHistorianFailure(db, sessionId, reason);
    } catch {
      return 1;
    }
  };

  try {
    await withRawMessageProvider(sessionId, deps.provider, async () => {
      updateSessionMeta(db, sessionId, { compartmentInProgress: true });
      const result = await runHistorianPassCore({
        db,
        sessionId,
        provider: deps.provider,
        summarize: deps.summarize,
        directory: deps.directory,
        chunkTokens: deps.chunkTokens,
        model: deps.model,
        boundarySnapshot: deps.boundarySnapshot,
        refreshBoundarySnapshot: deps.refreshBoundarySnapshot,
        currentContextLimit: deps.currentContextLimit,
        leaseHolderId: holderId,
        log,
        signal: deps.signal,
      });

      if (!result.ok) {
        telemetry.status = result.status === "noop" ? "noop" : "failed";
        telemetry.failureReason = result.reason ?? null;
        telemetry.chunkStartOrdinal = result.chunk?.startIndex ?? null;
        telemetry.chunkEndOrdinal = result.chunk?.endIndex ?? null;
        if (result.status === "failed") {
          const reason = result.reason ?? "unknown";
          log(`[magic-context] historian failure: ${reason}`);
          const failCount = recordFailure(reason);
          try {
            deps.notifyIssue?.(buildHistorianFailureNotice(failCount, reason));
          } catch (error) {
            log(`[magic-context] historian notify failed: ${describeError(error).brief}`);
          }
        }
        return;
      }

      const publish = publishHistorianResult({
        db,
        sessionId,
        directory: deps.directory,
        leaseHolderId: holderId,
        chunk: result.chunk!,
        newCompartments: result.newCompartments!,
        lastNewEnd: result.lastNewEnd!,
        validated: result.validated!,
        log,
      });
      if (!publish.ok) {
        telemetry.failureReason = "publish failed (lease lost or transaction error)";
        return;
      }

      completedSuccessfully = true;
      telemetry.status = "success";
      try {
        clearHistorianFailureState(db, sessionId);
      } catch {
        // fail-open
      }
      telemetry.chunkStartOrdinal = result.chunk!.startIndex;
      telemetry.chunkEndOrdinal = result.chunk!.endIndex;
      telemetry.unprocessedFrom = result.lastNewEnd! + 1;
      telemetry.compartmentsProduced = result.newCompartments!.length;
      const validIds = publish.persistedIds.filter((id): id is number => typeof id === "number");
      telemetry.compartmentIdMin = validIds.length > 0 ? Math.min(...validIds) : null;
      telemetry.compartmentIdMax = validIds.length > 0 ? Math.max(...validIds) : null;
      const facts = result.validated!.facts ?? [];
      telemetry.factsEmitted = facts.length;
      telemetry.factsByCategory = facts.length > 0 ? tallyFactsByCategory(facts) : null;
      telemetry.eventsEmitted = publish.eventsPublished;
      const imp = summarizeImportance(
        result.newCompartments!.map((c) => c.importance ?? 50),
      );
      telemetry.importanceMin = imp.min;
      telemetry.importanceMax = imp.max;
      telemetry.importanceAvg = imp.avg;
      telemetry.discardedLast = result.discardedLast === true;

      // Post-COMMIT only: the caller's hook may signal deferred history
      // refresh / materialization — never publish-visible state.
      deps.onPublished?.();
      // Magic note-nudger: historian completion is a natural note boundary.
      try {
        onNoteTrigger(deps.db, deps.sessionId, "historian_complete");
      } catch {
        // Nudges never break the publish path (fail-open).
      }
      log(
        `[magic-context] historian: published ${result.newCompartments!.length} compartment(s), ${facts.length} fact(s) covering messages ${result.chunk!.startIndex}-${result.lastNewEnd!}`,
      );
    });
  } catch (error) {
    const desc = describeError(error);
    telemetry.failureReason = `exception: ${desc.brief}`;
    log(`[magic-context] historian failure: source=exception ${desc.brief}`);
    const failCount = recordFailure(desc.brief);
    try {
      deps.notifyIssue?.(buildHistorianFailureNotice(failCount, desc.brief));
    } catch {
      // notify must never break the fire-and-forget contract
    }
  } finally {
    try {
      releaseCompartmentLease(db, sessionId, holderId);
    } catch (error) {
      log(`[magic-context] historian lease release failed: ${describeError(error).brief}`);
    }
    try {
      updateSessionMeta(db, sessionId, { compartmentInProgress: false });
    } catch (error) {
      log(`[magic-context] historian meta update failed: ${describeError(error).brief}`);
    }
    // One historian_runs telemetry row per attempt (every exit path).
    try {
      recordHistorianRun(db, {
        sessionId,
        harness: "dsh",
        runKind: telemetry.runKind ?? "incremental",
        status: telemetry.status ?? "failed",
        failureReason: telemetry.failureReason ?? null,
        chunkStartOrdinal: telemetry.chunkStartOrdinal ?? null,
        chunkEndOrdinal: telemetry.chunkEndOrdinal ?? null,
        unprocessedFrom: telemetry.unprocessedFrom ?? null,
        compartmentsProduced: telemetry.compartmentsProduced ?? 0,
        compartmentIdMin: telemetry.compartmentIdMin ?? null,
        compartmentIdMax: telemetry.compartmentIdMax ?? null,
        factsEmitted: telemetry.factsEmitted ?? 0,
        factsByCategory: telemetry.factsByCategory ?? null,
        eventsEmitted: telemetry.eventsEmitted ?? 0,
        importanceMin: telemetry.importanceMin ?? null,
        importanceMax: telemetry.importanceMax ?? null,
        importanceAvg: telemetry.importanceAvg ?? null,
        discardedLast: telemetry.discardedLast ?? false,
      });
    } catch {
      // telemetry must never break compaction
    }
  }
  return completedSuccessfully;
}

/**
 * Round 21: does a live historian pass (any holder) hold the compartment lease
 * of `sessionId`? The agent plane exposes this to the compaction engine
 * (`magicContextHost.historianBusy`) so the native pressure backstop defers
 * instead of failing "lease busy". Expired leases do not count.
 */
export function isDshHistorianBusy(db: Database, sessionId: string): boolean {
  return getCompartmentLeaseBlocker(db, sessionId) !== null;
}

/* ──────────────────────── magicSummarize hook (Magic 压缩策略) ─────────────────────── */

/** Deps for the Magic compression strategy hook. */
export interface MagicSummarizeDeps {
  readonly db: Database;
  readonly sessionId: string;
  /**
   * Cordis ctx — reserved for production wiring (`ctx.llm` +
   * `ctx.get("magicContextHost")`). This slice never reads it: the LLM call is
   * injected via {@link MagicSummarizeDeps.summarize}.
   */
  readonly ctx: unknown;
  /** Raw-message source for this session (transcript-backed). */
  readonly provider: RawMessageProvider;
  /** Injected historian LLM call used for the sync mini-historian. */
  readonly summarize: DshSummarizeCall;
  /** Project directory (memory promotion scope for the mini-historian). */
  readonly directory?: string;
  readonly chunkTokens?: number;
  /** Compartment-lease holder id for the mini-historian (default per-session). */
  readonly leaseHolderId?: string;
  /**
   * Round 21: how long the mini-historian waits for a compartment lease held
   * by another (background) historian pass before failing closed. Default
   * {@link DEFAULT_SUMMARIZE_LEASE_WAIT_MS}.
   */
  readonly leaseWaitMs?: number;
  /** Poll interval while waiting for the lease (default 500 ms). */
  readonly leasePollMs?: number;
  /** Provider/model resolution; default: the compacting agent's options. */
  readonly resolveModel?: (agent: Agent) => { provider: string; model: string };
  readonly log?: (message: string) => void;
}

/**
 * Round 21: bounded wait for a busy compartment lease in the summarize hook
 * (manual `/compact` while a background historian pass runs). A background
 * pass is one historian LLM call over one chunk; 45 s covers the common case
 * without letting `/compact` hang indefinitely.
 */
export const DEFAULT_SUMMARIZE_LEASE_WAIT_MS = 45_000;

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("magic-context: summarize aborted while waiting for the compartment lease"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("magic-context: summarize aborted while waiting for the compartment lease"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Default provider/model resolution: the compacting agent's options. */
function defaultResolveModel(agent: Agent): { provider: string; model: string } {
  const options = agent.options;
  return {
    provider: options.provider ?? "dsh",
    model: options.model ?? "unknown",
  };
}

/**
 * The Magic compression strategy: `MagicCompactionEngine.summarize` hook
 * (registered via the host service by the agent plane).
 *
 * 1. Determine the range [firstOrdinal, lastOrdinal] of `input.messages`
 *    (message ids → ordinals via the transcript-backed provider).
 * 2. Fully covered by published compartments (contiguity from ordinal 1 is the
 *    stored invariant, so `lastCompartmentEnd >= lastOrdinal` suffices)?
 *    → render the compartment block (buildCompartmentBlock: compartments +
 *    session facts) as the summary.
 * 3. Not fully covered → run ONE synchronous mini-historian pass (same
 *    SummarizeCall) over the uncovered range [lastCompartmentEnd+1, lastOrdinal]
 *    with validation + atomic publication, then re-render.
 * 4. Lease held by a background pass → wait (bounded, round 21) re-checking
 *    coverage; still busy afterwards → throw.
 * 5. Failures (LLM / validation / publish / lease-busy) THROW — the official
 *    compaction transaction closes the compaction/end with error (fail-closed).
 */
export function createMagicSummarizeHook(deps: MagicSummarizeDeps): SummarizeHook {
  const sessionId = deps.sessionId;
  const log = deps.log ?? (() => {});
  const holderId = deps.leaseHolderId ?? uniqueLeaseHolderId(sessionId);

  return async (input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> => {
    const { provider, model } = (deps.resolveModel ?? defaultResolveModel)(agent);
    const messages = input.messages;
    const emptyResult: SummaryResult = {
      summary: [{ type: "text", text: "Magic Context compacted prior history." }],
      provider,
      model,
    };
    if (messages.length === 0) return emptyResult;

    // Range resolution (first/last message ids → raw ordinals) runs INSIDE the
    // provider scope: the transcript-backed provider must be registered for
    // `readRawSessionMessageOrdinalById`. Fail-closed when unresolvable.
    const firstId = String(messages[0]!.id);
    const lastId = String(messages[messages.length - 1]!.id);

    return withRawMessageProvider(sessionId, deps.provider, async () => {
      // Round 20: compaction-basic prepends the conversation's system prompt
      // (surface node 0) to the region, and a region boundary can be a
      // surface message the view does not carry by id (a Magic op copy, a
      // folded tool result). Resolve the range over every message the view
      // knows (system prompts skipped) instead of the literal first/last ids.
      let firstOrdinal: number | null = null;
      let lastOrdinal: number | null = null;
      for (const message of messages) {
        if ((message as { role?: unknown }).role === "system") continue;
        const ordinal = readRawSessionMessageOrdinalById(sessionId, String(message.id));
        if (ordinal === null) continue;
        if (firstOrdinal === null || ordinal < firstOrdinal) firstOrdinal = ordinal;
        if (lastOrdinal === null || ordinal > lastOrdinal) lastOrdinal = ordinal;
      }
      if (firstOrdinal === null || lastOrdinal === null || lastOrdinal < firstOrdinal) {
        throw new Error(
          `magic-context: summarize range unresolvable for ${sessionId} (messages ${firstId}..${lastId})`,
        );
      }
      // Coverage: stored compartments are contiguous from ordinal 1
      // (validateStoredCompartments invariant), so the range is fully covered
      // iff the last compartment's endMessage reaches the range's last ordinal.
      let rawOutput: string | undefined;
      let covered = getLastCompartmentEndMessage(deps.db, sessionId) >= lastOrdinal;
      let lease = covered ? null : acquireCompartmentLease(deps.db, sessionId, holderId);
      if (!covered && lease === null) {
        // Round 21: another (background) historian pass holds the lease. Wait
        // for it — bounded — re-checking coverage: that pass usually publishes
        // exactly the range this compaction needs.
        const waitMs = Math.max(0, deps.leaseWaitMs ?? DEFAULT_SUMMARIZE_LEASE_WAIT_MS);
        const pollMs = Math.max(1, deps.leasePollMs ?? 500);
        const started = Date.now();
        const waitLine = `[magic-context] summarize: waiting for the compartment lease of ${sessionId} (a historian pass is running; up to ${Math.round(waitMs / 1000)}s)`;
        log(waitLine);
        // Round 22: headless prints stderr only (ctx.logger is not shown).
        debugConsole(waitLine);
        while (Date.now() - started < waitMs) {
          await sleepUnlessAborted(Math.min(pollMs, Math.max(1, waitMs - (Date.now() - started))), signal);
          if (getLastCompartmentEndMessage(deps.db, sessionId) >= lastOrdinal) {
            covered = true;
            break;
          }
          lease = acquireCompartmentLease(deps.db, sessionId, holderId);
          if (lease !== null) break;
        }
        if (!covered && lease === null) {
          const message = `magic-context: summarize mini-historian lease busy for ${sessionId} after waiting ${Math.round((Date.now() - started) / 1000)}s (a historian pass is still running; retry once it finishes)`;
          debugConsole(`[magic-context] ${message}`);
          throw new Error(message);
        }
        const endLine = `[magic-context] summarize: lease wait ended after ${Date.now() - started}ms (${covered ? "range covered by the background pass" : "lease acquired"})`;
        log(endLine);
        debugConsole(endLine);
      }
      if (!covered && lease !== null) {
        // Mini-historian: one synchronous pass over [lastCompartmentEnd+1, lastOrdinal].
        try {
          const result = await runHistorianPassCore({
            db: deps.db,
            sessionId,
            provider: deps.provider,
            summarize: deps.summarize,
            directory: deps.directory,
            chunkTokens: deps.chunkTokens,
            leaseHolderId: holderId,
            log,
            signal,
            eligibleEndOrdinalOverride: lastOrdinal + 1,
            keepLastCompartment: true,
          });
          if (!result.ok) {
            throw new Error(
              `magic-context: summarize mini-historian failed: ${result.reason ?? "unknown"}`,
            );
          }
          const publish = publishHistorianResult({
            db: deps.db,
            sessionId,
            directory: deps.directory,
            leaseHolderId: holderId,
            chunk: result.chunk!,
            newCompartments: result.newCompartments!,
            lastNewEnd: result.lastNewEnd!,
            validated: result.validated!,
            log,
          });
          if (!publish.ok) {
            throw new Error(
              "magic-context: summarize mini-historian publish failed (lease lost or transaction error)",
            );
          }
          rawOutput = result.llmText ?? undefined;
        } finally {
          try {
            releaseCompartmentLease(deps.db, sessionId, holderId);
          } catch (error) {
            log(`[magic-context] summarize mini-historian lease release failed: ${describeError(error).brief}`);
          }
        }
      }

      // Render the covered range as the summary block.
      const compartments = getCompartments(deps.db, sessionId).filter(
        (c) => c.endMessage >= firstOrdinal && c.startMessage <= lastOrdinal,
      );
      const facts: SessionFact[] = getSessionFacts(deps.db, sessionId);
      const text = buildCompartmentBlock(compartments, facts);
      if (text.length === 0) {
        throw new Error(
          `magic-context: summarize produced no compartment content for ${sessionId} range ${firstOrdinal}-${lastOrdinal}`,
        );
      }
      return {
        summary: [{ type: "text", text }],
        provider,
        model,
        ...(rawOutput !== undefined ? { rawOutput: [{ type: "text" as const, text: rawOutput }] } : {}),
      };
    });
  };
}


/**
 * E2E-ONLY fault injection (round 19): exercise the historian repair retry in
 * real DSH. When `MAGIC_CONTEXT_DSH_E2E_CORRUPT_HISTORIAN_ONCE` names an
 * ABSOLUTE marker path that does not exist yet, the first historian output is
 * replaced by truncated XML and the marker is created with O_EXCL — exactly
 * once across processes (headless runs one process per turn). Production never
 * sets the variable; an unset/relative value or an existing marker is a no-op.
 * Only the primary output is touched, never the repair call's.
 */
export const E2E_CORRUPT_HISTORIAN_ENV = "MAGIC_CONTEXT_DSH_E2E_CORRUPT_HISTORIAN_ONCE";
export const E2E_CORRUPTED_HISTORIAN_OUTPUT = '<output>\n<compartments>\n<compartment start="1" end="';

export function maybeCorruptHistorianOutputForE2e(
  text: string,
  log: (message: string) => void,
  env: Record<string, string | undefined> = process.env,
): string {
  const marker = env[E2E_CORRUPT_HISTORIAN_ENV];
  if (typeof marker !== "string" || marker.length === 0 || !isAbsolute(marker)) return text;
  try {
    closeSync(openSync(marker, "wx"));
  } catch {
    return text; // already injected once (or unwritable): never again
  }
  const line = `[magic-context] e2e: historian output corrupted once (${E2E_CORRUPT_HISTORIAN_ENV}); expecting a repair retry`;
  log(line);
  // headless prints console.error, not ctx.logger (e2e evidence; test-only path)
  try {
    // eslint-disable-next-line no-console
    console.error(line);
  } catch {
    // diagnostics only
  }
  return E2E_CORRUPTED_HISTORIAN_OUTPUT;
}

/** stderr diagnostics under MAGIC_CONTEXT_DEBUG_HISTORIAN=1 (headless prints these; ctx.logger is not shown). */
function debugConsole(line: string): void {
  if (process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN !== "1") return;
  try {
    // eslint-disable-next-line no-console
    console.error(line);
  } catch {
    // diagnostics only
  }
}
