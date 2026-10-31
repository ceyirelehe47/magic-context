/**
 * host/meter — the Magic Context context meter (host plane).
 *
 * Why this exists: the native composer ContextMeter (dsh-client-ui-conversation)
 * is hard-wired into the InputBar and renders whenever the `contextPressure`
 * session projection exists. That projection is registered by the stock
 * `token-meter` row, which also provides `ctx.tokenMeter` — a HARD inject of
 * `@deepseek-ai/dsh-compaction-tool-result-pruner` (root row and every web
 * preset's compaction group) — plus the `tokenUsage` / `contextBreakdown`
 * projections other native UI reads.
 *
 * So `setup` disables the stock `token-meter` row and mounts this row instead.
 * It runs the REAL `TokenMeter` service inside a child context whose
 * `sessionProjections` is a key-renaming facade:
 *
 *   - `contextPressure`  → wrapped as `magicContextPressure` (adds the MC
 *     thresholds, model route, preset and on/off state) — the native meter
 *     never sees its key, so it stays hidden;
 *   - `tokenUsage`, `contextBreakdown` → registered UNCHANGED under their
 *     native keys (status-bar usage figures, composition breakdown);
 *   - `ctx.tokenMeter` is provided globally as before (the pruner keeps
 *     working).
 *
 * The folds are token-meter's own (no copy, no drift). If the stock row is
 * still mounted (setup not run, or a hand patch), the meter only adds the
 * wrapped key next to the native one and logs why both indicators show.
 *
 * Purity: projection `apply` is a pure fold over session events; the
 * thresholds in the VIEW come from the live settings overlay at view time.
 * Views are cached until the state changes, so a threshold edit shows on the
 * next session event (the popover's `magicContext/context` read is fresh).
 */
import { Context } from "@deepseek-ai/cordis";

/** The MC projection key the composer indicator reads. */
export const MAGIC_PRESSURE_KEY = "magicContextPressure" as const;

/** The stock token-meter key the native ContextMeter reads (never registered by us). */
export const NATIVE_PRESSURE_KEY = "contextPressure" as const;

/** Native keys passed through unchanged. */
export const PASSTHROUGH_KEYS = ["tokenUsage", "contextBreakdown"] as const;

/** Version offset over the wrapped token-meter unit's stateVersion. */
export const MAGIC_PRESSURE_STATE_VERSION_BASE = 1000;

/** Wire view of `magicContextPressure`. */
export interface MagicPressureView {
  /** Route context window (tokens), when the adapter advertises one. */
  readonly contextWindow?: number;
  /** Provider-reported prompt tokens of the last request. */
  readonly pressureTokens?: number;
  /** Last sample + surface movement since (answers for the NEXT request). */
  readonly projectedTokens?: number;
  /** projectedTokens ?? pressureTokens. */
  readonly usedTokens?: number;
  /** round(used / window × 100), capped at 100. */
  readonly percent?: number;
  readonly provider?: string;
  readonly model?: string;
  /** Agent preset the session was composed from (web), when recorded. */
  readonly agentPreset?: string;
  /** Whether Magic Context manages this session's preset (thresholds apply). */
  readonly managed: boolean;
  /** Effective MC master switch (DSH overlay > jsonc). */
  readonly enabled: boolean;
  readonly executePercentage: number;
  readonly forcePercentage: number;
  readonly emergencyPercentage: number;
  readonly thresholdMode: "percentage" | "tokens";
  /** Thresholds in tokens, when the window is known. */
  readonly executeTokens?: number;
  readonly forceTokens?: number;
}

/** Live inputs of the view (settings overlay + preset membership). */
export interface MagicMeterSettings {
  thresholds(modelRef: string | undefined, contextWindow: number | undefined): {
    executePercentage: number;
    forcePercentage: number;
    emergencyPercentage: number;
    mode: "percentage" | "tokens";
  };
  enabled(): boolean;
  managed(agentPreset: string | undefined): boolean;
}

/** Structural projection definition (dsh-session-projection 0.2.1-rc.5). */
export interface ProjectionDefinitionLike {
  key: string;
  stateVersion: number;
  stateSchema: { parse(value: unknown): unknown };
  init(header?: unknown, inheritedEventCount?: number): unknown;
  apply(state: unknown, event: unknown): unknown;
  wire?: { viewSchema: { parse(value: unknown): unknown }; view(state: unknown): unknown };
}

interface WrappedState {
  readonly inner: unknown;
  readonly provider?: string;
  readonly model?: string;
  readonly agentPreset?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const optNonNeg = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Validator for the wrapped state (persisted by the projection cache). */
function wrappedStateSchema(inner: ProjectionDefinitionLike) {
  return {
    parse(value: unknown): WrappedState {
      if (!isRecord(value) || !("inner" in value)) throw new Error("magicContextPressure: malformed state");
      const out: { inner: unknown; provider?: string; model?: string; agentPreset?: string } = {
        inner: inner.stateSchema.parse(value.inner),
      };
      for (const key of ["provider", "model", "agentPreset"] as const) {
        const v = value[key];
        if (v === undefined) continue;
        if (typeof v !== "string") throw new Error(`magicContextPressure: ${key} must be a string`);
        out[key] = v;
      }
      return out;
    },
  };
}

/** Validator for the wire view (client contract). */
export const magicPressureViewSchema = {
  parse(value: unknown): MagicPressureView {
    if (!isRecord(value)) throw new Error("magicContextPressure: view must be an object");
    if (typeof value.managed !== "boolean" || typeof value.enabled !== "boolean") {
      throw new Error("magicContextPressure: managed/enabled must be boolean");
    }
    for (const key of ["executePercentage", "forcePercentage", "emergencyPercentage"]) {
      if (optNonNeg(value[key]) === undefined) throw new Error(`magicContextPressure: ${key} must be a number`);
    }
    if (value.thresholdMode !== "percentage" && value.thresholdMode !== "tokens") {
      throw new Error("magicContextPressure: bad thresholdMode");
    }
    return value as unknown as MagicPressureView;
  },
};

/**
 * Wrap token-meter's `contextPressure` unit as `magicContextPressure`: the
 * inner fold runs verbatim; the wrapper additionally remembers the model route
 * (`request/context`) and the session's agent preset (header), and its view
 * adds the MC thresholds resolved for that route.
 */
export function wrapPressureDefinition(
  inner: ProjectionDefinitionLike,
  settings: MagicMeterSettings,
): ProjectionDefinitionLike {
  if (inner.wire === undefined) throw new Error("contextPressure unit has no wire view");
  const innerWire = inner.wire;
  return {
    key: MAGIC_PRESSURE_KEY,
    stateVersion: MAGIC_PRESSURE_STATE_VERSION_BASE + inner.stateVersion,
    stateSchema: wrappedStateSchema(inner),
    init(header?: unknown, inheritedEventCount?: number): WrappedState {
      const agentPreset = isRecord(header) && typeof header.agentPreset === "string" ? header.agentPreset : undefined;
      return {
        inner: inner.init(header, inheritedEventCount),
        ...(agentPreset !== undefined ? { agentPreset } : {}),
      };
    },
    apply(state: unknown, event: unknown): WrappedState {
      const s = state as WrappedState;
      const nextInner = inner.apply(s.inner, event);
      let provider = s.provider;
      let model = s.model;
      if (isRecord(event) && event.type === "request/context" && isRecord(event.data)) {
        if (typeof event.data.provider === "string") provider = event.data.provider;
        if (typeof event.data.model === "string") model = event.data.model;
      }
      if (Object.is(nextInner, s.inner) && provider === s.provider && model === s.model) return s;
      return {
        inner: nextInner,
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(s.agentPreset !== undefined ? { agentPreset: s.agentPreset } : {}),
      };
    },
    wire: {
      viewSchema: magicPressureViewSchema,
      view(state: unknown): MagicPressureView {
        const s = state as WrappedState;
        const base = innerWire.viewSchema.parse(innerWire.view(s.inner)) as {
          contextWindow?: number;
          pressureTokens?: number;
          projectedTokens?: number;
        };
        const contextWindow = optNonNeg(base.contextWindow);
        const usedTokens = optNonNeg(base.projectedTokens) ?? optNonNeg(base.pressureTokens);
        const modelRef = s.provider !== undefined && s.model !== undefined ? `${s.provider}/${s.model}` : undefined;
        let thresholds: ReturnType<MagicMeterSettings["thresholds"]>;
        let enabled = true;
        let managed = true;
        try {
          thresholds = settings.thresholds(modelRef, contextWindow);
          enabled = settings.enabled();
          managed = settings.managed(s.agentPreset);
        } catch {
          thresholds = { executePercentage: 65, forcePercentage: 85, emergencyPercentage: 95, mode: "percentage" };
        }
        const tokensAt = (pct: number) =>
          contextWindow !== undefined ? Math.floor((contextWindow * pct) / 100) : undefined;
        const executeTokens = tokensAt(thresholds.executePercentage);
        const forceTokens = tokensAt(thresholds.forcePercentage);
        return {
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(base.pressureTokens !== undefined ? { pressureTokens: base.pressureTokens } : {}),
          ...(base.projectedTokens !== undefined ? { projectedTokens: base.projectedTokens } : {}),
          ...(usedTokens !== undefined ? { usedTokens } : {}),
          ...(usedTokens !== undefined && contextWindow !== undefined && contextWindow > 0
            ? { percent: Math.min(100, Math.round((usedTokens / contextWindow) * 100)) }
            : {}),
          ...(s.provider !== undefined ? { provider: s.provider } : {}),
          ...(s.model !== undefined ? { model: s.model } : {}),
          ...(s.agentPreset !== undefined ? { agentPreset: s.agentPreset } : {}),
          managed,
          enabled,
          executePercentage: thresholds.executePercentage,
          forcePercentage: thresholds.forcePercentage,
          emergencyPercentage: thresholds.emergencyPercentage,
          thresholdMode: thresholds.mode,
          ...(executeTokens !== undefined ? { executeTokens } : {}),
          ...(forceTokens !== undefined ? { forceTokens } : {}),
        };
      },
    },
  };
}

/** The `ctx.sessionProjections` face the facade forwards to. */
export interface SessionProjectionsLike {
  register(definition: ProjectionDefinitionLike): unknown;
  [key: string]: unknown;
}

/**
 * A `sessionProjections` facade for the token-meter child: renames
 * `contextPressure` to the wrapped MC unit, passes every other key through.
 */
export function createRenamingRegistry(
  real: SessionProjectionsLike,
  settings: MagicMeterSettings,
  onRegistered?: (key: string) => void,
): SessionProjectionsLike {
  // A plain object, not a Proxy over the registry: Cordis recognises a
  // provided Service instance through its tracker symbols and would hand
  // consumers the original registry, bypassing the rename.
  const facade: SessionProjectionsLike = {
    register(definition: ProjectionDefinitionLike) {
      const effective =
        definition.key === NATIVE_PRESSURE_KEY ? wrapPressureDefinition(definition, settings) : definition;
      onRegistered?.(effective.key);
      return real.register(effective);
    },
  };
  for (const method of ["onChanged", "stateOf", "snapshot", "cachedSnapshot", "checkpoint", "restoreFloor", "viewCheckpoint", "restore", "hydrate"]) {
    const fn = real[method];
    if (typeof fn === "function") facade[method] = (fn as (...args: unknown[]) => unknown).bind(real);
  }
  return facade;
}

/**
 * Capture token-meter's unit definitions in a throwaway Cordis root (the same
 * technique the contract test uses). Used when the stock row is still mounted:
 * we then only add the wrapped key, never a second `tokenMeter`.
 */
export async function captureTokenMeterDefinitions(
  TokenMeterClass: unknown,
  timeoutMs = 500,
): Promise<Map<string, ProjectionDefinitionLike>> {
  const defs = new Map<string, ProjectionDefinitionLike>();
  const root = new Context();
  root.provide("sessionProjections", {
    register(definition: ProjectionDefinitionLike) {
      defs.set(definition.key, definition);
      return () => defs.delete(definition.key);
    },
  } as never);
  const fiber = root.plugin(TokenMeterClass as never, undefined as never) as unknown as { dispose?: () => unknown };
  const started = Date.now();
  while (!defs.has(NATIVE_PRESSURE_KEY) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const captured = new Map(defs);
  try {
    await fiber?.dispose?.();
  } catch {
    // throwaway root
  }
  return captured;
}
