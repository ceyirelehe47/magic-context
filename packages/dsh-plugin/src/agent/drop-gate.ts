/**
 * agent/drop-gate — when queued drops may land on the DSH surface (round 36
 * line C).
 *
 * Core applies `pending_ops` (`applyPendingOperations`) only on a pass that
 * rewrites the provider prefix anyway (OpenCode
 * `transform-postprocess-phase.ts`: `shouldApplyPendingOps =
 * !compactionOff && publishedWorkDrainAllowed`; Pi `context-handler.ts`:
 * `shouldApplyPendingOps = publishedWorkDrainAllowed`), both through
 * `reclaimRidePermitted(rideSignals, gate)` in `cache-busting-signals.ts`.
 * Before this module the DSH adapter applied them on every pre-step, so a
 * single ctx_reduce turned into one prefix-cache break per step as each
 * deferred tag left the protection window (cache-bench run 42142782133).
 *
 * This module only maps DSH observations onto core's own signal shapes; the
 * decision itself is core's (`hasReclaimRide`, `reclaimRidePermitted`,
 * `originateExecuteReclaim`, `estimateExecuteReclaimTokens`). Mapping
 * (core signal → DSH observation):
 *
 *   hardFold          → a surface node the last served request carried was
 *                       replaced since that request (DSH compaction
 *                       checkpoint, /compact, system-prompt rewrite, any
 *                       non-Magic replace; Magic's own `mc-op:` plan copies
 *                       excluded) — read from the durable session log;
 *                       OR nothing served yet (first render); OR the
 *                       cache-TTL idle expiry (core folds idleExpiryRebuild
 *                       into hardFold too).
 *   publishedHistory  → a historian publication (compartments.created_at /
 *                       dsh_context_compaction_marker.published_at) at or
 *                       after the last served request. Its compartment drops
 *                       are queued pending ops in DSH, exactly the work core
 *                       lands on the m[1] refresh ride.
 *   force             → context ≥ the force band (escalationBands), with core's
 *                       estimate guard (< 95 % needs a provider-anchored
 *                       reading and no latched emergency sample).
 *   executeReclaim    → core `originateExecuteReclaim` on [execute, force),
 *                       with summaryCanCome = historian pass in flight
 *                       (compartmentInProgress) / unapplied DSH compaction
 *                       marker / core floor mark.
 *   explicitFlush     → not a ride here: DSH `/ctx-flush` runs core
 *                       `executeFlush`, which flips the tags to `dropped`
 *                       directly; `applyFlushedStatuses` replays them on the
 *                       very next pass with no gate (same effect, immediate).
 *   subagentExecute   → no counterpart: child sessions never enter the Magic
 *                       context plane (`isMagicChildSession`) — always false.
 *   servedShapeRepair → no counterpart (OpenCode served-shape replay) — false.
 *
 * Permission gate: DSH has no signed-thinking prefix hold (DeepSeek reasoning
 * is not signature-bound), so `signedThinkingHold` is false and
 * `prefixMutationPermitted` is true; the other gate fields are still passed
 * as core computes them. Anything unknown defaults to "no ride" (defer):
 * a drop may land later, never in a pass that would break a warm prefix.
 */
import {
  hasReclaimRide,
  reclaimRideLabel,
  reclaimRidePermitted,
  type ReclaimRidePermissionGate,
  type ReclaimRideSignals,
} from "@magic-context/core/hooks/magic-context/cache-busting-signals";
import {
  estimateExecuteReclaimTokens,
  originateExecuteReclaim,
  readExecuteReclaimState,
} from "@magic-context/core/hooks/magic-context/execute-reclaim";
import { getEmergencyInputSample } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { resolveCacheTtl } from "@magic-context/core/hooks/magic-context/event-resolvers";
import { parseCacheTtl } from "@magic-context/core/features/magic-context/scheduler";
import type { PendingOp, TagEntry } from "@magic-context/core/features/magic-context/types";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";
import type { Database } from "@magic-context/core/shared/sqlite";
import { getDshCompactionMarker } from "./outbox";
import { isMagicSource } from "../compat/dsh-0.1/session";

/** Core's absolute wall: at or above it the protected tail is not protected. */
export const DROP_GATE_UNPROTECT_PERCENTAGE = 95;

/** What the session log says about the last served request. */
export interface ServedPrefixState {
  /** Seq of the last served request marker (request/header, else the last appended assistant/message); -1 when nothing was served. */
  readonly servedBoundarySeq: number;
  /** Wall-clock time (epoch ms) of that marker; 0 when unknown. */
  readonly servedAt: number;
  /** Time of the latest completed (not interrupted) appended assistant/message — core's lastResponseTime. */
  readonly lastResponseAt: number;
  /** A node the served request carried was replaced after it (seq of that replace), or null. */
  readonly rewrittenBySeq: number | null;
  /** Event type of that replace (diagnostics). */
  readonly rewrittenByType: string | null;
}

interface LogEventLike {
  readonly type?: unknown;
  readonly seq?: unknown;
  readonly time?: unknown;
  readonly surfaceOp?: unknown;
  readonly data?: { readonly interrupted?: unknown } | null;
}

function isMagicOpCopy(e: LogEventLike): boolean {
  const data = (e as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return false;
  const source = (data as { source?: { messageId?: unknown } }).source;
  return isMagicSource(source) && typeof source?.messageId === "string" && source.messageId.startsWith("mc-op:");
}

function replaceStartSeq(op: unknown): number | null {
  if (op === null || typeof op !== "object") return null;
  const start = (op as { startSeq?: unknown }).startSeq;
  return typeof start === "number" ? start : null;
}

/**
 * Read the served-prefix state from the durable DSH session log (works across
 * headless processes). The served boundary is the latest `request/header`
 * (every surface node with a lower seq was in that request's prompt); a log
 * without request headers (older hosts, test doubles) falls back to the latest
 * APPENDED assistant/message (its own request carried every earlier node).
 * Replaced copies (surfaceOp replace) never count as a served marker.
 */
export function readServedPrefixState(events: readonly unknown[]): ServedPrefixState {
  let headerSeq = -1;
  let headerAt = 0;
  let assistantSeq = -1;
  let assistantAt = 0;
  let lastResponseAt = 0;
  for (const raw of events) {
    if (raw === null || typeof raw !== "object") continue;
    const e = raw as LogEventLike;
    const seq = typeof e.seq === "number" ? e.seq : -1;
    const time = typeof e.time === "number" && Number.isFinite(e.time) ? e.time : 0;
    if (e.type === "request/header") {
      if (seq > headerSeq) {
        headerSeq = seq;
        headerAt = time;
      }
    } else if (e.type === "assistant/message" && e.surfaceOp === "append") {
      if (seq > assistantSeq) {
        assistantSeq = seq;
        assistantAt = time;
      }
      if (e.data?.interrupted !== true && time > lastResponseAt) lastResponseAt = time;
    }
  }
  const servedBoundarySeq = headerSeq >= 0 ? headerSeq : assistantSeq;
  const servedAt = headerSeq >= 0 ? headerAt : assistantAt;
  let rewrittenBySeq: number | null = null;
  let rewrittenByType: string | null = null;
  if (servedBoundarySeq >= 0) {
    for (const raw of events) {
      if (raw === null || typeof raw !== "object") continue;
      const e = raw as LogEventLike;
      const seq = typeof e.seq === "number" ? e.seq : -1;
      if (seq <= servedBoundarySeq) continue;
      const start = replaceStartSeq(e.surfaceOp);
      if (start === null || start >= servedBoundarySeq) continue;
      // Magic's own plan copies (`mc-op:<opId>`) are not evidence of a cold
      // prefix: a tags copy re-materializes bytes the model was already
      // served through the §N§ preview, and a copy that did change bytes
      // (drop / cleanup / truncation) was itself a permitted rewrite whose
      // drops landed in that same pass. Counting them would turn every
      // tag materialization into a ride (the exact churn this gate removes).
      if (isMagicOpCopy(e)) continue;
      rewrittenBySeq = seq;
      rewrittenByType = typeof e.type === "string" ? e.type : null;
      break;
    }
  }
  return { servedBoundarySeq, servedAt, lastResponseAt, rewrittenBySeq, rewrittenByType };
}

/** Core's cache-TTL idle heuristic (knowledge-gate `computeHardSignals` parity). */
export function isCacheIdleExpired(lastResponseAt: number, now: number, cacheTtl: string | undefined, modelKey: string | undefined): boolean {
  if (!(lastResponseAt > 0)) return false;
  try {
    const ttlMs = parseCacheTtl(resolveCacheTtl(cacheTtl ?? "5m", modelKey));
    return Number.isFinite(ttlMs) && now - lastResponseAt > ttlMs;
  } catch {
    return false;
  }
}

/** Latest historian publication time (compartments / DSH marker), 0 when none. Fail-open 0. */
export function latestHistorianPublishAt(db: Database, sessionId: string): number {
  let latest = 0;
  try {
    const marker = getDshCompactionMarker(db, sessionId);
    if (marker !== null && marker.publishedAt > latest) latest = marker.publishedAt;
  } catch {
    // no marker table: fall through
  }
  try {
    const row = db.prepare("SELECT MAX(created_at) AS latest FROM compartments WHERE session_id = ?").get(sessionId) as
      | { latest: number | null }
      | null
      | undefined;
    if (typeof row?.latest === "number" && row.latest > latest) latest = row.latest;
  } catch {
    // fail-open
  }
  return latest;
}

/** Whether a historian summary can still come for this session (core `summaryCanCome`). */
export function dshSummaryCanCome(db: Database, sessionId: string): boolean {
  try {
    if (getOrCreateSessionMeta(db, sessionId).compartmentInProgress) return true;
  } catch {
    return true; // unknown → assume it can (defer the optional executeReclaim)
  }
  try {
    const marker = getDshCompactionMarker(db, sessionId);
    if (marker !== null && marker.status !== "applied") return true;
  } catch {
    // no marker
  }
  try {
    return readExecuteReclaimState(db, sessionId).floorOrdinal !== null;
  } catch {
    return true;
  }
}

/** Per-pass inputs the context plane gathers from the DSH session. */
export interface DshDropRideInput {
  readonly served: ServedPrefixState;
  readonly cacheExpired: boolean;
  readonly historianPublishedAt: number;
  /** Projected context % of the window (historian-trigger reading); undefined = unknown. */
  readonly contextPercentage?: number;
  /** True when no provider usage sample anchors the reading (core contextUsageFromEstimate). */
  readonly fromEstimate?: boolean;
  readonly executePercentage: number;
  readonly forcePercentage: number;
  /** Usable window for core's 2 % executeReclaim floor; 0/undefined = only the 3-held-pass rule. */
  readonly usableWindow?: number;
  readonly summaryCanCome: boolean;
}

export interface DropRideDecision {
  readonly permitted: boolean;
  readonly signals: ReclaimRideSignals;
  readonly gate: ReclaimRidePermissionGate;
  /** Core-format label, e.g. `ride=hardFold+publishedHistory`. */
  readonly label: string;
  /** ≥ 95 %: core passes no protected tags to applyPendingOperations. */
  readonly unprotectTail: boolean;
  readonly detail: string;
}

/** Ride signals that need no transcript targets (everything except executeReclaim). */
export function baseRideSignals(db: Database, sessionId: string, input: DshDropRideInput | undefined): {
  signals: ReclaimRideSignals;
  gate: ReclaimRidePermissionGate;
  pct: number | undefined;
} {
  if (input === undefined) {
    return {
      signals: { hardFold: false, force: false, explicitFlush: false, publishedHistory: false, subagentExecute: false, executeReclaim: false, servedShapeRepair: false },
      gate: { signedThinkingHold: false, firstRender: false, idleExpiry: false, emergency: false },
      pct: undefined,
    };
  }
  const pct =
    typeof input.contextPercentage === "number" && Number.isFinite(input.contextPercentage) ? input.contextPercentage : undefined;
  const firstRender = input.served.servedBoundarySeq < 0;
  const emergency = pct !== undefined && pct >= input.forcePercentage;
  let emergencySample = 0;
  if (emergency && (pct ?? 0) < DROP_GATE_UNPROTECT_PERCENTAGE) {
    try {
      emergencySample = getEmergencyInputSample(db, sessionId);
    } catch {
      emergencySample = 0;
    }
  }
  const signals: ReclaimRideSignals = {
    hardFold: firstRender || input.served.rewrittenBySeq !== null || input.cacheExpired,
    force:
      emergency &&
      ((pct ?? 0) >= DROP_GATE_UNPROTECT_PERCENTAGE || (input.fromEstimate !== true && emergencySample === 0)),
    explicitFlush: false,
    publishedHistory:
      input.historianPublishedAt > 0 && input.served.servedBoundarySeq >= 0 && input.historianPublishedAt >= input.served.servedAt,
    subagentExecute: false,
    executeReclaim: false,
    servedShapeRepair: false,
  };
  const gate: ReclaimRidePermissionGate = {
    signedThinkingHold: false,
    firstRender,
    idleExpiry: input.cacheExpired,
    emergency,
  };
  return { signals, gate, pct };
}

/**
 * Decide whether this pass may apply queued drops (core
 * `reclaimRidePermitted`). executeReclaim is originated through core only
 * when no other ride is present and drops are queued.
 */
export function decideDropRide(args: {
  readonly db: Database;
  readonly sessionId: string;
  readonly input: DshDropRideInput | undefined;
  readonly pendingOps: readonly PendingOp[];
  readonly tags: readonly TagEntry[];
  readonly targets: ReadonlyMap<number, TagTarget>;
  readonly protectedTagNumbers: ReadonlySet<number>;
}): DropRideDecision {
  const { signals, gate, pct } = baseRideSignals(args.db, args.sessionId, args.input);
  const input = args.input;
  const queuedDrops = args.pendingOps.some((op) => op.operation === "drop");
  if (input !== undefined && queuedDrops && pct !== undefined) {
    try {
      const primaryExecute = pct >= input.executePercentage && pct < input.forcePercentage;
      signals.executeReclaim = originateExecuteReclaim({
        db: args.db,
        sessionId: args.sessionId,
        primaryExecute,
        alreadyBusting: hasReclaimRide(signals),
        summaryCanCome: input.summaryCanCome,
        reclaimableTokens: primaryExecute
          ? estimateExecuteReclaimTokens({
              db: args.db,
              sessionId: args.sessionId,
              pendingOps: [...args.pendingOps],
              tags: args.tags,
              targets: args.targets,
              protectedTagIds: args.protectedTagNumbers,
            })
          : 0,
        usableWindow: input.usableWindow ?? 0,
      });
    } catch {
      signals.executeReclaim = false; // optional lane: defer on any failure
    }
  }
  const permitted = reclaimRidePermitted(signals, gate);
  const unprotectTail = pct !== undefined && pct >= DROP_GATE_UNPROTECT_PERCENTAGE;
  const detail =
    input === undefined
      ? "no ride input"
      : `context=${pct === undefined ? "?" : pct.toFixed(1)}% served=${input.served.servedBoundarySeq}` +
        (input.served.rewrittenBySeq !== null ? ` rewrittenBy=${input.served.rewrittenByType ?? "?"}@${input.served.rewrittenBySeq}` : "") +
        (input.cacheExpired ? " ttlExpired" : "");
  return { permitted, signals, gate, label: reclaimRideLabel(signals), unprotectTail, detail };
}
