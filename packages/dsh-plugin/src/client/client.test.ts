/**
 * Client bundle (browser half) — loaded through a fake `window.__ModuleLoader__`
 * with the real `react` + `react/jsx-runtime`. Pins: no ui-primitives require
 * (client purity rule), the four slot contributions, the settings draft → ops
 * diff (inherit = unset, per-model object), and the indicator tones.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";

type Factory = (require: (id: string) => unknown) => Record<string, unknown>;

function loadClient() {
  const source = readFileSync(join(import.meta.dir, "client.js"), "utf8");
  let factory: Factory | undefined;
  const required: string[] = [];
  const g = globalThis as unknown as { window?: unknown };
  const previous = g.window;
  g.window = { __ModuleLoader__: { load: (spec: { factory: Factory }) => (factory = spec.factory) } };
  try {
    new Function(source)();
  } finally {
    g.window = previous;
  }
  const mod = factory!((id) => {
    required.push(id);
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return JsxRuntime;
    if (id === "@deepseek-ai/dsh-client-store") {
      return {
        createSnapshotStore: (initial: unknown) => {
          let value = initial;
          return { getSnapshot: () => value, subscribe: () => () => {}, set: (next: unknown) => (value = next) };
        },
      };
    }
    throw new Error(`unavailable: ${id}`);
  });
  return { mod, required };
}

const view = {
  available: true,
  writable: true,
  revision: 7,
  user: { enabled: false, executeThresholdByModel: { "deepseek/deepseek-v4": 50 } },
  bounds: {
    executeThresholdPercentage: { min: 20, max: 90 },
    protectedTokens: { min: 4000, max: 1000000 },
    historianAwaitAtTurnEndMs: { min: 0, max: 60000 },
  },
};

describe("client bundle", () => {
  // `staticModules` of the 0.2.1-rc.5 web boot (dsh-web-frontend index-*.js
  // `OZ()`): the only ids a third-party client bundle can `require`. A require
  // outside this set throws inside the factory and the whole bundle is lost
  // (round 7: `@deepseek-ai/dsh-client-runtime/client` does not exist at 0.2).
  const WEB_STATIC_MODULES = new Set([
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
    "@deepseek-ai/cordis",
    "zod",
    "@tanstack/react-virtual",
    "@deepseek-ai/dsh-client-store",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-dockkit",
  ]);
  it("only requires modules the rc.5 web boot provides statically", () => {
    const { required } = loadClient();
    expect(required.filter((id) => !WEB_STATIC_MODULES.has(id))).toEqual([]);
    expect(required).toContain("@deepseek-ai/dsh-client-store");
  });

  it("declares only installed client inject targets (no dsh-client-runtime)", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8"));
    expect(pkg.dsh.client.inject).not.toContain("@deepseek-ai/dsh-client-runtime");
  });

  it("never requires @deepseek-ai/dsh-client-ui-primitives and registers its four slots", () => {
    const { mod, required } = loadClient();
    expect(required.some((id) => id.includes("ui-primitives"))).toBe(false);
    expect(mod.inject).toEqual(["slots", "connection"]);
    const registered: Array<{ name: string; id?: string; key?: string }> = [];
    const ctx = {
      get: () => ({ rpc: { call: async () => ({ ok: true, value: {} }) } }),
      slots: {
        inject: (_name: string, thunk: () => unknown) => thunk(),
        register: (spec: { name: string; id?: string; key?: string }) => {
          registered.push({ name: spec.name, id: spec.id, key: spec.key });
          return () => {};
        },
      },
    };
    (mod.apply as (c: unknown) => void)(ctx);
    expect(registered).toEqual([
      { name: "settings.section", id: "magic-context", key: undefined },
      { name: "plugins.bundle.config", id: undefined, key: "dsh-magic-context" },
      { name: "conversation.session.header.actions", id: "magic-context-status", key: undefined },
      { name: "conversation.composer.dock", id: "magic-context-meter", key: undefined },
    ]);
  });

  it("draft → ops: inherit unsets, override sets bounded values, per-model diff is one op", () => {
    const t = (loadClient().mod.__test as Record<string, (...a: unknown[]) => unknown>);
    const draft = t.draftFromView(view) as Record<string, { mode: string; value: unknown }> & {
      executeThresholdByModel: Array<{ model: string; value: unknown }>;
    };
    expect(draft.enabled).toEqual({ mode: "override", value: false });
    expect(draft.protectedTokens).toEqual({ mode: "inherit", value: "" });
    expect(t.opsFromDraft(view, draft)).toEqual({ ops: [], invalid: [] });

    draft.enabled = { mode: "inherit", value: "" };
    draft.protectedTokens = { mode: "override", value: "12000" };
    draft.executeThresholdByModel = [
      { model: "deepseek/deepseek-v4", value: "55" },
      { model: "", value: "70" },
    ];
    expect(t.opsFromDraft(view, draft)).toEqual({
      ops: [
        { op: "unset", path: ["enabled"] },
        { op: "set", path: ["protectedTokens"], value: 12000 },
        { op: "set", path: ["executeThresholdByModel"], value: { "deepseek/deepseek-v4": 55 } },
      ],
      invalid: [],
    });
    draft.executeThresholdByModel = [];
    draft.executeThresholdPercentage = { mode: "override", value: "95" };
    const out = t.opsFromDraft(view, draft) as { ops: unknown[]; invalid: string[] };
    expect(out.invalid).toEqual(["executeThresholdPercentage"]);
    expect(out.ops).toContainEqual({ op: "unset", path: ["executeThresholdByModel"] });
  });

  it("indicator tone: neutral < execute ≤ warn < force−3 ≤ danger; unmanaged/paused stay neutral", () => {
    const tone = (loadClient().mod.__test as Record<string, (p: unknown) => string>).meterTone;
    const p = (percent: number, extra: Record<string, unknown> = {}) => ({
      percent,
      managed: true,
      enabled: true,
      executePercentage: 65,
      forcePercentage: 85,
      ...extra,
    });
    expect(tone(p(40))).toBe("");
    expect(tone(p(65))).toBe("ckmc-warn");
    expect(tone(p(81))).toBe("ckmc-warn");
    expect(tone(p(82))).toBe("ckmc-danger");
    expect(tone(p(97))).toBe("ckmc-danger");
    expect(tone(p(97, { managed: false }))).toBe("");
    expect(tone(p(97, { enabled: false }))).toBe("");
  });

  it("remote calls ride the Typert /api channel as magicContext/<method> with payload.args.args", async () => {
    const calls: unknown[] = [];
    const t = loadClient().mod.__test as { callRemote: (c: unknown, m: string, a: unknown) => Promise<unknown> };
    await t.callRemote({ rpc: { call: async (...args: unknown[]) => (calls.push(args), { ok: true, value: 1 }) } }, "updateSettings", { ops: [] });
    expect(calls).toEqual([["/api", "magicContext/updateSettings", { args: { args: { ops: [] } } }]]);
    expect(await t.callRemote(undefined, "settings", {})).toMatchObject({ ok: false });
  });
});
