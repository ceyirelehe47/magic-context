/**
 * compat/dsh-0.1/session — DSH session & surface seams.
 *
 * Encapsulates every `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-llm`
 * vocabulary the Magic adapter touches: message factories, append semantics,
 * the surface-replace CAS transaction, and replay helpers. DSH upgrades touch
 * ONLY this directory (PLAN §2).
 */
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  isAgentLoopRequest,
  type ContentBlock,
  type Message,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import {
  Session,
  SessionSeq,
  type SessionEvent,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import {
  deriveEventMessage,
  foldSurface,
} from "@deepseek-ai/dsh-session/surface";
import TokenMeter from "@deepseek-ai/dsh-token-meter";

export {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  isAgentLoopRequest,
  deriveEventMessage,
  foldSurface,
  Session,
};
export type { Message, SessionEvent, SessionId, UserMessage };

/** Text block shorthand. */
export function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/** Message-source kind Magic registers in DSH's merge-extensible `MessageSourceMap`. */
export const MAGIC_SOURCE_KIND = "magic-context" as const;

/**
 * Source marker for Magic-injected knowledge messages (m0 baseline / m1 deltas).
 *
 * DSH 0.2 removed the shared catch-all `kind: "plugin"`; every producer now
 * declares its own kind via module augmentation of `MessageSourceMap`. We keep
 * the `plugin` field so persisted sources stay self-describing, and
 * {@link isMagicSource} still recognises sessions written by DSH 0.1
 * (`{ kind: "plugin", plugin: "magic-context" }`).
 */
export interface MagicMessageSource {
  kind: typeof MAGIC_SOURCE_KIND;
  plugin: "magic-context";
  /** Baseline id for watermark de-duplication (PLAN §4.1). */
  messageId?: string;
  /** Render revision (materialization epoch) folded into the watermark. */
  revision?: string;
  /** Content digest (m0+m1) folded into the watermark. */
  digest?: string;
}

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "magic-context": MagicMessageSource;
  }
}

/** Build a Magic message source (kind `magic-context`). */
export function magicSource(
  extra: Omit<Partial<MagicMessageSource>, "kind" | "plugin"> = {},
): MagicMessageSource {
  return { kind: MAGIC_SOURCE_KIND, plugin: "magic-context", ...extra };
}

/**
 * True for a Magic-produced message source: the DSH 0.2 `magic-context` kind,
 * or the legacy DSH 0.1 `{ kind: "plugin", plugin: "magic-context" }` shape
 * still present in older persisted sessions.
 */
export function isMagicSource(source: unknown): source is MagicMessageSource {
  if (!source || typeof source !== "object") return false;
  const s = source as { kind?: unknown; plugin?: unknown };
  if (s.kind === MAGIC_SOURCE_KIND) return true;
  return s.kind === "plugin" && s.plugin === "magic-context";
}

/**
 * All events of a session's log, oldest first.
 *
 * DSH 0.2 removed the public `Session.events` array; the log is read through
 * `snapshotEvents()` / `eventAt()`. Every adapter read of the event log MUST go
 * through these helpers — the old `(session as {events?}).events ?? []` idiom
 * compiles but silently yields an empty log on DSH 0.2.
 */
export function sessionEvents(session: unknown): readonly SessionEvent[] {
  if (!session || typeof session !== "object") return [];
  const s = session as {
    snapshotEvents?: () => readonly SessionEvent[];
    events?: readonly SessionEvent[];
  };
  if (typeof s.snapshotEvents === "function") return s.snapshotEvents();
  // Test doubles / DSH 0.1 shape.
  return Array.isArray(s.events) ? s.events : [];
}

/** The event at an exact seq, or undefined. See {@link sessionEvents}. */
export function sessionEventAt(
  session: unknown,
  seq: number,
): SessionEvent | undefined {
  if (!session || typeof session !== "object") return undefined;
  const s = session as {
    eventAt?: (seq: SessionSeq) => SessionEvent | undefined;
    events?: readonly SessionEvent[];
  };
  if (typeof s.eventAt === "function") return s.eventAt(SessionSeq(seq));
  return Array.isArray(s.events) ? s.events[seq] : undefined;
}

/**
 * Prompt size of ONE model call from DSH `TokenUsage`.
 *
 * DSH 0.2 reports mutually exclusive counters: `inputTokens` EXCLUDES cached
 * prompt tokens, so the context pressure of a call is
 * `inputTokens + cacheReadTokens + cacheWriteTokens` of the LAST call. (Never
 * sum across calls — each call re-sends the whole prompt.)
 */
export function promptTokensOf(usage: unknown): number | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as { inputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown };
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  if (typeof u.inputTokens !== "number" || !Number.isFinite(u.inputTokens)) return undefined;
  return n(u.inputTokens) + n(u.cacheReadTokens) + n(u.cacheWriteTokens);
}

/** Create a Magic-owned user message (knowledge injection / checkpoints). */
export function magicUserMessage(
  content: string,
  source: MagicMessageSource,
  extraBlocks: readonly ContentBlock[] = [],
): UserMessage {
  return createUserMessage({
    content: [textBlock(content), ...extraBlocks],
    source,
  });
}

/** Append a user-role surface message and return its seq. */
export function appendMessage(
  session: Session,
  message: UserMessage,
): number {
  return session.append("user/message", message, { surfaceOp: "append" }).seq;
}

/**
 * Surface-replace transaction (the CAS primitive): replace `[start..end]` with
 * one checkpoint message; `sourceEventSeqs` MUST cover every shadowed node.
 * Returns the new surface generation.
 */
export function replaceSurfaceRange(
  session: Session,
  start: number,
  end: number,
  message: UserMessage,
  sourceEventSeqs: readonly number[],
): number {
  const event = session.append("user/message", message, {
    surfaceOp: {
      op: "replace",
      startSeq: SessionSeq(start),
      endSeq: SessionSeq(end),
    },
    sourceEventSeqs: sourceEventSeqs.map((seq) => SessionSeq(seq)),
  });
  return event.seq;
}

/** Current surface nodes (model-visible order). */
export function surfaceNodes(session: Session): readonly number[] {
  return session.surface.nodes;
}

/** Current surface generation (CAS guard). */
export function surfaceGeneration(session: Session): number {
  return session.surface.replaceGeneration;
}

/* ───────────── round 36 line G (plan N): native per-node rewrites ───────────── */

/**
 * Price of one model-visible message under DSH token-meter's FIXED heuristic
 * (`estimateMessage`, the estimator the meter prices appends with). The
 * `compaction/prune` shadow price must use it, or the meter's O(1) fold
 * drifts. Fallback (meter package absent): 4 chars/token over the JSON.
 */
export function meterEstimateMessage(message: unknown): number {
  try {
    const proto = (TokenMeter as unknown as { prototype?: { estimateMessage?: (m: unknown) => unknown } }).prototype;
    const value = proto?.estimateMessage?.call(undefined, message);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  } catch {
    // fall through
  }
  return Math.ceil(JSON.stringify(message ?? null).length / 4);
}

/**
 * Append the `compaction/prune` shadow-price event for ONE surface node. It
 * must be immediately followed by the replace of exactly that node (the
 * token-meter consumes the claim on the very next event).
 */
export function appendNodePrune(session: Session, seq: number): void {
  const event = sessionEventAt(session, seq);
  if (event === undefined) throw new Error(`magic-context: prune of missing event seq ${seq}`);
  const message = deriveEventMessage(event);
  (session.append as unknown as (type: string, data: unknown) => unknown).call(
    session,
    "compaction/prune",
    {
      shadowedRange: { start: SessionSeq(seq), end: SessionSeq(seq) },
      shadowedSeqs: [SessionSeq(seq)],
      shadowedTokenCount: message === null ? 0 : meterEstimateMessage(message),
    },
  );
}

/**
 * Plan N: replace the CONTENT of one current `tool/result` node in place
 * (DSH `assertToolResultRewrite`: exactly one current tool/result node, data
 * deep-equal except `message.content` — callId, isError, turn and step are
 * kept, so the assistant `tool_calls` pairing is untouched). The first text
 * block takes `text`, later text blocks are removed (the view joins them with
 * "\n"), non-text blocks stay. Preceded by the node's `compaction/prune`.
 * Returns the replacement's seq.
 */
export function replaceToolResultContent(session: Session, seq: number, text: string): number {
  const event = sessionEventAt(session, seq) as unknown as
    | { type: string; data: { message: { content?: unknown } } & Record<string, unknown> }
    | undefined;
  if (event?.type !== "tool/result") throw new Error(`magic-context: seq ${seq} is not a tool/result node`);
  const original = Array.isArray(event.data.message.content) ? (event.data.message.content as unknown[]) : [];
  if (original.some((b) => b !== null && typeof b === "object" && (b as { type?: unknown }).type === "tool-result")) {
    throw new Error(`magic-context: seq ${seq} carries a legacy tool-result wrapper; native rewrite refused`);
  }
  const content: unknown[] = [];
  let placed = false;
  for (const block of original) {
    const isText = block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text";
    if (!isText) {
      content.push(block);
      continue;
    }
    if (placed) continue;
    content.push({ ...(block as object), text });
    placed = true;
  }
  if (!placed) content.unshift(textBlock(text));
  appendNodePrune(session, seq);
  return session.append(
    "tool/result",
    { ...event.data, message: { ...event.data.message, content } } as never,
    {
      surfaceOp: { op: "replace", startSeq: SessionSeq(seq), endSeq: SessionSeq(seq) },
      sourceEventSeqs: [SessionSeq(seq)],
    },
  ).seq;
}

/**
 * Plan N: replace one current `user/message` node with a Magic copy, preceded
 * by the node's `compaction/prune`. Returns the replacement's seq.
 */
export function replaceUserNode(session: Session, seq: number, message: UserMessage): number {
  appendNodePrune(session, seq);
  return replaceSurfaceRange(session, seq, seq, message, [seq]);
}
