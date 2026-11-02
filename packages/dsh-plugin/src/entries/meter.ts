/**
 * Subpath entry: `dsh-magic-context/meter` — host-plane replacement for the
 * stock `token-meter` row (see host/meter.ts for the why). `setup` writes:
 *
 *   - id: token-meter
 *     disabled: true
 *   - insert:
 *       - id: magic-meter
 *         name: 'dsh-magic-context/meter'
 *         config: { magicPresets: [magic-standard, …] }
 *
 * `magicPresets` lists the agent presets Magic Context manages (web); a
 * session without a recorded preset (headless/tui flat tree) counts as
 * managed when `flat` is true.
 */
import type { Context } from "@deepseek-ai/cordis";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import {
  MAGIC_PRESSURE_KEY,
  NATIVE_PRESSURE_KEY,
  captureTokenMeterDefinitions,
  createRenamingRegistry,
  wrapPressureDefinition,
  type MagicMeterSettings,
  type SessionProjectionsLike,
} from "../host/meter";
import { loadJsoncForHost } from "../host/remote";
import { resolveEffectiveSettings, resolveThresholds } from "../settings/magic-settings";
import { fireAndForget } from "../agent/fire-and-forget";
import type { MagicContextHostService } from "../index";

export const name = "magic-context-meter";
export const inject = ["sessionProjections"];

export interface MagicMeterConfig {
  /** Agent preset ids Magic Context is enabled in (web layout). */
  magicPresets?: string[];
  /** Flat layout (headless/tui): sessions without a preset are managed. */
  flat?: boolean;
}

export function meterSettings(ctx: Context, config: MagicMeterConfig): MagicMeterSettings {
  const presets = new Set(config.magicPresets ?? []);
  const effective = () => {
    const host = ctx.get("magicContextHost") as MagicContextHostService | undefined;
    return resolveEffectiveSettings(loadJsoncForHost(), host?.overrides?.() ?? {});
  };
  return {
    thresholds: (modelRef, contextWindow) => {
      const t = resolveThresholds(effective(), modelRef, contextWindow);
      return {
        executePercentage: t.executePercentage,
        forcePercentage: t.forcePercentage,
        emergencyPercentage: t.emergencyPercentage,
        mode: t.mode,
      };
    },
    enabled: () => effective().enabled.value,
    // No recorded preset = flat composition (headless/tui), managed unless the
    // row says otherwise; a web session is managed iff its preset is listed.
    managed: (agentPreset) => (agentPreset === undefined ? config.flat !== false : presets.has(agentPreset)),
  };
}

export function apply(ctx: Context, config: MagicMeterConfig = {}): void {
  const real = ctx.get("sessionProjections") as SessionProjectionsLike | undefined;
  if (real === undefined) throw new Error("magic-context-meter: sessionProjections unavailable");
  const settings = meterSettings(ctx, config);
  const log = (message: string) => ctx.logger?.info?.(message);

  if (ctx.get("tokenMeter") !== undefined) {
    // The stock token-meter row is still mounted (setup not run / hand patch):
    // never provide a second tokenMeter; only add the MC key beside the
    // native one. Both composer indicators will show until setup disables it.
    log(
      `[magic-context] meter: stock token-meter row still mounted — adding ${MAGIC_PRESSURE_KEY} only; ` +
        `run \`dsh-magic-context setup\` to hide the native indicator`,
    );
    fireAndForget(captureTokenMeterDefinitions(TokenMeter).then((defs) => {
      const pressure = defs.get(NATIVE_PRESSURE_KEY);
      if (pressure === undefined) {
        log("[magic-context] meter: token-meter exposes no contextPressure unit; MC indicator disabled");
        return;
      }
      real.register(wrapPressureDefinition(pressure, settings));
    }), log, "meter: token-meter definition capture");
    return;
  }

  // Normal path: the real TokenMeter in a child whose sessionProjections
  // renames contextPressure → magicContextPressure. `tokenMeter` itself is not
  // isolated, so the service stays global (tool-result-pruner injects it).
  // The facade is provided from its own child plugin: a service provided by a
  // fiber becomes visible to dependents only once that fiber is active, so
  // providing it from this (still applying) fiber would leave TokenMeter
  // pending forever.
  const isolate = (ctx as unknown as { isolate: (name: string) => Context }).isolate;
  const child = isolate.call(ctx, "sessionProjections");
  const facade = createRenamingRegistry(real, settings, (key) =>
    log(`[magic-context] meter: registered projection ${key}`),
  );
  child.plugin({
    name: "magic-context-meter-facade",
    apply(facadeCtx: Context) {
      facadeCtx.provide("sessionProjections", facade as never);
    },
  } as never, undefined as never);
  child.plugin(TokenMeter as never, undefined as never);
}

export default { name, inject, apply };
