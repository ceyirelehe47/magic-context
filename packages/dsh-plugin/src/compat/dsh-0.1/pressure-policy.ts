/**
 * compat/dsh-0.1/pressure-policy — dependency-free view of the round 19
 * native-pressure policy, shared by `MagicCompactionEngine` (runtime) and
 * setup/doctor (display/check). No DSH runtime imports, so the doctor CLI
 * bundle stays offline-safe.
 *
 * compaction-basic (rc.5 `resolveCompactSpec`) prices pressure at
 *   min(window × thresholdRatio, window − maxTokens − headroomTokens)
 * with defaults thresholdRatio 0.8 / headroomTokens 65 536.
 */

/** compaction-basic defaults (rc.5 `resolveConfig`). */
export const DSH_DEFAULT_THRESHOLD_RATIO = 0.8;
export const DSH_DEFAULT_HEADROOM_TOKENS = 65_536;
export const DSH_DEFAULT_RETAIN_RATIO = 0.16;

/**
 * Native backstop on MC-managed main sessions (user decision 2026-11-03):
 * 90 % by default, i.e. above MC's force-materialization band (85 % at
 * execute 65 %) so MC's own emergency path always gets the first chance.
 */
export const DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE = 90;
const NATIVE_BACKSTOP_MARGIN = 5;
const NATIVE_BACKSTOP_CAP = 98;

/** Native backstop for a route given MC's force band: max(90, force + 5), capped at 98. */
export function nativeBackstopPercentage(forceMaterializationPercentage: number): number {
  return Math.min(
    NATIVE_BACKSTOP_CAP,
    Math.max(DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE, forceMaterializationPercentage + NATIVE_BACKSTOP_MARGIN),
  );
}

/**
 * Pure mirror of compaction-basic's pressure threshold, or `null` when the
 * configuration leaves no pressure budget (compaction-basic throws
 * `TargetPressureConfigError` and pressure compaction never fires), or when
 * the retention (default 0.16 × message budget) is not below the threshold.
 */
export function nativePressureThresholdTokens(
  contextWindow: number,
  maxTokens: number,
  policy: { thresholdRatio: number; headroomTokens: number; retainRatio?: number; retainTokens?: number },
): number | null {
  const messageBudget = contextWindow - maxTokens;
  const pressureBudget = messageBudget - policy.headroomTokens;
  if (messageBudget <= 0 || pressureBudget <= 0) return null;
  const threshold = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudget));
  // compaction-basic also refuses a retention that is not below the threshold.
  const retain = policy.retainTokens ?? Math.floor(messageBudget * (policy.retainRatio ?? DSH_DEFAULT_RETAIN_RATIO));
  return retain >= threshold ? null : threshold;
}

export interface PressureRowConfig {
  headroomTokens?: unknown;
  thresholdRatio?: unknown;
  modelPolicies?: unknown;
}

export interface EffectivePressurePolicy {
  /** Policy MC-managed main sessions get (top-level only; per-route entries win). */
  main: { thresholdRatio: number; headroomTokens: number; source: "magic" | "user" | "mixed" };
  /** Policy child sessions get before the small-window fallback. */
  child: { thresholdRatio: number; headroomTokens: number; smallWindowFallback: boolean };
  /** Explicit per-route overrides (provider/model) — they beat both. */
  routeOverrides: string[];
}

/** Effective policy for a `magic-compaction` row config (round 19 rules). */
export function effectivePressurePolicy(
  row: PressureRowConfig | undefined,
  forcePercentage: number = DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE,
): EffectivePressurePolicy {
  const headroom = typeof row?.headroomTokens === "number" ? row.headroomTokens : undefined;
  const ratio = typeof row?.thresholdRatio === "number" ? row.thresholdRatio : undefined;
  const routes = Array.isArray(row?.modelPolicies)
    ? (row!.modelPolicies as { provider?: unknown; model?: unknown }[])
        .filter((p) => p !== null && typeof p === "object")
        .map((p) => `${String(p.provider)}/${String(p.model)}`)
    : [];
  return {
    main: {
      thresholdRatio: ratio ?? forcePercentage / 100,
      headroomTokens: headroom ?? 0,
      source: headroom === undefined && ratio === undefined ? "magic" : headroom !== undefined && ratio !== undefined ? "user" : "mixed",
    },
    child: {
      thresholdRatio: ratio ?? DSH_DEFAULT_THRESHOLD_RATIO,
      headroomTokens: headroom ?? DSH_DEFAULT_HEADROOM_TOKENS,
      smallWindowFallback: headroom === undefined,
    },
    routeOverrides: routes,
  };
}

/**
 * Round 37 seg 12 — S9 fix A (user decision 2026-11-07 "A+C", confirmed
 * 2026-11-12): MC prices its context pressure against the AVAILABLE window,
 * `window − output reserve` (the request's `maxTokens`), the same budget
 * compaction-basic's backstop is capped by (`window − maxTokens − headroom`).
 * Before, MC priced against the whole window, so on a 1M route with request
 * maxTokens 384 000 the native backstop (616 000) sat below MC's 65 % execute
 * line (650 000) and pre-empted the historian. This is the ONE place the
 * reserve is subtracted: the historian trigger, the persisted context %, the
 * drop ride and pressure truncation all use it (pressure truncation's old
 * `min(32 000, reserve)` cap is gone — it now prices the same budget).
 * A reserve that leaves no room (≥ window) or a non-finite input falls back to
 * the whole window (fail-open, the pre-fix pricing).
 */
export function magicAvailableWindow(contextWindow: number, outputReserveTokens: number | undefined): number {
  if (!(Number.isFinite(contextWindow) && contextWindow > 0)) return contextWindow;
  const reserve = typeof outputReserveTokens === "number" && Number.isFinite(outputReserveTokens) ? Math.max(0, outputReserveTokens) : 0;
  const available = contextWindow - reserve;
  return available > 0 ? available : contextWindow;
}

/** MC context pressure in percent of the available window (unrounded). */
export function magicPressurePercent(tokens: number, contextWindow: number, outputReserveTokens: number | undefined): number {
  const available = magicAvailableWindow(contextWindow, outputReserveTokens);
  return available > 0 ? (Math.max(0, tokens) / available) * 100 : 0;
}

/**
 * MC's execute / force lines and the MC-main native backstop for one route, in
 * tokens of prompt input. MC's lines are percentages of the available window;
 * the backstop is compaction-basic's own threshold under `policy` (default:
 * the MC main policy, ratio 0.9 / headroom 0). The S9 invariant is
 * `execute < force < backstop` (backstop `null` = no native pressure budget).
 */
export function magicPressureLines(
  contextWindow: number,
  outputReserveTokens: number,
  executePercentage = 65,
  forcePercentage = 85,
  policy: { thresholdRatio: number; headroomTokens: number } = { thresholdRatio: DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE / 100, headroomTokens: 0 },
): { available: number; execute: number; force: number; backstop: number | null } {
  const available = magicAvailableWindow(contextWindow, outputReserveTokens);
  return {
    available,
    execute: Math.floor((available * executePercentage) / 100),
    force: Math.floor((available * forcePercentage) / 100),
    backstop: nativePressureThresholdTokens(contextWindow, outputReserveTokens, policy),
  };
}

/**
 * S9 fix C: would the native backstop fire before MC's force band on this
 * route? True when the backstop threshold is at or below MC's force line. A
 * route with no legal backstop budget is not flagged (no native pressure
 * compaction runs there at all).
 */
export function backstopPreemptsForceBand(
  contextWindow: number,
  outputReserveTokens: number,
  policy: { thresholdRatio: number; headroomTokens: number },
  executePercentage = 65,
  forcePercentage = 85,
): boolean {
  const lines = magicPressureLines(contextWindow, outputReserveTokens, executePercentage, forcePercentage, policy);
  return lines.backstop !== null && lines.backstop <= lines.force;
}

/**
 * Threshold as a percentage (one decimal), or null. For an MC main-session
 * policy (`effectivePressurePolicy().main`, recognised by its `source`) the
 * percentage is of the AVAILABLE window (`window − maxTokens`, S9 fix A) —
 * the unit MC's own 65 % / 85 % lines are in; child policies (DSH native) stay
 * a percentage of the whole window.
 */
export function thresholdPercent(
  contextWindow: number,
  maxTokens: number,
  policy: { thresholdRatio: number; headroomTokens: number; source?: string },
  smallWindowFallback = false,
): number | null {
  let t = nativePressureThresholdTokens(contextWindow, maxTokens, policy);
  if (t === null && smallWindowFallback) t = nativePressureThresholdTokens(contextWindow, maxTokens, { ...policy, headroomTokens: 0 });
  if (t === null) return null;
  const basis = policy.source !== undefined ? magicAvailableWindow(contextWindow, maxTokens) : contextWindow;
  return Math.round((t / basis) * 1000) / 10;
}

/** Threshold as a percentage of the WHOLE window (one decimal), or null — any policy. */
export function thresholdPercentOfWindow(
  contextWindow: number,
  maxTokens: number,
  policy: { thresholdRatio: number; headroomTokens: number },
): number | null {
  const t = nativePressureThresholdTokens(contextWindow, maxTokens, policy);
  return t === null ? null : Math.round((t / contextWindow) * 1000) / 10;
}

/** One-paragraph human summary used by setup and doctor. */
export function describePressurePolicy(row: PressureRowConfig | undefined, executePercentage = 65): {
  text: string;
  /** main-session native threshold below MC's execute threshold on a 128k window. */
  preemptsMagic: boolean;
  /**
   * S9 fix C: example routes (window/maxTokens) on which the main-session
   * native backstop sits at or below MC's force band (85 % of the available
   * window) — the backstop may compact before MC's own emergency path.
   */
  backstopFirst: string[];
} {
  const p = effectivePressurePolicy(row);
  const fmt = (v: number | null) => (v === null ? "none (config error: no budget / retain >= threshold)" : `${v}%`);
  const windows: [string, number, number][] = [
    ["24k", 24_576, 2_048],
    ["40k", 40_960, 4_096],
    ["80k", 80_000, 4_096],
    ["128k", 131_072, 8_192],
  ];
  // Main: percent of the whole window (as before) = percent of the available
  // window MC prices against (S9 fix A).
  const main = windows
    .map(([n, w, m]) => {
      const usable = thresholdPercent(w, m, p.main);
      const whole = thresholdPercentOfWindow(w, m, p.main);
      return usable === null ? `${n} ${fmt(null)}` : `${n} ${fmt(whole)} of window = ${usable}% of usable`;
    })
    .join(", ");
  const child = windows
    .map(([n, w, m]) => `${n} ${fmt(thresholdPercent(w, m, p.child, p.child.smallWindowFallback))}`)
    .join(", ");
  const main128 = thresholdPercent(131_072, 8_192, p.main);
  const preemptsMagic = main128 !== null && main128 < executePercentage;
  // S9 fix C: the backstop vs MC's force band on the example windows and on
  // large-reserve routes (the evo 200k route, a 1M route with 384k output).
  const forcePercentage = Math.max(85, Math.min(executePercentage, 90) + 2); // mirror of core escalationBands (dependency-free view)
  const routes: [string, number, number][] = [
    ...windows,
    ["200k/32k", 200_000, 32_768],
    ["1M/384k", 1_000_000, 384_000],
  ];
  const backstopFirst = routes
    .filter(([, w, m]) => backstopPreemptsForceBand(w, m, p.main, executePercentage, forcePercentage))
    .map(([n]) => n);
  const mainHow =
    p.main.source === "magic"
      ? `MC-led (headroom 0, ratio = native backstop ${DEFAULT_MAGIC_NATIVE_PRESSURE_PERCENTAGE}% at execute 65%; per route max(90, MC force band + 5), cap 98)`
      : `user-set (thresholdRatio ${p.main.thresholdRatio}, headroomTokens ${p.main.headroomTokens})`;
  const childHow = p.child.smallWindowFallback
    ? `DSH native (ratio ${p.child.thresholdRatio}, headroom ${p.child.headroomTokens}; headroom 0 when that leaves no budget)`
    : `user-set (thresholdRatio ${p.child.thresholdRatio}, headroomTokens ${p.child.headroomTokens})`;
  const text =
    `native pressure compaction — main sessions: ${mainHow} → ${main}; ` +
    `child sessions: ${childHow} → ${child}` +
    (p.routeOverrides.length > 0 ? `; per-route modelPolicies win for ${p.routeOverrides.join(", ")}` : "") +
    ` (examples assume maxTokens 2048/4096/8192; MC prices pressure against the usable window = window − maxTokens).` +
    (backstopFirst.length > 0 ? ` Backstop at or below MC's force band on: ${backstopFirst.join(", ")}.` : "");
  return { text, preemptsMagic, backstopFirst };
}
