/**
 * Host half of dsh-magic-context (Phase 1 boundary).
 *
 * The bundle patch (cordis.patch.yml) mounts this row on the HOST plane:
 *   - id: magic-host
 *     name: 'dsh-magic-context'
 *     inject: []
 *
 * It boots the shared Magic SQLite store (with the DSH liveness marker), then
 * provides `ctx.magicContextHost` — the single host service the agent plane
 * and the Typert Remote consume. Full tool/command/dreamer registration lands
 * in Phase 2; this entry pins the boot contract and the service identity.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  bootstrapDshStorage,
  type DshStorageBootstrap,
} from "./host/bootstrap";
import { canonicalSessionKey, parseDshSessionKey } from "dsh-magic-context-adapter";
import { DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE } from "./compat/dsh-0.1/pressure-policy";
import {
  buildMagicHostConfigSchema,
  readMagicOverrides,
  type MagicDshOverrides,
} from "./settings/magic-settings";

/** Cordis plugin name (loader diagnostics). */
export const name = "magic-context-dsh";

/**
 * Host Config (schemastery): ordinary boot fields + the volatile DSH override
 * layer edited from the settings page (see settings/magic-settings.ts for the
 * precedence rules). `undefined` when the host's schemastery is unresolvable.
 */
export const Config = buildMagicHostConfigSchema();

/** Host plugin configuration. */
export interface MagicHostConfig {
  /** Workspace/directory identity for config migration + liveness marker. */
  directory?: string;
  /** Loopback port for the liveness marker (0 in headless runs). */
  port?: number;
  /** SHA-256 first-8-hex of the DSH home for canonical session keys. */
  homeHash?: string;
  /** Volatile DSH overrides (cosmokit refs at runtime; plain values in tests). */
  enabled?: unknown;
  historianModel?: unknown;
  historianAwaitAtTurnEndMs?: unknown;
  executeThresholdPercentage?: unknown;
  executeThresholdByModel?: unknown;
  protectedTokens?: unknown;
}

/** The host service the adapter's planes consume. */
export interface MagicContextHostService {
  /** Settles once the storage bootstrap finishes (ok or refused). */
  readonly ready: Promise<DshStorageBootstrap>;
  /** Canonical Magic session key for a DSH session. */
  canonicalKey(dshSessionId: string): string;
  /** Parse a canonical key back to the DSH-native session id. */
  parseKey(key: string): { homeHash: string; dshSessionId: string } | undefined;
  /**
   * Register the Magic compaction summarize hook. The agent plane registers it
   * at apply time; the compaction entry bundle reads it through the host
   * service (cross-bundle singleton — a module-level registry would be
   * duplicated per bundle).
   */
  registerSummarizeHook(hook: MagicSummarizeHook): void;
  /** The registered hook, if any (compaction engine bundle reads this). */
  summarizeHook(): MagicSummarizeHook | undefined;
  /**
   * Round 19: the agent plane registers how high DSH-native pressure
   * compaction may let an MC-managed main session climb (MC's
   * force-materialization band for the route); the compaction engine bundle
   * reads it through `nativePressurePercentage`. `undefined` = MC is not
   * managing that session (keep DSH's native defaults). Optional for older
   * host stand-ins.
   */
  registerNativePressurePercentage?(fn: (agent: unknown) => number | undefined): void;
  nativePressurePercentage?(agent: unknown): number | undefined;
  /**
   * Round 21: the agent plane registers a probe telling whether a Magic
   * historian pass holds the compartment lease of a session; the compaction
   * engine defers the native pressure backstop while it does (no
   * "lease busy" compaction error). Optional for older host stand-ins.
   */
  registerHistorianBusy?(fn: (agent: unknown) => boolean): void;
  historianBusy?(agent: unknown): boolean;
  /**
   * Round 21: the jsonc the running agent plane started with (restart-only
   * sections run with it); the settings page shows changed sections as
   * "running value · pending restart: new value". Optional.
   */
  registerRunningConfig?(fn: () => unknown): void;
  runningConfig?(): unknown;
  /**
   * Current DSH override layer (dereferenced on every call, so live
   * `settings.mutate` edits apply without a remount). Optional for older
   * host stand-ins.
   */
  overrides?(): MagicDshOverrides;
}

/**
 * The compaction summarize hook contract (structural view — the pinned
 * SummarizationInput/SummaryResult types live in compat/dsh-0.1/compaction).
 */
export type MagicSummarizeHook = (
  input: unknown,
  agent: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Register the host service on `ctx` (idempotent per fiber). */
export function apply(ctx: Context, config: MagicHostConfig = {}): void {
  const directory = config.directory ?? process.cwd();
  const homeHash = config.homeHash ?? defaultHomeHash();
  const ready = bootstrapDshStorage({
    directory,
    port: config.port ?? 0,
    homeHash,
    log: (message) => ctx.logger?.info?.(message),
  });
  let summarizeHook: MagicSummarizeHook | undefined;
  let nativePressure: ((agent: unknown) => number | undefined) | undefined;
  let historianBusy: ((agent: unknown) => boolean) | undefined;
  let runningConfig: (() => unknown) | undefined;
  const host: MagicContextHostService = {
    ready,
    canonicalKey(dshSessionId: string): string {
      return canonicalSessionKey(homeHash, dshSessionId);
    },
    parseKey(key: string) {
      return parseDshSessionKey(key);
    },
    registerSummarizeHook(hook: MagicSummarizeHook): void {
      summarizeHook = hook;
    },
    summarizeHook(): MagicSummarizeHook | undefined {
      return summarizeHook;
    },
    registerNativePressurePercentage(fn: (agent: unknown) => number | undefined): void {
      nativePressure = fn;
    },
    nativePressurePercentage(agent: unknown): number | undefined {
      // No agent plane yet: MC's default force band (the engine's own default).
      return nativePressure === undefined ? DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE : nativePressure(agent);
    },
    registerHistorianBusy(fn: (agent: unknown) => boolean): void {
      historianBusy = fn;
    },
    historianBusy(agent: unknown): boolean {
      return historianBusy === undefined ? false : historianBusy(agent);
    },
    registerRunningConfig(fn: () => unknown): void {
      runningConfig = fn;
    },
    runningConfig(): unknown {
      return runningConfig?.();
    },
    overrides(): MagicDshOverrides {
      return readMagicOverrides(config);
    },
  };
  ctx.provide("magicContextHost", host);
  // Unload/reload (round 15): release this instance's liveness marker so a
  // process that keeps running without the host no longer makes the core
  // migration guard treat Magic Context as live here. The shared DB stays open
  // (core keeps one connection per path; a reload reuses it).
  if (typeof (ctx as unknown as { effect?: unknown }).effect === "function") {
    ctx.effect(
      () => () => {
        void ready.then(
          (outcome) => {
            if (outcome.kind === "ok") outcome.release?.();
          },
          () => {
            // A failed bootstrap already removed its marker.
          },
        );
      },
      "magic-context:host-liveness",
    );
  }
  // This bundle ships its own settings page (settings.section), so opt out of
  // schema auto-generation. Optional: the host runs without dsh-settings.
  const inject = (ctx as unknown as {
    inject?: (deps: string[], callback: (child: Context) => void) => unknown;
    fiber?: unknown;
  });
  if (typeof inject.inject === "function") {
    try {
      inject.inject(["settings"], (child) => {
        const settings = (child as unknown as { settings?: { configure?: (p: { auto?: boolean }, owner?: unknown) => () => void } }).settings;
        if (typeof settings?.configure !== "function") return;
        child.effect(() => settings.configure!({ auto: false }, inject.fiber), "magic-context:settings-page-policy");
      });
    } catch {
      // Settings policy is cosmetic; never block the host boot.
    }
  }
  // The `magicContext` Typert Remote is registered by the dedicated
  // `/remote` bundle row (`dsh-magic-context/remote`), NOT here —
  // the loader mounts both rows, so registering in both double-provides
  // `magicContextRemote` and fails the tree.
}

/** Deterministic home hash (first 8 hex of sha256 of the DSH home path). */
export function defaultHomeHash(): string {
  const home = process.env.DSH_HOME ?? requireHome();
  return hash8(home);
}

function requireHome(): string {
  // Fall back to the OS home; DSH always sets DSH_HOME in launched profiles.
  return process.env.HOME ?? process.env.USERPROFILE ?? "unknown-home";
}

function hash8(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
