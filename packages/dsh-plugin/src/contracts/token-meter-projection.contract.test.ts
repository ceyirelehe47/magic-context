/**
 * Token-meter projection contract (runtime, DSH 0.2.1-rc.5).
 *
 * Pins the projection key and wire-view field names the adapter reads for the
 * historian pressure trigger and the protection-floor usable window:
 * `sessionProjections.snapshot(session).values.contextPressure` →
 * `{ contextWindow?, pressureTokens?, projectedTokens? }`.
 *
 * The REAL `TokenMeter` service registers its units against a capturing
 * `sessionProjections` stand-in; the captured `contextPressure` definition is
 * folded over real-shaped events and its `wire.view` output is fed through the
 * adapter's `readContextPressure`. A DSH rename of the key or a field fails
 * here first.
 */
import { describe, expect, it } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import {
  CONTEXT_PRESSURE_PROJECTION_KEY,
  pressureSampleFromView,
  readContextPressure,
} from "../agent/historian-wiring";

interface CapturedDefinition {
  key: string;
  init: () => unknown;
  apply: (state: unknown, event: unknown) => unknown;
  wire?: { view: (state: unknown) => unknown };
}

async function captureDefinitions(): Promise<Map<string, CapturedDefinition>> {
  const defs = new Map<string, CapturedDefinition>();
  const ctx = new Context();
  const registry = {
    register(definition: CapturedDefinition) {
      defs.set(definition.key, definition);
      return () => defs.delete(definition.key);
    },
  };
  ctx.provide("sessionProjections", registry as never);
  ctx.plugin(TokenMeter as never);
  // Cordis applies plugins on the next tick once their inject is satisfied.
  for (let i = 0; i < 20 && !defs.has(CONTEXT_PRESSURE_PROJECTION_KEY); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return defs;
}

describe("contract: token-meter contextPressure projection (0.2.1-rc.5)", () => {
  it("registers the unit under the key the adapter reads", async () => {
    const defs = await captureDefinitions();
    expect(CONTEXT_PRESSURE_PROJECTION_KEY).toBe("contextPressure");
    expect(defs.has("contextPressure")).toBe(true);
    // Sibling units (not read by the adapter today) — documents the surface.
    expect(defs.has("tokenUsage")).toBe(true);
    expect(defs.has("contextBreakdown")).toBe(true);
  });

  it("wire view publishes contextWindow / pressureTokens / projectedTokens", async () => {
    const def = (await captureDefinitions()).get("contextPressure")!;
    let state = def.init();
    state = def.apply(state, { type: "request/context", seq: 1, time: 0, data: { contextWindow: 1_000_000 } });
    expect(def.wire!.view(state)).toEqual({ contextWindow: 1_000_000 });
    state = def.apply(state, {
      type: "assistant/message",
      seq: 2,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1_000, cacheReadTokens: 180_000, cacheWriteTokens: 1_000, outputTokens: 50 },
        message: { id: "a1", role: "assistant", content: [], source: { kind: "model" } },
      },
    });
    const view = def.wire!.view(state) as Record<string, number>;
    expect(Object.keys(view).sort()).toEqual(["contextWindow", "pressureTokens", "projectedTokens"]);
    expect(view.pressureTokens).toBe(182_000);
    expect(typeof view.projectedTokens).toBe("number");
  });

  it("readContextPressure reads exactly that key and view through snapshot()", async () => {
    const def = (await captureDefinitions()).get("contextPressure")!;
    let state = def.init();
    state = def.apply(state, { type: "request/context", seq: 1, time: 0, data: { contextWindow: 200_000 } });
    state = def.apply(state, {
      type: "assistant/message",
      seq: 2,
      time: 0,
      data: { turn: 1, step: 1, usage: { inputTokens: 40_000, outputTokens: 1 }, message: { id: "a1", role: "assistant", content: [], source: { kind: "model" } } },
    });
    const view = def.wire!.view(state);
    const requestedKeys: unknown[] = [];
    const ctx = {
      get: (name: string) =>
        name === "sessionProjections"
          ? {
              snapshot: (_session: unknown, keys?: readonly string[]) => {
                requestedKeys.push(keys);
                return { asOfSeq: 2, values: { contextPressure: view } };
              },
            }
          : undefined,
    };
    const sample = readContextPressure(ctx as never)({ session: { events: [] } } as never);
    expect(requestedKeys).toEqual([["contextPressure", "magicContextPressure"]]);
    expect(sample?.contextWindow).toBe(200_000);
    expect(sample?.projectedTokens).toBe((view as { projectedTokens: number }).projectedTokens);
  });

  it("a present key is authoritative; only an absent key falls back to the session log", () => {
    const logAgent = {
      session: {
        events: [
          { type: "request/context", data: { contextWindow: 128_000 } },
          { type: "assistant/message", data: { usage: { inputTokens: 9_000, outputTokens: 1 } } },
        ],
      },
    } as never;
    const present = { get: () => ({ snapshot: () => ({ values: { contextPressure: {} } }) }) };
    expect(readContextPressure(present as never)(logAgent)).toBeUndefined();
    const absent = { get: () => ({ snapshot: () => ({ values: {} }) }) };
    expect(readContextPressure(absent as never)(logAgent)).toEqual({ projectedTokens: 9_000, contextWindow: 128_000 });
    expect(pressureSampleFromView({ pressureTokens: 5, contextWindow: 10 })).toEqual({ projectedTokens: 5, contextWindow: 10 });
    // The MC meter key (stock row disabled by setup) is read the same way.
    const magic = { get: () => ({ snapshot: () => ({ values: { magicContextPressure: { contextWindow: 50, projectedTokens: 7 } } }) }) };
    expect(readContextPressure(magic as never)(logAgent)).toEqual({ projectedTokens: 7, contextWindow: 50 });
  });
});
