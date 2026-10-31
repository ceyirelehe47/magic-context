/**
 * Token-floor protection window for the DSH adapter (core parity).
 *
 * Magic Context core ≥0.49 protects the newest tool output by TOKEN MASS, not
 * by tag count: `features/magic-context/protection-window.ts` walks the
 * persisted tool rows newest-first accumulating `COALESCE(token_count, 0)`
 * (×`toolsRatio`) until the floor is reached, plus a structural minimum of the
 * newest three distinct tool tags. The floor itself is an epoch snapshot
 * (`session_meta.protected_tokens_effective`) resolved by
 * `resolveEpochFloorForPass`: an explicit `protected_tokens` override, else the
 * derived default `clamp(round(0.05 × usableSoft), min(16k, round(0.08 ×
 * usableSoft)), 64k)`; it moves only on cache-busting passes.
 *
 * This module does NOT re-implement any of that — it only supplies the DSH
 * inputs (usable window, cache-bust signal, config) and calls the core
 * functions. `token_count` on tag rows is written by the shared
 * `tagTranscript` through core `estimateTokens`, i.e. the `ai-tokenizer`
 * dependency this package already declares.
 *
 * The legacy count knob (`protected_tags`) is ignored for behaviour, exactly as
 * core treats it (deprecated, "use protected_tokens instead").
 */
import {
  getProtectionWindowForSession,
  type ProtectionWindowResult,
} from "@magic-context/core/features/magic-context/protection-window";
import {
  getObservedEpochFloor,
  resolveEpochFloorForPass,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { deriveDefaultProtectedTokens } from "@magic-context/core/config/schema/magic-context";
import type { ProtectedTokensTierOverrides } from "@magic-context/core/config/project-security";
import type { Database } from "@magic-context/core/shared/sqlite";

/** Shared 128k fallback window (same default the historian budget uses). */
export const DSH_DEFAULT_USABLE_SOFT = 128_000;

export interface DshProtectionOptions {
  /** Absolute `protected_tokens` override (core-validated: 4_000..1_000_000). */
  readonly protectedTokens?: number;
  /** Trusted user / project tiers from `loadPluginConfig` (project may only raise). */
  readonly tierOverrides?: ProtectedTokensTierOverrides;
  /** DSH-reported model context window (request/context or token-meter). */
  readonly contextWindow?: number;
  /** True on a pass that rewrote the surface (DSH analogue of a cache bust). */
  readonly cacheBusting?: boolean;
  readonly log?: (message: string) => void;
}

export interface DshProtectionWindow {
  readonly floor: number;
  readonly protectedTagNumbers: ReadonlySet<number>;
  /** Tag-number cutoff (null = the session has no persisted tool rows). */
  readonly protectedCutoff: number | null;
  readonly window: ProtectionWindowResult;
}

/** Usable soft window for the derived floor. DSH reports one window number. */
export function dshUsableSoft(contextWindow: number | undefined): number {
  return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : DSH_DEFAULT_USABLE_SOFT;
}

/**
 * Resolve this pass's floor through the core 4-stage epoch lifecycle
 * (persisted snapshot on defer passes; re-resolve + persist on a bust).
 */
export function resolveDshProtectionFloor(
  db: Database,
  sessionId: string,
  opts: DshProtectionOptions = {},
): number {
  return resolveEpochFloorForPass(db, sessionId, {
    configuredOverride: opts.protectedTokens,
    tierOverrides: opts.tierOverrides,
    usableSoft: dshUsableSoft(opts.contextWindow),
    isCacheBustingPass: opts.cacheBusting === true,
    onRejectedProjectOverride: opts.log,
  }).floor;
}

/** Plan-time window: resolves (and on a bust persists) the epoch floor. */
export function tokenProtectionWindow(
  db: Database,
  sessionId: string,
  opts: DshProtectionOptions = {},
): DshProtectionWindow {
  const floor = resolveDshProtectionFloor(db, sessionId, opts);
  return toDshWindow(floor, getProtectionWindowForSession(db, sessionId, floor));
}

/**
 * Read-only window (tools / nudges): the observed epoch floor, exactly like
 * core `tool-registry` (`getObservedEpochFloor`). Before any pass observed a
 * floor it falls back to the override/derived value without writing state.
 */
export function observedProtectionWindow(
  db: Database,
  sessionId: string,
  opts: DshProtectionOptions = {},
): DshProtectionWindow {
  const observed = getObservedEpochFloor(db, sessionId);
  const override = opts.tierOverrides?.user ?? opts.protectedTokens;
  const floor =
    observed ??
    (typeof override === "number" && Number.isInteger(override) && override >= 4000 && override <= 1_000_000
      ? override
      : deriveDefaultProtectedTokens(dshUsableSoft(opts.contextWindow)));
  return toDshWindow(floor, getProtectionWindowForSession(db, sessionId, floor));
}

function toDshWindow(floor: number, window: ProtectionWindowResult): DshProtectionWindow {
  return {
    floor,
    protectedTagNumbers: window.protectedTagNumbers,
    protectedCutoff: window.cutoff,
    window,
  };
}
