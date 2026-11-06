/**
 * agent/nudge — ctx_reduce Channel-1 / Channel-2 nudges (Pi parity).
 *
 * Pi appends `<system-reminder>` blocks in-turn (Channel 1) and escalates to a
 * synthetic-user ceiling interrupt (Channel 2). DSH follows its "inject, do not
 * rewrite" philosophy: the decision functions and reminder bodies are the
 * shared core's (`ctx-reduce-nudge`), and delivery rides `agent.inject(...)`
 * (visible on the next pre-step batch), deduplicated by a `mc-nudge:<kind>`
 * watermark on the live surface. State persistence uses the shared
 * storage-meta accessors (Channel-1 JSON state + Channel-2 CAS lease), so a
 * Pi↔DSH session pair shares cadence.
 *
 * Core ≥0.49 drives the decisions from a tail-hygiene baseline (U = undropped
 * reclaimable tokens, T = live tail tokens). DSH now feeds the SAME core walk
 * (`refreshTailHygieneBaseline` → `measureTailHygiene`) with the DSH transcript
 * view (OpenCode-shaped `RawMessage` parts), the token-floor protection window
 * and the queued-drop set, so U/T, the turn deltas, the reclaimable-output
 * count and the post-reduce grace are real measurements — no tag-aggregate
 * approximation. A surface rewrite is the DSH cache bust (baseline refreeze);
 * other passes extend the frozen baseline with turn deltas, exactly as core.
 *
 * `hasRecentReduce` (core `reducedSinceRefresh`): true when a `ctx_reduce`
 * call appeared in the transcript, or a drop was queued in `pending_ops`,
 * after the baseline was last refrozen.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  buildChannel1Reminder,
  buildChannel2Reminder,
  decideChannel1,
  evaluateChannel2,
  currentReclaimableToolOutputCount,
  type ToolReclaimHint,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import { getPendingOps, getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import { sessionDecisionCalibration } from "@magic-context/core/features/magic-context/session-decision-calibration";
import {
  effectiveTailHygiene,
  refreshTailHygieneBaseline,
  type TailHygieneBaseline,
} from "@magic-context/core/hooks/magic-context/tail-hygiene-walk";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/tag-messages";
import {
  captureChannel1PostReduceGraceBaseline,
  casChannel2NudgeState,
  getChannel1NudgeState,
  getChannel2NudgeState,
  getLastNudgeUndropped,
  setChannel1NudgeState,
  setLastNudgeUndropped,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import {
  isMagicSource,
  magicUserMessage,
  promptTokensOf,
  sessionEvents,
  type MagicMessageSource,
} from "../compat/dsh-0.1/session";
import { observedProtectionWindow, type DshProtectionOptions } from "./protection";
import {
  isKnowledgeBaselineMessage,
  isNativeView,
  isSkillCatalogBaselineMessage,
  readDshTranscript,
} from "./transcript";

/** Scan the session event log for the live context window + last input usage. */
export function scanSessionMetrics(agent: Agent): {
  lastInputTokens: number;
  contextWindow: number | undefined;
} {
  let lastInputTokens = 0;
  let contextWindow: number | undefined;
  const events = sessionEvents(agent.session);
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const e = event as { type?: unknown; data?: unknown };
    if (e.type === "request/context") {
      const cw = (e.data as { contextWindow?: unknown } | undefined)?.contextWindow;
      if (typeof cw === "number" && cw > 0) contextWindow = cw;
      continue;
    }
    if (e.type === "assistant/message") {
      const usage = (e.data as { usage?: unknown } | undefined)?.usage;
      const prompt = promptTokensOf(usage);
      if (prompt !== undefined) lastInputTokens = prompt;
    }
  }
  return { lastInputTokens, contextWindow };
}

export { promptTokensOf };

/** Real (non-Magic) user turns on the log — the Channel-1 sticky-turn ordinal. */
function countRealUserTurns(agent: Agent): number {
  let count = 0;
  for (const event of sessionEvents(agent.session)) {
    const e = event as { type?: unknown; data?: { source?: unknown } };
    if (e.type !== "user/message") continue;
    const source = e.data?.source as { kind?: unknown } | undefined;
    if (isMagicSource(source)) continue;
    if (source && source.kind !== undefined && source.kind !== "user") continue;
    count += 1;
  }
  return count;
}

/** Oldest reclaimable tool tags, as reclaim hints (max 4, oldest first). */
function oldestReclaimableToolTags(
  tags: readonly TagEntry[],
  protectedSet: ReadonlySet<number>,
): ToolReclaimHint[] {
  const active = [...tags]
    .filter((t) => t.type === "tool" && t.status === "active")
    .sort((a, b) => a.tagNumber - b.tagNumber);
  return active.filter((t) => !protectedSet.has(t.tagNumber)).slice(0, 4)
    .map((t) => ({ tagNumber: t.tagNumber, toolName: t.toolName }));
}

function injectNudge(
  agent: Agent,
  sessionId: string,
  kind: "channel1" | "channel2",
  text: string,
): void {
  // Dedup: only inject when the surface has no live mc-nudge:<kind> node.
  const marker = `mc-nudge:${kind}`;
  const events = sessionEvents(agent.session);
  if (
    events.some((event) => {
      if (event === null || typeof event !== "object") return false;
      const e = event as { data?: { source?: { plugin?: unknown; messageId?: unknown } } };
      const source = e.data?.source;
      return isMagicSource(source) && source.messageId === marker;
    })
  ) {
    return;
  }
  const source: MagicMessageSource = {
    kind: "magic-context",
    plugin: "magic-context",
    messageId: marker,
  };
  const message = magicUserMessage(text, source, []);
  (agent as unknown as { inject?: (m: unknown) => void }).inject?.(message);
}

export interface NudgeOptions {
  /** execute-threshold percentage (default 65). */
  threshold?: number;
  /** @deprecated Legacy newest-N count; ignored (token-floor window). */
  protectedTags?: number;
  /** Token-floor protection inputs (core protection window). */
  protection?: DshProtectionOptions;
  /** True on a pass that rewrote the surface (DSH cache bust → refreeze). */
  cacheBusting?: boolean;
  /** True when this pass applied queued agent drops (core suppression). */
  agentDropsAppliedThisPass?: boolean;
  /** Override context window (default: scan the session events). */
  contextWindow?: number;
  /** Transcript override (tests); default: read the DSH transcript view. */
  messages?: readonly MessageLike[];
  /** Injectable clock (tests). */
  now?: () => number;
  /** Logger sink (optional). */
  log?: (message: string) => void;
}

/** Per-session frozen baseline + the reduce evidence seen at the last refreeze. */
interface DshNudgeBaselineState {
  baseline: TailHygieneBaseline;
  reduceCallIdsAtRefresh: ReadonlySet<string>;
  refreshedAt: number;
}

const baselineBySession = new Map<string, DshNudgeBaselineState>();

/** Test seam: forget per-session baselines (process-local state). */
export function resetDshNudgeStateForTest(): void {
  baselineBySession.clear();
}

/** Read-only view of the current baseline (diagnostics/tests). */
export function getDshNudgeBaseline(sessionId: string): TailHygieneBaseline | undefined {
  return baselineBySession.get(sessionId)?.baseline;
}

/** Transcript messages the core walk should measure (Magic/skill baselines excluded). */
export function nudgeMeasurementMessages(agent: Agent, sessionId: string): MessageLike[] {
  const session = agent.session as unknown as { surface?: { nodes?: number[] } };
  const view = readDshTranscript({
    session: {
      events: sessionEvents(agent.session),
      surface: session.surface as never,
      header: {},
    },
    canonicalSessionId: sessionId,
  });
  const native = isNativeView(view);
  return view.messages
    .filter((message) => !isKnowledgeBaselineMessage(message) && !isSkillCatalogBaselineMessage(message))
    .map((message) => ({
      info: { id: message.id, role: message.role },
      parts: native ? message.parts.map(pairedNativeToolPart) : message.parts,
    }));
}

/**
 * Round 36 line H (limitation 31) — native-role view only: the measurement
 * shape of a tool part is Pi's call/result arc, not OpenCode's single part.
 *
 * In the fold view a call and its output are ONE `{type:"tool"}` part per
 * call inside one message, and the tag row is owned by that message. In the
 * native view the assistant keeps its call part (`state.input` only) and the
 * output sits on a separate tool-result message, while the tag row stays owned
 * by the assistant call (`toolOwnerMessageId`). Core's walk keys a
 * `{type:"tool"}` part on the message it sits in, so the output part matched
 * no tag and U counted call arguments only (≈5 tokens a read).
 *
 * Pi (`tail-hygiene-walk-pi` arcs) pairs a `toolResult` with the call that
 * owns it. Core's walk already has that pairing for the Anthropic-shaped
 * parts: a `tool_result` takes the owner of the preceding `tool_use` with the
 * same call id. So the measurement view re-labels native parts — input-only
 * call part → `tool_use`, output part → `tool_result` — with identical
 * serialised content (same tokens), and nothing else changes: the surface,
 * the tags and the drop/truncation paths never see these copies.
 */
function pairedNativeToolPart(part: unknown): unknown {
  if (part === null || typeof part !== "object") return part;
  const p = part as { type?: unknown; tool?: unknown; callID?: unknown; state?: unknown };
  if (p.type !== "tool" || typeof p.callID !== "string") return part;
  const state = p.state !== null && typeof p.state === "object" ? (p.state as Record<string, unknown>) : null;
  if (state === null) return part;
  const hasInput = state.input !== undefined;
  const hasOutput = state.output !== undefined || state.error !== undefined || state.result !== undefined;
  if (hasInput && !hasOutput) {
    return { type: "tool_use", id: p.callID, callID: p.callID, name: p.tool, tool: p.tool, input: state.input };
  }
  if (hasOutput && !hasInput) {
    return {
      type: "tool_result",
      tool_use_id: p.callID,
      tool: p.tool,
      content: state.output !== undefined ? state.output : state.error !== undefined ? state.error : state.result,
    };
  }
  return part;
}

/** ctx_reduce call ids present in the transcript (DSH `{type:"tool", tool, callID}` parts). */
export function ctxReduceCallIds(messages: readonly MessageLike[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part === null || typeof part !== "object") continue;
      const p = part as { type?: unknown; tool?: unknown; callID?: unknown };
      // `tool_use` is the native-view measurement shape of a call (round 36 line H).
      if ((p.type === "tool" || p.type === "tool_use") && p.tool === "ctx_reduce" && typeof p.callID === "string") {
        ids.add(p.callID);
      }
    }
  }
  return ids;
}

/**
 * Core `reducedSinceRefresh` for DSH: a ctx_reduce call or a queued drop that
 * the frozen baseline has not yet absorbed.
 */
export function computeHasRecentReduce(input: {
  readonly currentReduceCallIds: ReadonlySet<string>;
  readonly reduceCallIdsAtRefresh: ReadonlySet<string>;
  readonly pendingDropQueuedAt: readonly number[];
  readonly refreshedAt: number;
}): boolean {
  for (const id of input.currentReduceCallIds) {
    if (!input.reduceCallIdsAtRefresh.has(id)) return true;
  }
  return input.pendingDropQueuedAt.some((queuedAt) => queuedAt > input.refreshedAt);
}

/** Oldest active, unprotected tool tags (core getOldestActiveUnprotectedToolTags shape). */
function reclaimHints(tags: readonly TagEntry[], protectedSet: ReadonlySet<number>): ToolReclaimHint[] {
  return oldestReclaimableToolTags(tags, protectedSet);
}

/**
 * Evaluate both nudge channels for a magic session. Runs inside the pre-step
 * after plan application; never throws (fail-open).
 */
export function maybeNudgeChannels(
  db: Database,
  sessionId: string,
  agent: Agent,
  opts: NudgeOptions = {},
): void {
  try {
    const tags = getTagsBySession(db, sessionId);
    // No tool output at all → nothing reclaimable; leave session_meta untouched.
    if (!tags.some((t) => t.type === "tool")) return;
    const now = opts.now?.() ?? Date.now();
    const protection = observedProtectionWindow(db, sessionId, {
      contextWindow: opts.contextWindow ?? scanSessionMetrics(agent).contextWindow,
      ...opts.protection,
    });
    const pendingDrops = getPendingOps(db, sessionId).filter((op) => op.operation === "drop");
    const pendingDropTagNumbers = new Set(pendingDrops.map((op) => op.tagId));
    const messages = opts.messages ?? nudgeMeasurementMessages(agent, sessionId);
    const currentReduceCallIds = ctxReduceCallIds(messages);

    const previous = baselineBySession.get(sessionId);
    const cacheBusting = opts.cacheBusting === true || previous === undefined;
    const calibration = sessionDecisionCalibration(db, sessionId);
    const baseline = refreshTailHygieneBaseline({
      messages,
      tags,
      protectedTagNumbers: protection.protectedTagNumbers,
      pendingDropTagNumbers,
      cacheBusting,
      previous: previous?.baseline,
      calibration: { toolsRatio: calibration.toolsRatio, proseRatio: calibration.proseRatio },
      now,
    });
    const refreshed = cacheBusting || baseline.baselineGeneration !== previous?.baseline.baselineGeneration;
    const state: DshNudgeBaselineState = refreshed
      ? { baseline, reduceCallIdsAtRefresh: currentReduceCallIds, refreshedAt: now }
      : { ...previous!, baseline };
    baselineBySession.set(sessionId, state);

    const hasRecentReduce = refreshed
      ? false
      : computeHasRecentReduce({
          currentReduceCallIds,
          reduceCallIdsAtRefresh: state.reduceCallIdsAtRefresh,
          pendingDropQueuedAt: pendingDrops.map((op) => op.queuedAt),
          refreshedAt: state.refreshedAt,
        });

    // Post-reduce grace starts from the first measured U that already excludes
    // the queued drops (core captureChannel1PostReduceGraceBaseline).
    const effective = effectiveTailHygiene(baseline);
    const c1 =
      baseline.evaluable && !baseline.generationInvalidated && !hasRecentReduce
        ? captureChannel1PostReduceGraceBaseline(db, sessionId, effective.u)
        : getChannel1NudgeState(db, sessionId);
    const reclaimableCount = currentReclaimableToolOutputCount(baseline);

    // ── Channel 1: in-turn gentle/firm/urgent reminder ──
    const currentRealUserTurnCount = countRealUserTurns(agent);
    const decision = decideChannel1({
      baselineU: baseline.baselineU,
      baselineT: baseline.baselineT,
      turnDeltaU: baseline.turnDeltaU,
      turnDeltaT: baseline.turnDeltaT,
      lastNudgeUndropped: getLastNudgeUndropped(db, sessionId),
      lastNudgeLevel: c1.level,
      lastFireOrdinal: c1.ordinal,
      currentRealUserTurnCount,
      hasRecentReduce,
      agentDropsAppliedThisPass: opts.agentDropsAppliedThisPass === true,
      postReduceGracePending: c1.postReduceGracePending,
      postReduceGraceBaselineU: c1.postReduceGraceBaselineU,
      postReduceGracePreLevel: c1.postReduceGracePreLevel,
      evaluable: baseline.evaluable,
      generationInvalidated: baseline.generationInvalidated,
    });
    setLastNudgeUndropped(db, sessionId, decision.nextLastNudge);
    const nextState = {
      ...c1,
      level: decision.nextLastNudgeLevel,
      ordinal: decision.fire ? currentRealUserTurnCount : c1.ordinal,
    };
    if (decision.clearPostReduceGrace) {
      delete nextState.postReduceGracePending;
      delete nextState.postReduceGraceBaselineU;
      delete nextState.postReduceGracePreLevel;
    }
    setChannel1NudgeState(db, sessionId, nextState);
    if (decision.fire) {
      const hint = reclaimHints(tags, protection.protectedTagNumbers);
      const reminder = buildChannel1Reminder(
        decision.level,
        decision.undroppedTokens,
        reclaimableCount,
        hint,
        decision.sticky,
      );
      injectNudge(agent, sessionId, "channel1", reminder);
      opts.log?.(
        `[magic-context] channel1 nudge fired: level=${decision.level} U=${decision.undroppedTokens} T=${decision.tailTokens} reason=${decision.verdictReason}`,
      );
    }

    // ── Channel 2: ceiling escalation (one-shot per session, CAS lease) ──
    const c2 = evaluateChannel2(baseline);
    if (c2.shouldTrigger && !hasRecentReduce && getChannel2NudgeState(db, sessionId) === "") {
      // Cross-process one-shot: only the process that wins "" → delivered injects.
      if (casChannel2NudgeState(db, sessionId, "", "delivered")) {
        const hint = reclaimHints(tags, protection.protectedTagNumbers);
        const reminder = buildChannel2Reminder(c2.reclaimableTokens, reclaimableCount, hint);
        injectNudge(agent, sessionId, "channel2", reminder);
        opts.log?.(`[magic-context] channel2 nudge delivered: reclaimable~${Math.round(c2.reclaimableTokens / 1000)}k`);
      }
    }
    void opts.threshold;
  } catch (error) {
    // Nudges must never break the pre-step chain (fail-open).
    opts.log?.(`[magic-context] nudge evaluation failed (fail-open): ${error instanceof Error ? error.message : String(error)}`);
  }
}
