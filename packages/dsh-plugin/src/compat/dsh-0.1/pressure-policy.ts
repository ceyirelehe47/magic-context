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

/** Threshold as a percentage of the window (one decimal), or null. */
export function thresholdPercent(
  contextWindow: number,
  maxTokens: number,
  policy: { thresholdRatio: number; headroomTokens: number },
  smallWindowFallback = false,
): number | null {
  let t = nativePressureThresholdTokens(contextWindow, maxTokens, policy);
  if (t === null && smallWindowFallback) t = nativePressureThresholdTokens(contextWindow, maxTokens, { ...policy, headroomTokens: 0 });
  return t === null ? null : Math.round((t / contextWindow) * 1000) / 10;
}

/** One-paragraph human summary used by setup and doctor. */
export function describePressurePolicy(row: PressureRowConfig | undefined, executePercentage = 65): {
  text: string;
  /** main-session native threshold below MC's execute threshold on a 128k window. */
  preemptsMagic: boolean;
} {
  const p = effectivePressurePolicy(row);
  const fmt = (v: number | null) => (v === null ? "none (config error: no budget / retain >= threshold)" : `${v}%`);
  const windows: [string, number, number][] = [
    ["24k", 24_576, 2_048],
    ["40k", 40_960, 4_096],
    ["80k", 80_000, 4_096],
    ["128k", 131_072, 8_192],
  ];
  const main = windows.map(([n, w, m]) => `${n} ${fmt(thresholdPercent(w, m, p.main))}`).join(", ");
  const child = windows
    .map(([n, w, m]) => `${n} ${fmt(thresholdPercent(w, m, p.child, p.child.smallWindowFallback))}`)
    .join(", ");
  const main128 = thresholdPercent(131_072, 8_192, p.main);
  const preemptsMagic = main128 !== null && main128 < executePercentage;
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
    ` (examples assume maxTokens 2048/4096/8192).`;
  return { text, preemptsMagic };
}
