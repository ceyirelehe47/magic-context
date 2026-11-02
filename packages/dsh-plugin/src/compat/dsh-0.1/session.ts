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
