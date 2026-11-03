/**
 * settings/config-load — magic-context.jsonc loading for the DSH planes.
 *
 * Round 20. The agent plane's live view (agent/index.ts `createLiveSettings`)
 * and the settings endpoints (host/remote.ts) re-read the shared jsonc on a
 * ~3 s TTL so edits apply without a restart. Core `parsePluginConfig` logs some
 * deprecations (`clear_reasoning_age …`) on EVERY parse, so a long session
 * wrote the same line to the Magic log every few seconds. Core is not changed:
 * the load runs with a temporary core log-line forwarder that passes each
 * distinct line through once per process (timestamp ignored) and drops the
 * repeats. Loading is synchronous, so the forwarder never sees another
 * caller's lines; it is always uninstalled (`finally`).
 */
import { loadPluginConfig, type MagicContextPluginConfig } from "@magic-context/core/config";
import { setLogLineForwarder, writeForwardedLogLine } from "@magic-context/core/shared/logger";

export type LoadedMagicConfig = MagicContextPluginConfig & { configWarnings?: string[] };

export interface QuietConfigLoaderDeps {
  readonly load?: (directory: string) => LoadedMagicConfig;
  readonly setForwarder?: (forward: ((line: string) => void) | null) => void;
  readonly write?: (line: string) => void;
}

/** `[2026-…Z] message` → `message` (the dedupe key). */
function lineKey(line: string): string {
  return line.replace(/^\[[^\]]*\]\s*/, "").trimEnd();
}

export function createQuietConfigLoader(deps: QuietConfigLoaderDeps = {}): (directory: string) => LoadedMagicConfig {
  const load = deps.load ?? ((directory: string) => loadPluginConfig(directory));
  const setForwarder = deps.setForwarder ?? setLogLineForwarder;
  const write = deps.write ?? writeForwardedLogLine;
  const seen = new Set<string>();
  return (directory: string) => {
    setForwarder((line) => {
      const key = lineKey(line);
      if (seen.has(key)) return;
      seen.add(key);
      write(line);
    });
    try {
      return load(directory);
    } finally {
      setForwarder(null);
    }
  };
}

/** Process-wide quiet loader shared by the agent plane and the settings endpoints. */
export const loadPluginConfigQuiet = createQuietConfigLoader();

/**
 * Top-level jsonc sections the agent plane bridges ONCE at apply time
 * (`bridgeMagicConfig`): memory, dreamer, compaction, … An edit to one of them
 * is not applied until DSH restarts. The live keys (`enabled`,
 * `execute_threshold_percentage`, `execute_threshold_tokens`) are re-read every
 * few seconds and are deliberately not listed.
 */
export const RESTART_ONLY_SECTIONS = [
  "memory",
  "dreamer",
  "compaction",
  "historian",
  "mural",
  "caveman_text_compression",
  "commit_cluster_trigger",
  "temporal_awareness",
  "prompt_surface",
  "cache_ttl",
  "protected_tags",
  "history_budget_percentage",
] as const;

/**
 * Round 21: jsonc keys the runtime reads per call / per step, so an edit is
 * applied live (agent plane getters over the live jsonc view): `historian.model`
 * (incl. the per-harness `historian.opencode.model`) and `protected_tokens`.
 * They are excluded from the restart notice and the pending-restart view.
 */
export const HOT_JSONC_KEYS = ["historian.model", "historian.opencode.model", "protected_tokens"] as const;

/** A restart-only section's value with its hot keys removed (comparison view). */
function restartView(key: string, value: unknown): unknown {
  if (key !== "historian" || value === null || typeof value !== "object") return value;
  const { model: _model, opencode, ...rest } = value as Record<string, unknown>;
  if (opencode !== null && typeof opencode === "object") {
    const { model: _ocModel, ...ocRest } = opencode as Record<string, unknown>;
    if (Object.keys(ocRest).length > 0) return { ...rest, opencode: ocRest };
    return rest;
  }
  return opencode === undefined ? rest : { ...rest, opencode };
}

/** One restart-only section that differs between the running and current jsonc. */
export interface PendingRestartChange {
  readonly key: string;
  /** Value the running agent plane started with (applied now). */
  readonly running: unknown;
  /** Value in magic-context.jsonc now (applied after a DSH restart). */
  readonly next: unknown;
}

/**
 * Round 21: restart-only sections whose current jsonc value differs from the
 * value the running agent plane started with. `running` undefined (no
 * snapshot registered) → nothing pending.
 */
export function pendingRestartChanges(
  running: Partial<MagicContextPluginConfig> | undefined,
  current: Partial<MagicContextPluginConfig> | undefined,
): PendingRestartChange[] {
  if (running === undefined || current === undefined) return [];
  const r = running as Record<string, unknown>;
  const c = current as Record<string, unknown>;
  const out: PendingRestartChange[] = [];
  for (const key of RESTART_ONLY_SECTIONS) {
    if (stable(restartView(key, r[key])) === stable(restartView(key, c[key]))) continue;
    out.push({ key, running: r[key], next: c[key] });
  }
  return out;
}

function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

/**
 * Watches successive jsonc loads: reports each config warning once per process
 * and, when a restart-only section differs from the config the agent plane
 * started with, says so once per new value (a revert to the startup value is
 * silent and re-arms the notice).
 */
export function createConfigReloadNotices(warn: (message: string) => void): {
  observe(config: LoadedMagicConfig | undefined): void;
} {
  let baseline: Map<string, string> | undefined;
  const reported = new Map<string, string>();
  const warned = new Set<string>();
  const say = (message: string) => {
    try {
      warn(message);
    } catch {
      // notices must never break a settings read
    }
  };
  return {
    observe(config) {
      if (config === undefined) return;
      for (const warning of config.configWarnings ?? []) {
        if (warned.has(warning)) continue;
        warned.add(warning);
        say(`[magic-context] magic-context.jsonc: ${warning}`);
      }
      const record = config as unknown as Record<string, unknown>;
      const now = new Map(RESTART_ONLY_SECTIONS.map((key) => [key, stable(restartView(key, record[key]))]));
      if (baseline === undefined) {
        baseline = now;
        return;
      }
      const changed: string[] = [];
      for (const key of RESTART_ONLY_SECTIONS) {
        const value = now.get(key)!;
        if (value === baseline.get(key)) {
          reported.delete(key);
          continue;
        }
        if (reported.get(key) === value) continue;
        reported.set(key, value);
        changed.push(key);
      }
      if (changed.length > 0) {
        say(
          `[magic-context] magic-context.jsonc changed: ${changed.map((k) => `"${k}"`).join(", ")} ` +
            "is read when DSH starts and is NOT applied to the running session — restart DSH to use the new value.",
        );
      }
    },
  };
}
