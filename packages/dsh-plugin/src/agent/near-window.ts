/**
 * agent/near-window — round 37 seg 12, limitation 35 option B (user decision
 * 2026-11-12): a SEPARATE "near the window" trigger. It is not folded into
 * MC's pressure percentage (the persisted / reported context % stays the
 * measured one); when it fires, the next pass treats MC pressure as being at
 * the force band (pressure truncation, drop ride, historian trigger).
 *
 * Why: the DSH pi-ai route clamps every request's output to
 *   min(maxTokens, max(1, window − estimate − 4096))
 * and in DSH 0.2.1-rc.5 / 0.2.2 `dsh-llm-pi-ai` replays every assistant with
 * `emptyPiUsage()` and timestamp 0, so pi-ai never anchors on real usage: the
 * estimate is ALWAYS sum(ceil(chars / 3.5)) + tool schemas, ≈ 1.07× the real
 * prompt near the window. MC's own pressure (real usage) can sit below its
 * lines while pi already squeezes the reply (real runs: 55 / 59 main requests
 * below 32 768, min 1 / 4 041).
 *
 * Fires when either holds:
 *   (a) pi estimate + 4096 + output floor > window — the floor is
 *       min(16 384, route maxTokens): a route that never asks for 16k output
 *       is held to its own maxTokens (a 24k window / 4096 route would
 *       otherwise sit permanently "near the window");
 *       only on sessions whose latest model reply came from the pi-ai adapter
 *       (`replayState.response.kind === "pi-ai"`): the estimator below is
 *       pi-ai's;
 *   (b) the latest model reply stopped on max tokens (`length` / `max-tokens`)
 *       with fewer output tokens than the route's maxTokens — the provider
 *       side clamped it below what the route asked for.
 *
 * BOUND TO pi-ai 1.3.0 (`packages/ai/src/utils/estimate.ts` CHARS_PER_TOKEN
 * 3.5, `estimateMessageTokens`, `estimateToolsTokens`; `api/simple-options.ts`
 * clamp safety 4096 — unchanged v1.3.0 → v1.5.2 for maxTokens 32 768; DSH
 * master pins 1.3.0). Every pi-specific constant lives here and nowhere else.
 * Not mirrored: images (4 800 chars each; DSH text sessions only) and the
 * first system message (pi's `systemPrompt`, outside `messages`).
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import { deriveEventMessage, sessionEvents } from "../compat/dsh-0.1/session";

/** pi-ai 1.3.0 utils/estimate.ts `CHARS_PER_TOKEN`. */
export const PI_CHARS_PER_TOKEN = 3.5;
/** pi-ai 1.3.0 api/simple-options.ts `clampMaxTokensToContext` safety margin. */
export const PI_CLAMP_SAFETY_TOKENS = 4096;
/** The output room the trigger keeps (user decision 2026-11-12: 16 384). */
export const NEAR_WINDOW_OUTPUT_FLOOR = 16_384;

const est = (chars: number) => Math.ceil(chars / PI_CHARS_PER_TOKEN);

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

type Block = { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown; content?: unknown; output?: unknown };

function textChars(blocks: unknown, depth = 0): number {
  if (typeof blocks === "string") return blocks.length;
  if (!Array.isArray(blocks) || depth > 4) return 0;
  let chars = 0;
  for (const b of blocks as Block[]) {
    if (b === null || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
    else if (b.type === "image") chars += 4800; // pi-ai ESTIMATED_IMAGE_CHARS
    else if (Array.isArray(b.content)) chars += textChars(b.content, depth + 1);
  }
  return chars;
}

/** pi-ai `estimateMessageTokens` for one derived DSH message. */
export function piMessageTokens(message: unknown): number {
  if (message === null || typeof message !== "object") return 0;
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== "assistant") return est(textChars(m.content));
  let chars = 0;
  if (Array.isArray(m.content)) {
    for (const b of m.content as Block[]) {
      if (b === null || typeof b !== "object") continue;
      if ((b.type === "text" || b.type === "reasoning") && typeof b.text === "string") chars += b.text.length;
      else if (b.type === "tool-call") {
        let args: unknown = b.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args || "{}");
          } catch {
            // pi stringifies the parsed arguments; an unparsable string is counted as is
          }
        }
        chars += (typeof b.name === "string" ? b.name.length : 0) + (typeof args === "string" ? args.length : safeStringify(args).length);
      }
    }
  }
  return est(chars);
}

export interface PiRouteFacts {
  /** pi estimate of the next request (surface + pending batch + tool schemas). */
  readonly estimate: number;
  /** the route's maxTokens (latest request/header), 0 when unknown. */
  readonly maxTokens: number;
  /** latest model reply came from the pi-ai adapter. */
  readonly piReply: boolean;
  /** latest model reply stopped on max tokens with output below maxTokens. */
  readonly shortMaxTokensStop: boolean;
}

/** Read what the trigger needs from the session (surface, headers, latest reply). Fail-open: undefined. */
export function readPiRouteFacts(agent: Agent, pending: readonly unknown[] = []): PiRouteFacts | undefined {
  try {
    const events = sessionEvents(agent.session);
    const bySeq = new Map<number, unknown>();
    let maxTokens = 0;
    let toolTokens = 0;
    let lastReply: { source?: { replayState?: { response?: { kind?: unknown; stopReason?: unknown } } }; stopReason?: unknown } | undefined;
    let lastUsage: { outputTokens?: unknown } | undefined;
    let lastFinish: unknown;
    for (const event of events) {
      if (event === null || typeof event !== "object") continue;
      const e = event as { type?: unknown; seq?: unknown; data?: Record<string, unknown> };
      if (typeof e.seq === "number") bySeq.set(e.seq, event);
      if (e.type === "request/header") {
        const header = e.data?.header as { config?: { maxTokens?: unknown }; tools?: unknown } | undefined;
        const max = header?.config?.maxTokens;
        if (typeof max === "number" && max > 0) maxTokens = max;
        // pi-ai `estimateToolsTokens(toolsAdded)`: ceil(JSON.stringify(tools) / 3.5)
        if (Array.isArray(header?.tools)) toolTokens = header!.tools.length > 0 ? est(safeStringify(header!.tools).length) : 0;
      } else if (e.type === "assistant/message") {
        const message = e.data?.message as typeof lastReply;
        const source = (message as { source?: { kind?: unknown } } | undefined)?.source;
        if (source?.kind === "model" || source?.kind === undefined) {
          lastReply = message;
          lastUsage = e.data?.usage as typeof lastUsage;
          lastFinish = e.data?.finishReason ?? e.data?.stopReason;
        }
      } else if (e.type === "turn/end") {
        const kind = (e.data?.reason as { kind?: unknown } | undefined)?.kind;
        if (kind === "max-tokens") lastFinish = "max-tokens";
      }
    }
    const nodes = (agent.session as unknown as { surface?: { nodes?: readonly unknown[] } }).surface?.nodes ?? [];
    let estimate = toolTokens;
    let first = true;
    for (const node of nodes) {
      const event = bySeq.get(Number(node));
      if (event === undefined) continue;
      let message: unknown;
      try {
        message = deriveEventMessage(event as never);
      } catch {
        continue;
      }
      const role = (message as { role?: unknown } | null)?.role;
      if (first && role === "system") {
        first = false; // pi's systemPrompt: not in `messages`
        continue;
      }
      first = false;
      estimate += piMessageTokens(message);
    }
    for (const m of pending) estimate += piMessageTokens(m);
    const response = lastReply?.source?.replayState?.response;
    const stop = response?.stopReason ?? lastReply?.stopReason ?? lastFinish;
    const out = typeof lastUsage?.outputTokens === "number" ? lastUsage.outputTokens : undefined;
    const maxStop = stop === "length" || stop === "max-tokens" || stop === "max_tokens";
    return {
      estimate,
      maxTokens,
      piReply: response?.kind === "pi-ai",
      shortMaxTokensStop: maxStop && maxTokens > 0 && out !== undefined && out < maxTokens,
    };
  } catch {
    return undefined;
  }
}

export interface NearWindowSignal {
  readonly reason: "pi-estimate" | "max-tokens-short";
  /** pi tokens over the kept output room (0 when only (b) fired). */
  readonly excessTokens: number;
  readonly estimate: number;
}

/** The trigger itself (pure over the facts). */
export function nearWindowFrom(facts: PiRouteFacts | undefined, contextWindow: number | undefined): NearWindowSignal | undefined {
  if (facts === undefined || !(typeof contextWindow === "number" && contextWindow > 0)) return undefined;
  const floor = facts.maxTokens > 0 ? Math.min(NEAR_WINDOW_OUTPUT_FLOOR, facts.maxTokens) : NEAR_WINDOW_OUTPUT_FLOOR;
  const excess = facts.estimate + PI_CLAMP_SAFETY_TOKENS + floor - contextWindow;
  if (facts.piReply && excess > 0) return { reason: "pi-estimate", excessTokens: excess, estimate: facts.estimate };
  if (facts.shortMaxTokensStop) return { reason: "max-tokens-short", excessTokens: Math.max(0, excess), estimate: facts.estimate };
  return undefined;
}

export function nearWindowSignal(agent: Agent, contextWindow: number | undefined, pending: readonly unknown[] = []): NearWindowSignal | undefined {
  return nearWindowFrom(readPiRouteFacts(agent, pending), contextWindow);
}
