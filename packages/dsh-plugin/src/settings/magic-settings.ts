/**
 * settings/magic-settings — the DSH-side Magic Context settings overlay.
 *
 * Two sources configure Magic Context on DSH:
 *
 *   1. `magic-context.jsonc` (user `~/.config/cortexkit/magic-context.jsonc`
 *      + project `.cortexkit/magic-context.jsonc`) — the SHARED core config
 *      every harness (OpenCode, Pi, DSH) reads. It stays the full source of
 *      truth for everything.
 *   2. The `magic-host` row's volatile Cordis `Config` (this module) — a small,
 *      DSH-only OVERRIDE layer edited live from the DSH settings page through
 *      `@deepseek-ai/dsh-settings` (`settings.mutate` → the active profile's
 *      `cordis.patch.yml`).
 *
 * Precedence (one-way overlay, never a sync): for each overlay field, a value
 * SET in the DSH override wins; an UNSET field inherits the jsonc value; an
 * unset jsonc key falls back to the core schema default. Nothing here ever
 * writes the jsonc file (comment-preserving JSONC rewriting is out of scope and
 * would race the other harnesses), so "reset to jsonc" is simply `unset` of the
 * DSH field.
 *
 * Volatile fields reach the plugin as cosmokit references (`{ get() }`) that
 * the Loader updates in place on a volatile-only profile edit; readers call
 * {@link readMagicOverrides} on every use, so changes apply without a remount.
 */
import { createRequire } from "node:module";
import type { MagicContextPluginConfig } from "@magic-context/core/config";
import { resolveExecuteThresholdDetail } from "@magic-context/core/hooks/magic-context/event-resolvers";
import {
  ABSOLUTE_EMERGENCY_PERCENTAGE,
  MAX_EXECUTE_THRESHOLD,
  escalationBands,
} from "@magic-context/core/shared/escalation-bands";
import { dshModelRefToCanonical } from "dsh-magic-context-adapter";

/** Profile entry id of the host row (settings namespace). */
export const MAGIC_SETTINGS_NAMESPACE = "magic-host";

/** Core schema default (`DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE`). */
export const DEFAULT_EXECUTE_THRESHOLD = 65;

/** Overlay field names (volatile, all optional = inherit). */
export const MAGIC_OVERRIDE_FIELDS = [
  "enabled",
  "historianModel",
  "historianAwaitAtTurnEndMs",
  "executeThresholdPercentage",
  "executeThresholdByModel",
  "protectedTokens",
] as const;
export type MagicOverrideField = (typeof MAGIC_OVERRIDE_FIELDS)[number];

/** Plain (dereferenced) DSH override values. Absent = inherit jsonc. */
export interface MagicDshOverrides {
  readonly enabled?: boolean;
  readonly historianModel?: string;
  readonly historianAwaitAtTurnEndMs?: number;
  readonly executeThresholdPercentage?: number;
  /** `provider/model` (DSH or canonical form) → percentage. */
  readonly executeThresholdByModel?: Readonly<Record<string, number>>;
  readonly protectedTokens?: number;
}

/** Bounds shared by the schema, the remote validator and the client form. */
export const MAGIC_OVERRIDE_BOUNDS = {
  executeThresholdPercentage: { min: 20, max: MAX_EXECUTE_THRESHOLD },
  protectedTokens: { min: 4_000, max: 1_000_000 },
  historianAwaitAtTurnEndMs: { min: 0, max: 60_000 },
} as const;

// ------------------------------------------------------------ schemastery

type SchemasteryLike = {
  (value?: unknown): unknown;
  object: (dict: Record<string, unknown>) => unknown;
  string: () => SchemaNode;
  boolean: () => SchemaNode;
  number: () => SchemaNode;
  natural: () => SchemaNode;
  dict: (inner: unknown) => SchemaNode;
};
type SchemaNode = {
  min: (n: number) => SchemaNode;
  max: (n: number) => SchemaNode;
  volatile: () => SchemaNode;
  description: (text: string) => SchemaNode;
};

/**
 * Load the host's schemastery. It is not a direct dependency of this package
 * (bun.lock stays untouched): every DSH install ships it as a dependency of
 * the stock plugins, so resolve it from here first and then through packages
 * that depend on it. Returns undefined when nothing resolves (the plugin then
 * exports no Config and the overlay is simply empty).
 */
export function loadSchemastery(): SchemasteryLike | undefined {
  const req = createRequire(import.meta.url);
  const anchors = [
    "@deepseek-ai/schemastery",
    "@deepseek-ai/dsh-token-meter",
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/cordis-plugin-include",
  ];
  for (const anchor of anchors) {
    try {
      if (anchor === "@deepseek-ai/schemastery") {
        const mod = req(anchor) as SchemasteryLike | { default?: SchemasteryLike };
        return ("default" in mod && mod.default ? mod.default : mod) as SchemasteryLike;
      }
      const nested = createRequire(req.resolve(anchor));
      const mod = nested("@deepseek-ai/schemastery") as SchemasteryLike | { default?: SchemasteryLike };
      return ("default" in mod && mod.default ? mod.default : mod) as SchemasteryLike;
    } catch {
      // try the next anchor
    }
  }
  return undefined;
}

/**
 * The host row's Config schema: the ordinary boot fields plus the volatile
 * overlay. Every overlay field is optional with no default, so "unset" stays
 * distinguishable from "set to the default" (inherit vs override).
 */
export function buildMagicHostConfigSchema(z: SchemasteryLike | undefined = loadSchemastery()): unknown {
  if (z === undefined) return undefined;
  const b = MAGIC_OVERRIDE_BOUNDS;
  return z.object({
    directory: z.string().description("Workspace directory identity (ordinary; boot only)."),
    port: z.natural().description("Liveness marker port (ordinary; boot only)."),
    homeHash: z.string().description("DSH home hash for canonical session keys (ordinary; boot only)."),
    enabled: z
      .boolean()
      .description("Magic Context on/off for this profile (unset = jsonc `enabled`). Live: pauses per-step work.")
      .volatile(),
    historianModel: z
      .string()
      .description("Historian model `provider/model` (unset = jsonc `historian.model`).")
      .volatile(),
    historianAwaitAtTurnEndMs: z
      .natural()
      .min(b.historianAwaitAtTurnEndMs.min)
      .max(b.historianAwaitAtTurnEndMs.max)
      .description("Await in-flight historian passes at turn end (ms; unset = env / 0).")
      .volatile(),
    executeThresholdPercentage: z
      .number()
      .min(b.executeThresholdPercentage.min)
      .max(b.executeThresholdPercentage.max)
      .description("Execute threshold % (unset = jsonc `execute_threshold_percentage`).")
      .volatile(),
    executeThresholdByModel: z
      .dict(z.number().min(b.executeThresholdPercentage.min).max(b.executeThresholdPercentage.max))
      .description("Per-model execute threshold % (`provider/model` → %); merged over jsonc per-model keys.")
      .volatile(),
    protectedTokens: z
      .natural()
      .min(b.protectedTokens.min)
      .max(b.protectedTokens.max)
      .description("Protected token floor (unset = jsonc `protected_tokens` / derived default).")
      .volatile(),
  });
}

// --------------------------------------------------------------- readers

/** Dereference a cosmokit volatile reference (or pass a plain value through). */
export function readVolatile<T>(value: unknown): T | undefined {
  if (value !== null && typeof value === "object" && typeof (value as { get?: unknown }).get === "function") {
    return (value as { get: () => T }).get();
  }
  return value as T | undefined;
}

/** Plain overrides from a (possibly volatile) host Config object. */
export function readMagicOverrides(config: unknown): MagicDshOverrides {
  if (config === null || typeof config !== "object") return {};
  const raw = config as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const bool = readVolatile<unknown>(raw.enabled);
  if (typeof bool === "boolean") out.enabled = bool;
  const model = readVolatile<unknown>(raw.historianModel);
  if (typeof model === "string" && model.trim() !== "") out.historianModel = model.trim();
  const awaitMs = readVolatile<unknown>(raw.historianAwaitAtTurnEndMs);
  if (typeof awaitMs === "number" && Number.isFinite(awaitMs) && awaitMs >= 0) out.historianAwaitAtTurnEndMs = awaitMs;
  const pct = readVolatile<unknown>(raw.executeThresholdPercentage);
  if (typeof pct === "number" && Number.isFinite(pct)) out.executeThresholdPercentage = pct;
  const byModel = readVolatile<unknown>(raw.executeThresholdByModel);
  if (byModel !== null && typeof byModel === "object" && !Array.isArray(byModel)) {
    const entries = Object.entries(byModel as Record<string, unknown>).filter(
      ([key, value]) => key.trim() !== "" && typeof value === "number" && Number.isFinite(value),
    ) as [string, number][];
    if (entries.length > 0) out.executeThresholdByModel = Object.fromEntries(entries);
  }
  const floor = readVolatile<unknown>(raw.protectedTokens);
  if (typeof floor === "number" && Number.isFinite(floor)) out.protectedTokens = floor;
  return out as MagicDshOverrides;
}

// ------------------------------------------------------------- effective

export type SettingSource = "dsh" | "jsonc" | "default";

export interface EffectiveSetting<T> {
  readonly value: T;
  readonly source: SettingSource;
}

/** Effective overlay fields (DSH override > jsonc > core default). */
export interface EffectiveMagicSettings {
  readonly enabled: EffectiveSetting<boolean>;
  readonly historianModel: EffectiveSetting<string | undefined>;
  readonly historianAwaitAtTurnEndMs: EffectiveSetting<number>;
  /** Number or `{ default, "provider/model": n }` — the core resolver shape. */
  readonly executeThreshold: EffectiveSetting<number | Record<string, number>>;
  readonly executeThresholdTokens?: Readonly<Record<string, number | undefined>>;
  readonly protectedTokens: EffectiveSetting<number | undefined>;
}

/** Historian model from the core config (legacy flat or per-harness block). */
export function jsoncHistorianModel(historian: unknown): string | undefined {
  const h = historian as { model?: unknown; opencode?: { model?: unknown } } | undefined;
  if (typeof h?.model === "string") return h.model;
  const entry = h?.opencode?.model;
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof (entry as { model?: unknown }).model === "string") {
    return (entry as { model: string }).model;
  }
  return undefined;
}

/** Env fallback for the turn-end await (documented in DSH-MAINTENANCE.md). */
export function envAwaitAtTurnEndMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Merge the DSH override over the jsonc config. `jsonc` is the core
 * `loadPluginConfig` result (or undefined when it failed to load).
 */
export function resolveEffectiveSettings(
  jsonc: Partial<MagicContextPluginConfig> | undefined,
  overrides: MagicDshOverrides,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveMagicSettings {
  const cfg = (jsonc ?? {}) as Partial<MagicContextPluginConfig> & Record<string, unknown>;

  const enabled: EffectiveSetting<boolean> =
    overrides.enabled !== undefined
      ? { value: overrides.enabled, source: "dsh" }
      : typeof cfg.enabled === "boolean"
        ? { value: cfg.enabled, source: "jsonc" }
        : { value: true, source: "default" };

  const jsoncModel = jsoncHistorianModel(cfg.historian);
  const historianModel: EffectiveSetting<string | undefined> =
    overrides.historianModel !== undefined
      ? { value: overrides.historianModel, source: "dsh" }
      : jsoncModel !== undefined
        ? { value: jsoncModel, source: "jsonc" }
        : { value: undefined, source: "default" };

  const envAwait = envAwaitAtTurnEndMs(env);
  const historianAwaitAtTurnEndMs: EffectiveSetting<number> =
    overrides.historianAwaitAtTurnEndMs !== undefined
      ? { value: overrides.historianAwaitAtTurnEndMs, source: "dsh" }
      : envAwait !== undefined
        ? { value: envAwait, source: "default" }
        : { value: 0, source: "default" };

  // Threshold: start from jsonc (number or per-model object), then lay the DSH
  // default + per-model keys over it.
  const raw = cfg.execute_threshold_percentage as unknown;
  const jsoncThreshold: number | Record<string, number> | undefined =
    typeof raw === "number"
      ? raw
      : raw !== null && typeof raw === "object"
        ? (Object.fromEntries(
            Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === "number"),
          ) as Record<string, number>)
        : undefined;
  let executeThreshold: EffectiveSetting<number | Record<string, number>>;
  const byModel = overrides.executeThresholdByModel;
  if (overrides.executeThresholdPercentage === undefined && byModel === undefined) {
    executeThreshold =
      jsoncThreshold !== undefined
        ? { value: jsoncThreshold, source: "jsonc" }
        : { value: DEFAULT_EXECUTE_THRESHOLD, source: "default" };
  } else {
    const base: Record<string, number> =
      typeof jsoncThreshold === "number"
        ? { default: jsoncThreshold }
        : jsoncThreshold !== undefined
          ? { ...jsoncThreshold }
          : { default: DEFAULT_EXECUTE_THRESHOLD };
    if (base.default === undefined) base.default = DEFAULT_EXECUTE_THRESHOLD;
    if (overrides.executeThresholdPercentage !== undefined) base.default = overrides.executeThresholdPercentage;
    const dshKeys = byModel ?? {};
    for (const [key, value] of Object.entries(dshKeys)) {
      base[key] = value;
      // Accept both DSH-native and canonical spellings of the model key. The
      // canonical alias carries the DSH value even over a jsonc key of the same
      // model (resolveThresholds tries the canonical spelling first, so a jsonc
      // `deepseek/…` key would otherwise beat a DSH `deepseek-official/…`
      // override); only an explicit DSH canonical key outranks the alias.
      const canonical = dshModelRefToCanonical(key);
      if (canonical !== key && !Object.hasOwn(dshKeys, canonical)) base[canonical] = value;
    }
    executeThreshold = { value: base, source: "dsh" };
  }

  const protectedTokens: EffectiveSetting<number | undefined> =
    overrides.protectedTokens !== undefined
      ? { value: overrides.protectedTokens, source: "dsh" }
      : typeof cfg.protected_tokens === "number"
        ? { value: cfg.protected_tokens, source: "jsonc" }
        : { value: undefined, source: "default" };

  const tokens = cfg.execute_threshold_tokens as Record<string, number | undefined> | undefined;
  return {
    enabled,
    historianModel,
    historianAwaitAtTurnEndMs,
    executeThreshold,
    ...(tokens !== undefined && typeof tokens === "object" ? { executeThresholdTokens: tokens } : {}),
    protectedTokens,
  };
}

/** Resolved thresholds for one model route (core resolver + escalation bands). */
export interface MagicThresholds {
  /** Effective execute threshold (% of the context window). */
  readonly executePercentage: number;
  /** Force-materialization band (`max(85, execute + 2)`). */
  readonly forcePercentage: number;
  /** Absolute emergency wall (95%). */
  readonly emergencyPercentage: number;
  readonly mode: "percentage" | "tokens";
  readonly matchedKey?: string;
  readonly absoluteTokens?: number;
}

/**
 * Resolve the thresholds for a model route. `modelRef` is the DSH-native
 * `provider/model`; the canonical spelling is tried first (core keys), the raw
 * DSH spelling second.
 */
export function resolveThresholds(
  effective: Pick<EffectiveMagicSettings, "executeThreshold" | "executeThresholdTokens">,
  modelRef: string | undefined,
  contextWindow?: number,
): MagicThresholds {
  const config = effective.executeThreshold.value as never;
  const options =
    effective.executeThresholdTokens !== undefined && typeof contextWindow === "number" && contextWindow > 0
      ? { tokensConfig: effective.executeThresholdTokens as never, contextLimit: contextWindow }
      : undefined;
  const canonical = modelRef !== undefined ? dshModelRefToCanonical(modelRef) : undefined;
  let detail = resolveExecuteThresholdDetail(config, canonical, DEFAULT_EXECUTE_THRESHOLD, options);
  if (
    modelRef !== undefined &&
    modelRef !== canonical &&
    (detail.matchedKey === undefined || detail.matchedKey === "default")
  ) {
    const raw = resolveExecuteThresholdDetail(config, modelRef, DEFAULT_EXECUTE_THRESHOLD, options);
    if (raw.matchedKey !== undefined && raw.matchedKey !== "default") detail = raw;
  }
  const bands = escalationBands(detail.percentage);
  return {
    executePercentage: detail.percentage,
    forcePercentage: bands.forceMaterializationPercentage,
    emergencyPercentage: bands.emergencyPercentage ?? ABSOLUTE_EMERGENCY_PERCENTAGE,
    mode: detail.mode,
    ...(detail.matchedKey !== undefined ? { matchedKey: detail.matchedKey } : {}),
    ...(detail.absoluteTokens !== undefined ? { absoluteTokens: detail.absoluteTokens } : {}),
  };
}

// --------------------------------------------------------- form edit ops

/** One path op as `@deepseek-ai/dsh-settings` `mutate` takes it. */
export type MagicSettingsOp =
  | { readonly op: "set"; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: "unset"; readonly path: readonly string[] };

/**
 * Validate client-supplied ops before they reach `settings.mutate`: only the
 * overlay fields, bounded values, and at most one level below
 * `executeThresholdByModel`. Returns an error string or undefined.
 */
/** `provider/model` model ref accepted as a historian model or per-model key. */
const MODEL_REF = /^[^\s/]+\/\S+$/;
const MODEL_REF_MAX = 256;
const PER_MODEL_MAX_ENTRIES = 64;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function badModelRef(key: string): boolean {
  return key.length > MODEL_REF_MAX || !MODEL_REF.test(key) || RESERVED_KEYS.has(key);
}

export function validateMagicSettingsOps(ops: unknown): string | undefined {
  if (!Array.isArray(ops)) return "ops must be an array";
  if (ops.length === 0) return "ops is empty";
  if (ops.length > 64) return "too many ops";
  const b = MAGIC_OVERRIDE_BOUNDS;
  for (const raw of ops) {
    if (raw === null || typeof raw !== "object") return "op must be an object";
    const op = raw as { op?: unknown; path?: unknown; value?: unknown };
    if (op.op !== "set" && op.op !== "unset") return `unknown op ${String(op.op)}`;
    if (!Array.isArray(op.path) || op.path.length === 0 || op.path.length > 2) return "bad path";
    if (!op.path.every((part) => typeof part === "string" && part.length > 0 && part.length <= 256)) return "bad path";
    const [field, sub] = op.path as string[];
    if (!(MAGIC_OVERRIDE_FIELDS as readonly string[]).includes(field!)) return `field ${field} is not editable`;
    if (sub !== undefined && field !== "executeThresholdByModel") return `field ${field} has no sub-path`;
    if (op.op === "unset") continue;
    const v = op.value;
    const inRange = (n: unknown, lo: number, hi: number) =>
      typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
    switch (field) {
      case "enabled":
        if (typeof v !== "boolean") return "enabled must be boolean";
        break;
      case "historianModel":
        if (typeof v !== "string" || v.trim().length > MODEL_REF_MAX || !MODEL_REF.test(v.trim())) {
          return `historianModel must be provider/model (at most ${MODEL_REF_MAX} characters)`;
        }
        break;
      case "historianAwaitAtTurnEndMs":
        if (!inRange(v, b.historianAwaitAtTurnEndMs.min, b.historianAwaitAtTurnEndMs.max) || !Number.isInteger(v)) {
          return `historianAwaitAtTurnEndMs must be an integer in [${b.historianAwaitAtTurnEndMs.min}, ${b.historianAwaitAtTurnEndMs.max}]`;
        }
        break;
      case "executeThresholdPercentage":
        if (!inRange(v, b.executeThresholdPercentage.min, b.executeThresholdPercentage.max)) {
          return `executeThresholdPercentage must be in [${b.executeThresholdPercentage.min}, ${b.executeThresholdPercentage.max}]`;
        }
        break;
      case "executeThresholdByModel":
        if (sub !== undefined) {
          if (badModelRef(sub)) return `per-model key ${JSON.stringify(sub.slice(0, 64))} must be provider/model`;
          if (!inRange(v, b.executeThresholdPercentage.min, b.executeThresholdPercentage.max)) {
            return `per-model threshold must be in [${b.executeThresholdPercentage.min}, ${b.executeThresholdPercentage.max}]`;
          }
        } else {
          if (v === null || typeof v !== "object" || Array.isArray(v)) return "executeThresholdByModel must be an object";
          const entries = Object.entries(v as Record<string, unknown>);
          if (entries.length > PER_MODEL_MAX_ENTRIES) return `executeThresholdByModel has more than ${PER_MODEL_MAX_ENTRIES} entries`;
          for (const [key, n] of entries) {
            if (key.trim() === "") return "empty model key";
            if (badModelRef(key)) return `per-model key ${JSON.stringify(key.slice(0, 64))} must be provider/model`;
            if (!inRange(n, b.executeThresholdPercentage.min, b.executeThresholdPercentage.max)) {
              return `per-model threshold for ${key} out of range`;
            }
          }
        }
        break;
      case "protectedTokens":
        if (!inRange(v, b.protectedTokens.min, b.protectedTokens.max) || !Number.isInteger(v)) {
          return `protectedTokens must be an integer in [${b.protectedTokens.min}, ${b.protectedTokens.max}]`;
        }
        break;
    }
  }
  return undefined;
}
