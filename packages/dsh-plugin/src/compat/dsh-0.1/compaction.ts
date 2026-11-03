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
import { DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE } from "./pressure-policy";
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
  protected readonly explicitPressure: { headroomTokens: boolean; thresholdRatio: boolean };

  constructor(ctx: Context, config: BasicCompactionConfig & { summarize?: SummarizeHook }) {
    super(ctx, { ...config, auto: config.auto ?? true });
    this.magicSummarize = config.summarize;
    this.explicitPressure = {
      headroomTokens: config.headroomTokens !== undefined,
      thresholdRatio: config.thresholdRatio !== undefined,
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
   *    only when the DEFAULT headroom leaves no budget does it retry with
   *    `headroomTokens: 0` (a legal `window × thresholdRatio` threshold).
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
    const base = this.config;
    if (!isDshChildSession(agent)) {
      const percentage = readHostNativePressurePercentage(this.ctx, agent);
      if (percentage === null) return super.compactIfNeeded(agent, trigger, signal);
      return this.withPressureConfig(magicMainPressureConfig(base, this.explicitPressure, percentage), () =>
        super.compactIfNeeded(agent, trigger, signal),
      );
    }
    try {
      return await super.compactIfNeeded(agent, trigger, signal);
    } catch (error) {
      if (this.explicitPressure.headroomTokens || !isNoPressureBudgetError(error)) throw error;
      return this.withPressureConfig(withConfigOverrides(base, { headroomTokens: 0 }), () =>
        super.compactIfNeeded(agent, trigger, signal),
      );
    }
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

/** compaction-basic's TargetPressureConfigError for "no pressure budget". */
function isNoPressureBudgetError(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as { targetKey?: unknown }).targetKey === "string" &&
    /leaving no pressure budget/.test(error.message)
  );
}

/** Read the hook the agent plane registered on the host service (if any). */
function readHostSummarizeHook(ctx: Context): SummarizeHook | undefined {
  const host = ctx.get("magicContextHost") as
    | { summarizeHook?: () => unknown }
    | undefined;
  const hook = host?.summarizeHook?.();
  return typeof hook === "function" ? (hook as SummarizeHook) : undefined;
}
