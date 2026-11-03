/**
 * Agent plane entry — `/agent` subpath of dsh-magic-context
 * (Phase 2 slice A: knowledge mode).
 *
 * Mounted on the AGENT plane (host-side plugin scope that observes every
 * agent), this plugin composes the four knowledge-mode pieces:
 *
 *   - system-guidance  — static `## Magic Context` prompt section (cache-stable);
 *   - session-track    — session → project attribution (session_projects rows);
 *   - knowledge-gate   — first-step m[0]/m[1] injection via agent.inject(),
 *                        once per session per surface generation (pre-step);
 *   - auto-search      — `<ctx-search-hint>` vague-recall blocks on new user
 *                        messages (fired from inside the gate).
 *
 * All side effects are fiber-owned: every registration goes through ctx.on /
 * ctx.effect / the section disposer, so stop/update/reload unwinds them.
 * `inject` lists ONLY the hard dependency (the host service); the systemPrompt
 * service is optional and read via ctx.get-style structural access.
 */
import type { Context } from "@deepseek-ai/cordis";
import { escalationBands } from "@magic-context/core/shared/escalation-bands";
import { nativeBackstopPercentage } from "../compat/dsh-0.1/pressure-policy";
import { setDshHarness } from "dsh-magic-context-adapter";
import { fireAndForget } from "./fire-and-forget";
import type { MagicContextPluginConfig } from "@magic-context/core/config";
import { createConfigReloadNotices, loadPluginConfigQuiet, type LoadedMagicConfig } from "../settings/config-load";
import { getProtectedTokensTierOverrides } from "@magic-context/core/config/project-security";
import { isCompactionEnabled, isDreamerRunnable, isHistorianRunnable } from "@magic-context/core/config/agent-disable";
import type { MagicContextHostService } from "../index";
import { registerKnowledgeGate } from "./knowledge-gate";
import type { KnowledgeConfig } from "./knowledge-gate";
import { registerSystemGuidance } from "./system-guidance";
import type { GuidanceConfig } from "./system-guidance";
import { registerSessionProjectTracking } from "./session-track";
import type { SessionTrackOptions } from "./session-track";
import type { AutoSearchConfig } from "./auto-search";
import { registerCtxTools, type CtxToolsOptions } from "./tools";
import { registerCtxCommands, type CtxCommandsOptions } from "./commands";
import { registerContextPlane, type ContextPlaneConfig, type ContextPlaneHistorianConfig } from "./context-plane";
import {
  registerMagicHistorianPlane,
  createLlmSummarizeCall,
  readContextPressure,
  currentModel,
} from "./historian-wiring";
import {
  isDshHistorianBusy,
  runDshHistorian,
  signalDshDeferredHistoryRefresh,
  signalDshDeferredMaterialization,
} from "./historian";
import { createHistorianDrain, UNLOAD_DRAIN_MS } from "./historian-drain";
import { dshDreamSeams, registerDshDreamer } from "./dreamer";
import { prunePressureTruncations } from "./pressure-truncation";
import { pruneTerminalOutboxRows } from "./outbox";
import { createRecompSeams } from "./recomp";
import { createEmbedSeam } from "./embed";
import { registerOutputTagStrip } from "./output-tag-strip";
import { isAgentLoopRequest } from "../compat/dsh-0.1/session";
import { dshModelRefToCanonical } from "dsh-magic-context-adapter";
import { modelSupportsVision } from "@magic-context/core/shared/models-dev-cache";
import type { KnowledgeAgentView } from "./knowledge-gate";
import {
  resolveEffectiveSettings,
  resolveThresholds,
  type EffectiveMagicSettings,
  type MagicDshOverrides,
} from "../settings/magic-settings";

/**
 * Mural wiring (Phase 4): vision-gated image-block injection on the m0
 * baseline. The vision gate uses the canonical model (adapter-api map) with
 * the core models.dev cache — unknown models fail closed (no image). The data
 * URL produced by the m0 fold is persisted via ctx.attachments.saveImage.
 */
function createMuralWiring(
  ctx: Context,
  enabled: boolean,
): NonNullable<Parameters<typeof registerKnowledgeGate>[1]["mural"]> {
  return {
    enabled,
    supportsVision: (agent: KnowledgeAgentView) => {
      const { provider, model } = agent.options;
      if (!provider || !model) return false;
      const canonical = dshModelRefToCanonical(`${provider}/${model}`);
      const separator = canonical.indexOf("/");
      if (separator <= 0) return false;
      return modelSupportsVision(canonical.slice(0, separator), canonical.slice(separator + 1));
    },
    resolveImage: async (dataUrl: string) => {
      const attachments = ctx.get("attachments") as
        | { saveImage?: (input: { data: Uint8Array; mediaType: string; name?: string }) => Promise<unknown> }
        | undefined;
      if (attachments?.saveImage === undefined) return null;
      const match = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(dataUrl);
      if (match === null) return null;
      const attachment = await attachments.saveImage({
        data: Buffer.from(match[2]!, "base64"),
        mediaType: `image/${match[1]!}`,
        name: "magic-mural.png",
      });
      return { type: "image", attachment };
    },
  };
}

/** Cordis plugin name (loader diagnostics). */
export const name = "magic-context-agent";

/** Hard dependency: the host plugin's storage/bootstrap service. */
export const inject = ["magicContextHost"];

/** Agent-plane plugin configuration (all sections optional; defaults are knowledge-mode). */
export interface MagicAgentConfig {
  /** Session workspace directory (header cwd wins per session). */
  directory?: string;
  /** m[0]/m[1] knowledge gate options. */
  knowledge?: KnowledgeConfig;
  /** Static guidance section options. */
  guidance?: GuidanceConfig;
  /** Auto-search hint options. */
  autoSearch?: AutoSearchConfig;
  /** Session → project tracking options. */
  sessionTracking?: SessionTrackOptions;
  /** Context-management plane (Phase 3): transcript/coordinator pre-step gate. */
  context?: ContextPlaneConfig;
  /** Historian background-pass trigger (Phase 4): pressure threshold config. */
  historian?: ContextPlaneHistorianConfig;
  /** Dreamer scheduler (Phase 4): per-project background tasks. */
  dreamer?: { enabled?: boolean; tickMs?: number };
  /** ctx_* tool registration options. */
  tools?: CtxToolsOptions;
  /** /ctx-* command registration options. */
  commands?: CtxCommandsOptions;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Internal: raw `dreamer` section bridged from the shared config. */
  _dreamerCore?: unknown;
}

/** Read the host service provided by the host entry (inject guarantees it). */
export function readMagicContextHost(ctx: Context): MagicContextHostService | undefined {
  return (ctx as unknown as { magicContextHost?: MagicContextHostService }).magicContextHost;
}

/**
 * Bridge the shared `magic-context.jsonc` (user + project) into the agent-plane
 * options. Pi loads the config per session (loadPiConfig); DSH previously ran
 * the agent plane on schema defaults only — the file was validated by doctor
 * but never consumed at runtime. Every mapping is a fallback: explicit row
 * config (preset/tests) still wins.
 */
export function bridgeMagicConfig(
  config: MagicAgentConfig,
  directory: string,
): MagicAgentConfig {
  let magic: MagicContextPluginConfig | undefined;
  try {
    magic = loadPluginConfigQuiet(directory);
  } catch {
    magic = undefined;
  }
  if (magic === undefined) return config;
  const cfg = magic;
  const thresholdRaw = cfg.execute_threshold_percentage;
  const threshold: number | undefined =
    typeof thresholdRaw === "number"
      ? thresholdRaw
      : typeof thresholdRaw === "object" && thresholdRaw !== null
        ? (typeof (thresholdRaw as { default?: unknown }).default === "number"
            ? (thresholdRaw as { default: number }).default
            : undefined)
        : undefined;
  const memoryCfg = cfg.memory;
  const dreamerCfg = cfg.dreamer;
  const compactionCfg = cfg.compaction;
  const muralCfg = cfg.mural;
  const commitCluster = cfg.commit_cluster_trigger;
  return {
    ...config,
    knowledge: {
      ...config.knowledge,
      injectDocs: config.knowledge?.injectDocs ?? dreamerCfg?.inject_docs ?? true,
      compactionOff:
        config.knowledge?.compactionOff ?? compactionCfg?.enabled === false,
      memoryInjectionBudgetTokens:
        config.knowledge?.memoryInjectionBudgetTokens ?? memoryCfg?.injection_budget_tokens,
      muralEnabled: config.knowledge?.muralEnabled ?? muralCfg?.enabled ?? false,
      cacheTtl: config.knowledge?.cacheTtl ?? (typeof cfg.cache_ttl === "string" ? cfg.cache_ttl : undefined),
    },
    context: {
      ...config.context,
      protectedTags: config.context?.protectedTags ?? cfg.protected_tags,
      protectedTokens: config.context?.protectedTokens ?? cfg.protected_tokens,
      protectedTokenTierOverrides:
        config.context?.protectedTokenTierOverrides ?? getProtectedTokensTierOverrides(cfg),
      heuristicCleanup:
        config.context?.heuristicCleanup ??
        (() => {
          const caveman = cfg.caveman_text_compression;
          if (typeof caveman !== "object" || caveman === null) return undefined;
          const raw = caveman as { enabled?: unknown; min_chars?: unknown };
          return {
            caveman: {
              enabled: raw.enabled === true,
              minChars:
                typeof raw.min_chars === "number" && raw.min_chars > 0
                  ? raw.min_chars
                  : 500,
            },
          };
        })(),
    },
    historian: {
      ...config.historian,
      executeThresholdPercentage: config.historian?.executeThresholdPercentage ?? threshold,
      model: config.historian?.model ?? coreHistorianModel(cfg.historian),
      commitClusterTrigger:
        config.historian?.commitClusterTrigger ??
        (commitCluster !== undefined
          ? { enabled: commitCluster.enabled ?? true, min_clusters: commitCluster.min_clusters ?? 3 }
          : undefined),
    },
    autoSearch: {
      ...config.autoSearch,
      enabled: config.autoSearch?.enabled ?? memoryCfg?.auto_search?.enabled ?? true,
    },
    tools: {
      ...config.tools,
      memoryToolEnabled: config.tools?.memoryToolEnabled ?? memoryCfg?.enabled !== false,
      dreamerEnabled: config.tools?.dreamerEnabled ?? isDreamerRunnable(cfg),
      compactionOff: config.tools?.compactionOff ?? !isCompactionEnabled(cfg),
      protectedTags: config.tools?.protectedTags ?? cfg.protected_tags,
      protectedTokens: config.tools?.protectedTokens ?? cfg.protected_tokens,
      protectedTokenTierOverrides:
        config.tools?.protectedTokenTierOverrides ?? getProtectedTokensTierOverrides(cfg),
    },
    guidance: {
      ...config.guidance,
      directory: config.guidance?.directory ?? directory,
      protectedTags: config.guidance?.protectedTags ?? cfg.protected_tags,
      ctxReduceCallable: config.guidance?.ctxReduceCallable ?? isCompactionEnabled(cfg),
      dreamerEnabled: config.guidance?.dreamerEnabled ?? isDreamerRunnable(cfg),
      temporalAwarenessEnabled:
        config.guidance?.temporalAwarenessEnabled ?? cfg.temporal_awareness === true,
      cavemanTextCompressionEnabled:
        config.guidance?.cavemanTextCompressionEnabled ??
        (typeof cfg.caveman_text_compression === "object" &&
        cfg.caveman_text_compression !== null &&
        (cfg.caveman_text_compression as { enabled?: unknown }).enabled === true),
      memoryEnabled: config.guidance?.memoryEnabled ?? memoryCfg?.enabled !== false,
      promptSurface: config.guidance?.promptSurface ?? cfg.prompt_surface,
    },
    commands: {
      ...config.commands,
      executeThresholdPercentage: config.commands?.executeThresholdPercentage ?? threshold,
      executeThresholdTokens: config.commands?.executeThresholdTokens ?? cfg.execute_threshold_tokens,
      historyBudgetPercentage: config.commands?.historyBudgetPercentage ?? cfg.history_budget_percentage,
      commitClusterTrigger:
        config.commands?.commitClusterTrigger ??
        (commitCluster !== undefined
          ? { enabled: commitCluster.enabled ?? true, min_clusters: commitCluster.min_clusters ?? 3 }
          : undefined),
      compactionOff: config.commands?.compactionOff ?? compactionCfg?.enabled === false,
    },
    dreamer: {
      ...config.dreamer,
      // 核心语义：dreamer 段存在且未 disable 即可运行（schema 无 enabled 键）
      enabled: config.dreamer?.enabled ?? isDreamerRunnable(cfg),
    },
    _dreamerCore: dreamerCfg,
  };
}

/** Raw `dreamer` section of the shared config (bridged by bridgeMagicConfig). */
export function dreamerCoreConfigOf(config: MagicAgentConfig): unknown {
  return (config as unknown as { _dreamerCore?: unknown })._dreamerCore;
}

/**
 * Live view over the DSH settings overlay (host `magic-host` volatile Config).
 * Each getter re-reads the host overrides, so a `settings.mutate` edit applies
 * on the next step without remounting the agent plane. Row config set
 * explicitly to `enabled: false` (preset/tests) always wins.
 */
export interface MagicLiveSettings {
  overrides(): MagicDshOverrides;
  effective(): EffectiveMagicSettings;
  enabled(): boolean;
  thresholdFor(agent: { options?: { provider?: string; model?: string } }, contextWindow?: number): number;
}

/**
 * How long the live view trusts its last magic-context.jsonc read. Same order
 * as the settings page's cache (host/remote.ts, 3 s) so the page and the agent
 * plane agree within a few seconds of an edit, without a file read per step.
 */
export const LIVE_JSONC_TTL_MS = 3_000;

export function createLiveSettings(
  host: Pick<MagicContextHostService, "overrides">,
  directory: string,
  opts: {
    now?: () => number;
    ttlMs?: number;
    /** jsonc loader (tests); default: the process-wide quiet core loader. */
    load?: (directory: string) => LoadedMagicConfig;
    /**
     * Round 20: receives each config warning once and a notice when a
     * restart-only section (memory / dreamer / compaction / …) changed since
     * startup. When set, the startup config is read eagerly as the baseline.
     */
    warn?: (message: string) => void;
  } = {},
): MagicLiveSettings {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? LIVE_JSONC_TTL_MS;
  const load = opts.load ?? loadPluginConfigQuiet;
  const notices = opts.warn !== undefined ? createConfigReloadNotices(opts.warn) : undefined;
  // Re-read the shared jsonc with a short TTL (round 15): it used to be read
  // once at apply time, so a jsonc edit showed up as the effective value on the
  // settings page while the agent kept the old enabled/threshold until restart.
  let cache: { at: number; value: MagicContextPluginConfig | undefined } | undefined;
  const jsonc = (): MagicContextPluginConfig | undefined => {
    const t = now();
    if (cache !== undefined && t - cache.at < ttlMs) return cache.value;
    let value: MagicContextPluginConfig | undefined;
    try {
      value = load(directory);
    } catch {
      value = undefined;
    }
    cache = { at: t, value };
    notices?.observe(value as LoadedMagicConfig | undefined);
    return value;
  };
  if (notices !== undefined) jsonc();
  const overrides = () => {
    try {
      return host.overrides?.() ?? {};
    } catch {
      return {};
    }
  };
  const effective = () => resolveEffectiveSettings(jsonc(), overrides());
  return {
    overrides,
    effective,
    enabled: () => effective().enabled.value,
    thresholdFor: (agent, contextWindow) => {
      const { provider, model } = agent.options ?? {};
      const ref = provider && model ? `${provider}/${model}` : undefined;
      return resolveThresholds(effective(), ref, contextWindow).executePercentage;
    },
  };
}

/** Overlay a getter onto a config section (spreads would freeze the value). */
function withGetters<T extends object>(base: T | undefined, getters: Record<string, () => unknown>): T {
  const out = { ...(base ?? {}) } as T;
  for (const [key, get] of Object.entries(getters)) {
    Object.defineProperty(out, key, { get, enumerable: true, configurable: true });
  }
  return out;
}

export function apply(ctx: Context, config: MagicAgentConfig = {}): void {
  // The AGENT plane is a separate bundle from the host plane: each inlines its
  // own copy of the core's harness module, so the host's setDshHarness() never
  // reaches the storage calls this plane makes (session_meta / session_projects
  // / compartments…). Lock "dsh" HERE too, before any DB write — the core's
  // setHarness is idempotent for the same value and throws only on a mismatch.
  setDshHarness();
  // Explicit row thresholds (preset/tests) are final; captured before the
  // jsonc bridge fills the default.
  const explicitThreshold = config.historian?.executeThresholdPercentage;
  config = bridgeMagicConfig(config, config.directory ?? process.cwd());
  const host = readMagicContextHost(ctx);
  if (!host) {
    throw new Error("magic-context-agent: magicContextHost service unavailable");
  }
  const log = (message: string) => ctx.logger?.info?.(message);
  const directory = config.directory ?? process.cwd();

  // DSH settings overlay (live). Explicit row `enabled: false` stays final.
  const live = createLiveSettings(host, directory, {
    warn: (message) => (ctx.logger?.warn ?? ctx.logger?.info)?.call(ctx.logger, message),
  });
  const rowContext = config.context;
  const rowHistorian = config.historian;
  const rowKnowledge = config.knowledge;
  const liveEnabled = () => live.enabled();
  config = {
    ...config,
    context: withGetters(rowContext, {
      enabled: () => (rowContext?.enabled === false ? false : liveEnabled()),
      protectedTokens: () => live.overrides().protectedTokens ?? rowContext?.protectedTokens,
    }),
    historian: withGetters(rowHistorian, {
      enabled: () => (rowHistorian?.enabled === false ? false : liveEnabled()),
      executeThresholdPercentage: () => {
        const o = live.overrides();
        return o.executeThresholdPercentage !== undefined || o.executeThresholdByModel !== undefined
          ? resolveThresholds(live.effective(), undefined).executePercentage
          : rowHistorian?.executeThresholdPercentage;
      },
      model: () => live.overrides().historianModel ?? rowHistorian?.model,
      awaitAtTurnEndMs: () => live.overrides().historianAwaitAtTurnEndMs ?? rowHistorian?.awaitAtTurnEndMs,
    }),
    knowledge: withGetters(rowKnowledge, {
      enabled: () => (rowKnowledge?.enabled === false ? false : liveEnabled()),
    }),
  };
  const historianModel = () => config.historian?.model;

  registerSystemGuidance(ctx, { config: config.guidance, log });

  // Persistence-boundary strip of copied `§N§` notation from assistant text
  // (upstream: OpenCode experimental.text.complete / Pi message_end). Without
  // it every reply reached the user as "§8§ …" (round 17 real rc.5, C5).
  registerOutputTagStrip(ctx as never, { isAgentLoopRequest: isAgentLoopRequest as never, isEnabled: liveEnabled, log });

  // Background historian passes are fire-and-forget; one-shot hosts (dsh
  // headless) unload right after the turn, so give in-flight passes a bounded
  // window to publish (DSH grants ~5 s for shutdown; cordis awaits async
  // disposers). See historian-drain.ts.
  const historianDrain = createHistorianDrain();
  ctx.effect(() => async () => {
    if (historianDrain.pending() === 0) return;
    const result = await historianDrain.drain(UNLOAD_DRAIN_MS);
    log(
      `[magic-context] historian unload drain: settled=${result.settled} pending=${result.pending} waited=${result.waitedMs}ms`,
    );
  }, "magic-context:historian-drain");

  registerSessionProjectTracking(ctx, {
    host,
    directory,
    config: config.sessionTracking,
    log,
  });

  // Explicit row thresholds (tests/presets) win; otherwise the core resolver
  // over jsonc + DSH overlay picks the per-model value.
  const resolveExecuteThreshold = (agent: unknown): number => {
    const o = live.overrides();
    if (
      explicitThreshold !== undefined &&
      o.executeThresholdPercentage === undefined &&
      o.executeThresholdByModel === undefined
    ) {
      return explicitThreshold;
    }
    const a = agent as { options?: { provider?: string; model?: string } };
    return live.thresholdFor(a);
  };

  // Round 19: DSH-native pressure compaction stays BEHIND MC on main sessions
  // — the compaction engine prices its threshold at the native backstop for the
  // route: max(90, MC force band + 5), cap 98 (force band = core escalationBands:
  // max(85, execute + 2)). A
  // context-disabled row / live-disabled MC returns undefined → native defaults.
  host.registerNativePressurePercentage?.((agent) => {
    if (rowContext?.enabled === false || !liveEnabled()) return undefined;
    return nativeBackstopPercentage(escalationBands(resolveExecuteThreshold(agent)).forceMaterializationPercentage);
  });

  // Round 21: the native pressure backstop defers (no "lease busy" error)
  // while a historian pass holds this session's compartment lease. The probe
  // needs the shared DB, which settles with host.ready; before that → false.
  let busyDb: import("@magic-context/core/shared/sqlite").Database | undefined;
  fireAndForget(
    host.ready.then((bootstrap) => {
      if (bootstrap.kind === "ok") busyDb = bootstrap.db;
    }),
    log,
    "magic-context:historian-busy-probe",
  );
  host.registerHistorianBusy?.((agent) => {
    const id = (agent as { id?: unknown }).id;
    if (busyDb === undefined || typeof id !== "string") return false;
    return isDshHistorianBusy(busyDb, host.canonicalKey(id));
  });

  // Context plane FIRST, so the knowledge gate below stays the outermost
  // pre-step listener (Phase 2 contract). The plane runs after it (inner):
  // outbox reconciliation + plan derivation + serialized surface application
  // + the historian context-pressure trigger (fire-and-forget background pass).
  registerContextPlane(ctx, {
    host,
    config: config.context,
    directory,
    isEnabled: liveEnabled,
    historian: {
      config: config.historian,
      readPressure: readContextPressure(ctx),
      // Explicit row thresholds (tests/presets) win; otherwise the core
      // resolver over jsonc + DSH overlay picks the per-model value.
      resolveExecuteThreshold,
      fire: ({ db, sessionId, directory: fireDirectory, provider, contextWindow }) => {
        // Fire-and-forget: the pass publishes atomically and only signals
        // deferred work; it must never block the pre-step chain.
        const pass = runDshHistorian({
          db,
          sessionId,
          directory: fireDirectory,
          provider,
          summarize: createLlmSummarizeCall(ctx, historianModel),
          model: currentModel(ctx),
          currentContextLimit: contextWindow,
          onPublished: () => {
            signalDshDeferredHistoryRefresh(sessionId);
            signalDshDeferredMaterialization(sessionId);
          },
          log,
        }).catch((error: unknown) => {
          log(`[magic-context] historian pass failed (background): ${error instanceof Error ? error.message : String(error)}`);
        });
        historianDrain.track(sessionId, pass);
      },
      drain: historianDrain,
    },
    log,
  });

  // Historian plane: the Magic compaction summarize hook (compartment digest
  // + sync mini-historian) registered on the host service, read back by the
  // compaction entry bundle at summarize() time (cross-bundle singleton).
  registerMagicHistorianPlane(ctx, {
    host,
    directory,
    model: historianModel,
    log,
  });

  // Dreamer plane: per-project background scheduler (core lease/gate/telemetry
  // reused; self-built ctx timers — see dreamer.ts module doc for the
  // deviation from the core's process-singleton timer).
  registerDshDreamer(ctx, {
    host,
    directory,
    config: config.dreamer,
    coreConfig: dreamerCoreConfigOf(config),
    log,
  });

  registerKnowledgeGate(ctx, {
    host,
    config: withGetters({ ...(config.knowledge ?? {}), directory }, {
      enabled: () => (rowKnowledge?.enabled === false ? false : liveEnabled()),
    }),
    autoSearch: config.autoSearch ?? {},
    mural: createMuralWiring(ctx, config.knowledge?.muralEnabled === true),
    now: config.now,
    log,
  });

  // Tools + commands: registered on the agent plane (visible to every session
  // joining the magic-standard preset); the host service supplies the shared
  // DB and canonical session-key derivation.
  const runtime = {
    canonicalKey: (dshSessionId: string) => host.canonicalKey(dshSessionId),
    resolveProjectIdentity: undefined,
    log,
  };
  registerCtxTools(ctx, { ...runtime, ...(config.tools ?? {}) });

  // Phase 4 seams: dreamer / recomp. The seam factories need the
  // shared DB, which the host bootstrap resolves asynchronously; fill the
  // seams lazily once `host.ready` settles (the commands read them at
  // invocation time and answer "not wired" until then).
  const seams = new Map<string, unknown>();
  fireAndForget(host.ready.then((bootstrap) => {
    if (bootstrap.kind !== "ok") return;
    seams.set(
      "dreamer",
      dshDreamSeams(ctx, {
        db: bootstrap.db,
        log,
        compactionOff: config.commands?.compactionOff === true,
      }),
    );
    seams.set("recomp", createRecompSeams({ ctx, host, directory, db: bootstrap.db, log }));
    // S6 (round 15): one startup prune of pressure-truncation rows that can
    // never be replayed again (dropped/compacted tags, cleared sessions).
    // Never touches rows of active tags, so replay stays byte-identical.
    try {
      const { deleted } = prunePressureTruncations(bootstrap.db);
      if (deleted > 0) log(`[magic-context] pressure truncations: pruned ${deleted} unreplayable row(s)`);
    } catch (error) {
      log(`[magic-context] pressure truncation prune failed (fail-open): ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const pruned = pruneTerminalOutboxRows(bootstrap.db);
      if (pruned > 0) log(`[magic-context] outbox: pruned ${pruned} terminal row(s) older than 14 days`);
    } catch (error) {
      log(`[magic-context] outbox prune failed (fail-open): ${error instanceof Error ? error.message : String(error)}`);
    }
  }), log, "dreamer/recomp seam setup");
  registerCtxCommands(ctx, {
    ...runtime,
    ...(config.commands ?? {}),
    get dreamer() {
      return seams.get("dreamer") as ReturnType<typeof dshDreamSeams> | undefined;
    },
    get runRecomp() {
      return (seams.get("recomp") as ReturnType<typeof createRecompSeams> | undefined)?.runRecomp;
    },
    get runWrapup() {
      return (seams.get("recomp") as ReturnType<typeof createRecompSeams> | undefined)?.runWrapup;
    },
    // The embed seam receives the DB at call time (no host dependency).
    runEmbedDrain: createEmbedSeam({ log }),
  });

  log(
    `[magic-context] agent plane ready: knowledge=${config.knowledge?.enabled !== false} ` +
      `guidance=${config.guidance?.enabled !== false} autoSearch=${config.autoSearch?.enabled !== false} ` +
      `sessionTracking=${config.sessionTracking?.enabled !== false} directory=${directory}`,
  );
}

/**
 * Historian model from the core config. Core ≥0.49 moved it into per-harness
 * blocks (`historian.opencode.model`, entry string or `{ model }` object); the
 * legacy flat `historian.model` string is still honoured. DSH model refs are
 * `provider/model` strings, so the `opencode` block is the one that applies.
 */
function coreHistorianModel(historian: unknown): string | undefined {
  const h = historian as { model?: unknown; opencode?: { model?: unknown } } | undefined;
  if (typeof h?.model === "string") return h.model;
  const entry = h?.opencode?.model;
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof (entry as { model?: unknown }).model === "string") {
    return (entry as { model: string }).model;
  }
  return undefined;
}
