/**
 * compat/dsh-0.1/compaction — the Magic compaction engine seam.
 *
 * PLAN D3 / §5.1: `MagicCompactionEngine extends BasicCompactionEngine`,
 * overriding ONLY `summarize()`. The official transaction (lock, event order,
 * replacement adjacency, flush, validation) stays fully owned by
 * `@deepseek-ai/dsh-compaction-basic`.
 *
 * The hook types are the OFFICIAL `SummarizationInput` / `SummaryResult`
 * contracts (validated in Phase 0 spike-3): `summary` is a ContentBlock array,
 * `provider`/`model` are required.
 */
import {
  BasicCompactionEngine,
  type BasicCompactionConfig,
  type ResolvedConfig,
} from "@deepseek-ai/dsh-compaction-basic";
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
  type CompactionEngine,
} from "@deepseek-ai/dsh-compaction";
import type { Context } from "@deepseek-ai/cordis";
import type { CompactionResult, CompactionTrigger } from "@deepseek-ai/dsh-compaction";
import { isDshChildSession } from "./child-session";
import { DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE, nativePressureThresholdTokens } from "./pressure-policy";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock, Message, TokenUsage, ToolSchema } from "@deepseek-ai/dsh-llm";

export {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
};
export type { BasicCompactionConfig, CompactionEngine };

/**
 * OFFICIAL hook contracts, pinned here because
 * `@deepseek-ai/dsh-compaction-basic` does not export a `/summarizer` subpath.
 * Shapes copied verbatim from its `lib/types/summarizer.d.ts`; the DSH-upgrade
 * gate (compat layer contract fixtures) verifies they still match.
 */
export interface SummarizationInput {
  readonly system?: string;
  readonly tools?: readonly ToolSchema[];
  readonly messages: readonly Message[];
}

export type SummaryResult = {
  summary: ContentBlock[];
  provider: string;
  model: string;
  maxTokens?: number;
  usage?: TokenUsage;
} & (
  | {
      rawOutput: ContentBlock[];
      llmStreamCall: true;
    }
  | {
      rawOutput?: ContentBlock[];
      llmStreamCall?: never;
    }
);

/** The sole subclass customization hook (official contract). */
export type SummarizeHook = (
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
) => Promise<SummaryResult>;

/**
 * Magic compaction engine. Mounted inside the preset's isolated `compaction`
 * group in place of the stock `compaction-basic` row; `auto` is controlled by
 * composition config (the preset row).
 *
 * The summarize hook is a FUNCTION and cannot travel in YAML config, and the
 * compaction entry bundle and the agent plane are separate bundles with
 * separate module state. The agent plane therefore registers the hook on the
 * HOST service (`magicContextHost.registerSummarizeHook`); this engine reads
 * it through the service at call time (falling back to a config-supplied
 * hook, which tests use).
 */
export class MagicCompactionEngine extends BasicCompactionEngine {
  /** Config-supplied hook (tests); the production path reads the host service. */
  protected readonly magicSummarize?: SummarizeHook;

  /** Which top-level pressure keys the user set explicitly (those always win). */
  protected readonly explicitPressure: { headroomTokens: boolean; thresholdRatio: boolean; retain: boolean };

  constructor(ctx: Context, config: BasicCompactionConfig & { summarize?: SummarizeHook }) {
    super(ctx, { ...config, auto: config.auto ?? true });
    this.magicSummarize = config.summarize;
    this.explicitPressure = {
      headroomTokens: config.headroomTokens !== undefined,
      thresholdRatio: config.thresholdRatio !== undefined,
      retain: config.retainTokens !== undefined || config.retainRatio !== undefined,
    };
  }

  /**
   * Round 19 — pressure threshold policy (adapter-only; compaction-basic's
   * transaction is untouched). compaction-basic prices pressure at
   * `min(window × thresholdRatio, window − maxTokens − headroomTokens)` with
   * `headroomTokens` defaulting to 65 536, which (a) leaves windows ≤ ~70k with
   * no pressure budget at all (`TargetPressureConfigError`, pressure compaction
   * never fires) and (b) fires at ≈ 44–46 % on a 128k window — before MC's
   * 65 % execute threshold, so the MC historian/drops never get to work.
   *
   *  - MC-managed MAIN session: MC leads. Unless the user set them, the native
   *    defaults become `headroomTokens: 0` and `thresholdRatio` = MC's
   *    force-materialization band for the route (core `escalationBands`,
   *    85 % for the default 65 % execute threshold), supplied by the agent
   *    plane through `magicContextHost.nativePressurePercentage`. Native
   *    pressure compaction is then only the backstop behind MC.
   *  - CHILD session (round 16: stock summarizer): native policy unchanged;
   *    only when the DEFAULT headroom makes the policy illegal (no pressure
   *    budget, or the default retention not below the threshold) does it
   *    retry with `headroomTokens: 0` (a legal `window × thresholdRatio`).
   *  - Explicit user values (top-level keys or a per-route `modelPolicies`
   *    entry) always win; a per-route entry already beats these top-level
   *    defaults inside compaction-basic's `resolveTargetPolicy`.
   *
   * compaction-basic resolves the policy from `this.config` synchronously at
   * the top of `compactIfNeeded` (before its first await), so the effective
   * config is swapped in for exactly that synchronous prefix and restored in
   * `finally` — the summarizer and overflow paths keep reading the original.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (trigger !== "pressure") return super.compactIfNeeded(agent, trigger, signal);
    if (process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN !== "1") return this.pressureCompaction(agent, trigger, signal);
    // e2e diagnostics (headless prints console.error, not ctx.logger): one
    // line per pressure check with the pressure, the effective threshold and
    // the outcome — the evidence that native compaction stays behind MC.
    const probe = await this.describePressure(agent);
    const say = (outcome: string) => {
      try {
        // eslint-disable-next-line no-console
        console.error(
          `[magic-context] native pressure check: child=${isDshChildSession(agent)} pct=${probe.pct ?? "?"} thresholdPct=${this.lastPressureThresholdPct ?? "?"} window=${probe.window ?? "?"} outcome=${outcome}`,
        );
      } catch {
        // diagnostics only
      }
    };
    this.lastPressureThresholdPct = undefined;
    try {
      const result = await this.pressureCompaction(agent, trigger, signal, probe);
      say(result === null ? "none" : "compacted");
      return result;
    } catch (error) {
      say(`error:${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
      throw error;
    }
  }

  /** Last effective native threshold (% of window) computed by a debug probe. */
  private lastPressureThresholdPct: number | undefined;

  private async describePressure(agent: Agent): Promise<{ pct?: number; window?: number; reserved?: number }> {
    try {
      const header = (agent.session as unknown as {
        requestHeader?: () => { config?: { provider?: string; model?: string; maxTokens?: number } } | undefined;
      }).requestHeader?.()?.config;
      const ctx = this.ctx as unknown as {
        tokenMeter?: { measure(s: unknown): { totalTokens: number } };
        llm?: { resolveModelInfo?(p: string, m: string): Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number }> };
      };
      if (!header?.provider || !header.model) return {};
      const info = await ctx.llm?.resolveModelInfo?.(header.provider, header.model);
      const window = info?.context?.contextWindow;
      const tokens = ctx.tokenMeter?.measure(agent.session).totalTokens;
      const reserved = header.maxTokens ?? info?.defaultMaxTokens ?? 0;
      return {
        window,
        reserved,
        ...(tokens !== undefined && window ? { pct: Math.round((tokens / window) * 1000) / 10 } : {}),
      };
    } catch {
      return {};
    }
  }

  private notePressureThreshold(
    config: ResolvedConfig,
    agent: Agent,
    probe?: { window?: number; reserved?: number },
  ): void {
    if (probe?.window === undefined) return;
    const header = (agent.session as unknown as {
      requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined;
    }).requestHeader?.()?.config;
    const override = config.modelPolicies.find((p) => p.provider === header?.provider && p.model === header?.model);
    const t = nativePressureThresholdTokens(probe.window, probe.reserved ?? 0, {
      thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
      headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    });
    this.lastPressureThresholdPct = t === null ? undefined : Math.round((t / probe.window) * 1000) / 10;
  }

  private async pressureCompaction(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
    probe?: { window?: number; reserved?: number },
  ): Promise<CompactionResult | null> {
    const base = this.config;
    if (!isDshChildSession(agent)) {
      const percentage = readHostNativePressurePercentage(this.ctx, agent);
      if (percentage === null) {
        this.notePressureThreshold(base, agent, probe);
        return super.compactIfNeeded(agent, trigger, signal);
      }
      const main = magicMainPressureConfig(base, this.explicitPressure, percentage);
      this.notePressureThreshold(main, agent, probe);
      return this.withPressureConfig(main, () => super.compactIfNeeded(agent, trigger, signal));
    }
    this.notePressureThreshold(base, agent, probe);
    try {
      return await super.compactIfNeeded(agent, trigger, signal);
    } catch (error) {
      if (this.explicitPressure.headroomTokens || !isDefaultHeadroomConfigError(error, this.explicitPressure.retain)) {
        throw error;
      }
      const legal = withConfigOverrides(base, { headroomTokens: 0 });
      this.notePressureThreshold(legal, agent, probe);
      return this.withPressureConfig(legal, () => super.compactIfNeeded(agent, trigger, signal));
    }
  }

  /**
   * Observability (round 19): one log line per automatic native compaction
   * region (pressure or overflow recovery — `compactNow` does not come through
   * here), with the pre-compaction pressure as a percentage of the routed
   * window, so the e2e can prove native compaction never pre-empts MC.
   */
  override async compactRegion(
    start: Parameters<BasicCompactionEngine["compactRegion"]>[0],
    end: Parameters<BasicCompactionEngine["compactRegion"]>[1],
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    try {
      const session = agent.session as unknown as { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined };
      const target = session.requestHeader?.()?.config;
      const ctx = this.ctx as unknown as {
        tokenMeter?: { measure(s: unknown): { totalTokens: number } };
        llm?: { resolveModelInfo?(p: string, m: string): Promise<{ context?: { contextWindow?: number } }> };
        logger?: { info?(m: string): void };
      };
      const tokens = ctx.tokenMeter?.measure(agent.session).totalTokens;
      const window =
        target?.provider && target.model
          ? (await ctx.llm?.resolveModelInfo?.(target.provider, target.model))?.context?.contextWindow
          : undefined;
      const pct = tokens !== undefined && window ? Math.round((tokens / window) * 1000) / 10 : undefined;
      const line = `[magic-context] native compaction region: child=${isDshChildSession(agent)} tokens=${tokens ?? "?"} window=${window ?? "?"} pct=${pct ?? "?"}`;
      ctx.logger?.info?.(line);
      // headless prints console.error, not ctx.logger
      // eslint-disable-next-line no-console
      if (process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN === "1") console.error(line);
    } catch {
      // observability only
    }
    return super.compactRegion(start, end, agent, signal);
  }

  /** Run `fn` with `config` visible to its synchronous prefix only. */
  private withPressureConfig<T>(config: ResolvedConfig, fn: () => Promise<T>): Promise<T> {
    const self = this as unknown as { config: ResolvedConfig };
    const original = self.config;
    self.config = config;
    try {
      return fn();
    } finally {
      self.config = original;
    }
  }

  override summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    // Upstream parity (core event-handler: subagent sessions never run the
    // historian). A DSH child session (subagent origin / delegation depth ≥ 1)
    // is outside Magic's per-session machinery, so its compaction falls back
    // to the stock compaction-basic summarizer (the pre-replacement
    // behaviour) and Magic writes nothing (no compartments / marker / lease).
    if (isDshChildSession(agent)) return super.summarize(input, agent, signal);
    const hook = this.magicSummarize ?? readHostSummarizeHook(this.ctx);
    if (hook === undefined) {
      throw new Error(
        "magic-context: compaction summarize hook unavailable (agent plane not wired?)",
      );
    }
    return hook(input, agent, signal);
  }
}

/**
 * The native pressure percentage the agent plane asks for on a main session:
 * a number (MC manages it), `null` (MC is not managing it — e.g. live-disabled
 * preset — keep DSH's native defaults). No hook registered (older host stand-in
 * / agent plane not wired yet) → MC's default force band.
 */
function readHostNativePressurePercentage(ctx: Context, agent: Agent): number | null {
  const host = ctx.get("magicContextHost") as
    | { nativePressurePercentage?: (agent: unknown) => number | undefined }
    | undefined;
  if (typeof host?.nativePressurePercentage !== "function") return DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE;
  let value: number | undefined;
  try {
    value = host.nativePressurePercentage(agent);
  } catch {
    return DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE;
  }
  if (value === undefined) return null;
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE;
}

/** Effective top-level pressure defaults for an MC-managed main session. */
export function magicMainPressureConfig(
  base: ResolvedConfig,
  explicit: { headroomTokens: boolean; thresholdRatio: boolean },
  percentage: number,
): ResolvedConfig {
  return withConfigOverrides(base, {
    ...(explicit.headroomTokens ? {} : { headroomTokens: 0 }),
    ...(explicit.thresholdRatio ? {} : { thresholdRatio: percentage / 100 }),
  });
}

function withConfigOverrides(
  base: ResolvedConfig,
  overrides: { headroomTokens?: number; thresholdRatio?: number },
): ResolvedConfig {
  return Object.freeze({ ...base, ...overrides }) as ResolvedConfig;
}

/**
 * compaction-basic `TargetPressureConfigError`s that only the DEFAULT 65 536
 * headroom causes: "no pressure budget" (window ≤ ~65k + maxTokens) and the
 * default retention (0.16 × message budget) not below the shrunken threshold
 * (≈ 70–82k windows; real rc.5 round 19 e2e run 41589483637 on an 80k route:
 * "retainTokens (12144) must be less than threshold tokens 10368"). An
 * explicit user retention keeps its own error.
 */
function isDefaultHeadroomConfigError(error: unknown, explicitRetain: boolean): boolean {
  if (!(error instanceof Error) || typeof (error as { targetKey?: unknown }).targetKey !== "string") return false;
  if (/leaving no pressure budget/.test(error.message)) return true;
  return !explicitRetain && /retainTokens \(\d+\) must be less than threshold tokens/.test(error.message);
}

/** Read the hook the agent plane registered on the host service (if any). */
function readHostSummarizeHook(ctx: Context): SummarizeHook | undefined {
  const host = ctx.get("magicContextHost") as
    | { summarizeHook?: () => unknown }
    | undefined;
  const hook = host?.summarizeHook?.();
  return typeof hook === "function" ? (hook as SummarizeHook) : undefined;
}
