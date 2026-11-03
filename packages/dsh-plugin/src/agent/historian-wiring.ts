/**
 * agent/historian-wiring — production wiring of the historian plane (Phase 3):
 *
 *   1. the Magic compaction summarize hook, registered ON the host service
 *      (cross-bundle singleton — the compaction entry bundle reads it there).
 *      The wrapper resolves the canonical session from the compacting agent at
 *      call time and lazily builds one per-session hook (transcript-backed
 *      raw-message provider + the production LLM SummarizeCall).
 *   2. the production `DshSummarizeCall` over `ctx.llm.stream()` with the
 *      shared compartment-agent system prompt (PLAN §5.13/D7: historian calls
 *      the LLM directly — no subagent, no tools).
 *
 * The background historian pass itself is triggered from the context plane /
 * pre-step by the integrator via `runDshHistorian`; this module owns only the
 * hook + LLM call production paths.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { createUserMessage, promptTokensOf, sessionEvents } from "../compat/dsh-0.1/session";
import type { SummarizeHook } from "../compat/dsh-0.1/compaction";
import type { MagicContextHostService, MagicSummarizeHook } from "../index";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
  COMPARTMENT_AGENT_SYSTEM_PROMPT,
  buildCompartmentAgentPrompt,
} from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { buildHistorianRepairPrompt } from "@magic-context/core/hooks/magic-context/compartment-runner-validation";
import { messageNodeSpan, readDshHistory } from "./transcript";
import { isMagicChildSession } from "./worker";
import {
  createMagicSummarizeHook,
  type DshSummarizeCall,
  type MagicSummarizeDeps,
} from "./historian";

export interface MagicHistorianWiringDeps {
  /** The host service (ready + canonicalKey + registerSummarizeHook). */
  readonly host: MagicContextHostService;
  /** Project working directory (memory promotion scope). */
  readonly directory?: string;
  /** historian.model override ("provider/model") for the compaction hook too (getter = live). */
  readonly model?: string | (() => string | undefined);
  /** Summarize-hook lease wait (default 45 s; round 22 e2e override only). */
  readonly leaseWaitMs?: number;
  readonly log?: (message: string) => void;
}

/** Read the LLM runtime without declaring a hard inject (optional service). */
function readLlm(ctx: Context): LlmRuntime | undefined {
  return ctx.get("llm") as LlmRuntime | undefined;
}

/** Current provider/model route (fresh per call). */
export function currentModel(ctx: Context): string {
  const route = currentRoute(ctx);
  return `${route.provider}/${route.model}`;
}

/**
 * The token-meter projection key and its wire view, verified against
 * `@deepseek-ai/dsh-token-meter@0.2.1-rc.5`: `contextPressureProjectionDefinition`
 * registers `key: "contextPressure"` and its `wire.view` publishes
 * `{ contextWindow?, pressureTokens?, projectedTokens? }` (all optional; absent
 * until a provider reports usage / an adapter advertises a window). Pinned by
 * `src/contracts/token-meter-projection.contract.test.ts`.
 */
export const CONTEXT_PRESSURE_PROJECTION_KEY = "contextPressure" as const;

/**
 * The MC meter's key (host/meter.ts): token-meter's contextPressure fold
 * re-registered under this name once setup disables the stock row. Same
 * pressure fields, so it is read the same way when the native key is absent.
 */
export const MAGIC_CONTEXT_PRESSURE_PROJECTION_KEY = "magicContextPressure" as const;

/** Wire view of the token-meter `contextPressure` projection (0.2.1-rc.5). */
export interface DshContextPressureView {
  readonly pressureTokens?: number;
  readonly projectedTokens?: number;
  readonly contextWindow?: number;
}

/** Normalise the projection view to the trigger sample (projected → pressure). */
export function pressureSampleFromView(
  view: DshContextPressureView,
): { projectedTokens?: number; contextWindow?: number } | undefined {
  const contextWindow =
    typeof view.contextWindow === "number" && view.contextWindow > 0 ? view.contextWindow : undefined;
  // `projectedTokens` is present whenever `pressureTokens` is (token-meter
  // wire.view); it already folds post-sample surface movement (compactions).
  const projectedTokens =
    typeof view.projectedTokens === "number"
      ? view.projectedTokens
      : typeof view.pressureTokens === "number"
        ? view.pressureTokens
        : undefined;
  if (contextWindow === undefined) return undefined;
  return { projectedTokens, contextWindow };
}

/**
 * Read the current context pressure for the historian trigger (Phase 4):
 * `ctx.sessionProjections.snapshot(session, ["contextPressure"]).values.contextPressure`.
 *
 * Capability rule (dsh-session-projection): an absent key means the
 * token-meter unit is not mounted in this preset. Only then do we derive the
 * same figure from the session log (last `request/context` window + LAST
 * call's prompt usage, token-meter `pressureFrom` semantics). A PRESENT key is
 * authoritative — no secondary fallback when its fields are not yet available.
 */
export function readContextPressure(ctx: Context): (agent: Agent) => { projectedTokens?: number; contextWindow?: number } | undefined {
  return (agent: Agent) => {
    const projections = ctx.get("sessionProjections") as
      | {
          snapshot?: (
            session: unknown,
            keys?: readonly string[],
          ) => { values?: Record<string, unknown> };
        }
      | undefined;
    const values = projections?.snapshot?.(agent.session, [
      CONTEXT_PRESSURE_PROJECTION_KEY,
      MAGIC_CONTEXT_PRESSURE_PROJECTION_KEY,
    ])?.values;
    for (const key of [CONTEXT_PRESSURE_PROJECTION_KEY, MAGIC_CONTEXT_PRESSURE_PROJECTION_KEY]) {
      if (values !== undefined && Object.hasOwn(values, key)) {
        const view = values[key];
        return view !== null && typeof view === "object"
          ? pressureSampleFromView(view as DshContextPressureView)
          : undefined;
      }
    }
    return pressureFromSessionLog(agent);
  };
}

/** Token-meter-less presets: derive pressure from the session event log. */
export function pressureFromSessionLog(
  agent: Agent,
): { projectedTokens?: number; contextWindow?: number } | undefined {
  try {
    const events = sessionEvents(agent.session);
    let contextWindow: number | undefined;
    let projectedTokens = 0;
    for (const event of events) {
      if (event === null || typeof event !== "object") continue;
      const e = event as { type?: unknown; data?: unknown };
      if (e.type === "request/context") {
        const cw = (e.data as { contextWindow?: unknown } | undefined)?.contextWindow;
        if (typeof cw === "number" && cw > 0) contextWindow = cw;
        continue;
      }
      if (e.type === "assistant/message") {
        // Pressure is the LAST call's prompt (input + cacheRead + cacheWrite);
        // summing across calls over-counts (each call re-sends the prompt).
        const prompt = promptTokensOf((e.data as { usage?: unknown } | undefined)?.usage);
        if (prompt !== undefined) projectedTokens = prompt;
      }
    }
    if (typeof contextWindow !== "number" || contextWindow <= 0) return undefined;
    return { projectedTokens, contextWindow };
  } catch {
    return undefined;
  }
}

/** Resolve the current provider/model route (fresh per call). */
function currentRoute(ctx: Context): { provider: string; model: string } {
  const defaultModel = ctx.get("agentDefaultModel") as
    | { currentSelection?: () => { provider?: string; model?: string } }
    | undefined;
  const selection = defaultModel?.currentSelection?.();
  return {
    provider: selection?.provider ?? "deepseek",
    model: selection?.model ?? "deepseek-chat",
  };
}

/**
 * The production historian LLM call: one `ctx.llm.stream()` request with the
 * shared compartment-agent system prompt and the chunk text as the user turn.
 * Returns the raw historian XML the runner validates and publishes.
 */
export function createLlmSummarizeCall(
  ctx: Context,
  modelOverrideSource?: string | (() => string | undefined),
): DshSummarizeCall {
  const llm = readLlm(ctx);
  if (llm === undefined) {
    throw new Error("magic-context: llm service unavailable (historian wiring)");
  }
  return async (chunk, _priorCompartments, signal, repair) => {
    // Resolved per call: the DSH settings overlay edits historian.model live.
    const modelOverride =
      typeof modelOverrideSource === "function" ? modelOverrideSource() : modelOverrideSource;
    // Pi parity: historian.model routes the compartment call to a dedicated
    // model — required when the main session runs a low-context window (the
    // compartment prompt alone is ~60KB, far beyond small windows).
    const { provider, model } = modelOverride !== undefined && modelOverride.includes("/")
      ? { provider: modelOverride.split("/")[0], model: modelOverride.split("/").slice(1).join("/") }
      : currentRoute(ctx);
    const basePrompt = buildCompartmentAgentPrompt({
      seedExamples: "",
      sessionReferences: "",
      projectMemory: "",
      inputSource: chunk.text,
      memoryEnabled: true,
    });
    // Repair retry: core's exact repair wrapper around the original prompt.
    const prompt =
      repair === undefined
        ? basePrompt
        : buildHistorianRepairPrompt(basePrompt, repair.previousOutput, repair.validationError);
    const user = createUserMessage({
      content: [{ type: "text", text: prompt }],
      source: { kind: "magic-context", plugin: "magic-context" },
    });
    let text = "";
    let reasoningChars = 0;
    let failed: string | undefined;
    let finishKind = "none";
    let outputTokens: number | undefined;
    for await (const streamChunk of llm.stream({
      provider,
      model,
      system: COMPARTMENT_AGENT_SYSTEM_PROMPT,
      messages: [user],
      purpose: "compaction",
      signal,
    })) {
      if (streamChunk.type === "text-delta") text += streamChunk.text;
      if (streamChunk.type === "reasoning-delta") reasoningChars += streamChunk.text.length;
      if (streamChunk.type === "usage") outputTokens = streamChunk.usage.outputTokens;
      if (streamChunk.type === "finish") {
        finishKind = streamChunk.reason.kind;
        if (streamChunk.reason.kind === "error") {
          const failure = (streamChunk.reason as { failure?: { message?: string } }).failure;
          failed = failure?.message ?? "error finish";
        } else if (streamChunk.reason.kind === "aborted") {
          failed = "aborted";
        }
      }
    }
    const route = `${provider}/${model}`;
    if (failed !== undefined) {
      throw new Error(
        `magic-context: historian LLM stream failed (${failed}; finish=${finishKind}; route=${route})`,
      );
    }
    if (text.trim().length === 0) {
      const hint = finishKind === "max-tokens"
        ? ` — the route ran out of output tokens (prompt ~${Math.round(prompt.length / 4)} tok est.); ` +
          "point historian.model at a larger-window route"
        : "";
      throw new Error(
        `magic-context: historian LLM stream returned no text (finish=${finishKind}; route=${route}; ` +
        `outputTokens=${outputTokens ?? "?"}; reasoningChars=${reasoningChars})${hint}`,
      );
    }
    return text;
  };
}

/** Message id of a surface event (`user/message` data.id, else data.message.id). */
function surfaceEventMessageId(event: unknown): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const data = (event as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return undefined;
  const direct = (data as { id?: unknown }).id;
  if (typeof direct === "string") return direct;
  const message = (data as { message?: unknown }).message;
  const nested = message !== null && typeof message === "object" ? (message as { id?: unknown }).id : undefined;
  return typeof nested === "string" ? nested : undefined;
}

/**
 * RawMessageProvider plus the history-ordinal RANGE a surface message stands
 * for (round 23): a native-compaction checkpoint (or its op copy) covers every
 * history message it shadowed, so a compaction region starting on it begins at
 * that range's first ordinal, not its last.
 */
export interface DshRawMessageProvider extends RawMessageProvider {
  readMessageOrdinalRangeById(messageId: string): { first: number; last: number } | null;
}

/**
 * Transcript-backed RawMessageProvider for one live session (read-only).
 *
 * Round 23: it serves the session HISTORY (`readDshHistory`: native
 * compaction checkpoints expanded back into the messages they shadowed), so
 * ordinals stay stable across DSH native compactions and keep matching the
 * published compartments. Before, it served the surface view, whose ordinals
 * restart at the checkpoint (real rc.5 run 41619627652: the second `/compact`
 * judged compartments 1–17 "covered", the background historian found nothing
 * after ordinal 17 and the post-compaction turn became a drop candidate).
 */
export function transcriptRawMessageProvider(
  agent: Agent,
  canonicalSessionId: string,
): DshRawMessageProvider {
  const events = sessionEvents(agent.session);
  const view = readDshHistory({
    session: {
      events,
      surface: agent.session.surface,
      header: { cwd: agent.session.header.cwd },
    },
    canonicalSessionId,
  });
  const byId = new Map(view.messages.map((message) => [message.id, message]));
  const ordinalById = new Map(view.messages.map((message) => [message.id, message.ordinal]));
  // Round 20: compaction-basic hands the summarize hook SURFACE messages. A
  // Magic op copy (or a folded tool result) has a surface id the view does not
  // carry — the view expands copies back into their source events. Map every
  // surface event id a view message covers (its span seqs) to that message's
  // ordinal (the last covering message wins), so a region ending on a copy
  // resolves to the message it re-renders.
  const surfaceRangeById = new Map<string, { first: number; last: number }>();
  const eventBySeq = new Map(events.map((event) => [Number((event as { seq?: unknown }).seq), event]));
  for (const message of view.messages) {
    const span = messageNodeSpan(message);
    if (span === null) continue;
    for (const seq of span.seqs) {
      const id = surfaceEventMessageId(eventBySeq.get(seq));
      if (id !== undefined && !ordinalById.has(id)) surfaceRangeById.set(id, { first: message.ordinal, last: message.ordinal });
    }
  }
  // Round 23: a checkpoint / checkpoint copy on the surface stands for the
  // whole history range it shadowed.
  for (const [seq, range] of view.standInOrdinals) {
    const id = surfaceEventMessageId(eventBySeq.get(seq));
    if (id !== undefined && !ordinalById.has(id)) surfaceRangeById.set(id, range);
  }
  return {
    readMessages: () => [...view.messages],
    readMessageById: (messageId: string) => byId.get(messageId) ?? null,
    readMessageOrdinalById: (messageId: string) =>
      ordinalById.get(messageId) ?? surfaceRangeById.get(messageId)?.last ?? null,
    readMessageOrdinalRangeById: (messageId: string) => {
      const own = ordinalById.get(messageId);
      if (own !== undefined) return { first: own, last: own };
      return surfaceRangeById.get(messageId) ?? null;
    },
    getMessageCount: () => view.messages.length,
  };
}

/**
 * Register the summarize hook on the host service. The per-session hook is
 * built per compaction call from the compacting agent: its raw-message
 * provider is a SNAPSHOT of the transcript (`transcriptRawMessageProvider`),
 * so caching it would serve a later compaction of the same session the
 * messages of the first one ("summarize range unresolvable", round 14). The
 * hook itself is a cheap closure; every durable state (lease, compartments,
 * marker) lives in the DB.
 */
export function registerMagicHistorianPlane(
  ctx: Context,
  deps: MagicHistorianWiringDeps,
): void {
  const summarize = createLlmSummarizeCall(ctx, deps.model);
  const log = deps.log ?? (() => {});

  const wrapper: MagicSummarizeHook = async (input, agent, signal) => {
    const a = agent as Agent;
    // Defence in depth: MagicCompactionEngine already routes child sessions
    // to the stock summarizer; any other caller must not run the historian
    // (or touch the DB) for a child session either (upstream parity).
    if (isMagicChildSession(a)) {
      throw new Error(
        "magic-context: historian does not run for child (subagent) sessions — use the stock summarizer",
      );
    }
    const sessionId = deps.host.canonicalKey(a.id);
    const bootstrap = await deps.host.ready;
    if (bootstrap.kind !== "ok") {
      throw new Error(
        `magic-context: compaction summarize unavailable — host bootstrap ${bootstrap.kind}`,
      );
    }
    const hook = createMagicSummarizeHook({
      db: bootstrap.db,
      sessionId,
      ctx,
      provider: transcriptRawMessageProvider(a, sessionId),
      summarize,
      directory: deps.directory,
      ...(deps.leaseWaitMs !== undefined ? { leaseWaitMs: deps.leaseWaitMs } : {}),
      log,
    } satisfies MagicSummarizeDeps);
    return hook(input as Parameters<SummarizeHook>[0], a, signal);
  };
  deps.host.registerSummarizeHook(wrapper);
  log("[magic-context] historian plane wired: summarize hook registered on the host service");
}
