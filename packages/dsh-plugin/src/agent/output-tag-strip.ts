/**
 * agent/output-tag-strip — persistence-boundary strip of Magic `§N§` notation
 * from assistant text on DSH (upstream parity).
 *
 * Magic prefixes every model-visible message with `§N§ `. Models mimic it and
 * open their own replies with `§N§ …`. Upstream strips that notation where the
 * assistant text is persisted: OpenCode `experimental.text.complete`
 * (core `hooks/magic-context/text-complete.ts` → `stripPersistedAssistantText`)
 * and Pi `message_end` (`stripTagPrefixFromAssistantMessage`); the transform
 * re-adds the authoritative tag from DB state on the next pass. DSH had no
 * such boundary, so the copied prefix reached the user verbatim (headless
 * `text` / `final` frames, the web transcript, the persisted
 * `assistant/message`) — round 17 e2e C5.
 *
 * DSH has no "assistant text completed" rewrite hook: the session log is
 * append-only and `agent/request` cannot touch messages. The one seam that
 * sees the text before the loop assembles and persists it is the `llm/stream`
 * waterfall around every model call (dsh-llm). This module wraps the chunk
 * stream of agent-loop requests that carry Magic tags:
 *
 *   - `text-delta` chunks pass through a per-block streaming filter that drops
 *     every complete `§<digits>§` pair (and, at the start of the block, the
 *     whitespace that follows a dropped prefix). Only a `§` whose pair is not
 *     yet decided is held back (at most `§` + digits), so streaming stays live.
 *   - the text `block-end` carries exactly the filtered text (the loop builds
 *     the persisted `assistant/message` from the assembled blocks).
 *
 * Scope: only requests built by the agent loop (`isAgentLoopRequest`) whose
 * messages already carry a Magic `§N§ ` prefix — i.e. sessions Magic tags.
 * Hand-built calls (historian, compaction summaries, recomp), children and
 * Magic-disabled presets see untagged context and are never touched.
 * Reasoning deltas and tool-call arguments are never rewritten.
 *
 * Divergence from `stripPersistedAssistantText` (documented): a stray `§`
 * that is not part of a `§digits§` pair (e.g. legal "§ 5", "§5.1") is kept;
 * upstream also drops stray `§` and malformed hybrids. Keeping it costs
 * nothing here (the transform layer strips leading notation on re-tag) and
 * never eats legitimate text.
 */

type Chunk =
  | { type: "text-delta"; index: number; text: string }
  | { type: "block-end"; index: number; block: { type?: unknown; text?: unknown } & Record<string, unknown> }
  | { type: string; index?: number; [key: string]: unknown };

const TAG_PREFIX_RE = /^\s*§\d+§/;

/** Does any message of the request start a text part with a Magic `§N§` tag? */
export function requestCarriesMagicTags(messages: readonly unknown[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = (messages[i] as { content?: unknown } | null)?.content;
    if (typeof content === "string") {
      if (TAG_PREFIX_RE.test(content)) return true;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = (part as { type?: unknown; text?: unknown } | null)?.text;
      if ((part as { type?: unknown } | null)?.type === "text" && typeof text === "string" && TAG_PREFIX_RE.test(text)) {
        return true;
      }
    }
  }
  return false;
}

/** Streaming `§digits§` remover for one text block. */
export class TagNotationFilter {
  private pending = "";
  /** Nothing but whitespace emitted (or held) so far in this block. */
  private atStart = true;
  /** A prefix pair was dropped at block start: drop the whitespace after it. */
  private dropWhitespace = false;
  private leadingWhitespace = "";
  private emitted = "";

  /** Feed one delta; returns the text safe to emit now. */
  push(text: string): string {
    this.pending += text;
    return this.drain(false);
  }

  /** End of block: release anything held; returns the final piece. */
  flush(): string {
    return this.drain(true);
  }

  /** Everything emitted for this block so far. */
  get text(): string {
    return this.emitted;
  }

  private drain(final: boolean): string {
    let out = "";
    const emit = (piece: string) => {
      if (piece.length === 0) return;
      if (this.atStart || this.dropWhitespace) {
        // Leading whitespace is decided by what follows it: dropped after a
        // stripped prefix, released before ordinary text.
        const m = /^\s*/.exec(piece)![0];
        if (m.length === piece.length) {
          if (!this.dropWhitespace) this.leadingWhitespace += piece;
          return;
        }
        if (!this.dropWhitespace) out += this.leadingWhitespace;
        this.leadingWhitespace = "";
        piece = this.dropWhitespace ? piece.slice(m.length) : piece;
        this.atStart = false;
        this.dropWhitespace = false;
      }
      out += piece;
    };
    for (;;) {
      const at = this.pending.indexOf("§");
      if (at < 0) {
        emit(this.pending);
        this.pending = "";
        break;
      }
      emit(this.pending.slice(0, at));
      this.pending = this.pending.slice(at);
      const m = /^§(\d*)(§?)/.exec(this.pending)!;
      const reachedEnd = m[0].length === this.pending.length;
      if (m[2] === "§" && m[1].length > 0) {
        // Complete pair: drop it.
        this.pending = this.pending.slice(m[0].length);
        if (this.atStart) this.dropWhitespace = true;
        continue;
      }
      if (reachedEnd && !final && m[2] === "") {
        // `§` or `§12` at the end of what we have: undecided, hold it.
        break;
      }
      // Not a pair (`§x`, `§12x`, `§§`, or end of block): keep the `§` literally.
      emit("§");
      this.pending = this.pending.slice(1);
    }
    if (final && !this.dropWhitespace && this.leadingWhitespace.length > 0 && this.emitted.length === 0 && out.length === 0) {
      // A whitespace-only block stays as it was.
      out = this.leadingWhitespace;
      this.leadingWhitespace = "";
    }
    this.emitted += out;
    return out;
  }
}

/** Wrap one model chunk stream: strip `§N§` pairs from every text block. */
export async function* stripTagNotationStream<T extends Chunk>(source: AsyncIterable<T>): AsyncIterable<T> {
  const filters = new Map<number, TagNotationFilter>();
  const filterOf = (index: number) => {
    let f = filters.get(index);
    if (f === undefined) {
      f = new TagNotationFilter();
      filters.set(index, f);
    }
    return f;
  };
  for await (const chunk of source) {
    if (chunk.type === "text-delta" && typeof (chunk as { text?: unknown }).text === "string") {
      const c = chunk as Extract<Chunk, { type: "text-delta" }>;
      const text = filterOf(c.index).push(c.text);
      if (text.length > 0) yield { ...c, text } as T;
      continue;
    }
    if (chunk.type === "block-end") {
      const c = chunk as Extract<Chunk, { type: "block-end" }>;
      if (c.block?.type === "text" && typeof c.block.text === "string") {
        const f = filters.get(c.index);
        if (f === undefined) {
          // No deltas seen (adapter emitted the block whole): filter it now.
          const whole = new TagNotationFilter();
          whole.push(c.block.text);
          whole.flush();
          yield { ...c, block: { ...c.block, text: whole.text } } as T;
        } else {
          const tail = f.flush();
          if (tail.length > 0) yield { type: "text-delta", index: c.index, text: tail } as unknown as T;
          yield { ...c, block: { ...c.block, text: f.text } } as T;
          filters.delete(c.index);
        }
        continue;
      }
    }
    yield chunk;
  }
}

export interface OutputTagStripDeps {
  /** dsh-llm `isAgentLoopRequest` (injected so tests need no DSH runtime). */
  readonly isAgentLoopRequest: (options: never) => boolean;
  readonly isEnabled?: () => boolean;
  readonly log?: (message: string) => void;
}

/**
 * The `llm/stream` waterfall listener. Returns the wrapped stream for Magic
 * agent-loop requests, `next()` untouched otherwise. Fail-open.
 */
export function createOutputTagStripListener(deps: OutputTagStripDeps) {
  return (options: { messages?: readonly unknown[] }, next: () => AsyncIterable<Chunk>): AsyncIterable<Chunk> => {
    let applies = false;
    try {
      applies =
        (deps.isEnabled?.() ?? true) &&
        deps.isAgentLoopRequest(options as never) &&
        requestCarriesMagicTags(options.messages);
    } catch (error) {
      deps.log?.(`[magic-context] output tag strip skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    const stream = next();
    return applies ? stripTagNotationStream(stream) : stream;
  };
}

/** Minimal `ctx.on` surface (cordis Context) the registration needs. */
interface ListenerHost {
  on(event: "llm/stream", listener: (...args: never[]) => unknown): unknown;
}

/**
 * Register the strip on the `llm/stream` waterfall (fiber-owned through
 * `ctx.on`, so stop/reload unwinds it). Listener `this` is the LlmRuntime;
 * the wrapper ignores it.
 */
export function registerOutputTagStrip(ctx: ListenerHost, deps: OutputTagStripDeps): void {
  const listener = createOutputTagStripListener(deps);
  ctx.on("llm/stream", ((options: { messages?: readonly unknown[] }, next: () => AsyncIterable<Chunk>) =>
    listener(options, next)) as never);
}
