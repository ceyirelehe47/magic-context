/**
 * agent/transcript — DshTranscript (Phase 3 slice T).
 *
 * Read-only view of a DSH session plus MutationPlan derivation. Mirrors the
 * Pi adapter's mapping semantics (`pi-plugin/read-session-pi.ts`) and the
 * design doc `docs/phase3-design.md` §3 / §9.9-9.12:
 *
 *   1. `readDshTranscript` — the model-visible transcript (surface nodes →
 *      core `RawMessage[]`), with a reversible event-seq ↔ ordinal map.
 *   2. `deriveMutationPlan` — runs the shared core pipeline stages
 *      (temporal markers → tagTranscript → applyPendingOperations →
 *      applyFlushedStatuses → reasoning replay) through a RECORDING
 *      transcript/target layer, producing `MutationOp`s that the coordinator
 *      slice (C) will apply through the surface CAS. This module NEVER
 *      mutates the view's messages or any source array (D4).
 *
 * Recording design: `RecordingPart` wraps each RawMessage part and records
 * every content mutation (`from` → `to`) on its owning `RecordingMessage`;
 * `RecordingTagTarget` implements the core `TagTarget` interface by
 * delegating to the shared tagTranscript-built targets (which call the
 * recording parts), so `applyPendingOperations`/`applyFlushedStatuses` run
 * unchanged and their effects land in the plan instead of the wire. At the
 * end, each dirty message coalesces into ONE replace op (per design §3:
 * "同一消息多个变更 → 合并为单个 replace op").
 *
 * Scope: tags / drops / reasoning / temporal stages only. The remaining
 * stages (nudge / decay / caveman / historian / recomp / wrapup / emergency)
 * arrive with later slices; stage lists are plain arrays so the pipeline is
 * extensible.
 *
 * Known Phase-4 handoffs (documented at each site):
 *   - reasoning clearing is REPLAY-only (watermark reads); the watermark-
 *     advancing clear pass lands with the coordinator, which owns pass type.
 *   - `minimalCacheClassForOp` is a temporary stand-in for the
 *     cache-classification slice (§6); the official `classifyPlan` replaces
 *     it at integration.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import {
  applyFlushedStatuses,
  applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import { applyHeuristicCleanup } from "@magic-context/core/hooks/magic-context/heuristic-cleanup";
import type {
  MessageLike,
  TagTarget,
} from "@magic-context/core/hooks/magic-context/tag-messages";
import type { ToolDropResult } from "@magic-context/core/hooks/magic-context/tool-drop-target";
import {
  byteSize,
  peelLeadingMcTagNotation,
  stripTagPrefix,
} from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import {
  applyPressureTruncation,
  PRESSURE_TRUNCATION_MARKER,
  type PressureTruncationInput,
  type TruncationCandidate,
} from "./pressure-truncation";
import {
  formatGap,
  TEMPORAL_MARKER_PATTERN,
  temporalMarkerPrefix,
} from "@magic-context/core/hooks/magic-context/temporal-awareness";
import {
  getOrCreateSessionMeta,
  getPendingOps,
  getTagsBySession,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import type {
  Transcript,
  TranscriptMessage,
  TranscriptPart,
  TranscriptPartKind,
} from "@magic-context/core/shared/transcript";
import type { KnowledgeSessionView } from "./knowledge-gate";
import { isMagicSource, sessionEvents } from "../compat/dsh-0.1/session";
import { tokenProtectionWindow, type DshProtectionOptions } from "./protection";
import {
  deriveEventMessage,
  type SessionEvent,
} from "../compat/dsh-0.1/session";

/* ─────────────────────────────── public types ─────────────────────────────── */

/** Input to {@link readDshTranscript}: the DSH session structural view. */
export interface DshTranscriptInput {
  readonly session: KnowledgeSessionView & {
    readonly header: { readonly id?: string; readonly cwd?: string };
  };
  readonly canonicalSessionId: string;
}

/**
 * Read-only transcript view (design §3). `messages` are the model-visible
 * (surface) messages in surface order; `surfaceNodes` are the DSH surface
 * event seqs they were derived from. `inputDigest` =
 * sha256(JSON(messages))[0:16]; `sourceWatermark` = the last log seq covered;
 * `generation` = surface.replaceGeneration snapshot.
 *
 * Each view message carries NON-ENUMERABLE metadata (invisible to
 * JSON.stringify, so the digest is unaffected): its surface node span
 * (read via {@link messageNodeSpan}) and its knowledge-baseline flag (read
 * via {@link isKnowledgeBaselineMessage}). The mutation plan uses those to
 * index ops into `surfaceNodes` and to keep the m[0]/m[1] knowledge baseline
 * out of the tag/drop pipeline (see `buildRecordingTranscript`).
 */
export interface DshTranscriptView {
  readonly sessionId: string;
  readonly sourceWatermark: number;
  readonly inputDigest: string;
  readonly generation: number;
  readonly messages: readonly RawMessage[];
  readonly surfaceNodes: readonly number[];
}

export type MutationKind =
  | "tags"
  | "drops"
  | "reasoning"
  | "temporal"
  | "nudge"
  | "decay"
  | "caveman"
  | "historian"
  | "recomp"
  | "wrapup"
  | "emergency";

/**
 * Temporary local cache-class union. The cache-classification slice
 * (`src/agent/cache-classification.ts`) owns the official `CacheClass`;
 * until it lands, `minimalCacheClassForOp` is the stand-in.
 */
export type CacheClass = "soft-plus" | "soft" | "hard";

export interface MutationOp {
  readonly kind: MutationKind;
  /** Surface node range [start, end) (pre-replacement indices into view.surfaceNodes). */
  readonly start: number;
  readonly end: number;
  /** Replacement text: the full Magic-rendered content of the user-role message. */
  readonly replacement: string;
  readonly cacheClass: CacheClass;
  readonly reason: string;
  /** DSH event seqs of every shadowed surface node (sourceEventSeqs coverage). */
  readonly shadowedSeqs: readonly number[];
}

export interface MutationPlan {
  readonly opId: string;
  readonly sessionId: string;
  readonly sourceWatermark: number;
  readonly inputDigest: string;
  readonly generation: number;
  readonly ops: readonly MutationOp[];
}

/** Reversible DSH event seq ↔ ordinal mapping (ctx_expand traceability). */
export interface DshOrdinalMap {
  readonly ordinalToSeq: ReadonlyMap<number, number>;
  readonly seqToOrdinal: ReadonlyMap<number, number>;
}

/** Plan-derivation context (design §3). */
export interface PlanContext {
  readonly db: Database;
  /**
   * Token-floor protection inputs (core `computeProtectionWindow` membership
   * gates pending drops + heuristic cleanup). Replaces the legacy newest-N
   * `protectedTags` count, which core ignores since ≥0.49.
   */
  readonly protection?: DshProtectionOptions;
  /** Injectable clock; reserved for later stages (decay/nudge). Unused by this slice. */
  readonly now?: () => number;
  /** Heuristic cleanup config (Pi/OpenCode parity): routine dedup + optional
   *  caveman text compression. Emergency tier runs only on force passes and is
   *  intentionally not wired here. */
  readonly heuristicCleanup?: {
    readonly caveman?: { readonly enabled: boolean; readonly minChars: number };
  };
  /**
   * Pressure truncation (DSH emergency tier for protected large tool results,
   * `agent/pressure-truncation.ts`). Persisted truncations are ALWAYS replayed;
   * this input only allows a new decision on this pass. Absent = replay only.
   */
  readonly pressureTruncation?: PressureTruncationInput;
  readonly log?: (message: string) => void;
}

/* ────────────────────────────── event accessors ───────────────────────────── */

interface EventLike {
  readonly type?: unknown;
  readonly seq?: unknown;
  readonly time?: unknown;
  readonly data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asEvent(value: unknown): EventLike | null {
  return isRecord(value) ? (value as unknown as EventLike) : null;
}

function seqOf(event: EventLike): number {
  return typeof event.seq === "number" ? event.seq : -1;
}

function timeOf(event: EventLike): number | undefined {
  return typeof event.time === "number" ? event.time : undefined;
}

function dataOf(event: EventLike): Record<string, unknown> | null {
  return isRecord(event.data) ? event.data : null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/* ───────────────────────────── message conversion ─────────────────────────── */

/** `synth-user-` prefix for synthetic tail user messages (design §9.9). */
export const SYNTH_USER_ID_PREFIX = "synth-user-";

function isSyntheticUserMessage(message: RawMessage): boolean {
  return typeof message.id === "string" && message.id.startsWith(SYNTH_USER_ID_PREFIX);
}

/** True for Magic-injected knowledge messages (source.plugin === 'magic-context'). */
function isKnowledgeMessage(message: Record<string, unknown>): boolean {
  const source = isRecord(message.source) ? message.source : null;
  return source !== null && isMagicSource(source);
}

/**
 * True for DSH skill-catalog user messages (dsh-tool-skill's durable catalog
 * reminder: `source.kind === 'skill-catalog'` with `entries`). These must be
 * treated like knowledge baselines — excluded from the tag/drop pipeline — or
 * the §N§ prefix injection forces a surface replace each round, the catalog's
 * original event seq leaves the visible surface, `catalogHistory` can no
 * longer find a visible digest, and dsh-tool-skill re-injects the catalog on
 * every subsequent pre-step (the per-round <system-reminder> loop).
 */
function isSkillCatalogMessage(message: Record<string, unknown>): boolean {
  const source = isRecord(message.source) ? message.source : null;
  return source !== null && source.kind === "skill-catalog";
}

/**
 * True for the DSH agent-loop runtime-context snapshot
 * (`source.kind === 'runtime-context'`, rc.5 `RuntimeContextProjection`).
 * Treated as a baseline like the knowledge / skill-catalog messages:
 *   - rc.5 appends it AFTER the pre-step waterfall, so it cannot be tagged
 *     on its first call; tagging it on the next pass gave it the number the
 *     model had already written as its own "highest + 1" reply prefix (that
 *     prefix stays verbatim in the raw assistant event) — the round 9
 *     raw-vs-surface `§N§` pair;
 *   - replacing it nulls `RuntimeContextProjection.retained`
 *     (`sourceEventSeqs` contains the retained seq), so DSH re-appended an
 *     identical snapshot every turn while the Magic copy of the old one
 *     stayed on the surface.
 * It is never folded into (tool results before it flush first), tagged,
 * dropped or replaced.
 */
function isRuntimeContextMessage(message: Record<string, unknown>): boolean {
  const source = isRecord(message.source) ? message.source : null;
  return source !== null && source.kind === "runtime-context";
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Where a view text part came from: the DSH source message id and the index of
 * the block among that message's `{type:"text"}` blocks. Kept in a WeakMap (not
 * on the part) so the parts — and therefore the view's `inputDigest` and every
 * rendered replacement — stay byte-identical.
 *
 * Needed because the view folds messages (a tool-call assistant's text lands
 * in the following user / synthetic user message), so the core text tag key
 * `${viewMessageId}:p${textOrdinal}` cannot be derived from a source message
 * alone. See {@link textTagContentIdsBySource}.
 */
const TEXT_PART_ORIGIN = new WeakMap<object, { sourceId: string; blockIndex: number }>();

function textPart(text: string, sourceId: unknown, blockIndex: number): Record<string, unknown> {
  const part = { type: "text", text };
  if (typeof sourceId === "string" && sourceId.length > 0) {
    TEXT_PART_ORIGIN.set(part, { sourceId, blockIndex });
  }
  return part;
}

/** User content blocks → `{type:"text", text}` parts; image/other blocks dropped (§9.9). */
function userTextParts(content: unknown, sourceId?: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  const parts: unknown[] = [];
  let blockIndex = 0;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    parts.push(textPart(block.text, sourceId, blockIndex));
    blockIndex += 1;
  }
  return parts;
}

/**
 * Assistant content blocks → text parts + `{type:"tool", state:{input}}` parts
 * for tool calls (Pi `synthesizeAssistantParts` mirror). With
 * `keepReasoning`, `{type:"reasoning", text}` blocks are retained as parts so
 * the reasoning stage can plan their removal — the pure conversion drops them
 * (§9.9 "assistant thinking 丢弃"). Images/unknown dropped.
 */
function assistantParts(
  message: Record<string, unknown>,
  keepReasoning: boolean,
  toolNameByCallId: Map<string, string>,
): unknown[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const parts: unknown[] = [];
  let textBlockIndex = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(textPart(block.text, message.id, textBlockIndex));
      textBlockIndex += 1;
    } else if (block.type === "tool-call" && typeof block.id === "string") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      if (typeof block.name === "string" && block.name.length > 0) {
        toolNameByCallId.set(block.id, block.name);
      }
      parts.push({
        type: "tool",
        tool: name,
        callID: block.id,
        state: { input: parseToolArguments(block.arguments) },
      });
    } else if (
      keepReasoning &&
      (block.type === "reasoning" || block.type === "thinking") &&
      typeof block.text === "string"
    ) {
      parts.push({ type: "reasoning", text: block.text });
    }
  }
  return parts;
}

/**
 * ToolResultMessage → one `{type:"tool", tool, callID, state:{output}}` part;
 * multiple text fragments joined with "\n" (Pi `synthesizeToolResultParts`
 * mirror). The tool name resolves from `tool/call` events (or assistant
 * tool-call blocks) by callId; falls back to "unknown".
 */
function toolResultParts(
  message: Record<string, unknown>,
  toolNameByCallId: ReadonlyMap<string, string>,
): unknown[] {
  const content = Array.isArray(message.content) ? message.content : [];
  let callId: string | undefined;
  const source = isRecord(message.source) ? message.source : null;
  if (source && typeof source.callId === "string" && source.callId.length > 0) {
    callId = source.callId;
  }
  if (!callId) {
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === "tool-result" &&
        typeof block.toolCallId === "string" &&
        block.toolCallId.length > 0
      ) {
        callId = block.toolCallId;
        break;
      }
    }
  }
  if (!callId) return [];

  const fragments: string[] = [];
  for (const block of content) {
    // DSH 0.2 (`createToolResultMessage`): the tool message's content is the
    // raw result blocks themselves (`{type:"text"}`), not a `tool-result`
    // wrapper. Without this the transcript saw an EMPTY output for every 0.2
    // tool result (token_count≈0, nothing reclaimable for drops/nudges).
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      fragments.push(block.text);
      continue;
    }
    if (!isRecord(block) || block.type !== "tool-result") continue;
    const inner = block.content;
    if (!Array.isArray(inner)) continue;
    for (const fragment of inner) {
      if (isRecord(fragment) && fragment.type === "text" && typeof fragment.text === "string") {
        fragments.push(fragment.text);
      }
    }
  }
  return [
    {
      type: "tool",
      tool: toolNameByCallId.get(callId) ?? "unknown",
      callID: callId,
      state: { output: fragments.join("\n") },
    },
  ];
}

/* ─────────────────────────── log → RawMessage walk ────────────────────────── */

/**
 * Per-message surface span: which surface node range (indices into
 * `surfaceNodes`) and event seqs a view message covers. A user message that
 * absorbed tool-result nodes covers [firstToolNode .. userNode].
 */
export interface DshMessageSpan {
  readonly nodeStart: number;
  readonly nodeEnd: number;
  readonly seqs: readonly number[];
}

/** Non-enumerable span marker attached to view messages (digest-invisible). */
export const DSH_MESSAGE_SPAN_KEY = "__dshMessageNodeSpan";
/** Non-enumerable knowledge-baseline marker attached to view messages. */
export const DSH_KNOWLEDGE_KEY = "__dshKnowledgeBaseline";
/** Non-enumerable skill-catalog marker attached to view messages. */
export const DSH_SKILL_CATALOG_KEY = "__dshSkillCatalog";
/** Non-enumerable runtime-context marker attached to view messages. */
export const DSH_RUNTIME_CONTEXT_KEY = "__dshRuntimeContext";
/** Non-enumerable current op-copy text attached to rebuilt view messages. */
export const DSH_SURFACE_TEXT_KEY = "__dshSurfaceText";

/** Non-enumerable marker: the view message was rebuilt from op copies only. */
export const DSH_OP_COPY_KEY = "__dshOpCopyBacked";

/** True when every surface node of this view message is a Magic op copy. */
export function isOpCopyBackedMessage(message: RawMessage): boolean {
  return (message as unknown as Record<string, unknown>)[DSH_OP_COPY_KEY] === true;
}

/** The op copy's current text when this view message was rebuilt from one. */
export function currentSurfaceText(message: RawMessage): string | undefined {
  const value = (message as unknown as Record<string, unknown>)[DSH_SURFACE_TEXT_KEY];
  return typeof value === "string" ? value : undefined;
}

/** The surface span of a view message, or null for messages without one. */
export function messageNodeSpan(message: RawMessage): DshMessageSpan | null {
  const span = (message as unknown as Record<string, unknown>)[DSH_MESSAGE_SPAN_KEY];
  return span !== null && typeof span === "object" ? (span as DshMessageSpan) : null;
}

/** True when the view message is a Magic-context knowledge baseline (m0/m1). */
export function isKnowledgeBaselineMessage(message: RawMessage): boolean {
  return (message as unknown as Record<string, unknown>)[DSH_KNOWLEDGE_KEY] === true;
}

/**
 * Round 24c: the view message without the text Magic itself injected.
 *
 * A knowledge-baseline view message (m0/m1 `<session-history>` /
 * `<project-memory>`, the `<ctx-search-hint>`, any `magic-context`-sourced
 * user message) carries Magic's OWN text, which OpenCode/Pi add at transform
 * time only and never store. History consumers (message-history FTS index,
 * historian chunk) must not read it as conversation. Only the message's own
 * text blocks are removed: tool results / a tool-call assistant folded into it
 * stay. Ordinal, id, version and every non-enumerable marker are kept, so
 * compartment ranges and ctx_expand numbering do not move. Other messages are
 * returned as is (same object).
 */
export function withoutInjectedText(message: RawMessage): RawMessage {
  if (!isKnowledgeBaselineMessage(message)) return message;
  const parts = message.parts.filter((part) => {
    if (part === null || typeof part !== "object") return true;
    return TEXT_PART_ORIGIN.get(part)?.sourceId !== message.id;
  });
  if (parts.length === message.parts.length) return message;
  const copy = Object.create(Object.getPrototypeOf(message)) as RawMessage;
  Object.defineProperties(copy, Object.getOwnPropertyDescriptors(message));
  Object.defineProperty(copy, "parts", { value: parts, enumerable: true, configurable: true, writable: true });
  return copy;
}

/** True when the view message is a DSH skill-catalog reminder (dsh-tool-skill). */
export function isSkillCatalogBaselineMessage(message: RawMessage): boolean {
  return (message as unknown as Record<string, unknown>)[DSH_SKILL_CATALOG_KEY] === true;
}

/** True when the view message is a DSH runtime-context snapshot (agent loop). */
export function isRuntimeContextBaselineMessage(message: RawMessage): boolean {
  return (message as unknown as Record<string, unknown>)[DSH_RUNTIME_CONTEXT_KEY] === true;
}

interface DshWalkResult {
  readonly messages: RawMessage[];
  readonly spans: ReadonlyArray<DshMessageSpan | null>;
  readonly knowledgeOrdinals: ReadonlySet<number>;
  readonly skillCatalogOrdinals: ReadonlySet<number>;
  readonly runtimeContextOrdinals: ReadonlySet<number>;
  /** ordinal → current text of the op copy this message was rebuilt from. */
  readonly surfaceTexts: ReadonlyMap<number, string>;
  /** ordinals of messages whose every surface node is an expanded op copy. */
  readonly opCopyOrdinals: ReadonlySet<number>;
  readonly ordinalToSeq: Map<number, number>;
  readonly seqToOrdinal: Map<number, number>;
}

interface WalkEntry {
  readonly event: EventLike;
  /** Surface node index this entry occupies (an op copy's index for its sources). */
  readonly nodeIndex: number;
  /** Live surface seq covering this entry (the op copy's seq for its sources). */
  readonly surfaceSeq: number;
  /** Close any pending fold before this entry (op-copy boundary). */
  boundaryBefore: boolean;
  /** Seq of the op copy this entry was expanded from. */
  readonly copySeq?: number;
}

function uniqueSeqs(seqs: readonly number[]): number[] {
  const out: number[] = [];
  for (const seq of seqs) if (!out.includes(seq)) out.push(seq);
  return out;
}

const MAX_OP_COPY_DEPTH = 64;

/**
 * Source events of a Magic op copy (`source.messageId` = `mc-op:<opId>`,
 * temporal merges excluded — they stay baselines), oldest first, with nested
 * copies expanded. `null` when the event is not an op copy or a source event
 * is missing (then the copy stays a baseline, the pre-round-10 behaviour).
 */
function expandOpCopy(
  event: EventLike,
  eventBySeq: ReadonlyMap<number, EventLike>,
  depth: number,
): EventLike[] | null {
  if (event.type !== "user/message") return null;
  const data = dataOf(event);
  const source = data !== null && isRecord(data.source) ? data.source : null;
  if (source === null || !isMagicSource(source)) return null;
  const messageId = source.messageId;
  if (typeof messageId !== "string" || !messageId.startsWith("mc-op:") || messageId.endsWith(":temporal")) return null;
  const shadowed = (event as { sourceEventSeqs?: unknown }).sourceEventSeqs;
  if (!Array.isArray(shadowed) || shadowed.length === 0 || depth >= MAX_OP_COPY_DEPTH) return null;
  const out: EventLike[] = [];
  for (const seq of [...shadowed].sort((a, b) => Number(a) - Number(b))) {
    const sourceEvent = typeof seq === "number" ? eventBySeq.get(seq) : undefined;
    if (sourceEvent === undefined) return null;
    const nested = expandOpCopy(sourceEvent, eventBySeq, depth + 1);
    if (nested === null) {
      // A non-copy Magic message inside a copy (knowledge, temporal) cannot
      // be rebuilt faithfully: keep the copy as a baseline.
      const nestedData = dataOf(sourceEvent);
      if (nestedData !== null && isRecord(nestedData.source) && isMagicSource(nestedData.source)) return null;
      out.push(sourceEvent);
    } else {
      out.push(...nested);
    }
  }
  return out;
}

/** The single text block of an op copy (what the model currently sees). */
function opCopyText(event: EventLike): string | undefined {
  const data = dataOf(event);
  const content = data !== null && Array.isArray(data.content) ? data.content : [];
  const texts = content.filter((part) => isRecord(part) && part.type === "text").map((part) => String((part as { text?: unknown }).text ?? ""));
  return texts.length === 1 ? texts[0] : undefined;
}

/**
 * Shared walk. With `surfaceNodes` (surface order iteration) it produces the
 * model-visible messages; with null it walks the whole log in seq order (the
 * pure Pi-mirror conversion). Both keep tool-result folding consistent with
 * their own adjacency notion.
 */
function walkDshLog(events: readonly unknown[], surfaceNodes: readonly number[] | null): DshWalkResult {
  const eventBySeq = new Map<number, EventLike>();
  const boundaryAfter = new Set<number>();
  const toolNameByCallId = new Map<string, string>();
  for (const raw of events) {
    const event = asEvent(raw);
    if (!event) continue;
    const seq = seqOf(event);
    if (seq >= 0 && !eventBySeq.has(seq)) eventBySeq.set(seq, event);
    const data = dataOf(event);
    if (event.type === "tool/call" && data) {
      const callId = data.callId;
      const name = data.name;
      if (typeof callId === "string" && callId.length > 0 && typeof name === "string") {
        toolNameByCallId.set(callId, name);
      }
    }
  }

  // Surface walk: a Magic op copy (`mc-op:<opId>` replace written by the
  // coordinator) stands for the events it shadows. It is expanded back into
  // those source events (recursively) so the view keeps the ORIGINAL message
  // ids and parts: core keys (`${id}:pN`, tool owner ids) stay stable, and
  // later drops / cleanup / reasoning ops can still target the message.
  // Pre-round-10 the copy was read as a knowledge baseline, so nothing that
  // was ever tagged could be dropped afterwards (queued drops stayed pending
  // forever). Expanded entries carry the copy's node index / seq (the live
  // surface coverage the coordinator validates), fold boundaries are forced
  // on both sides of a copy (its content is self-contained), and the copy's
  // current text is remembered so an op that would re-render the same text
  // is skipped (deriveMutationPlan).
  const ordered: WalkEntry[] = [];
  const copyText = new Map<number, string>();
  const expandedCopies = new Set<number>();
  if (surfaceNodes !== null) {
    for (let nodeIndex = 0; nodeIndex < surfaceNodes.length; nodeIndex += 1) {
      const surfaceSeq = surfaceNodes[nodeIndex];
      const event = eventBySeq.get(surfaceSeq);
      if (event === undefined) continue;
      const expanded = expandOpCopy(event, eventBySeq, 0);
      if (expanded === null) {
        ordered.push({ event, nodeIndex, surfaceSeq, boundaryBefore: false });
        continue;
      }
      expandedCopies.add(surfaceSeq);
      const text = opCopyText(event);
      if (text !== undefined) copyText.set(surfaceSeq, text);
      expanded.forEach((source, i) => {
        ordered.push({ event: source, nodeIndex, surfaceSeq, boundaryBefore: i === 0, copySeq: surfaceSeq });
      });
      const next = surfaceNodes[nodeIndex + 1];
      if (next !== undefined) boundaryAfter.add(next);
    }
    for (const entry of ordered) if (boundaryAfter.has(entry.surfaceSeq) && entry.copySeq === undefined) entry.boundaryBefore = true;
  } else {
    for (const raw of events) {
      const event = asEvent(raw);
      if (event !== null) ordered.push({ event, nodeIndex: ordered.length, surfaceSeq: seqOf(event), boundaryBefore: false });
    }
  }

  const messages: RawMessage[] = [];
  const spans: Array<DshMessageSpan | null> = [];
  const knowledgeOrdinals = new Set<number>();
  const skillCatalogOrdinals = new Set<number>();
  const runtimeContextOrdinals = new Set<number>();
  const ordinalToSeq = new Map<number, number>();
  const seqToOrdinal = new Map<number, number>();

  let pendingParts: unknown[] = [];
  let pendingSeqs: number[] = [];
  let pendingSurfaceSeqs: number[] = [];
  let pendingStartIndex: number | null = null;
  let pendingFirstId: string | null = null;
  let pendingFirstSeq = -1;
  let pendingFirstTime: number | undefined = undefined;

  // An assistant message carrying tool-call blocks is held back until its
  // tool results arrive: folding the results into the next user message must
  // ALSO fold the tool-call assistant node, otherwise the surface keeps an
  // assistant `tool_calls` block with no following `role=tool` message and
  // the LLM API rejects the sequence (insufficient tool messages).
  let pendingAssistant:
    | { nodeIndex: number; seq: number; surfaceSeq: number; parts: unknown[]; createdAt: number | null; id: string }
    | null = null;

  const resetPending = (): void => {
    pendingParts = [];
    pendingSeqs = [];
    pendingSurfaceSeqs = [];
    pendingStartIndex = null;
    pendingFirstId = null;
    pendingFirstSeq = -1;
    pendingFirstTime = undefined;
    pendingAssistant = null;
  };

  /** Push one assistant message as-is (orphan tool-call / normal path). */
  const pushAssistant = (item: {
    nodeIndex: number;
    seq: number;
    surfaceSeq: number;
    parts: unknown[];
    createdAt: number | null;
    id: string;
  }): void => {
    const ordinal = messages.length + 1;
    messages.push({
      ordinal,
      id: item.id,
      role: "assistant",
      parts: item.parts,
      createdAt: item.createdAt,
      version: item.seq >= 0 ? item.seq : null,
    });
    spans.push(
      surfaceNodes !== null
        ? { nodeStart: item.nodeIndex, nodeEnd: item.nodeIndex + 1, seqs: [item.surfaceSeq] }
        : null,
    );
    ordinalToSeq.set(ordinal, item.seq);
    if (item.seq >= 0) seqToOrdinal.set(item.seq, ordinal);
    if (item.surfaceSeq >= 0) seqToOrdinal.set(item.surfaceSeq, ordinal);
  };

  const flushSynthetic = (): void => {
    if (pendingParts.length === 0 && pendingAssistant === null) return;
    const ordinal = messages.length + 1;
    const seqs = [
      ...(pendingAssistant === null ? [] : [pendingAssistant.seq]),
      ...pendingSeqs,
    ];
    const surfaceSeqs = uniqueSeqs([
      ...(pendingAssistant === null ? [] : [pendingAssistant.surfaceSeq]),
      ...pendingSurfaceSeqs,
    ]);
    const start = Math.min(
      pendingStartIndex ?? Number.POSITIVE_INFINITY,
      pendingAssistant?.nodeIndex ?? Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(start)) throw new Error("fold flush without any covered node");
    messages.push({
      ordinal,
      id: `${SYNTH_USER_ID_PREFIX}${pendingFirstId ?? "tail"}`,
      role: "user",
      parts: [...(pendingAssistant?.parts ?? []), ...pendingParts],
      createdAt: pendingFirstTime ?? null,
      version: pendingFirstSeq >= 0 ? pendingFirstSeq : null,
    });
    spans.push(
      surfaceNodes !== null
        ? { nodeStart: start, nodeEnd: start + surfaceSeqs.length, seqs: surfaceSeqs }
        : null,
    );
    if (pendingFirstSeq >= 0) ordinalToSeq.set(ordinal, pendingFirstSeq);
    for (const s of [...seqs, ...surfaceSeqs]) seqToOrdinal.set(s, ordinal);
    resetPending();
  };

  for (let entryIndex = 0; entryIndex < ordered.length; entryIndex += 1) {
    const entry = ordered[entryIndex];
    const event = entry.event;
    const nodeIndex = entry.nodeIndex;
    const surfaceSeq = entry.surfaceSeq;
    if (entry.boundaryBefore) {
      // Op-copy boundary: close any pending fold (tail orphan / synthetic).
      if (pendingAssistant !== null && pendingParts.length === 0) {
        pushAssistant(pendingAssistant);
        pendingAssistant = null;
      }
      if (pendingParts.length > 0 || pendingAssistant !== null) flushSynthetic();
    }
    const type = event.type;
    if (type !== "user/message" && type !== "assistant/message" && type !== "tool/result") {
      continue; // log-only events (tool/call, turn/*, request/*, ...) — skipped
    }
    const message = deriveEventMessage(event as unknown as SessionEvent);
    if (!message) continue; // e.g. empty-content assistant/message
    const record = message as unknown as Record<string, unknown>;
    const seq = seqOf(event);

    if (type === "assistant/message") {
      if (pendingParts.length > 0) flushSynthetic();
      const parts = assistantParts(record, surfaceNodes !== null, toolNameByCallId);
      const hasToolCalls = parts.some(
        (part) => isRecord(part) && part.type === "tool" && typeof part.callID === "string",
      );
      if (hasToolCalls) {
        // Hold the tool-call assistant until its results arrive; the fold
        // (into the next user / synthetic tail) will include this node.
        pendingAssistant = {
          nodeIndex,
          seq,
          surfaceSeq,
          parts,
          createdAt: timeOf(event) ?? null,
          id: String(message.id),
        };
        continue;
      }
      // Orphan tool-call assistant (no results followed): keep as-is.
      if (pendingAssistant !== null) {
        pushAssistant(pendingAssistant);
        pendingAssistant = null;
      }
      pushAssistant({ nodeIndex, seq, surfaceSeq, parts, createdAt: timeOf(event) ?? null, id: String(message.id) });
      continue;
    }

    if (type === "user/message" && isRuntimeContextMessage(record)) {
      // Runtime-context snapshot: its own baseline message, never a fold
      // target (pending tool results / tool-call assistant flush first, so
      // they keep being tagged and dropped normally).
      if (pendingAssistant !== null && pendingParts.length === 0) {
        pushAssistant(pendingAssistant);
        pendingAssistant = null;
      }
      if (pendingParts.length > 0 || pendingAssistant !== null) flushSynthetic();
      const ordinal = messages.length + 1;
      messages.push({
        ordinal,
        id: String(message.id),
        role: "user",
        parts: userTextParts(record.content, record.id),
        createdAt: timeOf(event) ?? null,
        version: seq >= 0 ? seq : null,
      });
      spans.push(surfaceNodes !== null ? { nodeStart: nodeIndex, nodeEnd: nodeIndex + 1, seqs: [surfaceSeq] } : null);
      ordinalToSeq.set(ordinal, seq);
      if (seq >= 0) seqToOrdinal.set(seq, ordinal);
      if (surfaceSeq >= 0) seqToOrdinal.set(surfaceSeq, ordinal);
      runtimeContextOrdinals.add(ordinal);
      continue;
    }

    if (type === "user/message") {
      // An orphan tool-call assistant (no results) stays as its own message.
      if (pendingAssistant !== null && pendingParts.length === 0) {
        pushAssistant(pendingAssistant);
        pendingAssistant = null;
      }
      const ordinal = messages.length + 1;
      const start =
        surfaceNodes !== null
          ? Math.min(
              pendingStartIndex ?? Number.POSITIVE_INFINITY,
              pendingAssistant?.nodeIndex ?? Number.POSITIVE_INFINITY,
              nodeIndex,
            )
          : nodeIndex;
      const knowledge = isKnowledgeMessage(record);
      const skillCatalog = isSkillCatalogMessage(record);
      messages.push({
        ordinal,
        id: String(message.id),
        role: "user",
        parts: [
          ...(pendingAssistant?.parts ?? []),
          ...pendingParts,
          ...userTextParts(record.content, record.id),
        ],
        createdAt: timeOf(event) ?? null,
        version: seq >= 0 ? seq : null,
      });
      spans.push(
        surfaceNodes !== null
          ? {
              nodeStart: start,
              nodeEnd: nodeIndex + 1,
              seqs: uniqueSeqs([
                ...(pendingAssistant === null ? [] : [pendingAssistant.surfaceSeq]),
                ...pendingSurfaceSeqs,
                surfaceSeq,
              ]),
            }
          : null,
      );
      ordinalToSeq.set(ordinal, seq);
      for (const s of [
        ...(pendingAssistant === null ? [] : [pendingAssistant.seq, pendingAssistant.surfaceSeq]),
        ...pendingSeqs,
        ...pendingSurfaceSeqs,
        seq,
        surfaceSeq,
      ]) {
        seqToOrdinal.set(s, ordinal);
      }
      if (knowledge) knowledgeOrdinals.add(ordinal);
      if (skillCatalog) skillCatalogOrdinals.add(ordinal);
      resetPending();
      continue;
    }

    // tool/result — folded into the next user (or synthetic tail user).
    pendingParts.push(...toolResultParts(record, toolNameByCallId));
    pendingSeqs.push(seq);
    pendingSurfaceSeqs.push(surfaceSeq);
    if (pendingStartIndex === null) pendingStartIndex = nodeIndex;
    if (pendingFirstId === null) pendingFirstId = String(message.id);
    if (pendingFirstSeq < 0) pendingFirstSeq = seq;
    if (pendingFirstTime === undefined) pendingFirstTime = timeOf(event);
  }

  if (pendingAssistant !== null && pendingParts.length === 0) {
    // Tail orphan tool-call assistant (no results) — keep as-is.
    pushAssistant(pendingAssistant);
    pendingAssistant = null;
  }
  if (pendingParts.length > 0 || pendingAssistant !== null) flushSynthetic();
  // A view message rebuilt from exactly one op copy: the copy's current text
  // (what the model sees now) — an op rendering the same text is a no-op.
  const surfaceTexts = new Map<number, string>();
  const opCopyOrdinals = new Set<number>();
  spans.forEach((span, i) => {
    if (span !== null && span.seqs.length > 0 && span.seqs.every((seq) => expandedCopies.has(seq))) {
      opCopyOrdinals.add(messages[i].ordinal);
    }
    if (span === null || span.seqs.length !== 1) return;
    const text = copyText.get(span.seqs[0]);
    if (text !== undefined) surfaceTexts.set(messages[i].ordinal, text);
  });
  return {
    surfaceTexts,
    opCopyOrdinals,
    messages,
    spans,
    knowledgeOrdinals,
    skillCatalogOrdinals,
    runtimeContextOrdinals,
    ordinalToSeq,
    seqToOrdinal,
  };
}

/**
 * Pure conversion of a DSH event log into core `RawMessage[]` (Pi-mirror
 * mapping; see module doc). Ordinals are 1-based and monotonic over message
 * events only; tool-results fold into the following user message; a dangling
 * tool-result tail becomes a synthetic user (`synth-user-` prefix). Assistant
 * thinking is dropped here (the VIEW keeps it for the reasoning stage).
 */
export function convertDshEventsToRawMessages(events: readonly unknown[]): RawMessage[] {
  return walkDshLog(events, null).messages;
}

/**
 * Reversible DSH event seq ↔ ordinal map for a log (or, with `surfaceNodes`,
 * for the surface view). `ordinalToSeq` maps each message to its own event
 * seq (synthetic users map to their first folded tool-result seq);
 * `seqToOrdinal` maps every contributing event seq (tool-result seqs fold
 * into the containing message's ordinal) back to its ordinal.
 */
export function buildDshOrdinalMap(
  events: readonly unknown[],
  surfaceNodes?: readonly number[],
): DshOrdinalMap {
  const walk = walkDshLog(events, surfaceNodes ?? null);
  return { ordinalToSeq: new Map(walk.ordinalToSeq), seqToOrdinal: new Map(walk.seqToOrdinal) };
}

/** Convenience reverse lookup: the DSH event seq that produced `ordinal`. */
export function dshSeqForOrdinal(
  events: readonly unknown[],
  ordinal: number,
  surfaceNodes?: readonly number[],
): number | undefined {
  return buildDshOrdinalMap(events, surfaceNodes).ordinalToSeq.get(ordinal);
}

/** Surface node indices occupied by Magic-context knowledge messages (m0/m1). */
export function findKnowledgeBaselineNodeIndices(
  events: readonly unknown[],
  surfaceNodes: readonly number[],
): number[] {
  const eventBySeq = new Map<number, EventLike>();
  for (const raw of events) {
    const event = asEvent(raw);
    if (!event) continue;
    const seq = seqOf(event);
    if (seq >= 0) eventBySeq.set(seq, event);
  }
  const out: number[] = [];
  surfaceNodes.forEach((seq, index) => {
    const event = eventBySeq.get(seq);
    if (!event || event.type !== "user/message") return;
    const data = dataOf(event);
    if (data && isKnowledgeMessage(data)) out.push(index);
  });
  return out;
}

/* ────────────────────────────────── view ──────────────────────────────────── */

/** Build the read-only transcript view (design §3). */
export function readDshTranscript(input: DshTranscriptInput): DshTranscriptView {
  const events = sessionEvents(input.session);
  const nodes = Array.isArray(input.session.surface?.nodes)
    ? [...input.session.surface.nodes]
    : [];
  const walk = walkDshLog(events, nodes);

  for (let i = 0; i < walk.messages.length; i += 1) {
    const message = walk.messages[i];
    const span = walk.spans[i];
    if (span !== null) {
      Object.defineProperty(message, DSH_MESSAGE_SPAN_KEY, {
        value: span,
        enumerable: false,
        configurable: true,
      });
    }
    if (walk.knowledgeOrdinals.has(message.ordinal)) {
      Object.defineProperty(message, DSH_KNOWLEDGE_KEY, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (walk.skillCatalogOrdinals.has(message.ordinal)) {
      Object.defineProperty(message, DSH_SKILL_CATALOG_KEY, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (walk.runtimeContextOrdinals.has(message.ordinal)) {
      Object.defineProperty(message, DSH_RUNTIME_CONTEXT_KEY, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (walk.opCopyOrdinals.has(message.ordinal)) {
      Object.defineProperty(message, DSH_OP_COPY_KEY, { value: true, enumerable: false, configurable: true });
    }
    const surfaceText = walk.surfaceTexts.get(message.ordinal);
    if (surfaceText !== undefined) {
      Object.defineProperty(message, DSH_SURFACE_TEXT_KEY, {
        value: surfaceText,
        enumerable: false,
        configurable: true,
      });
    }
  }

  return {
    sessionId: input.canonicalSessionId,
    sourceWatermark: maxEventSeq(events),
    inputDigest: sha256Hex(JSON.stringify(walk.messages)).slice(0, 16),
    generation:
      typeof input.session.surface?.replaceGeneration === "number"
        ? input.session.surface.replaceGeneration
        : 0,
    messages: walk.messages,
    surfaceNodes: nodes,
  };
}

/* ─────────────────────────── history (native compaction) ─────────────────── */

/** `source.kind` of the checkpoint message DSH compaction-basic writes. */
export const DSH_COMPACT_CHECKPOINT_KIND = "compact-checkpoint";

/** Surface (model-history) event types; log-only events never become nodes. */
const SURFACE_EVENT_TYPES = new Set([
  "system/message",
  "developer/message",
  "user/message",
  "assistant/message",
  "tool/result",
]);

function isCompactCheckpointEvent(event: EventLike): boolean {
  if (event.type !== "user/message") return false;
  const data = dataOf(event);
  const source = data !== null && isRecord(data.source) ? data.source : null;
  const shadowed = (event as { sourceEventSeqs?: unknown }).sourceEventSeqs;
  return source !== null && source.kind === DSH_COMPACT_CHECKPOINT_KIND && Array.isArray(shadowed) && shadowed.length > 0;
}

function isMagicOpCopyEvent(event: EventLike): boolean {
  if (event.type !== "user/message") return false;
  const data = dataOf(event);
  const source = data !== null && isRecord(data.source) ? data.source : null;
  if (source === null || !isMagicSource(source)) return false;
  const messageId = source.messageId;
  const shadowed = (event as { sourceEventSeqs?: unknown }).sourceEventSeqs;
  return (
    typeof messageId === "string" &&
    messageId.startsWith("mc-op:") &&
    !messageId.endsWith(":temporal") &&
    Array.isArray(shadowed) &&
    shadowed.length > 0
  );
}

/**
 * A surface node that stands for history it replaced: a native compaction
 * checkpoint, or a Magic op copy (transitively) re-rendering one.
 * `[nodeStart, nodeEnd)` indexes the expanded history node list.
 */
export interface DshHistoryStandIn {
  readonly seq: number;
  readonly nodeStart: number;
  readonly nodeEnd: number;
}

/**
 * Round 23: the history node list behind a DSH surface. A native compaction
 * (compaction-basic: `/compact` or the pressure backstop) REPLACES surface
 * nodes with one checkpoint message; the surface view then restarts its
 * ordinals while published compartments keep the old numbering (real rc.5,
 * run 41619627652: `/compact` #2 judged compartments 1–17 "covered" and
 * shadowed the new turn). Core's raw-message contract is the session's
 * HISTORY (OpenCode/Pi keep compacted messages in their store), so every
 * checkpoint is expanded back into the surface nodes it shadowed — recursively,
 * through Magic op copies that re-rendered a checkpoint (tag prefixes) and
 * through earlier checkpoints. Other nodes (op copies included) are kept as-is,
 * so pre-compaction ordinals are reproduced exactly. Unknown seqs are kept.
 */
export function expandCompactionCheckpoints(
  events: readonly unknown[],
  surfaceNodes: readonly number[],
): { readonly nodes: number[]; readonly standIns: DshHistoryStandIn[] } {
  const eventBySeq = new Map<number, EventLike>();
  for (const raw of events) {
    const event = asEvent(raw);
    if (!event) continue;
    const seq = seqOf(event);
    if (seq >= 0 && !eventBySeq.has(seq)) eventBySeq.set(seq, event);
  }
  const containsCheckpoint = new Map<number, boolean>();
  const hasCheckpoint = (seq: number, depth: number): boolean => {
    const cached = containsCheckpoint.get(seq);
    if (cached !== undefined) return cached;
    const event = eventBySeq.get(seq);
    let result = false;
    if (event !== undefined && depth < MAX_OP_COPY_DEPTH) {
      if (isCompactCheckpointEvent(event)) result = true;
      else if (isMagicOpCopyEvent(event)) {
        const sources = (event as { sourceEventSeqs?: unknown[] }).sourceEventSeqs ?? [];
        result = sources.some((s) => typeof s === "number" && hasCheckpoint(s, depth + 1));
      }
    }
    containsCheckpoint.set(seq, result);
    return result;
  };

  const nodes: number[] = [];
  const standIns: DshHistoryStandIn[] = [];
  const visit = (seq: number, depth: number): void => {
    const event = eventBySeq.get(seq);
    if (event === undefined || depth >= MAX_OP_COPY_DEPTH || !hasCheckpoint(seq, depth)) {
      nodes.push(seq);
      return;
    }
    const start = nodes.length;
    const raw = ((event as { sourceEventSeqs?: unknown[] }).sourceEventSeqs ?? []).filter(
      (s): s is number => typeof s === "number",
    );
    // A checkpoint lists its log-only compaction events first, then the
    // shadowed nodes in SURFACE order (keep it: a replaced node sits where the
    // original was). An op copy's sources are ordered by seq (expandOpCopy).
    const sources = isCompactCheckpointEvent(event)
      ? raw.filter((s) => SURFACE_EVENT_TYPES.has(String(eventBySeq.get(s)?.type ?? "")))
      : [...raw].sort((a, b) => a - b);
    for (const source of sources) visit(source, depth + 1);
    standIns.push({ seq, nodeStart: start, nodeEnd: nodes.length });
  };
  for (const seq of surfaceNodes) visit(seq, 0);
  return { nodes, standIns };
}

/** History view: {@link readDshTranscript} over the checkpoint-expanded nodes. */
export interface DshHistoryView extends DshTranscriptView {
  /** Surface stand-ins (checkpoints / their op copies) → the history ordinals they cover. */
  readonly standInOrdinals: ReadonlyMap<number, { readonly first: number; readonly last: number }>;
}

/**
 * Read the session HISTORY (round 23): the transcript view of
 * {@link expandCompactionCheckpoints}' node list. Its ordinals are stable
 * across native compactions and are what compartments, the historian, the
 * summarize hook and the compartment drop queue number against. The context
 * plane keeps using {@link readDshTranscript} (the model-visible surface).
 */
export function readDshHistory(input: DshTranscriptInput): DshHistoryView {
  const events = sessionEvents(input.session);
  const surface = Array.isArray(input.session.surface?.nodes) ? [...input.session.surface.nodes] : [];
  const { nodes, standIns } = expandCompactionCheckpoints(events, surface);
  const view = readDshTranscript({
    ...input,
    // Plain object: a real DSH Session keeps its events behind a prototype
    // method (snapshotEvents) that a spread would drop.
    session: {
      events,
      surface: { nodes, replaceGeneration: input.session.surface?.replaceGeneration ?? 0 },
      header: input.session.header,
    } as unknown as DshTranscriptInput["session"],
  });
  const standInOrdinals = new Map<number, { first: number; last: number }>();
  for (const standIn of standIns) {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const message of view.messages) {
      const span = messageNodeSpan(message);
      if (span === null || span.nodeStart < standIn.nodeStart || span.nodeStart >= standIn.nodeEnd) continue;
      first = Math.min(first, message.ordinal);
      last = Math.max(last, message.ordinal);
    }
    if (Number.isFinite(first)) standInOrdinals.set(standIn.seq, { first, last });
  }
  return { ...view, surfaceNodes: surface, standInOrdinals };
}

function maxEventSeq(events: readonly unknown[]): number {
  let max = 0;
  for (const raw of events) {
    const event = asEvent(raw);
    if (!event) continue;
    const seq = seqOf(event);
    if (seq > max) max = seq;
  }
  return max;
}

/* ─────────────────────────── recording transcript ─────────────────────────── */

/** Canonical dropped placeholder (byte-identical to buildReplacementContent). */
const DROPPED_SENTINEL_PATTERN = /^\[dropped\s+\u00a7\d+\u00a7\]$/;

export type RecordingPartField = "text" | "output" | "input" | "sentinel" | "reasoning";

/** One recorded content change: which part went from what to what. */
export interface MutationRecord {
  /** Index into the owning message's parts; -1 for message-level records (reasoning). */
  readonly partIndex: number;
  readonly field: RecordingPartField;
  readonly from: string;
  readonly to: string;
  /** Tag number the mutation belongs to (reasoning watermark records). */
  readonly tag?: number;
}

function classifyRecordingPart(raw: Record<string, unknown>): TranscriptPartKind {
  switch (raw.type) {
    case "text":
      return "text";
    case "reasoning":
    case "thinking":
      return "thinking";
    case "tool": {
      const state = isRecord(raw.state) ? raw.state : null;
      return state !== null && state.output !== undefined ? "tool_result" : "tool_use";
    }
    case "image":
      return "image";
    default:
      return "unknown";
  }
}

/**
 * Recording TranscriptPart: wraps one RawMessage part, exposes the shared
 * `TranscriptPart` mutation surface, and records every mutation on its
 * owning RecordingMessage instead of changing any source array.
 */
export class RecordingPart implements TranscriptPart {
  readonly kind: TranscriptPartKind;
  readonly id: string | undefined;
  readonly partIndex: number;
  private readonly owner: RecordingMessage;
  private readonly raw: Record<string, unknown>;
  private readonly toolName: string | undefined;
  private readonly callId: string | undefined;
  private payload: string | undefined;
  private input: Record<string, unknown> | null;

  constructor(owner: RecordingMessage, partIndex: number, raw: unknown) {
    this.owner = owner;
    this.partIndex = partIndex;
    this.raw = isRecord(raw) ? raw : {};
    this.kind = classifyRecordingPart(this.raw);
    this.callId = typeof this.raw.callID === "string" ? this.raw.callID : undefined;
    this.toolName = typeof this.raw.tool === "string" ? this.raw.tool : undefined;
    this.id = this.callId;
    this.input = this.readInputState();
    this.payload = this.initPayload();
  }

  private readInputState(): Record<string, unknown> | null {
    if (this.kind !== "tool_use" && this.kind !== "tool_result") return null;
    const state = isRecord(this.raw.state) ? this.raw.state : null;
    return state !== null && isRecord(state.input) ? state.input : null;
  }

  private initPayload(): string | undefined {
    if (this.kind === "text") return typeof this.raw.text === "string" ? this.raw.text : "";
    if (this.kind === "thinking") {
      const text = typeof this.raw.text === "string" ? this.raw.text : undefined;
      return text ?? (typeof this.raw.thinking === "string" ? this.raw.thinking : "");
    }
    if (this.kind === "tool_use") return JSON.stringify(this.input ?? {});
    if (this.kind === "tool_result") {
      const state = isRecord(this.raw.state) ? this.raw.state : null;
      const output = state !== null ? state.output : undefined;
      if (typeof output === "string") return output;
      return output !== undefined ? JSON.stringify(output) : "";
    }
    return "";
  }

  private record(field: RecordingPartField, from: string, to: string, tag?: number): void {
    const record: MutationRecord = {
      partIndex: this.partIndex,
      field,
      from,
      to,
      ...(tag !== undefined ? { tag } : {}),
    };
    this.owner.mutations.push(record);
  }

  getText(): string | undefined {
    return this.payload;
  }

  setText(newText: string): boolean {
    if (newText === this.payload) return false;
    const from = this.payload ?? "";
    this.payload = newText;
    this.record("text", from, newText);
    return true;
  }

  setToolOutput(newText: string): boolean {
    if (newText === this.payload) return false;
    const from = this.payload ?? "";
    this.payload = newText;
    this.record("output", from, newText);
    return true;
  }

  getToolInput(): Record<string, unknown> | null {
    return this.input;
  }

  setToolInput(input: Record<string, unknown>): boolean {
    if (input === this.input) return false;
    const from = JSON.stringify(this.input ?? {});
    this.input = input;
    this.record("input", from, JSON.stringify(input));
    return true;
  }

  getToolMetadata(): {
    toolName: string | undefined;
    inputByteSize: number;
    inputTokenCount: number;
  } {
    if (this.kind === "tool_use" || this.kind === "tool_result") {
      return {
        toolName: this.toolName,
        inputByteSize: byteSize(JSON.stringify(this.input ?? {})),
        inputTokenCount: 0,
      };
    }
    return { toolName: undefined, inputByteSize: 0, inputTokenCount: 0 };
  }

  replaceWithSentinel(sentinelText: string): boolean {
    if (this.payload === sentinelText) return false;
    const from = this.payload ?? "";
    this.payload = sentinelText;
    this.record("sentinel", from, sentinelText);
    return true;
  }

  /** Deterministic text rendering of this part's CURRENT state. */
  render(): string | null {
    if (this.kind === "thinking" || this.kind === "image") return null;
    const payload = this.payload ?? "";
    if (this.kind === "text" || this.kind === "unknown") return payload.length > 0 ? payload : null;
    if (DROPPED_SENTINEL_PATTERN.test(payload)) return payload.length > 0 ? payload : null;
    const head = this.kind === "tool_use" ? "tool" : "tool result";
    const lines = [
      `[${head}: ${this.toolName ?? "tool"}${this.callId ? ` #${this.callId}` : ""}]`,
    ];
    if (this.input) lines.push(`input: ${JSON.stringify(this.input)}`);
    if (this.kind === "tool_result" && payload.length > 0) lines.push(`output:\n${payload}`);
    return lines.join("\n");
  }
}

/**
 * Recording TranscriptMessage: accumulates {@link MutationRecord}s from its
 * parts and coalesces them into one op at plan time.
 */
export class RecordingMessage implements TranscriptMessage {
  readonly info: { id?: string; role: string; sessionId?: string };
  readonly parts: RecordingPart[] = [];
  readonly span: DshMessageSpan | null;
  readonly mutations: MutationRecord[] = [];

  constructor(
    info: { id?: string; role: string; sessionId?: string },
    span: DshMessageSpan | null,
  ) {
    this.info = info;
    this.span = span;
  }

  addPart(raw: unknown): RecordingPart {
    const part = new RecordingPart(this, this.parts.length, raw);
    this.parts.push(part);
    return part;
  }

  isDirty(): boolean {
    return this.mutations.length > 0;
  }

  /** Coalesced op kind: the "worst" of this message's mutations (drops > reasoning > tags). */
  opKind(): MutationKind {
    if (
      this.mutations.some(
        (record) =>
          record.field === "sentinel" ||
          record.field === "output" ||
          record.field === "input" ||
          DROPPED_SENTINEL_PATTERN.test(record.to),
      )
    ) {
      return "drops";
    }
    if (this.mutations.some((record) => record.field === "reasoning")) return "reasoning";
    return "tags";
  }

  /** Deterministic human-readable reason for the coalesced op. */
  reason(): string {
    const parts: string[] = [];
    for (const record of this.mutations) {
      if (record.field === "sentinel") {
        parts.push(`drop → ${record.to}`);
      } else if (record.field === "reasoning") {
        parts.push(`reasoning cleared through tag §${record.tag ?? "?"}§`);
      } else if (record.field === "output" && record.to.includes(PRESSURE_TRUNCATION_MARKER)) {
        parts.push(`pressure truncation ${record.from.length} → ${record.to.length} chars`);
      } else if (/^\u00a7\d+\u00a7/.test(record.to)) {
        const space = record.to.indexOf(" ");
        parts.push(`tag prefix ${space > 0 ? record.to.slice(0, space) : record.to}`);
      } else {
        parts.push(`${record.field} → ${record.to}`);
      }
    }
    return parts.join("; ");
  }

  /** Full Magic-rendered text of this message in its CURRENT (recorded) state. */
  render(): string {
    const out: string[] = [];
    const sentinels = new Set<string>();
    for (const part of this.parts) {
      const value = part.render();
      if (value === null || value.length === 0) continue;
      // A dropped tool arc puts the same `[dropped §N§]` sentinel on its call
      // AND its result part (DSH folds both into one copy): render it once.
      // The parts need not be adjacent: a parallel-call step folds as
      // [call A, call B, result A, result B] (round 17 real rc.5 showed
      // "[dropped §6§] [dropped §7§] [dropped §6§] [dropped §7§]").
      if (DROPPED_SENTINEL_PATTERN.test(value)) {
        if (sentinels.has(value)) continue;
        sentinels.add(value);
      }
      out.push(value);
    }
    return out.join("\n\n");
  }
}

/** Recording Transcript: same shape the shared tagTranscript walks. */
export class RecordingTranscript implements Transcript {
  readonly harness: "opencode" = "opencode";
  readonly messages: RecordingMessage[];

  constructor(messages: RecordingMessage[]) {
    this.messages = messages;
  }

  /** Recording never mutates source arrays; nothing to commit. */
  commit(): void {}
}

/**
 * Recording TagTarget (design §9.3): implements the core TagTarget interface
 * by delegating to the shared tagTranscript-built target. The shared target
 * calls our RecordingParts, so every setContent/drop/truncate/editMarker
 * lands as MutationRecords on the affected messages instead of changing any
 * source array. One tag → one target; per-message records are coalesced into
 * one replace op at plan time.
 */
export class RecordingTagTarget implements TagTarget {
  constructor(
    readonly tagId: number,
    private readonly inner: TagTarget,
  ) {}

  setContent(content: string): boolean {
    return this.inner.setContent(content);
  }

  getContent(): string | null {
    return this.inner.getContent?.() ?? null;
  }

  drop(): ToolDropResult {
    return this.inner.drop?.() ?? "absent";
  }

  truncate(): ToolDropResult {
    return this.inner.truncate?.() ?? "absent";
  }

  editMarker(): ToolDropResult {
    return this.inner.editMarker?.() ?? "absent";
  }

  canDrop(): boolean {
    return this.inner.canDrop?.() ?? false;
  }

  readInput(): Record<string, unknown> | null {
    return this.inner.readInput?.() ?? null;
  }

  get message(): MessageLike | undefined {
    return this.inner.message;
  }
}

/* ────────────────────────────── plan derivation ───────────────────────────── */

function buildRecordingTranscript(
  view: DshTranscriptView,
): {
  transcript: RecordingTranscript;
  byMessageId: Map<string, RecordingMessage>;
  rawByRecording: Map<RecordingMessage, RawMessage>;
} {
  const messages: RecordingMessage[] = [];
  const byMessageId = new Map<string, RecordingMessage>();
  const rawByRecording = new Map<RecordingMessage, RawMessage>();
  for (const raw of view.messages) {
    // Knowledge-baseline (m0/m1) messages stay out of the tag/drop pipeline:
    // the coordinator's surface replace would give them a NEW event id each
    // pass, so tag numbers (and §N§ prefixes) would churn forever — the
    // replay invariant (design §3) would break. They remain in the view
    // (digest + cache classification) but never produce ops.
    //
    // Skill-catalog reminders (dsh-tool-skill) get the same protection: the
    // catalog's digest must stay visible to the session surface unchanged or
    // catalogHistory() cannot find the published digest and dsh-tool-skill
    // re-injects the <system-reminder> on every pre-step. Tagging/prefixing
    // them would force a surface replace each round (new seq), breaking the
    // visible-digest invariant and causing the per-round catalog loop.
    if (isKnowledgeBaselineMessage(raw)) continue;
    if (isSkillCatalogBaselineMessage(raw)) continue;
    if (isRuntimeContextBaselineMessage(raw)) continue;
    const message = new RecordingMessage(
      { id: raw.id, role: raw.role, sessionId: view.sessionId },
      messageNodeSpan(raw),
    );
    for (const part of raw.parts) message.addPart(part);
    messages.push(message);
    rawByRecording.set(message, raw);
    if (typeof raw.id === "string") byMessageId.set(raw.id, message);
  }
  return { transcript: new RecordingTranscript(messages), byMessageId, rawByRecording };
}

/**
 * Text ordinals a NEW plain user message would inherit from the view's tail.
 *
 * When the view ends in a synthetic tail (`synth-user-…`: tool results, and
 * their tool-call assistant, with no closing user message yet), the next
 * `user/message` appended to the log absorbs those parts (walkDshLog fold):
 * its own text blocks then start at `:p${n}`, where `n` is the number of
 * text parts in that tail (the tool-call assistant's text; tool parts are not
 * text). Returns 0 when the view does not end in a synthetic tail.
 */
export function pendingFoldTextCount(view: DshTranscriptView): number {
  const last = view.messages[view.messages.length - 1];
  if (last === undefined || !isSyntheticUserMessage(last) || isOpCopyBackedMessage(last)) return 0;
  let n = 0;
  for (const part of last.parts) if (isRecord(part) && classifyRecordingPart(part) === "text") n += 1;
  return n;
}

/** True when the view ends in a synthetic tail (pending tool results). */
export function endsInPendingFold(view: DshTranscriptView): boolean {
  const last = view.messages[view.messages.length - 1];
  // A synthetic tail rebuilt from an op copy is closed (copy boundary): the
  // next user message does not absorb it.
  return last !== undefined && isSyntheticUserMessage(last) && !isOpCopyBackedMessage(last);
}

/**
 * The core text tag key of every taggable source text block in the view:
 * `sourceMessageId → (textBlockIndex → "${viewMessageId}:p${textOrdinal}")`.
 *
 * This is exactly the contentId `tagTranscript` (core) passes to the tagger
 * for that text (positional `:pN` over the VIEW message's text parts, after
 * folding), and the same knowledge-baseline / skill-catalog exclusions as
 * {@link buildRecordingTranscript}. Callers that show a §N§ number outside
 * the plan (the first-call payload preview) must look tags up under these keys
 * — never under the bare source id, which core never uses for text and which
 * would allocate a second, different tag number for the same message.
 */
export function textTagContentIdsBySource(
  view: DshTranscriptView,
): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  for (const raw of view.messages) {
    if (isKnowledgeBaselineMessage(raw)) continue;
    if (isSkillCatalogBaselineMessage(raw)) continue;
    if (isRuntimeContextBaselineMessage(raw)) continue;
    if (typeof raw.id !== "string" || raw.id.length === 0) continue;
    let textOrdinal = 0;
    for (const part of raw.parts) {
      if (!isRecord(part) || classifyRecordingPart(part) !== "text") continue;
      const origin = TEXT_PART_ORIGIN.get(part);
      if (origin !== undefined) {
        let byBlock = out.get(origin.sourceId);
        if (byBlock === undefined) {
          byBlock = new Map();
          out.set(origin.sourceId, byBlock);
        }
        byBlock.set(origin.blockIndex, `${raw.id}:p${textOrdinal}`);
      }
      textOrdinal += 1;
    }
  }
  return out;
}

/**
 * Temporary cache classification (design §6 stand-in). Rules:
 *   - pure tail append (insertion at/after the last surface node) → soft-plus;
 *   - a replace covering a knowledge-baseline node (m0/m1) → hard;
 *   - everything else → soft.
 * The cache-classification slice owns the official `classifyPlan`; this is
 * replaced at integration.
 */
export function minimalCacheClassForOp(
  range: { readonly start: number; readonly end: number },
  surfaceNodeCount: number,
  baselineNodeIndices: readonly number[] = [],
): CacheClass {
  if (range.start >= surfaceNodeCount) return "soft-plus";
  for (let i = range.start; i < range.end; i += 1) {
    if (baselineNodeIndices.includes(i)) return "hard";
  }
  return "soft";
}

function baselineNodeIndices(view: DshTranscriptView): number[] {
  const out: number[] = [];
  for (const message of view.messages) {
    if (!isKnowledgeBaselineMessage(message)) continue;
    const span = messageNodeSpan(message);
    if (span !== null) out.push(span.nodeStart);
  }
  return out;
}

/**
 * Stage 1: temporal gap markers (design §9.10.1). Idempotent: skipped when
 * the user message already carries a marker prefix or the immediately
 * preceding message IS a marker message. Produces "insertion" ops with
 * start === end === insertion point (the user message's node span start) and
 * empty shadowedSeqs. NOTE for the coordinator slice: the DSH surface has no
 * pure-insert surface op, so insertion ops must be merged into an adjacent
 * replace (or appended at the tail) at apply time.
 */
function planTemporalMarkers(view: DshTranscriptView): MutationOp[] {
  const ops: MutationOp[] = [];
  const baseline = baselineNodeIndices(view);
  let prev: RawMessage | null = null;
  for (const message of view.messages) {
    const isGapEligibleUser =
      message.role === "user" &&
      !isKnowledgeBaselineMessage(message) &&
      !isSkillCatalogBaselineMessage(message) &&
      !isSyntheticUserMessage(message);
    if (isGapEligibleUser && prev !== null) {
      const prevTime = typeof prev.createdAt === "number" ? prev.createdAt : null;
      const currTime = typeof message.createdAt === "number" ? message.createdAt : null;
      if (prevTime !== null && currTime !== null) {
        const gapSeconds = Math.floor((currTime - prevTime) / 1000);
        const marker = temporalMarkerPrefix(gapSeconds);
        if (marker !== null && !hasTemporalMarker(message) && !isTemporalMarkerMessage(prev)) {
          const span = messageNodeSpan(message);
          if (span !== null) {
            ops.push({
              kind: "temporal",
              start: span.nodeStart,
              end: span.nodeStart,
              replacement: marker,
              cacheClass: minimalCacheClassForOp(
                { start: span.nodeStart, end: span.nodeStart },
                view.surfaceNodes.length,
                baseline,
              ),
              reason: `temporal gap ${formatGap(gapSeconds) ?? "?"}`,
              shadowedSeqs: [],
            });
          }
        }
      }
    }
    if (!isKnowledgeBaselineMessage(message) && !isSkillCatalogBaselineMessage(message)) {
      prev = message;
    }
  }
  return ops;
}

function hasTemporalMarker(message: RawMessage): boolean {
  for (const part of message.parts) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    return TEMPORAL_MARKER_PATTERN.test(peelLeadingMcTagNotation(part.text).body);
  }
  return false;
}

/** True when every non-empty text part of the message is a temporal marker. */
function isTemporalMarkerMessage(message: RawMessage): boolean {
  let sawMarker = false;
  for (const part of message.parts) {
    if (!isRecord(part) || part.type !== "text") continue;
    const text = typeof part.text === "string" ? part.text : "";
    if (text.trim().length === 0) continue;
    if (TEMPORAL_MARKER_PATTERN.test(peelLeadingMcTagNotation(text).body)) {
      sawMarker = true;
    } else {
      return false;
    }
  }
  return sawMarker;
}

/**
 * Stage 5: reasoning replay (design §9.10.7, Pi `replayClearedReasoning`
 * mirror). For assistant messages whose max tag number is at or below the
 * `clearedReasoningThroughTag` watermark and whose content still carries
 * reasoning blocks, record a reasoning mutation — the message's replacement
 * render then excludes the reasoning. Minimal deterministic version; the
 * watermark-advancing clear pass and inline `<thinking>` stripping land in
 * Phase 4 (the coordinator owns pass type).
 */
function planReasoningReplay(
  view: DshTranscriptView,
  byMessageId: ReadonlyMap<string, RecordingMessage>,
  targets: ReadonlyMap<number, TagTarget>,
  db: Database,
): void {
  const meta = getOrCreateSessionMeta(db, view.sessionId);
  const watermark = typeof meta.clearedReasoningThroughTag === "number" ? meta.clearedReasoningThroughTag : 0;
  if (watermark <= 0) return;

  const maxTagById = new Map<string, number>();
  for (const [tagId, target] of targets) {
    const id = target.message?.info?.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const prev = maxTagById.get(id) ?? 0;
    if (tagId > prev) maxTagById.set(id, tagId);
  }

  for (const message of view.messages) {
    if (message.role !== "assistant" || typeof message.id !== "string") continue;
    const msgTag = maxTagById.get(message.id) ?? 0;
    if (msgTag === 0 || msgTag > watermark) continue;
    const reasoningTexts: string[] = [];
    for (const part of message.parts) {
      if (!isRecord(part)) continue;
      const type = part.type;
      if (type !== "reasoning" && type !== "thinking") continue;
      const text =
        typeof part.text === "string"
          ? part.text
          : typeof part.thinking === "string"
            ? part.thinking
            : "";
      if (text.length > 0 && text !== "[cleared]") reasoningTexts.push(text);
    }
    if (reasoningTexts.length === 0) continue;
    const recording = byMessageId.get(message.id);
    if (!recording) continue;
    recording.mutations.push({
      partIndex: -1,
      field: "reasoning",
      from: reasoningTexts.join("\n"),
      to: "[cleared]",
      tag: msgTag,
    });
  }
}

/**
 * Derive a MutationPlan from the view + shared DB state (design §3).
 *
 * Pipeline (this slice: stages 1-5 of §9.10, all through the recording
 * layer — the view's messages are never mutated):
 *   1. temporal gap markers (idempotent insertion ops);
 *   2. tagTranscript (shared; §N§ prefix injections recorded on parts);
 *   3. applyPendingOperations (shared, recording TagTargets, preloaded reads);
 *   4. applyFlushedStatuses (every pass; byte-level drop replay);
 *   5. reasoning replay from the clearedReasoningThroughTag watermark.
 *
 * Determinism: the view is immutable, so re-deriving from the same log +
 * DB state yields byte-identical ops (replay invariant). Returns null when
 * nothing changed.
 */
export function deriveMutationPlan(view: DshTranscriptView, ctx: PlanContext): MutationPlan | null {
  const db = ctx.db;
  const sessionId = view.sessionId;

  const ops: MutationOp[] = [...planTemporalMarkers(view)];

  const { transcript, byMessageId, rawByRecording } = buildRecordingTranscript(view);
  if (transcript.messages.length > 0) {
    const tagger = createTagger();
    tagger.initFromDb(sessionId, db);
    const tagged = tagTranscript(sessionId, transcript, tagger, db);

    // Wrap the shared targets: recording targets delegate to them, and the
    // shared targets call our recording parts — every mutation is recorded.
    const recordingTargets = new Map<number, TagTarget>();
    for (const [tagId, target] of tagged.targets) {
      recordingTargets.set(tagId, new RecordingTagTarget(tagId, target));
    }

    // Preloaded reads: avoid re-reading tags/pending ops inside the shared
    // stages (the transaction body reads them otherwise).
    const preloadedTags = getTagsBySession(db, sessionId);
    const preloadedPendingOps = getPendingOps(db, sessionId);
    // Core token-floor window (persisted tool-row mass vs the epoch floor).
    const protection = tokenProtectionWindow(db, sessionId, ctx.protection ?? {});
    applyPendingOperations(
      sessionId,
      db,
      recordingTargets,
      protection.protectedTagNumbers,
      preloadedTags,
      preloadedPendingOps,
    );
    applyFlushedStatuses(sessionId, db, recordingTargets, preloadedTags);

    // Heuristic cleanup (Pi/OpenCode parity): routine dedup + optional caveman
    // text compression. Mutations go through the recording targets → dirty →
    // ops, so the surface CAS pipeline handles them exactly like drops.
    const cleanupCfg = ctx.heuristicCleanup;
    if (cleanupCfg !== undefined) {
      try {
        const messageTagNumbers = new Map<MessageLike, number>();
        for (const [tagId, target] of recordingTargets) {
          const message = target.message;
          if (message !== undefined) messageTagNumbers.set(message, tagId);
        }
        applyHeuristicCleanup(
          sessionId,
          db,
          recordingTargets,
          messageTagNumbers,
          {
            protectedTagNumbers: protection.protectedTagNumbers,
            protectedCutoff: protection.protectedCutoff,
            caveman: cleanupCfg.caveman,
          },
          preloadedTags,
        );
      } catch {
        // Cleanup must never break the pre-step chain (fail-open).
      }
    }

    // Pressure truncation: replay persisted head/tail truncations of active
    // tool results, then (force band, latch permitting) decide one batch.
    // After drops/cleanup so a dropped tag is never truncated (drop wins).
    try {
      const resultParts = new Map<string, RecordingPart>();
      for (const message of transcript.messages) {
        for (const part of message.parts) {
          if (part.kind === "tool_result" && part.id !== undefined && !resultParts.has(part.id)) {
            resultParts.set(part.id, part);
          }
        }
      }
      const candidates: TruncationCandidate[] = [];
      for (const tag of getTagsBySession(db, sessionId)) {
        if (tag.type !== "tool" || tag.status !== "active") continue;
        const part = tag.messageId ? resultParts.get(tag.messageId) : undefined;
        if (part !== undefined) candidates.push({ tagNumber: tag.tagNumber, part });
      }
      applyPressureTruncation(db, sessionId, candidates, ctx.pressureTruncation, ctx.log);
    } catch (error) {
      ctx.log?.(
        `[magic-context] pressure truncation failed (fail-open): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    planReasoningReplay(view, byMessageId, recordingTargets, db);

    const baseline = baselineNodeIndices(view);
    for (const message of transcript.messages) {
      if (!message.isDirty()) continue;
      const span = message.span;
      if (span === null || span.seqs.length === 0) continue; // no surface coverage
      const replacement = message.render();
      // Rebuilt from an op copy that already shows exactly this text: the
      // surface is current, no replace (no cache bust, no new event).
      const raw = rawByRecording.get(message);
      if (raw !== undefined && currentSurfaceText(raw) === replacement) continue;
      ops.push({
        kind: message.opKind(),
        start: span.nodeStart,
        end: span.nodeEnd,
        replacement,
        cacheClass: minimalCacheClassForOp(
          { start: span.nodeStart, end: span.nodeEnd },
          view.surfaceNodes.length,
          baseline,
        ),
        reason: message.reason(),
        shadowedSeqs: [...span.seqs],
      });
    }
  }

  if (ops.length === 0) return null;
  ops.sort((left, right) => left.start - right.start || left.end - right.end);
  return {
    opId: randomUUID(),
    sessionId: view.sessionId,
    sourceWatermark: view.sourceWatermark,
    inputDigest: view.inputDigest,
    generation: view.generation,
    ops,
  };
}
