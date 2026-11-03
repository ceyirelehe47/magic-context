/**
 * agent/context-plane — the pre-step wiring of the context-management plane
 * (Phase 3): per-session outbox reconciliation + MutationPlan derivation +
 * serialized coordinator application. Runs INSIDE the agent pre-step
 * waterfall, after the knowledge gate (registered first, so this gate is
 * inner): drops/prefixes/reasoning/temporal ops land on the surface before the
 * request is derived — the Magic semantics (mutations visible to the current
 * step), executed through the surface CAS (never a direct rewrite).
 *
 * The historian plane (compartment publication + summarize hook + deferred
 * signals) registers alongside when its slice lands.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { DshStorageBootstrap } from "../host/bootstrap";
import { deriveEventMessage, isMagicSource, sessionEvents } from "../compat/dsh-0.1/session";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import {
  registerPreStepGate,
  type PreStepDecision,
  type PreStepPayload,
} from "../compat/dsh-0.1/prestep";
import {
  createCoordinatorState,
  enqueuePlan,
  type CoordinatorHostView,
  type CoordinatorState,
} from "./coordinator";
import {
  initializeDshAdapterTables,
  reconcileSessionOutbox,
} from "./outbox";
import {
  deriveMutationPlan,
  endsInPendingFold,
  pendingFoldTextCount,
  readDshTranscript,
  textTagContentIdsBySource,
  type PlanContext,
} from "./transcript";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { checkDshCompartmentTrigger } from "./historian";
import { foldLegacyBareMessageTags } from "./legacy-tag-cleanup";
import { maybeNudgeChannels, promptTokensOf, scanSessionMetrics } from "./nudge";
import type { PressureTruncationInput } from "./pressure-truncation";
import { escalationBands } from "@magic-context/core/shared/escalation-bands";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { markNoteNudgeDelivered, onNoteTrigger, peekNoteNudgeText } from "@magic-context/core/hooks/magic-context/note-nudger";
import { historyContentProvider } from "./historian-wiring";
import { scheduleDshMessageHistoryIndex } from "./message-index";
import { scheduleDshAutoEmbed } from "./embedding-wiring";
import { resolveAwaitAtTurnEndMs, type HistorianDrain } from "./historian-drain";
import { isMagicChildSession } from "./worker";
import { deriveTriggerBudget } from "@magic-context/core/hooks/magic-context/derive-budgets";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { ProtectedTokensTierOverrides } from "@magic-context/core/config/project-security";
import { resolveDshProtectionFloor, type DshProtectionOptions } from "./protection";

/** The host-service slice the context plane needs (structural view). */
export interface ContextPlaneHostView {
  /** Settles once the storage bootstrap finishes (ok or refused). */
  readonly ready: Promise<DshStorageBootstrap>;
  /** Canonical Magic session key for a DSH session. */
  canonicalKey(dshSessionId: string): string;
}

export interface ContextPlaneConfig {
  enabled?: boolean;
  /**
   * @deprecated Legacy newest-N count. Ignored for behaviour (core ≥0.49
   * parity); use `protectedTokens`.
   */
  protectedTags?: number;
  /** Absolute token floor (`protected_tokens`); unset = core derived default. */
  protectedTokens?: number;
  /** Trusted-user / project `protected_tokens` tiers (core loadPluginConfig). */
  protectedTokenTierOverrides?: ProtectedTokensTierOverrides;
  /** Heuristic cleanup options (routed from the shared config). */
  heuristicCleanup?: { readonly caveman?: { readonly enabled: boolean; readonly minChars: number } };
  /**
   * Pressure truncation of large tool results at the force band (input +
   * output reserve). Default on; `false` stops NEW decisions (persisted ones
   * keep replaying so the surface does not flip back and bust the cache).
   */
  pressureTruncation?: boolean;
}

/** Historian background-pass plane (Phase 4): trigger + fire. */
export interface ContextPlaneHistorianConfig {
  enabled?: boolean;
  /** executeThresholdPercentage (default 65). */
  executeThresholdPercentage?: number;
  /** Minimum eligible tokens for a size-based fire (default 0 = off). */
  triggerBudgetTokens?: number;
  /** Model context window (<= 0 falls back to the shared 128k default). */
  contextLimit?: number;
  /** Commit-cluster trigger (shared semantics: enabled + min_clusters). */
  commitClusterTrigger?: { enabled: boolean; min_clusters: number };
  /** Historian model override ("provider/model"); defaults to the session route. */
  model?: string;
  /**
   * Await in-flight historian passes at the turn boundary
   * (`agent/turn-stopping`) for at most this many ms. 0/unset = off; the env
   * var `MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS` is the fallback. Meant
   * for one-shot hosts (dsh headless) whose process exits right after the turn.
   */
  awaitAtTurnEndMs?: number;
}

/** Context-pressure read for the trigger (structural; injectable in tests). */
export interface ContextPressureSample {
  readonly projectedTokens?: number;
  readonly contextWindow?: number;
}

export interface ContextPlaneDeps {
  readonly host: ContextPlaneHostView;
  readonly config?: ContextPlaneConfig;
  /** Heuristic cleanup config (routed from the shared config by the integrator). */
  readonly heuristicCleanup?: { readonly caveman?: { readonly enabled: boolean; readonly minChars: number } };
  /** Historian plane: fire the background compartment pass (fire-and-forget). */
  readonly historian?: {
    readonly config?: ContextPlaneHistorianConfig;
    /** Read the current context pressure (production: sessionProjections). */
    readPressure?: (agent: Agent) => ContextPressureSample | undefined;
    /** Fire one background historian pass for the session. */
    fire: (deps: {
      readonly db: Database;
      readonly sessionId: string;
      readonly directory?: string;
      readonly provider: RawMessageProvider;
      /** Resolved model context window (drives the historian chunk budget). */
      readonly contextWindow?: number;
    }) => void;
    /** In-flight pass tracker (turn-end await + unload drain). */
    readonly drain?: HistorianDrain;
    /**
     * Per-model execute threshold for this agent's route (core resolver over
     * the effective jsonc + DSH overlay). Absent = `config.executeThresholdPercentage`.
     */
    readonly resolveExecuteThreshold?: (agent: Agent) => number | undefined;
  };
  /** Workspace directory for the historian fire (project memory scope). */
  readonly directory?: string;
  /**
   * Live master switch (DSH settings overlay `enabled`). `false` pauses every
   * per-step Magic action (plan, nudges, historian trigger); absent = on.
   */
  readonly isEnabled?: () => boolean;
  readonly log?: (message: string) => void;
}

/** Per-plugin state (reset on plugin reload; the outbox is authoritative). */
export interface ContextPlaneState {
  readonly coordinator: CoordinatorState;
  /** sessionId → reconciliation already run this process. */
  readonly reconciled: Set<string>;
  /** Adapter tables already ensured for this process (idempotent init). */
  tablesInitialized: boolean;
  /** sessionId → legacy bare-id §N§ tags already folded this process. */
  readonly legacyTagsFolded: Set<string>;
}

export function createContextPlaneState(): ContextPlaneState {
  return {
    coordinator: createCoordinatorState(),
    reconciled: new Set(),
    tablesInitialized: false,
    legacyTagsFolded: new Set(),
  };
}

/** DSH-log view adapter for the outbox reconciliation. */
function sessionLogView(
  db: Database,
  sessionId: string,
  agent: Agent,
  canonicalSessionId: string,
): { hasSeq(seq: number): boolean; generation: number } {
  const events = sessionEvents(agent.session);
  const seqSet = new Set<number>();
  for (const event of events) {
    if (event !== null && typeof event === "object") {
      const seq = (event as { seq?: unknown }).seq;
      if (typeof seq === "number") seqSet.add(seq);
    }
  }
  return {
    hasSeq: (seq: number) => seqSet.has(seq),
    generation: agent.session.surface.replaceGeneration,
  };
}

/**
 * Lightweight commit-cluster signal (Pi/OpenCode parity in spirit): count
 * contiguous bursts of commit-hash mentions in the most recent assistant
 * texts. The shared trigger counts clusters in the chunk's TC scan; here the
 * session log is the same source, scanned conservatively (>= min_clusters
 * distinct bursts). Gated additionally by the eligible-token budget below.
 */
/**
 * Wall-clock time (event `time`, epoch ms) of the latest assistant/message
 * that completed (not `interrupted`) — the DSH equivalent of the response
 * completion that upstream stamps as lastResponseTime. 0 when none.
 */
export function latestCompletedResponseTime(agent: Agent): number {
  try {
    const events = sessionEvents(agent.session);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i] as { type?: unknown; time?: unknown; data?: { interrupted?: unknown } } | null;
      if (e === null || typeof e !== "object" || e.type !== "assistant/message") continue;
      if (e.data?.interrupted === true) continue;
      return typeof e.time === "number" && Number.isFinite(e.time) ? e.time : 0;
    }
  } catch {
    // fail-open
  }
  return 0;
}

const COMMIT_MENTION_RE = /(?:^|[\s(`])[0-9a-f]{7,40}(?:$|[\s`)])/i;
export function recentCommitClusterCount(agent: Agent): number {
  try {
    const events = sessionEvents(agent.session);
    const texts: string[] = [];
    for (const event of events) {
      if (event === null || typeof event !== "object") continue;
      // DSH 0.2: assistant/message data is `{ turn, step, message, stream, usage }`
      // — the content lives on `data.message.content` (0.1 had `data.content`).
      const e = event as { type?: unknown; data?: { content?: unknown; message?: { content?: unknown } } };
      if (e.type !== "assistant/message") continue;
      const content = e.data?.message?.content ?? e.data?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text") {
            const text = (part as { text?: unknown }).text;
            if (typeof text === "string") texts.push(text);
          }
        }
      }
    }
    const recent = texts.slice(-10);
    let clusters = 0;
    let inCluster = false;
    for (const text of recent) {
      const hasCommit = COMMIT_MENTION_RE.test(text);
      if (hasCommit) {
        if (!inCluster) {
          clusters += 1;
          inCluster = true;
        }
      } else {
        inCluster = false;
      }
    }
    return clusters;
  } catch {
    return 0;
  }
}

/** Per-model threshold resolver, fail-open to undefined. */
function safeThreshold(
  historian: NonNullable<ContextPlaneDeps["historian"]> | undefined,
  agent: Agent,
): number | undefined {
  try {
    const value = historian?.resolveExecuteThreshold?.(agent);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Fire the historian pass when the context-pressure trigger fires. */
function maybeFireHistorian(
  historian: NonNullable<ContextPlaneDeps["historian"]>,
  db: Database,
  sessionId: string,
  agent: Agent,
  directory: string | undefined,
): void {
  try {
    const readPressure = historian.readPressure ?? (() => undefined);
    const sample = readPressure(agent);
    if (sample === undefined) return;
    const contextWindow = sample.contextWindow;
    if (typeof contextWindow !== "number" || contextWindow <= 0) return;
    const percentage = Math.round(((sample.projectedTokens ?? 0) / contextWindow) * 100);
    const config = historian.config ?? {};
    const executeThresholdPercentage =
      safeThreshold(historian, agent) ?? config.executeThresholdPercentage ?? 65;
    // The shared trigger refuses to fire with a zero budget; the DSH adapter
    // derives it exactly like Pi does (deriveTriggerBudget over the context
    // window × threshold), instead of leaving triggerBudgetTokens at 0 (which
    // previously made the historian unreachable — it never fired on DSH).
    const contextLimit =
      typeof config.contextLimit === "number" && config.contextLimit > 0
        ? config.contextLimit
        : contextWindow;
    const forceFire = process.env.MAGIC_CONTEXT_FORCE_HISTORIAN === "1" && percentage >= 0;
    const commitCfg = config.commitClusterTrigger;
    const commitClusters = recentCommitClusterCount(agent);
    const commitClusterFires =
      commitCfg !== undefined &&
      commitCfg.enabled !== false &&
      commitClusters >= Math.max(1, commitCfg.min_clusters ?? 3) &&
      (config.triggerBudgetTokens ?? deriveTriggerBudget(contextLimit, executeThresholdPercentage)) > 0;
    // Magic note-nudger: a commit burst is a natural note-review boundary.
    if (commitCfg !== undefined && commitCfg.enabled !== false && commitClusters >= 1) {
      try {
        onNoteTrigger(db, sessionId, "commit_detected");
      } catch {
        // fail-open
      }
    }
    const fires =
      forceFire ||
      commitClusterFires ||
      checkDshCompartmentTrigger(
        {
          executeThresholdPercentage,
          triggerBudget:
            config.triggerBudgetTokens ??
            deriveTriggerBudget(contextLimit, executeThresholdPercentage),
          contextLimit,
        },
        { lastContextPercentage: percentage },
      );
    if (process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN === "1") {
      try {
        // eslint-disable-next-line no-console
        console.error(
          `[magic-context] historian trigger: pct=${percentage} threshold=${executeThresholdPercentage} budget=${config.triggerBudgetTokens ?? deriveTriggerBudget(contextLimit, executeThresholdPercentage)} window=${contextWindow} fires=${fires}`,
        );
      } catch {
        // Diagnostics must never break the pre-step chain.
      }
    }
    // 压力持久化（对齐 Pi persistPiPressureFromMessageEnd）：把最近一次的
    // 百分比写入 session_meta，供 /ctx-status 与共享状态读取。
    try {
      // Round 17: the measured prompt tokens too (upstream writes both from
      // the response usage); /ctx-status and ctx_reduce's nudge stamp read
      // last_input_tokens and showed 0 on DSH.
      const inputTokens = Math.max(0, Math.round(sample.projectedTokens ?? 0));
      // Round 18: the completion clock too (upstream stamps lastResponseTime
      // when a response completes). DSH never wrote it: /ctx-status said
      // "Last response: never" and core's ttl_idle HARD fold could not arm.
      const responseTime = latestCompletedResponseTime(agent);
      const prevResponseTime = (
        db.prepare("SELECT last_response_time AS t FROM session_meta WHERE session_id = ?").get(sessionId) as
          | { t: number | null }
          | null
          | undefined
      )?.t ?? 0;
      updateSessionMeta(db, sessionId, {
        lastContextPercentage: percentage,
        ...(inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
        ...(responseTime > prevResponseTime ? { lastResponseTime: responseTime } : {}),
      });
    } catch {
      // 持久化失败不可破坏 pre-step 链（fail-open）。
    }
    if (fires) {
      historian.fire({
        db,
        sessionId,
        directory,
        provider: historyContentProvider(agent as unknown as Agent, sessionId),
        contextWindow,
      });
    }
  } catch {
    // The trigger must never break the pre-step chain (fail-open).
  }
}

/**
 * First-call §N§ preview (Pi transform parity): the pre-step message list is
 * deep-frozen and the surface CAS replace only lands on the NEXT pass, so the
 * very first LLM call would otherwise see untagged messages. Rebuild the
 * frozen messages with the `§N§ ` prefix of the tag the plan derivation
 * (core `tagTranscript`) assigned to that text.
 *
 * Tags are looked up under the core content key
 * (`${viewMessageId}:p${textOrdinal}`, see `textTagContentIdsBySource`). The
 * only allocation here is for a plain user message that is not in the view
 * yet (the step's new input), under the exact key core will use for it —
 * never under a bare id. Pre-fix this function assigned its own tag under the
 * BARE source message id while `tagTranscript` assigned another under
 * `:p0`, so one message owned two tag numbers and the preview number could
 * collide with what a different message showed after the surface replace
 * (the round 7/8 duplicate `§N§` observation).
 *
 * Text with no tag under its core key (blank assistant framing, knowledge /
 * skill-catalog baselines, Magic-sourced copies) passes through unchanged.
 * Never throws (fail-open).
 */
/**
 * Pending fold at the session tail AFTER this pass's surface replace: the
 * next appended user message absorbs it (see `pendingFoldTextCount`).
 * `textCount` = text ordinals it occupies ahead of the new message's own text.
 */
export interface PendingTailFold {
  readonly pending: boolean;
  readonly textCount: number;
}

export function previewTagPayloadMessages(
  db: Database,
  sessionId: string,
  messages: readonly unknown[],
  contentIdsBySource: ReadonlyMap<string, ReadonlyMap<number, string>>,
  tail: PendingTailFold = { pending: false, textCount: 0 },
): void {
  try {
    const tagger = createTagger();
    tagger.initFromDb(sessionId, db);
    const out: unknown[] = [];
    // Fold tracking (walkDshLog semantics, replayed over the payload in
    // append order): a tool-call assistant / tool results with no closing
    // user message are absorbed by the NEXT user/message, so that message's
    // own text blocks start at `:p${foldTextCount}` (the tool-call
    // assistant's text blocks; tool parts are not text). Starts from the
    // session tail after this pass's replace. A runtime-context snapshot
    // never absorbs (it flushes the fold into a synthetic tail).
    let foldPending = tail.pending;
    let foldTextCount = tail.pending ? tail.textCount : 0;
    for (const raw of messages) {
      const msg = raw as {
        id?: unknown;
        role?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
        source?: { kind?: unknown };
      };
      const sourceKind = msg.source?.kind;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const hasToolCall = content.some((part) => part !== null && typeof part === "object" && part.type === "tool-call");
      const ordinalOffset = foldPending ? foldTextCount : 0;
      if (msg.role === "assistant") {
        foldPending = hasToolCall;
        foldTextCount = hasToolCall
          ? content.filter((part) => part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string").length
          : 0;
      } else if (msg.role === "tool") {
        if (!foldPending) foldTextCount = 0;
        foldPending = true;
      } else if (msg.role === "user") {
        // Every user/message (incl. Magic / skill-catalog ones) closes the
        // fold; the runtime-context snapshot flushes it instead — either
        // way the next user message starts at :p0.
        foldPending = false;
        foldTextCount = 0;
      }
      if (
        isMagicSource(msg.source) ||
        sourceKind === "skill-catalog" ||
        // Runtime-context snapshots are baselines (never tagged; see
        // agent/transcript.ts isRuntimeContextMessage).
        sourceKind === "runtime-context" ||
        typeof msg.id !== "string" ||
        !Array.isArray(msg.content)
      ) {
        out.push(raw);
        continue;
      }
      let keys: ReadonlyMap<number, string> | undefined = contentIdsBySource.get(msg.id);
      // Not in the session view yet: the step's NEW user input (the prompt,
      // the runtime-context snapshot) is appended to the log only after the
      // pre-step. Pre-assign the SAME key core will use once it is in the
      // view (`${id}:p${textBlock}` — a plain user message is its own view
      // message), so the model sees the number it will keep and its own
      // "highest + 1" reply prefix matches what core assigns next. When it
      // follows a pending fold (tool-call / results with no closing user
      // message, in the payload or at the session tail after this pass's
      // replace) its own text starts after the absorbed assistant text:
      // `${id}:p${offset + block}`. Non-user roles are never pre-assigned.
      let assignNew = false;
      if (keys === undefined) {
        if (msg.role !== "user") {
          out.push(raw);
          continue;
        }
        const derived = new Map<number, string>();
        let blockIndex = 0;
        for (const part of content) {
          if (part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
            derived.set(blockIndex, `${msg.id}:p${ordinalOffset + blockIndex}`);
            blockIndex += 1;
          }
        }
        keys = derived;
        assignNew = true;
      }
      const resolvedKeys = keys;
      let textBlockIndex = 0;
      let changed = false;
      const newContent = msg.content.map((part) => {
        if (part === null || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string") {
          return part;
        }
        const contentId = resolvedKeys.get(textBlockIndex);
        textBlockIndex += 1;
        if (contentId === undefined) return part;
        let tag = tagger.getTag(sessionId, contentId, "message");
        if ((tag === undefined || tag <= 0) && assignNew && part.text.trim().length > 0) {
          tag = tagger.assignTag(sessionId, contentId, "message", Buffer.byteLength(part.text), db);
        }
        if (tag === undefined || tag <= 0) return part;
        if (part.text.startsWith(`\u00a7${tag}\u00a7 `)) return part;
        changed = true;
        return { ...part, text: `\u00a7${tag}\u00a7 ${part.text}` };
      });
      out.push(changed ? { ...msg, content: newContent } : raw);
    }
    (messages as unknown[]).length = 0;
    (messages as unknown[]).push(...out);
  } catch {
    // Preview must never break the pre-step chain (fail-open).
  }
}

/** The session-tail fold the step's new input will absorb (after replace). */
function tailFoldAfterPass(
  agent: Agent,
  canonicalSessionId: string,
  before: ReturnType<typeof readDshTranscript>,
  replaced: boolean,
): PendingTailFold {
  try {
    const view = replaced
      ? readDshTranscript({
          session: { events: sessionEvents(agent.session), surface: agent.session.surface, header: {} },
          canonicalSessionId,
        })
      : before;
    return { pending: endsInPendingFold(view), textCount: pendingFoldTextCount(view) };
  } catch {
    return { pending: false, textCount: 0 };
  }
}

/**
 * Pressure-truncation inputs: projected input (token-meter projection, else
 * the last provider usage), the request's output reserve (latest
 * `request/header` `maxTokens`), the execute/force bands, and the seq of the
 * latest usage-bearing assistant message (one batch per sample).
 */
export function pressureTruncationInputFor(deps: ContextPlaneDeps, agent: Agent): PressureTruncationInput | undefined {
  try {
    let projected: number | undefined;
    let contextWindow: number | undefined;
    try {
      const sample = deps.historian?.readPressure?.(agent);
      projected = sample?.projectedTokens;
      contextWindow = sample?.contextWindow;
    } catch {
      // fall back to the event log
    }
    let outputReserve = 0;
    let usageSeq = -1;
    let lastPrompt = 0;
    let logWindow: number | undefined;
    const bySeq = new Map<number, unknown>();
    for (const event of sessionEvents(agent.session)) {
      if (event === null || typeof event !== "object") continue;
      const e = event as { type?: unknown; seq?: unknown; data?: Record<string, unknown> };
      if (typeof e.seq === "number") bySeq.set(e.seq, event);
      if (e.type === "request/header") {
        const header = e.data?.header as { config?: { maxTokens?: unknown } } | undefined;
        const max = header?.config?.maxTokens;
        if (typeof max === "number" && max > 0) outputReserve = max;
      } else if (e.type === "request/context") {
        const cw = e.data?.contextWindow;
        if (typeof cw === "number" && cw > 0) logWindow = cw;
      } else if (e.type === "assistant/message") {
        const prompt = promptTokensOf(e.data?.usage);
        if (prompt !== undefined) {
          lastPrompt = prompt;
          if (typeof e.seq === "number") usageSeq = e.seq;
        }
      }
    }
    if (!(typeof contextWindow === "number" && contextWindow > 0)) contextWindow = logWindow;
    if (!(typeof contextWindow === "number" && contextWindow > 0)) return undefined;
    const meterProjected = Math.max(typeof projected === "number" ? projected : 0, lastPrompt);
    const projectedTokens = meterProjected + denseSurfaceCorrection(agent, bySeq, usageSeq, meterProjected > lastPrompt);
    const executePercentage =
      safeThreshold(deps.historian, agent) ?? deps.historian?.config?.executeThresholdPercentage ?? 65;
    return {
      projectedTokens,
      contextWindow,
      outputReserveTokens: outputReserve,
      executePercentage,
      forcePercentage: escalationBands(executePercentage).forceMaterializationPercentage,
      usageSeq,
    };
  } catch {
    return undefined;
  }
}

/**
 * Round 23b (P0-1): what DSH's token-meter projection misses. The projection
 * is the last provider sample plus the surface's movement since, priced at a
 * FIXED 4 chars/token — common Chinese text is ≈ 0.94 tokens/char (3.75× that
 * price) and dense digit listings ≈ 2×, so one Chinese `read` put a real rc.5
 * request at 27 700 tokens of a 24 000 window while the projection said
 * 63.5 % and the truncation trigger stayed silent (provider overflow; every
 * later turn re-sent it). Re-price the text of every surface node that joined
 * after the last usage sample (seq ≥ usageSeq: the sampled assistant message
 * itself joins after its own sample) with core's tokenizer and add what the
 * fixed price under-counts. `meterPriced` = the projection already includes
 * that movement at 4 chars/token (token-meter mounted); without a meter the
 * fallback is the bare last prompt, so the full re-priced movement is added.
 * Never negative: an over-price is left to the meter (no truncation earlier
 * than before for ordinary text). Fail-open (0).
 */
export function denseSurfaceCorrection(
  agent: Agent,
  bySeq: ReadonlyMap<number, unknown>,
  usageSeq: number,
  meterPriced: boolean,
): number {
  if (usageSeq < 0) return 0;
  try {
    const nodes = (agent.session as unknown as { surface?: { nodes?: readonly number[] } }).surface?.nodes ?? [];
    let extra = 0;
    for (const seq of nodes) {
      if (seq < usageSeq) continue;
      const event = bySeq.get(seq);
      if (event === undefined) continue;
      let message: unknown;
      try {
        message = deriveEventMessage(event as never);
      } catch {
        continue;
      }
      for (const text of messageTexts(message)) {
        const exact = estimateTokens(text);
        extra += meterPriced ? Math.max(0, exact - Math.ceil(text.length / 4)) : exact;
      }
    }
    return extra;
  } catch {
    return 0;
  }
}

/** Every text-bearing leaf of a derived DSH message (text, reasoning, tool-call name + arguments, nested tool-result content). */
function messageTexts(message: unknown): string[] {
  const out: string[] = [];
  const walk = (blocks: unknown, depth: number) => {
    if (!Array.isArray(blocks) || depth > 4) return;
    for (const block of blocks) {
      if (block === null || typeof block !== "object") continue;
      const b = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown; content?: unknown; output?: unknown };
      if (typeof b.text === "string") out.push(b.text);
      if (b.type === "tool-call") {
        if (typeof b.name === "string") out.push(b.name);
        if (typeof b.arguments === "string") out.push(b.arguments);
      }
      if (typeof b.output === "string") out.push(b.output);
      walk(b.content, depth + 1);
      walk(b.output, depth + 1);
    }
  };
  if (message !== null && typeof message === "object") walk((message as { content?: unknown }).content, 0);
  return out;
}

/** Protection-window inputs for one pass (config + live DSH context window). */
export function protectionOptionsFor(deps: ContextPlaneDeps, agent: Agent): DshProtectionOptions {
  let contextWindow: number | undefined;
  try {
    contextWindow = deps.historian?.readPressure?.(agent)?.contextWindow;
  } catch {
    contextWindow = undefined;
  }
  if (!(typeof contextWindow === "number" && contextWindow > 0)) {
    try {
      contextWindow = scanSessionMetrics(agent).contextWindow;
    } catch {
      contextWindow = undefined;
    }
  }
  if (!(typeof contextWindow === "number" && contextWindow > 0)) {
    const configured = deps.historian?.config?.contextLimit;
    contextWindow = typeof configured === "number" && configured > 0 ? configured : undefined;
  }
  return {
    protectedTokens: deps.config?.protectedTokens,
    tierOverrides: deps.config?.protectedTokenTierOverrides,
    contextWindow,
    log: deps.log,
  };
}

/** The full pre-step body: reconcile → derive → apply → next. */
export async function runContextPlaneStep(
  state: ContextPlaneState,
  deps: ContextPlaneDeps,
  payload: Pick<PreStepPayload, "agent" | "messages">,
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const agent = payload.agent as unknown as Agent;
  try {
    // Recursion isolation (PLAN §9): child sessions (subagents/workers) run
    // with official semantics — the Magic context plane never processes them.
    if (isMagicChildSession(agent)) return await next();
    if (deps.isEnabled?.() === false) return await next();
    const bootstrap = await deps.host.ready;
    if (bootstrap.kind !== "ok") return await next();
    const db = bootstrap.db;
    const canonicalSessionId = deps.host.canonicalKey(agent.id);

    // Adapter tables (outbox saga) — the host bootstrap creates them, but a
    // direct user of this gate must not depend on the bootstrap having run.
    if (!state.tablesInitialized) {
      state.tablesInitialized = true;
      initializeDshAdapterTables(db);
    }

    // Startup/first-step reconciliation of the saga records.
    if (!state.reconciled.has(canonicalSessionId)) {
      state.reconciled.add(canonicalSessionId);
      reconcileSessionOutbox(db, canonicalSessionId, sessionLogView(db, canonicalSessionId, agent, canonicalSessionId));
    }

    // Plan derivation + application (gated by enabled; the historian trigger
    // below is independent of the plan gate).
    // Token-floor protection inputs (core parity): usable window from the
    // DSH pressure read (token-meter projection or request/context fallback).
    const protection = protectionOptionsFor(deps, agent);
    let surfaceRewritten = false;
    let agentDropsApplied = false;

    if (deps.config?.enabled !== false) {
      const view = readDshTranscript({
        session: {
          events: sessionEvents(agent.session),
          surface: agent.session.surface,
          header: {},
        },
        canonicalSessionId,
      });
      const contentIdsBySource = textTagContentIdsBySource(view);
      // 旧数据兼容：一次性折叠修复前预览写下的裸 id 标签（每进程每会话一次，
      // 在 plan 之前，使被迁移的 pending drop 本轮即生效）。
      if (!state.legacyTagsFolded.has(canonicalSessionId)) {
        state.legacyTagsFolded.add(canonicalSessionId);
        try {
          const folded = foldLegacyBareMessageTags(db, canonicalSessionId, contentIdsBySource);
          if (folded.removed.length > 0) {
            deps.log?.(
              `[magic-context] folded ${folded.removed.length} legacy bare-id §N§ tag(s) (retargeted ${folded.retargeted.length} pending op(s), discarded ${folded.discardedOps})`,
            );
          }
        } catch {
          // fail-open: legacy rows are inert for the plan; retry next process.
        }
      }
      const plan = deriveMutationPlan(view, {
        db,
        protection,
        heuristicCleanup: deps.heuristicCleanup,
        pressureTruncation:
          deps.config?.pressureTruncation === false ? undefined : pressureTruncationInputFor(deps, agent),
        log: deps.log,
      } satisfies PlanContext);
      if (plan !== null) {
        surfaceRewritten = true;
        agentDropsApplied = plan.ops.some((op) => op.kind === "drops");
        const hostView: CoordinatorHostView = {
          db,
          canonicalKey: (id: string) => deps.host.canonicalKey(id),
          log: deps.log,
        };
        await enqueuePlan(state.coordinator, hostView, agent.session, plan);
      }
      // 首轮 §N§ 预览：本次调用即可见（Pi transform 语义）。必须在
      // deriveMutationPlan（core tagTranscript 分配标签）之后、且只按 core 的
      // `${id}:pN` 键只读查询——同一条消息只有一个标签号。放在 surface 替换
      // 之后：新输入会吸收的尾部折叠（未闭合的 tool-call/结果）以替换后的
      // surface 为准（替换成功则无折叠，失败/未替换则偏移 = 尾部文本块数）。
      previewTagPayloadMessages(
        db,
        canonicalSessionId,
        payload.messages,
        contentIdsBySource,
        tailFoldAfterPass(agent, canonicalSessionId, view, plan !== null),
      );
    }

    // ctx_reduce 双通道 nudge（Pi parity）：inject `<system-reminder>`，
    // 决策/正文/状态持久化复用共享核心；fail-open。
    maybeNudgeChannels(db, canonicalSessionId, agent, {
      threshold:
        safeThreshold(deps.historian, agent) ?? deps.historian?.config?.executeThresholdPercentage ?? 65,
      protection,
      cacheBusting: surfaceRewritten,
      agentDropsAppliedThisPass: agentDropsApplied,
      log: deps.log,
    });

    // A surface rewrite is the DSH cache bust: start the next protection-floor
    // epoch (core lifecycle (a): re-resolve the live override/geometry and
    // persist the snapshot). Defer passes keep reading the snapshot verbatim.
    if (surfaceRewritten) {
      try {
        resolveDshProtectionFloor(db, canonicalSessionId, { ...protection, cacheBusting: true });
      } catch {
        // Floor persistence is best-effort (fail-open); the next bust retries.
      }
    }

    // Magic note-nudger delivery: peek + inject (DSH inject semantics; no
    // anchor message id, so delivery clears the trigger + cooldown).
    try {
      const firstUser = (payload.messages as Array<{ id?: unknown }>).find((m) => m?.id !== undefined);
      const noteText = peekNoteNudgeText(
        db,
        canonicalSessionId,
        typeof firstUser?.id === "string" ? firstUser.id : undefined,
        deps.directory,
        undefined,
      );
      if (noteText !== null) {
        const noteMarker = `mc-nudge:note`;
        const events = sessionEvents(agent.session);
        const alreadyInjected = events.some((event) => {
          if (event === null || typeof event !== "object") return false;
          const e = event as { data?: { source?: { plugin?: unknown; messageId?: unknown } } };
          const source = e.data?.source;
          return source?.plugin === "magic-context" && source?.messageId === noteMarker;
        });
        if (!alreadyInjected) {
          const { magicUserMessage } = await import("../compat/dsh-0.1/session");
          const noteMessage = magicUserMessage(
            noteText,
            { kind: "magic-context", plugin: "magic-context", messageId: noteMarker } as never,
            [],
          );
          (agent as unknown as { inject?: (m: unknown) => void }).inject?.(noteMessage);
          markNoteNudgeDelivered(db, canonicalSessionId, noteText, null);
        }
      }
    } catch {
      // Note nudge must never break the pre-step chain (fail-open).
    }

    // Round 24 (P1-1): keep core's message-history FTS index (ctx_search's
    // message lane) caught up with the DSH log — OpenCode/Pi parity.
    scheduleDshMessageHistoryIndex(db, canonicalSessionId, agent, deps.log);
    // Round 24b (item 2): register the project's embedding provider and start
    // the automatic compartment-embedding backfill for the active session
    // (core-throttled, deferred off the step, fail-open) — OpenCode/Pi parity.
    scheduleDshAutoEmbed(db, canonicalSessionId, agent, deps.directory, deps.log);

    // Historian plane: evaluate the context-pressure trigger and fire the
    // background compartment pass (fire-and-forget; never blocks the step).
    const historian = deps.historian;
    if (historian !== undefined && historian.config?.enabled !== false) {
      maybeFireHistorian(historian, db, canonicalSessionId, agent, deps.directory);
    }
  } catch (error) {    deps.log?.(
      `[magic-context] context plane failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return await next();
}

/**
 * Register the context plane as a pre-step gate. Registered BEFORE the
 * knowledge gate so the knowledge gate stays the outermost listener.
 */
export function registerContextPlane(ctx: Context, deps: ContextPlaneDeps): () => boolean {
  const state = createContextPlaneState();
  const disposeTurnEnd = registerHistorianTurnEndAwait(ctx, deps);
  const disposeGate = registerPreStepGate(ctx, (payload, next) =>
    runContextPlaneStep(state, deps, payload, next),
  );
  return () => {
    disposeTurnEnd?.();
    return disposeGate();
  };
}

/**
 * One-shot hosts: at the turn boundary, re-evaluate the historian trigger with
 * the turn's final pressure (the pre-step sample predates the last model call)
 * and await in-flight passes for at most `awaitMs`. DSH awaits
 * `agent/turn-stopping` listeners before committing the turn end, so the pass
 * publishes before `dsh headless` prints its result and exits.
 */
export async function awaitHistorianAtTurnEnd(
  deps: ContextPlaneDeps,
  agent: Agent,
  awaitMs: number,
): Promise<void> {
  const historian = deps.historian;
  if (historian === undefined || historian.config?.enabled === false) return;
  if (awaitMs <= 0 || historian.drain === undefined) return;
  if (isMagicChildSession(agent)) return;
  if (deps.isEnabled?.() === false) return;
  try {
    const bootstrap = await deps.host.ready;
    if (bootstrap.kind !== "ok") return;
    const sessionId = deps.host.canonicalKey(agent.id);
    if (historian.drain.pending(sessionId) === 0) {
      maybeFireHistorian(historian, bootstrap.db, sessionId, agent, deps.directory);
    }
    if (historian.drain.pending(sessionId) === 0) return;
    const result = await historian.drain.drain(awaitMs, sessionId);
    deps.log?.(
      `[magic-context] historian turn-end await: settled=${result.settled} pending=${result.pending} waited=${result.waitedMs}ms (budget ${awaitMs}ms)`,
    );
  } catch (error) {
    deps.log?.(
      `[magic-context] historian turn-end await failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function registerHistorianTurnEndAwait(
  ctx: Context,
  deps: ContextPlaneDeps,
): (() => unknown) | undefined {
  // Resolved per turn (not at registration): the DSH settings overlay edits
  // historian.awaitAtTurnEndMs live, so a 0 at boot may become >0 later.
  if (deps.historian?.drain === undefined) return undefined;
  const on = (ctx as unknown as {
    on?: (event: string, listener: (payload: { agent: Agent }) => Promise<void>) => () => unknown;
  }).on;
  if (typeof on !== "function") return undefined;
  return on.call(ctx, "agent/turn-stopping", async (payload) => {
    const awaitMs = resolveAwaitAtTurnEndMs(deps.historian?.config?.awaitAtTurnEndMs);
    if (awaitMs <= 0) return;
    await awaitHistorianAtTurnEnd(deps, payload.agent, awaitMs);
  });
}
