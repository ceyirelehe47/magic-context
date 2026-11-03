/**
 * MC meter projection contract (runtime, DSH 0.2.1-rc.5, REAL cordis Context).
 *
 * A real `@deepseek-ai/cordis` root with the REAL
 * `@deepseek-ai/dsh-session-projection` registry mounts the `magic-meter`
 * entry, which runs the REAL `TokenMeter` behind the key-renaming facade.
 * Pins: (1) the native `contextPressure` key is NOT registered (the stock
 * composer ContextMeter stays hidden); (2) `tokenUsage` / `contextBreakdown`
 * stay registered under their native keys; (3) `ctx.tokenMeter` is still
 * provided (tool-result-pruner hard-injects it); (4) `magicContextPressure`
 * folds real-shaped events into window / used tokens / percent + the MC
 * execute / force thresholds for the session's model route.
 */
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { Context } from "@deepseek-ai/cordis";
import * as meterEntry from "../entries/meter";
import { MAGIC_PRESSURE_KEY, magicPressureViewSchema } from "../host/meter";

const tokenMeterRequire = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-token-meter"));
const { SessionProjectionRegistry } = (await import(
  tokenMeterRequire.resolve("@deepseek-ai/dsh-session-projection")
)) as { SessionProjectionRegistry: new (ctx: Context) => unknown };

/** Minimal Session the registry folds over (snapshotEvents/eventAt/seq/header). */
function fakeSession(header: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = [];
  return {
    header: { id: "s1", version: 1, createdAt: 0, isSeeded: false, ...header },
    inheritedEventCount: 0,
    get seq() {
      return events.length;
    },
    snapshotEvents(from = 0, to = events.length) {
      return events.slice(from as number, to as number);
    },
    eventAt(seq: number) {
      return events[seq];
    },
    push(event: Record<string, unknown>) {
      const full = { seq: events.length, time: 0, ...event };
      events.push(full);
      return full;
    },
  };
}

async function settle(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
}

async function mount(config: meterEntry.MagicMeterConfig = {}, overrides: Record<string, unknown> = {}) {
  const root = new Context();
  (root as unknown as { plugin(p: unknown): unknown }).plugin(SessionProjectionRegistry);
  root.provide("magicContextHost", { overrides: () => overrides } as never);
  await settle(() => root.get("sessionProjections") !== undefined);
  root.plugin(meterEntry as never, config as never);
  const registry = () => root.get("sessionProjections") as {
    snapshot(session: unknown, keys?: string[]): { values: Record<string, unknown> };
  };
  await settle(() => root.get("tokenMeter") !== undefined);
  return { root, registry };
}

describe("contract: magic-meter projections on a real cordis Context", () => {
  it("hides contextPressure, keeps tokenUsage/contextBreakdown + ctx.tokenMeter, adds magicContextPressure", async () => {
    const { root, registry } = await mount({ flat: true });
    expect(root.get("tokenMeter")).toBeDefined();
    const session = fakeSession();
    const values = registry().snapshot(session).values;
    expect(Object.keys(values).sort()).toEqual(["contextBreakdown", MAGIC_PRESSURE_KEY, "tokenUsage"]);
    expect(values.contextPressure).toBeUndefined();
  });

  it("folds window + usage + model route into the MC view with per-model thresholds", async () => {
    const { root, registry } = await mount({ flat: true }, { executeThresholdByModel: { "deepseek/deepseek-v4": 50 } });
    const session = fakeSession();
    const emit = (event: Record<string, unknown>) => (root as unknown as { emit(...args: unknown[]): unknown }).emit("session/event", session as never, session.push(event) as never);
    emit({ type: "request/context", data: { provider: "deepseek", model: "deepseek-v4", contextWindow: 200_000 } });
    emit({
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 2_000, cacheReadTokens: 108_000, outputTokens: 10 },
        message: { id: "a1", role: "assistant", content: [], source: { kind: "model" } },
      },
    });
    const view = magicPressureViewSchema.parse(registry().snapshot(session, [MAGIC_PRESSURE_KEY]).values[MAGIC_PRESSURE_KEY]);
    expect(view.contextWindow).toBe(200_000);
    expect(view.pressureTokens).toBe(110_000);
    expect(view.usedTokens).toBe(view.projectedTokens ?? 110_000);
    expect(view.percent).toBe(55);
    expect(view.provider).toBe("deepseek");
    expect(view.model).toBe("deepseek-v4");
    expect(view.executePercentage).toBe(50);
    expect(view.forcePercentage).toBe(85);
    expect(view.emergencyPercentage).toBe(95);
    expect(view.executeTokens).toBe(100_000);
    expect(view.forceTokens).toBe(170_000);
    expect(view.managed).toBe(true);
    expect(view.enabled).toBe(true);
  });

  it("web sessions are managed only in the listed presets", async () => {
    const { registry } = await mount({ magicPresets: ["magic-standard"] });
    const inPreset = fakeSession({ agentPreset: "magic-standard" });
    const other = fakeSession({ agentPreset: "standard" });
    const viewOf = (s: unknown) =>
      registry().snapshot(s, [MAGIC_PRESSURE_KEY]).values[MAGIC_PRESSURE_KEY] as { managed: boolean; agentPreset?: string };
    expect(viewOf(inPreset)).toMatchObject({ managed: true, agentPreset: "magic-standard" });
    expect(viewOf(other)).toMatchObject({ managed: false, agentPreset: "standard" });
  });

  it("checkpointed state round-trips through the stateSchema (projection cache)", async () => {
    const { root, registry } = await mount({ flat: true });
    const session = fakeSession();
    (root as unknown as { emit(...args: unknown[]): unknown }).emit("session/event", session as never, session.push({ type: "request/context", data: { provider: "p", model: "m", contextWindow: 1000 } }) as never);
    const reg = registry() as unknown as {
      checkpoint(s: unknown): Record<string, { ver: number; seq: number; val: unknown }>;
      viewCheckpoint(rows: unknown, keys?: string[]): Record<string, unknown>;
    };
    const rows = JSON.parse(JSON.stringify(reg.checkpoint(session)));
    expect(rows[MAGIC_PRESSURE_KEY].ver).toBeGreaterThanOrEqual(1000);
    const restored = reg.viewCheckpoint(rows, [MAGIC_PRESSURE_KEY])[MAGIC_PRESSURE_KEY] as { contextWindow?: number; model?: string };
    expect(restored.contextWindow).toBe(1000);
    expect(restored.model).toBe("m");
  });

  it("with the stock token-meter still mounted, adds only the MC key (no second tokenMeter)", async () => {
    const root = new Context();
    (root as unknown as { plugin(p: unknown): unknown }).plugin(SessionProjectionRegistry);
    await settle(() => root.get("sessionProjections") !== undefined);
    const TokenMeter = (await import("@deepseek-ai/dsh-token-meter")).default;
    (root as unknown as { plugin(p: unknown): unknown }).plugin(TokenMeter);
    await settle(() => root.get("tokenMeter") !== undefined);
    const stock = root.get("tokenMeter");
    root.plugin(meterEntry as never, { flat: true } as never);
    const registry = root.get("sessionProjections") as { snapshot(s: unknown): { values: Record<string, unknown> } };
    const session = fakeSession();
    await settle(() => MAGIC_PRESSURE_KEY in registry.snapshot(session).values);
    expect(Object.keys(registry.snapshot(session).values).sort()).toEqual(
      ["contextBreakdown", "contextPressure", MAGIC_PRESSURE_KEY, "tokenUsage"].sort(),
    );
    // Same service instance (cordis hands out per-get proxies; compare its state map).
    expect((root.get("tokenMeter") as unknown as { states: unknown }).states).toBe((stock as unknown as { states: unknown }).states);
  });
});
