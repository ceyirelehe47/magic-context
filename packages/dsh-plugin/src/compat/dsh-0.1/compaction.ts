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
  protected readonly explicitPressure: { headroomTokens: boolean; thresholdRatio: boolean; retain: boolean; retries?: boolean };
  /** Round 22: sessions whose current historian episode already used its one backstop deferral. */
  private readonly backstopDeferred = new WeakSet<object>();

  constructor(ctx: Context, config: BasicCompactionConfig & { summarize?: SummarizeHook }) {
    super(ctx, { ...config, auto: config.auto ?? true });
    this.magicSummarize = config.summarize;
    this.explicitPressure = {
      headroomTokens: config.headroomTokens !== undefined,
      thresholdRatio: config.thresholdRatio !== undefined,
      retain: config.retainTokens !== undefined || config.retainRatio !== undefined,
      retries: (config as { compactionRetries?: number }).compactionRetries !== undefined,
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
   *    90 % native backstop for the default 65 % execute threshold, above MC's 85 % force band), supplied by the agent
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
    // Round 21 (P7): per-call diagnostics, not engine-instance fields — the
    // engine is shared by every session, so concurrent checks overwrote each
    // other's threshold.
    const note: PressureNote = {};
    const say = (outcome: string) => {
      try {
        // eslint-disable-next-line no-console
        console.error(
          `[magic-context] native pressure check: child=${isDshChildSession(agent)} pct=${probe.pct ?? "?"} thresholdPct=${note.thresholdPct ?? "?"} window=${probe.window ?? "?"} outcome=${outcome}`,
        );
      } catch {
        // diagnostics only
      }
    };
    try {
      const result = await this.pressureCompaction(agent, trigger, signal, probe, note);
      say(result === null ? (note.outcome ?? "none") : "compacted");
      return result;
    } catch (error) {
      say(`error:${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
      throw error;
    }
  }

  /** Round 23: last region committed per session during the current pressure check. */
  private readonly committedRegion = new WeakMap<object, CompactionResult>();

  /**
   * Round 23 — the MC main backstop compacts ONCE per pressure check.
   * compaction-basic retries while the session is still above the threshold;
   * on an MC main session the retry's region is the checkpoint the first
   * attempt just wrote, Magic renders the same compartments for it, and
   * compaction-basic rejects it ("summary is not smaller than the shadowed
   * content") — the whole check failed although the first compaction had
   * committed (real rc.5 e2e run 41625463298, 6 of 7 backstop compactions).
   * Unless the user set `compactionRetries` (top level or per route), main
   * sessions run with 0 retries, and "still above threshold" after a committed
   * compaction returns that compaction: what stays above the backstop is the
   * retained tail / already-summarized history, which MC's own pipeline
   * (historian, drops, pressure truncation) handles; the next check retries.
   */
  private async compactOnce(
    main: ResolvedConfig,
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const session = agent.session as unknown as object;
    const once = this.explicitPressure.retries === true ? main : withConfigOverrides(main, { compactionRetries: 0 });
    this.recordCommittedRegions();
    this.committedRegion.delete(session);
    try {
      return await this.withPressureConfig(once, () => super.compactIfNeeded(agent, trigger, signal));
    } catch (error) {
      const committed = this.committedRegion.get(session);
      const message = error instanceof Error ? error.message : String(error);
      if (this.explicitPressure.retries === true || committed === undefined || !/compaction still above threshold after/.test(message)) {
        throw error;
      }
      logInfo(
        this.ctx,
        `[magic-context] native pressure backstop compacted once; the session is still above it (${message.replace(/^compaction still above threshold after \d+ compaction attempts? /, "")}) — the rest is the retained tail / already-summarized history, left to Magic; the next pressure check retries`,
      );
      return committed;
    } finally {
      this.committedRegion.delete(session);
    }
  }

  /** Wrap the (possibly instance-overridden) `compactRegion` once so a committed region is remembered per session. */
  private recordCommittedRegions(): void {
    const self = this as unknown as {
      compactRegion: (start: unknown, end: unknown, agent: Agent, signal?: AbortSignal) => Promise<CompactionResult>;
    };
    const current = self.compactRegion as typeof self.compactRegion & { __magicRecords?: true };
    if (current.__magicRecords === true) return;
    const committed = this.committedRegion;
    const wrapped = async function (this: unknown, start: unknown, end: unknown, agent: Agent, signal?: AbortSignal) {
      const result = await current.call(this, start, end, agent, signal);
      committed.set(agent.session as unknown as object, result);
      return result;
    } as typeof current;
    wrapped.__magicRecords = true;
    self.compactRegion = wrapped;
  }

  private async describePressure(agent: Agent): Promise<{ pct?: number; window?: number; reserved?: number }> {
    try {
      const header = routeOf(agent);
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

  /**
   * Would the backstop fire now under `config`? Prices the same threshold the
   * debug probe does (window, reserved output, threshold ratio / headroom,
   * per-route override). Unknown window / pressure → treat as firing (the
   * deferral is the safe side: no compaction while the lease is busy).
   */
  private async backstopWouldFire(
    config: ResolvedConfig,
    agent: Agent,
    known?: { pct?: number; window?: number; reserved?: number },
  ): Promise<{ pct?: number; thresholdPct: number | string } | null> {
    const probe = known?.window !== undefined ? known : await this.describePressure(agent);
    if (probe.window === undefined || probe.pct === undefined) return { thresholdPct: "?" };
    const header = routeOf(agent);
    const override = config.modelPolicies.find((p) => p.provider === header?.provider && p.model === header?.model);
    const t = nativePressureThresholdTokens(probe.window, probe.reserved ?? 0, {
      thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
      headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    });
    if (t === null) return { pct: probe.pct, thresholdPct: "?" };
    const thresholdPct = Math.round((t / probe.window) * 1000) / 10;
    return probe.pct >= thresholdPct ? { pct: probe.pct, thresholdPct } : null;
  }

  private notePressureThreshold(
    config: ResolvedConfig,
    agent: Agent,
    probe?: { window?: number; reserved?: number },
    note?: PressureNote,
  ): void {
    if (probe?.window === undefined || note === undefined) return;
    const header = routeOf(agent);
    const override = config.modelPolicies.find((p) => p.provider === header?.provider && p.model === header?.model);
    const t = nativePressureThresholdTokens(probe.window, probe.reserved ?? 0, {
      thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
      headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    });
    note.thresholdPct = t === null ? undefined : Math.round((t / probe.window) * 1000) / 10;
  }

  private async pressureCompaction(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
    probe?: { window?: number; reserved?: number },
    note?: PressureNote,
  ): Promise<CompactionResult | null> {
    const base = this.config;
    if (!isDshChildSession(agent)) {
      const percentage = readHostNativePressurePercentage(this.ctx, agent);
      if (percentage === null) {
        this.notePressureThreshold(base, agent, probe, note);
        return super.compactIfNeeded(agent, trigger, signal);
      }
      const main = magicMainPressureConfig(base, this.explicitPressure, percentage);
      this.notePressureThreshold(main, agent, probe, note);
      // Round 21: a background historian pass holds the compartment lease, so
      // the Magic summarize hook could not run its mini-historian now (it would
      // wait, then close compaction/end with "lease busy"). The backstop is
      // DEFERRED instead — no compaction, no error — and the next pressure
      // check (every step) retries once the pass has finished.
      //
      // Round 22: ONE deferral per episode. Above MC's threshold the historian
      // re-fires as soon as a pass publishes, so the lease is held almost
      // continuously; deferring on every check let a real rc.5 session climb
      // 32 points past the backstop (scenario L, run 41619627652). The next
      // over-backstop check compacts even if a pass still runs — the summarize
      // hook waits (≤ 45 s) for its lease and usually renders what it covered.
      // The episode ends when a check finds the lease free or the session
      // back under the backstop.
      const session = agent.session as unknown as object;
      if (readHostHistorianBusy(this.ctx, agent)) {
        const deferred = await this.backstopWouldFire(main, agent, probe);
        if (deferred) {
          if (!this.backstopDeferred.has(session)) {
            this.backstopDeferred.add(session);
            if (note !== undefined) note.outcome = "deferred:historian-busy";
            logInfo(
              this.ctx,
              `[magic-context] native pressure backstop deferred: a historian pass is running for this session (pressure ${deferred.pct ?? "?"} % ≥ ${deferred.thresholdPct} %); the next pressure check retries`,
            );
            return null;
          }
          logInfo(
            this.ctx,
            `[magic-context] native pressure backstop already deferred once for this historian episode (pressure ${deferred.pct ?? "?"} % ≥ ${deferred.thresholdPct} %); compacting now — the summarize hook waits for the historian's lease`,
          );
        } else {
          this.backstopDeferred.delete(session);
        }
      } else {
        this.backstopDeferred.delete(session);
      }
      return this.compactOnce(main, agent, trigger, signal);
    }
    this.notePressureThreshold(base, agent, probe, note);
    try {
      return await super.compactIfNeeded(agent, trigger, signal);
    } catch (error) {
      if (this.explicitPressure.headroomTokens || !isDefaultHeadroomConfigError(error, this.explicitPressure.retain)) {
        throw error;
      }
      const legal = withConfigOverrides(base, { headroomTokens: 0 });
      this.notePressureThreshold(legal, agent, probe, note);
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
      const target = routeOf(agent);
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

/** Per-call pressure diagnostics (round 21, P7). */
interface PressureNote {
  thresholdPct?: number;
  outcome?: string;
}

/**
 * The session's provider/model/maxTokens route: the request header once the
 * session has made a request, else the agent's own options (round 21, P8 —
 * the first pressure check of a session has no request/context yet).
 */
function routeOf(agent: Agent): { provider?: string; model?: string; maxTokens?: number } {
  const header = (agent.session as unknown as {
    requestHeader?: () => { config?: { provider?: string; model?: string; maxTokens?: number } } | undefined;
  }).requestHeader?.()?.config;
  if (header?.provider && header.model) return header;
  const options = (agent as unknown as { options?: { provider?: string; model?: string; maxTokens?: number } }).options;
  return {
    provider: options?.provider,
    model: options?.model,
    maxTokens: header?.maxTokens ?? options?.maxTokens,
  };
}

/**
 * Round 21: is a Magic historian pass holding the compartment lease for this
 * session? Read through the host service (the agent plane registers the
 * probe). No probe / a throwing probe → false (never block the backstop).
 */
function readHostHistorianBusy(ctx: Context, agent: Agent): boolean {
  const host = ctx.get("magicContextHost") as { historianBusy?: (agent: unknown) => boolean } | undefined;
  if (typeof host?.historianBusy !== "function") return false;
  try {
    return host.historianBusy(agent) === true;
  } catch {
    return false;
  }
}

function logInfo(ctx: Context, line: string): void {
  try {
    (ctx as unknown as { logger?: { info?(m: string): void } }).logger?.info?.(line);
    // headless prints console.error, not ctx.logger
    // eslint-disable-next-line no-console
    if (process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN === "1") console.error(line);
  } catch {
    // observability only
  }
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
  overrides: { headroomTokens?: number; thresholdRatio?: number; compactionRetries?: number },
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
