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
 * reclaimable tool-output tokens, T = live tail tokens) computed by the
 * OpenCode/Pi transform's tail walk. DSH has no such walk; U/T are approximated
 * from the persisted tag aggregate (U = active tool output below the protection
 * cutoff, T = all active conversation + tool tokens) with zero turn deltas.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  buildChannel1Reminder,
  buildChannel2Reminder,
  decideChannel1,
  evaluateChannel2,
  type ToolReclaimHint,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import { getActiveTagTokenAggregate } from "@magic-context/core/features/magic-context/storage-tags";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import {
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
import { countProtectionWindow } from "./protection";

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
function oldestReclaimableToolTags(tags: readonly TagEntry[], protectedTags: number): ToolReclaimHint[] {
  const active = [...tags]
    .filter((t) => t.type === "tool" && t.status === "active")
    .sort((a, b) => a.tagNumber - b.tagNumber);
  const protectedSet =
    protectedTags > 0
      ? new Set(
          [...tags]
            .filter((t) => t.type === "tool" && t.status === "active")
            .map((t) => t.tagNumber)
            .sort((a, b) => b - a)
            .slice(0, protectedTags),
        )
      : new Set<number>();
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
  /** Protected-tag tail (default 20). */
  protectedTags?: number;
  /** Override context window (default: scan the session events). */
  contextWindow?: number;
  /** Logger sink (optional). */
  log?: (message: string) => void;
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
    const protectedTags = Math.max(0, opts.protectedTags ?? 20);
    const tags = getTagsBySession(db, sessionId);
    const protection = countProtectionWindow(tags, protectedTags);
    const agg = getActiveTagTokenAggregate(db, sessionId, protection.protectedCutoff);
    const reclaimableCount = tags.filter(
      (t) =>
        t.type === "tool" &&
        t.status === "active" &&
        (protection.protectedCutoff === null || t.tagNumber < protection.protectedCutoff),
    ).length;
    // Tag-aggregate approximation of the core tail-hygiene baseline (see header).
    const baselineU = Math.max(0, agg.toolOutput ?? 0);
    const baselineT = Math.max(baselineU, (agg.conversation ?? 0) + (agg.toolCall ?? 0));

    // ── Channel 1: in-turn gentle/firm/urgent reminder ──
    const c1 = getChannel1NudgeState(db, sessionId);
    const currentRealUserTurnCount = countRealUserTurns(agent);
    const decision = decideChannel1({
      baselineU,
      baselineT,
      turnDeltaU: 0,
      turnDeltaT: 0,
      lastNudgeUndropped: getLastNudgeUndropped(db, sessionId),
      lastNudgeLevel: c1.level,
      lastFireOrdinal: c1.ordinal,
      currentRealUserTurnCount,
      hasRecentReduce: false,
      postReduceGracePending: c1.postReduceGracePending,
      postReduceGraceBaselineU: c1.postReduceGraceBaselineU,
      postReduceGracePreLevel: c1.postReduceGracePreLevel,
      evaluable: true,
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
      const hint = oldestReclaimableToolTags(tags, protectedTags);
      const reminder = buildChannel1Reminder(
        decision.level,
        decision.undroppedTokens,
        reclaimableCount,
        hint,
        decision.sticky,
      );
      injectNudge(agent, sessionId, "channel1", reminder);
      opts.log?.(`[magic-context] channel1 nudge fired: level=${decision.level} reclaimable~${Math.round(decision.undroppedTokens / 1000)}k`);
    }

    // ── Channel 2: ceiling escalation (one-shot per session, CAS lease) ──
    const c2 = evaluateChannel2({
      baselineU,
      baselineT,
      turnDeltaU: 0,
      turnDeltaT: 0,
      evaluable: true,
      generationInvalidated: false,
    });
    if (c2.shouldTrigger && getChannel2NudgeState(db, sessionId) === "") {
      // Cross-process one-shot: only the process that wins "" → delivered injects.
      if (casChannel2NudgeState(db, sessionId, "", "delivered")) {
        const hint = oldestReclaimableToolTags(tags, protectedTags);
        const reminder = buildChannel2Reminder(c2.reclaimableTokens, reclaimableCount, hint);
        injectNudge(agent, sessionId, "channel2", reminder);
        opts.log?.(`[magic-context] channel2 nudge delivered: reclaimable~${Math.round(c2.reclaimableTokens / 1000)}k`);
      }
    }
    void opts.threshold;
    void opts.contextWindow;
  } catch {
    // Nudges must never break the pre-step chain (fail-open).
  }
}
