/**
 * agent/knowledge-gate — the first-step knowledge injection gate (Phase 2
 * slice A).
 *
 * Registered on `agent/pre-step` with `prepend: true` (outermost, via the
 * compat seam registerPreStepGate). The gate:
 *
 *   1. awaits the host `magicContextHost.ready` bootstrap (fail-open on
 *      refusal);
 *   2. attributes the session to its project (`session_projects`, once per
 *      session — see session-track.ts);
 *   3. injects the Magic knowledge baseline — core m[0]/m[1] through
 *      mustMaterialize / materializeWithRetry (which internally renders m[1]
 *      and persists the cached m[0] via persistCachedM0) or, on a cache-valid
 *      defer pass, replays the persisted bytes — ONCE per session per surface
 *      generation (in-memory Map<sessionId, generation>) with a content
 *      watermark de-dup against the visible surface (resume safety);
 *   4. evaluates the auto-search hint for the incoming user message and
 *      appends it to the current batch (bounded wait, see auto-search.ts);
 *   5. passes the pre-step decision through untouched (`await next()`).
 *
 * Injection timing (DSH 0.2.1-rc.5): the baseline is prepended to the CURRENT
 * pre-step batch, which DSH appends to the surface for this request. It is
 * not additionally queued with `agent.inject()` (that duplicate kept the
 * next-step inbox non-empty and forced an extra step after a final reply). This matches the PLAN §4.1 "inject, do not rewrite"
 * contract — the adapter never mutates existing message arrays.
 *
 * Knowledge-mode preview: `compactionOff: true` by default — the zero-
 * compartment path where m[0] carries memory/docs/user-profile only and
 * historical compartments never render.
 */
import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import {
  mustMaterialize,
  materializeWithRetry,
  renderM1,
  type M0HardSignals,
  type M0M1RenderOptions,
  type M0M1State,
  type M0SnapshotMarkers,
  type MaterializeM0Result,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { resolveCacheTtl } from "@magic-context/core/hooks/magic-context/event-resolvers";
import { buildSyntheticTodoPart } from "@magic-context/core/hooks/magic-context/todo-view";
import { consumeDshDeferredSignals } from "./historian";
import { getDshCompactionMarker } from "./outbox";
import { parseCacheTtl } from "@magic-context/core/features/magic-context/scheduler";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
  isMagicSource,
  magicUserMessage,
  replaceUserNode,
  sessionEventAt,
  type MagicMessageSource,
} from "../compat/dsh-0.1/session";
import {
  registerPreStepGate,
  type PreStepDecision,
  type PreStepPayload,
} from "../compat/dsh-0.1/prestep";
import type { DshStorageBootstrap } from "../host/bootstrap";
import { resolveSessionProjectIdentity, trackSessionProjectOnce, sessionProjectPath } from "./session-track";
import { maybeRunAutoSearchHint, type AutoSearchConfig } from "./auto-search";
import { isMagicChildSession } from "./worker";
import { TOOL_RECORD_NOTE_PREFIX } from "./transcript";

/** The host-service slice the gate needs (structural view). */
export interface KnowledgeGateHostView {
  /** Settles once the storage bootstrap finishes (ok or refused). */
  readonly ready: Promise<DshStorageBootstrap>;
  /** Canonical Magic session key for a DSH session. */
  canonicalKey(dshSessionId: string): string;
}

/** Knowledge (m0/m1) gate options surfaced in the agent plugin config. */
export interface KnowledgeConfig {
  enabled?: boolean;
  /** Session workspace directory (fallback when the header has no cwd). */
  directory?: string;
  /** m[0] includes the <project-docs> block (default true). */
  injectDocs?: boolean;
  /** Zero-compartment knowledge-mode path (default true — preview mode). */
  compactionOff?: boolean;
  memoryInjectionBudgetTokens?: number;
  historyBudgetTokens?: number;
  userProfileBudgetTokens?: number;
  muralEnabled?: boolean;
  /** Provider-side cache TTL ("5m", "1h", ...) for the HARD-bust signal. */
  cacheTtl?: string;
}

export interface KnowledgeGateDeps {
  readonly host: KnowledgeGateHostView;
  readonly config: KnowledgeConfig;
  readonly autoSearch: AutoSearchConfig;
  /** Mural image injection (Phase 4): vision-gated image block on m0. */
  readonly mural?: {
    /** Master switch (config mural.enabled). */
    enabled?: boolean;
    /** Vision gate for the session's model (production: modelSupportsVision). */
    supportsVision?: (agent: KnowledgeAgentView) => boolean;
    /** Persist the mural data URL as an attachment and return the image block. */
    resolveImage?: (dataUrl: string) => Promise<unknown | null>;
  };
  /** Injectable clock (tests). */
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/** Per-plugin gate state (owned by the registration, reset on plugin reload). */
export interface KnowledgeGateState {
  /** sessionId → surface generation already injected for. */
  readonly injectedGenerations: Map<string, number>;
  /** sessionId → project attribution already recorded for. */
  readonly trackedSessions: Set<string>;
  /** Messages injected by the most recent pass (first-round prepend). */
  lastInjectedMessages: unknown[];
}

export function createKnowledgeGateState(): KnowledgeGateState {
  return { injectedGenerations: new Map(), trackedSessions: new Set(), lastInjectedMessages: [] };
}

/** The session surface slice the gate reads (test-friendly structural view). */
export interface KnowledgeSessionView {
  readonly surface: { readonly nodes: readonly number[]; readonly replaceGeneration: number };
  /** DSH 0.2 event-log readers (Session.events was removed in 0.2). */
  eventAt?(seq: never): unknown;
  snapshotEvents?(): readonly unknown[];
  /** Legacy / test-double log array; read via sessionEventAt(). */
  readonly events?: readonly unknown[];
  readonly header: { readonly cwd?: string };
}

/** The agent slice the gate drives (structural view over DSH Agent). */
export interface KnowledgeAgentView {
  readonly id: SessionId;
  readonly options: { readonly provider?: string; readonly model?: string };
  readonly session: KnowledgeSessionView;
  inject(message: UserMessage): void;
}

/** One materialized knowledge payload ready for injection. */
export interface KnowledgeBlocks {
  readonly m0Text: string;
  readonly m1Text: string;
  /** Combined model-facing text (m0 + optional m1 delta). */
  readonly text: string;
  readonly watermark: string;
  readonly revision: string;
  readonly digest: string;
}

/**
 * Mirror of the core's M1 "nothing new" placeholder (inject-compartments.ts).
 * The adapter strips it so the model never sees the "no new content" stub.
 */
const M1_EMPTY_PLACEHOLDER =
  "<session-history-since>(no new content since last materialization)</session-history-since>";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function decodeUtf8(bytes: Buffer | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

/** Provider/model key for the HARD-bust signal ("provider/model", or ""). */
function modelKeyOf(agent: KnowledgeAgentView): string {
  const { provider, model } = agent.options;
  if (!provider || !model) return "";
  return `${provider}/${model}`;
}

/** Compute the runtime HARD-bust signals (system/model/TTL idle). */
export function computeHardSignals(
  deps: Pick<KnowledgeGateDeps, "config" | "now">,
  meta: { systemPromptHash?: string | number; lastResponseTime: number },
  agent: KnowledgeAgentView,
): M0HardSignals {
  const modelKey = modelKeyOf(agent);
  const rawSystemHash = typeof meta.systemPromptHash === "string" ? meta.systemPromptHash : "";
  const systemHash =
    rawSystemHash !== "" && rawSystemHash !== "0" ? rawSystemHash : "";
  let cacheExpired = false;
  if (meta.lastResponseTime > 0) {
    try {
      const ttl = resolveCacheTtl(deps.config.cacheTtl ?? "5m", modelKey || undefined);
      const ttlMs = parseCacheTtl(ttl);
      const now = deps.now?.() ?? Date.now();
      cacheExpired = now - meta.lastResponseTime > ttlMs;
    } catch {
      cacheExpired = false;
    }
  }
  return { systemHash, modelKey, cacheExpired, lastResponseTime: meta.lastResponseTime };
}

/**
 * Core pipeline: mustMaterialize → materializeWithRetry (m0/m1 render +
 * persistCachedM0, contention-retried) or, on a cache-valid defer pass, replay
 * the persisted bytes. Returns the injection-ready blocks + content watermark.
 */
export function materializeKnowledgeBlocks(
  deps: KnowledgeGateDeps,
  db: Database,
  magicSessionId: string,
  projectPath: string | undefined,
  directory: string | undefined,
  agent: KnowledgeAgentView,
  forceMaterialize = false,
): KnowledgeBlocks | null {
  const meta = getOrCreateSessionMeta(db, magicSessionId);
  const state = meta as unknown as M0M1State;
  const hardSignals = computeHardSignals(deps, meta, agent);
  const renderOptions: M0M1RenderOptions = {
    db,
    sessionId: magicSessionId,
    state,
    projectPath,
    // projectDirectory is the FILESYSTEM directory (docs read); projectPath is
    // the canonical project identity (memory lookup). Keep them distinct.
    projectDirectory: directory ?? "",
    injectDocs: deps.config.injectDocs ?? true,
    // Pi parity: compartments render into <session-history> by default;
    // only compaction.enabled=false (compaction-off mode) empties them.
    compactionOff: deps.config.compactionOff ?? false,
    memoryInjectionBudgetTokens: deps.config.memoryInjectionBudgetTokens,
    historyBudgetTokens: deps.config.historyBudgetTokens,
    userProfileBudgetTokens: deps.config.userProfileBudgetTokens,
    muralEnabled: deps.config.muralEnabled ?? false,
    hardSignals,
  };

  const decision = forceMaterialize
    ? { value: true, reason: "deferred_materialization" }
    : mustMaterialize({
        db,
        sessionId: magicSessionId,
        state,
        projectPath,
        hardSignals,
        injectDocs: renderOptions.injectDocs,
        muralEnabled: renderOptions.muralEnabled,
        memoryInjectionBudgetTokens: renderOptions.memoryInjectionBudgetTokens,
        historyBudgetTokens: renderOptions.historyBudgetTokens,
      });

  let m0Text: string;
  let m1Text: string;
  let markers: M0SnapshotMarkers | null;
  let materializedAt: number;

  if (decision.value) {
    const result: MaterializeM0Result = materializeWithRetry(renderOptions);
    m0Text = result.m0Text;
    m1Text = result.m1Text;
    markers = result.snapshotMarkers;
    materializedAt = result.snapshotMarkers.materializedAt;
    // Hold the markers for in-process defer passes (fresh m1 delta rendering).
    state.snapshotMarkers = result.snapshotMarkers;
  } else {
    // Defer: replay the persisted baseline bytes.
    m0Text = decodeUtf8(state.cachedM0Bytes) ?? "";
    m1Text = decodeUtf8(state.cachedM1Bytes) ?? "";
    materializedAt = state.cachedM0MaterializedAt ?? 0;
    markers = state.snapshotMarkers ?? null;
    if (markers) {
      // Fresh m1 delta against the held markers so additive memories surface
      // even when the cache is valid (soft refresh, non-persisted).
      try {
        const fresh = renderM1(renderOptions, markers, []);
        if (fresh && fresh.trim().length > 0 && fresh !== M1_EMPTY_PLACEHOLDER) {
          m1Text = fresh;
        }
      } catch {
        // Keep the cached m1 on any marker mismatch.
      }
    }
  }

  if (m0Text.length === 0) return null;

  const m1Part =
    m1Text.trim().length > 0 && m1Text !== M1_EMPTY_PLACEHOLDER ? `\n\n${m1Text}` : "";
  const text = `${m0Text}${m1Part}`;
  const digest = sha256Hex(text).slice(0, 16);
  const revision = String(materializedAt);
  return {
    m0Text,
    m1Text,
    text,
    watermark: `mc-kb:${revision}:${digest}`,
    revision,
    digest,
  };
}

/**
 * Watermark de-dup against the VISIBLE surface: true when a Magic knowledge
 * message with this watermark is already a live surface node (resume replay —
 * the durable log still carries it, so a restarted process must not re-inject).
 * Replaced (shadowed) nodes do not count, so a compacted session re-injects.
 */
export function isMagicWatermarkOnSurface(
  session: KnowledgeSessionView,
  watermark: string,
): boolean {
  for (const seq of session.surface.nodes) {
    const event = sessionEventAt(session, seq) as
      | { type?: string; data?: { source?: MagicMessageSource | { kind?: string } } }
      | undefined;
    if (!event || event.type !== "user/message") continue;
    const source = event.data?.source;
    if (
      isMagicSource(source) &&
      source.messageId === watermark
    ) {
      return true;
    }
  }
  return false;
}

/** Watermark prefix of a Magic knowledge baseline (`mc-kb:<revision>:<digest>`; m1 adds `:m1`). */
export const KNOWLEDGE_WATERMARK_PREFIX = "mc-kb:";
/** Message-id prefix of a superseded baseline node's stand-in (round 37 I4). */
export const RETIRED_BASELINE_PREFIX = "mc-kb-retired:";
/** Text of a superseded baseline node's stand-in (legacy duplicates only). */
export const RETIRED_BASELINE_TEXT = "(superseded Magic Context knowledge baseline; the current one is above)";

/** One LIVE Magic knowledge-baseline node on the surface (identified by source, never by text). */
export interface LiveKnowledgeNode {
  readonly seq: number;
  readonly part: "m0" | "m1";
  readonly messageId: string;
  /** Materialization epoch (`source.revision`, or the watermark's revision field). */
  readonly revision: string;
  readonly text: string;
}

function textOfMessage(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("");
}

/**
 * Round 37 (I4): the knowledge-baseline nodes that are LIVE on the surface, in
 * surface order. Identity is the controlled Magic source (`magic-context`
 * kind) plus the gate's own watermark id (`mc-kb:<revision>:<digest>`, m1 with
 * `:m1`) — a user message that merely quotes `<session-history>` has a `user`
 * source and is never matched. Shadowed (replaced) baselines are not live.
 */
export function liveKnowledgeBaselines(session: KnowledgeSessionView): LiveKnowledgeNode[] {
  const out: LiveKnowledgeNode[] = [];
  for (const seq of session.surface.nodes) {
    const event = sessionEventAt(session, seq) as
      | { type?: string; data?: { source?: unknown } & Record<string, unknown> }
      | undefined;
    if (!event || event.type !== "user/message") continue;
    const source = event.data?.source;
    if (!isMagicSource(source)) continue;
    const messageId = source.messageId;
    if (typeof messageId !== "string" || !messageId.startsWith(KNOWLEDGE_WATERMARK_PREFIX)) continue;
    const part = messageId.endsWith(":m1") ? "m1" : "m0";
    const revision =
      typeof source.revision === "string" && source.revision.length > 0
        ? source.revision
        : (messageId.slice(KNOWLEDGE_WATERMARK_PREFIX.length).split(":")[0] ?? "");
    out.push({ seq, part, messageId, revision, text: textOfMessage(event.data) });
  }
  return out;
}

/**
 * Round 37 (I4): true when the surface's live knowledge baseline does not yet
 * render the latest historian publication — the window between a committed
 * publication (compartments + queued drops) and the baseline that shows those
 * compartments. While it is open, the publication's drops must not land, or
 * the covered raw history and its summary are both invisible (a crash in that
 * window used to lose them). `pendingBatch` are the messages the current
 * pre-step will append (a first baseline delivered in the batch counts).
 * Fail-open false (no guard) on read errors.
 */
export function knowledgeBaselineBehindPublication(
  session: KnowledgeSessionView,
  latestPublishAt: number,
  pendingBatch: readonly unknown[] = [],
): boolean {
  if (!(latestPublishAt > 0)) return false;
  try {
    const live = liveKnowledgeBaselines(session).filter((n) => n.part === "m0");
    const revisions = live.map((n) => Number(n.revision)).filter((n) => Number.isFinite(n));
    for (const message of pendingBatch) {
      const source = (message as { source?: unknown } | null)?.source;
      if (!isMagicSource(source)) continue;
      const id = source.messageId;
      if (typeof id !== "string" || !id.startsWith(KNOWLEDGE_WATERMARK_PREFIX) || id.endsWith(":m1")) continue;
      const revision = Number(source.revision ?? id.slice(KNOWLEDGE_WATERMARK_PREFIX.length).split(":")[0]);
      if (Number.isFinite(revision)) revisions.push(revision);
    }
    if (revisions.length === 0) return false; // no Magic baseline at all (knowledge off / never injected)
    return Math.max(...revisions) < latestPublishAt;
  } catch {
    return false;
  }
}

/**
 * Round 37 phase 2 (checkpoint ↔ m0 overlap): true when a Magic knowledge
 * baseline (m0) is live on the surface or in this pre-step's batch AND it
 * renders the latest historian publication (its materialization is not older
 * than `latestPublishAt`). Then it renders every stored compartment — the
 * compartments are contiguous from ordinal 1 — so history up to the last
 * compartment's end is visible through it. False without a publication, without
 * a Magic baseline (knowledge off / never injected) and on read errors
 * (fail-safe: nothing is retired on its account).
 */
export function knowledgeBaselineRendersLatestPublication(
  session: KnowledgeSessionView,
  latestPublishAt: number,
  pendingBatch: readonly unknown[] = [],
): boolean {
  if (!(latestPublishAt > 0)) return false;
  try {
    const revisions = liveKnowledgeBaselines(session)
      .filter((n) => n.part === "m0")
      .map((n) => Number(n.revision))
      .filter((n) => Number.isFinite(n));
    for (const message of pendingBatch) {
      const source = (message as { source?: unknown } | null)?.source;
      if (!isMagicSource(source)) continue;
      const id = source.messageId;
      if (typeof id !== "string" || !id.startsWith(KNOWLEDGE_WATERMARK_PREFIX) || id.endsWith(":m1")) continue;
      const revision = Number(source.revision ?? id.slice(KNOWLEDGE_WATERMARK_PREFIX.length).split(":")[0]);
      if (Number.isFinite(revision)) revisions.push(revision);
    }
    if (revisions.length === 0) return false;
    return Math.max(...revisions) >= latestPublishAt;
  } catch {
    return false;
  }
}

/** Replace each node with the retired stand-in (single-node user replace + prune, later nodes first). */
function retireBaselineNodes(
  session: import("@deepseek-ai/dsh-session").Session,
  nodes: readonly LiveKnowledgeNode[],
  revision: string,
): void {
  for (const node of [...nodes].sort((a, b) => b.seq - a.seq)) {
    replaceUserNode(
      session,
      node.seq,
      magicUserMessage(RETIRED_BASELINE_TEXT, {
        kind: "magic-context",
        plugin: "magic-context",
        messageId: `${RETIRED_BASELINE_PREFIX}${node.messageId}`,
        revision,
      }, []),
    );
  }
}

type SurfaceWriter = { append: (...args: never[]) => unknown };

function canRewriteSurface(session: KnowledgeSessionView): session is KnowledgeSessionView & SurfaceWriter {
  return typeof (session as unknown as { append?: unknown }).append === "function";
}

/** Inject the knowledge baseline once per (session, surface generation). */
export async function maybeInjectKnowledge(
  state: KnowledgeGateState,
  deps: KnowledgeGateDeps,
  agent: KnowledgeAgentView,
  db: Database,
  magicSessionId: string,
  projectPath: string | undefined,
  directory: string | undefined,
  forceMaterialize = false,
): Promise<void> {
  if (deps.config.enabled === false) return;
  const generation = agent.session.surface.replaceGeneration;
  if (state.injectedGenerations.get(magicSessionId) === generation) return;

  const blocks = materializeKnowledgeBlocks(
    deps,
    db,
    magicSessionId,
    projectPath,
    directory,
    agent,
    forceMaterialize,
  );
  if (blocks === null) return;

  // Round 37 (I4): the live baselines decide between resume (no write), a
  // tail m1 delta, an in-place supersession and a first delivery.
  const live = liveKnowledgeBaselines(agent.session);
  const liveM0 = live.filter((n) => n.part === "m0");
  const liveM1 = live.filter((n) => n.part === "m1");
  const currentM0 = liveM0[0];
  if (isMagicWatermarkOnSurface(agent.session, blocks.watermark)) {
    // Resume: the persisted surface already carries this exact baseline.
    // Sessions written before round 37 can still hold older full baselines
    // next to it: retire those (other revisions only — same-revision m1
    // deltas stay) once, in place.
    const stale = live.filter((n) => n.revision !== blocks.revision);
    if (stale.length > 0 && canRewriteSurface(agent.session)) {
      try {
        retireBaselineNodes(agent.session as never, stale, blocks.revision);
        deps.log?.(
          `[magic-context] retired ${stale.length} superseded knowledge baseline node(s) next to live ${blocks.watermark} for ${magicSessionId}`,
        );
      } catch (error) {
        deps.log?.(
          `[magic-context] baseline retirement failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    state.injectedGenerations.set(magicSessionId, agent.session.surface.replaceGeneration);
    return;
  }
  if (
    currentM0 !== undefined &&
    liveM0.length === 1 &&
    currentM0.revision === blocks.revision &&
    currentM0.text === blocks.m0Text
  ) {
    // Same materialization, only the soft m1 delta moved (memories added
    // since): never rewrite the stable m0/m1 prefix without a new
    // materialization — append the fresh m1 at the tail, once.
    const m1Id = `${blocks.watermark}:m1`;
    const latestM1 = liveM1[liveM1.length - 1];
    if (latestM1 === undefined || (latestM1.messageId !== m1Id && latestM1.text !== blocks.m1Text)) {
      state.lastInjectedMessages = [
        magicUserMessage(blocks.m1Text, {
          kind: "magic-context",
          plugin: "magic-context",
          messageId: m1Id,
          revision: blocks.revision,
          digest: blocks.digest,
        }, []),
      ];
      deps.log?.(`[magic-context] knowledge m1 delta ${m1Id} appended for ${magicSessionId} (m0 unchanged)`);
    }
    state.injectedGenerations.set(magicSessionId, generation);
    return;
  }

  const source: MagicMessageSource = {
    kind: "magic-context",
    plugin: "magic-context",
    messageId: blocks.watermark,
    revision: blocks.revision,
    digest: blocks.digest,
  };
  // Mural (Phase 4): when enabled + the model supports vision + the m0 fold
  // produced a mural, persist the data URL as an attachment and ride the
  // image block on the injected baseline message. The extra blocks ride the
  // content array of the SAME message (createUserMessage deep-freezes, so the
  // array is assembled before construction).
  const mural = deps.mural;
  let muralBlock: unknown = null;
  if (mural?.enabled === true && (mural.supportsVision?.(agent) ?? false)) {
    try {
      const meta = getOrCreateSessionMeta(db, magicSessionId) as unknown as {
        cachedM0MuralDataUrl?: string | null;
      };
      const dataUrl = meta.cachedM0MuralDataUrl;
      if (typeof dataUrl === "string" && dataUrl.length > 0 && mural.resolveImage !== undefined) {
        muralBlock = await mural.resolveImage(dataUrl);
      }
    } catch (error) {
      deps.log?.(
        `[magic-context] mural injection skipped (fail-open): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const muralBlocks =
    muralBlock === null || muralBlock === undefined
      ? []
      : ([muralBlock] as unknown as Parameters<typeof magicUserMessage>[2]);
  // Pi 语义：m0 与 m1 是两条独立合成 user 消息（m0/m1 缓存分裂契约）。
  const m0Message = magicUserMessage(blocks.m0Text, source, muralBlocks);
  const m1Source: MagicMessageSource = {
    ...source,
    messageId: `${blocks.watermark}:m1`,
  };
  const m1Message = magicUserMessage(blocks.m1Text, m1Source, []);
  // DSH 0.2 delivery: the gate prepends these to the CURRENT pre-step batch
  // (the claimed array the terminal decision returns), which DSH appends to
  // the surface for this very request. Do NOT also `agent.inject()` them:
  // that queues a duplicate copy in the next-step inbox, so a step that
  // finished with plain text no longer ends the turn (DSH 0.2.1-rc.5 loop:
  // `turnEnds && inbox.nextStep.length === 0`) — an extra model call that
  // re-sends the baseline, verified on a real headless run.
  const delivered: unknown[] = [];
  // Round 37 (I4): a NEW baseline supersedes the live one IN PLACE (one
  // single-node user replace each for m0 and m1, preceded by its
  // compaction/prune shadow price) instead of appending a second full
  // <session-history>. One atomic event per node: at no point is neither the
  // old nor the new m0 live. m0 and m1 stay two messages at the old m0/m1
  // positions (cache split kept); only a new materialization gets here, and
  // that is a HARD bust in core semantics anyway. Older duplicate baselines
  // (sessions written before this fix, superseded m1 deltas) are retired to a
  // short stand-in. The durable log keeps every version.
  let supersededInPlace = false;
  if (currentM0 !== undefined && canRewriteSurface(agent.session)) {
    try {
      const session = agent.session as unknown as import("@deepseek-ai/dsh-session").Session;
      const firstM1 = liveM1.find((n) => n.seq > currentM0.seq) ?? liveM1[0];
      const retire = live.filter((n) => n !== currentM0 && n !== firstM1);
      retireBaselineNodes(session, retire, blocks.revision);
      if (firstM1 !== undefined) replaceUserNode(session, firstM1.seq, m1Message);
      replaceUserNode(session, currentM0.seq, m0Message);
      if (firstM1 === undefined) delivered.push(m1Message);
      supersededInPlace = true;
      deps.log?.(
        `[magic-context] knowledge baseline ${currentM0.messageId} superseded in place by ${blocks.watermark} for ${magicSessionId} (retired ${retire.length} older baseline node(s))`,
      );
    } catch (error) {
      deps.log?.(
        `[magic-context] in-place baseline supersession failed (${error instanceof Error ? error.message : String(error)}); delivering in the batch`,
      );
      supersededInPlace = false;
    }
  }
  if (!supersededInPlace) delivered.push(m0Message, m1Message);
  // Synthetic todowrite replay (Magic todo-view parity): this pass IS a
  // cache-bust (HARD materialization) — resurface the last todo snapshot so
  // the model regains its task list after the fold, exactly like OpenCode/Pi
  // ride the synthetic pair on cache-busting passes. DSH delivery keeps the
  // inject + watermark semantics; the part is rendered in the DSH folded
  // tool-call text shape the model already sees.
  try {
    const meta = getOrCreateSessionMeta(db, magicSessionId) as unknown as {
      lastTodoState?: string | null;
    };
    const todoState = meta.lastTodoState ?? null;
    if (typeof todoState === "string" && todoState.length > 0) {
      const part = buildSyntheticTodoPart(todoState);
      if (part !== null) {
        const todoWatermark = `mc-todo:${sha256Hex(todoState).slice(0, 16)}`;
        if (!isMagicWatermarkOnSurface(agent.session, todoWatermark)) {
          // Round 28 (limitations 21/22): a prose note, never a call / id /
          // input / result template (the round 26 `[tool: …]` and round 27
          // `- called todowrite (id …)` records were both imitated by the
          // model). The todo JSON itself is the content the model needs.
          const todoText = `${TOOL_RECORD_NOTE_PREFIX}the todo list as last set with todowrite, restored after a context fold as plain reference text (still current; update it by calling todowrite normally).\n\n${String(part.state.output)}`;
          const todoSource: MagicMessageSource = {
            kind: "magic-context",
            plugin: "magic-context",
            messageId: todoWatermark,
          };
          const todoMessage = magicUserMessage(todoText, todoSource, []);
          delivered.push(todoMessage);
        }
      }
    }
  } catch {
    // Todo replay must never break injection (fail-open).
  }
  state.injectedGenerations.set(magicSessionId, agent.session.surface.replaceGeneration);
  // 首轮 pre-step 前置用：本次 LLM 调用即可见（Pi transform unshift 语义）。
  state.lastInjectedMessages = delivered;
  deps.log?.(
    `[magic-context] injected knowledge baseline ${blocks.watermark} for ${magicSessionId}@gen${generation}`,
  );
}

/**
 * Durable twin of the historian's in-memory deferred-materialization signal.
 *
 * DSH headless runs each turn in a fresh process: the post-publish signal
 * (historian.ts deferredSignalsBySession) dies with the process that ran the
 * background historian, so the next process saw a cache-valid m0, replayed
 * the old (empty) <session-history> under the same watermark, and the
 * compartmentalized raw messages were dropped anyway — history lost (real
 * rc.5, round 17 e2e). The publish itself is durable: it stages the
 * compaction marker (published_at) and writes compartments (created_at) in
 * one transaction. Anything published after the cached m0 baseline was
 * materialized therefore owes a fold. Self-consuming like core's ttl_idle /
 * host_compaction triggers: the fold stamps cached_m0_materialized_at =
 * Date.now(), newer than the publish. Fail-open (false) on any read error.
 */
export function hasUnmaterializedHistorianPublish(
  db: Database,
  magicSessionId: string,
  config: { compactionOff?: boolean },
): boolean {
  if (config.compactionOff === true) return false; // compartments never render
  try {
    const meta = db
      .prepare("SELECT cached_m0_bytes IS NOT NULL AS has_m0, cached_m0_materialized_at AS at FROM session_meta WHERE session_id = ?")
      .get(magicSessionId) as { has_m0: number; at: number | null } | null | undefined;
    // No baseline yet → core's first_render handles it.
    if (!meta || !meta.has_m0) return false;
    const materializedAt = meta.at ?? 0;
    const marker = getDshCompactionMarker(db, magicSessionId);
    if (marker !== null && marker.publishedAt > materializedAt) return true;
    const row = db
      .prepare("SELECT MAX(created_at) AS latest FROM compartments WHERE session_id = ?")
      .get(magicSessionId) as { latest: number | null } | null | undefined;
    return typeof row?.latest === "number" && row.latest > materializedAt;
  } catch {
    return false;
  }
}

/** Resolve the canonical project identity for a session workspace. */
export function resolveKnowledgeProjectPath(directory: string | undefined): string | undefined {
  return resolveSessionProjectIdentity(directory);
}

/** Full gate body (host wait → track → knowledge → auto-search → next). */
export async function runKnowledgeGateStep(
  state: KnowledgeGateState,
  deps: KnowledgeGateDeps,
  payload: Pick<PreStepPayload, "agent" | "messages">,
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const agent = payload.agent as unknown as KnowledgeAgentView;
  try {
    // Recursion isolation (PLAN §9): child sessions (subagents/workers) run
    // with official semantics — no Magic knowledge processing on children.
    if (isMagicChildSession(agent as unknown as import("@deepseek-ai/dsh-agent").Agent)) {
      return await next();
    }
    const bootstrap = await deps.host.ready;
    if (bootstrap.kind === "ok") {
      const db = bootstrap.db;
      const magicSessionId = deps.host.canonicalKey(agent.id);
      const directory = sessionProjectPath(agent, deps.config.directory);
      const projectPath = resolveKnowledgeProjectPath(directory);

      // Session → project attribution (once per session).
      trackSessionProjectOnce(state.trackedSessions, db, magicSessionId, projectPath);

      // Historian 发布后的 deferred-materialization 信号（Pi parity）：下一轮
      // pre-step 强制 HARD 物化 → m0 折叠 m1 并渲染 <session-history>。
      // The in-memory signal only survives inside one process; the durable
      // check covers headless (one process per turn) and a signal consumed
      // on a pass whose surface generation was already injected.
      const deferred = consumeDshDeferredSignals(magicSessionId);
      const forceMaterialize =
        deferred.materialization ||
        hasUnmaterializedHistorianPublish(db, magicSessionId, { compactionOff: deps.config.compactionOff });
      // Knowledge baseline (once per surface generation; forced after publish).
      await maybeInjectKnowledge(state, deps, agent, db, magicSessionId, projectPath, directory, forceMaterialize);
      // Pi transform 语义：首轮注入的消息前置到本次调用的消息列表（立即可见）。
      // DSH 0.2: the claimed batch IS appended to the surface (user/message
      // events), so the prepend is the single delivery path; the watermark
      // de-dup reads it back from the surface on resume.
      if (state.lastInjectedMessages.length > 0) {
        const injected = state.lastInjectedMessages;
        state.lastInjectedMessages = [];
        (payload.messages as unknown[]).unshift(...injected);
      }

      // Auto-search hint on the incoming user message, delivered in THIS
      // batch (same single-delivery path as the baseline above; never
      // agent.inject — see auto-search.ts). Bounded by the 3s search cap;
      // batches without a fresh user prompt return immediately.
      const hints: unknown[] = [];
      try {
        await maybeRunAutoSearchHint({
          db,
          sessionId: magicSessionId,
          projectPath: projectPath ?? "",
          messages: payload.messages,
          deliver: (message) => {
            hints.push(message);
          },
          config: deps.autoSearch,
          log: deps.log,
        });
      } catch (error) {
        deps.log?.(
          `[magic-context] auto-search crashed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (hints.length > 0) (payload.messages as unknown[]).push(...hints);
    } else {
      deps.log?.(
        `[magic-context] knowledge gate skipped: storage bootstrap ${bootstrap.kind} (${String(bootstrap.detail)})`,
      );
    }
  } catch (error) {
    deps.log?.(
      `[magic-context] knowledge gate failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return await next();
}

/**
 * Register the knowledge gate as the OUTERMOST pre-step listener. The gate
 * never vetoes a step: it delays only until injection readiness and always
 * resolves the downstream decision.
 */
export function registerKnowledgeGate(ctx: Context, deps: KnowledgeGateDeps): () => boolean {
  const state = createKnowledgeGateState();
  return registerPreStepGate(ctx, (payload, next) =>
    runKnowledgeGateStep(state, deps, payload, next),
  );
}
