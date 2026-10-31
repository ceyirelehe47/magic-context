import { describe, expect, it } from "bun:test";
import {
  MAGIC_SETTINGS_NAMESPACE,
  buildMagicHostConfigSchema,
  loadSchemastery,
  readMagicOverrides,
  resolveEffectiveSettings,
  resolveThresholds,
  validateMagicSettingsOps,
} from "./magic-settings";
import { applySettingsUpdate, buildSettingsView, resetJsoncCache, type SettingsFormsView } from "../host/remote";
import { createLiveSettings } from "../agent/index";
import * as hostEntry from "../index";
import type { MagicContextHostService } from "../index";

describe("DSH settings overlay schema (real schemastery)", () => {
  it("resolves schemastery and exports a host Config", () => {
    expect(loadSchemastery()).toBeDefined();
    expect(hostEntry.Config).toBeDefined();
  });

  it("overlay fields are volatile refs even when unset; ordinary fields stay plain", () => {
    const schema = buildMagicHostConfigSchema() as (value: unknown) => Record<string, unknown>;
    const parsed = schema({ directory: "/w", enabled: false, executeThresholdByModel: { "deepseek/deepseek-chat": 50 } });
    expect(parsed.directory).toBe("/w");
    expect(typeof (parsed.enabled as { get: () => unknown }).get).toBe("function");
    expect((parsed.historianModel as { get: () => unknown }).get()).toBeUndefined();
    expect(readMagicOverrides(parsed)).toEqual({
      enabled: false,
      executeThresholdByModel: { "deepseek/deepseek-chat": 50 },
    });
    const json = JSON.stringify((schema as unknown as { toJSON: () => unknown }).toJSON());
    expect(json).toContain('"volatile":true');
  });

  it("rejects out-of-range overlay values at the schema (Loader refuses the write)", () => {
    const schema = buildMagicHostConfigSchema() as (value: unknown) => unknown;
    expect(() => schema({ executeThresholdPercentage: 95 })).toThrow();
    expect(() => schema({ protectedTokens: 10 })).toThrow();
  });
});

describe("precedence: DSH override > jsonc > core default", () => {
  it("unset overlay inherits jsonc, set overlay wins", () => {
    const jsonc = {
      enabled: true,
      execute_threshold_percentage: { default: 60, "anthropic/claude-x": 40 },
      protected_tokens: 20_000,
      historian: { model: "openai/gpt-x" },
    } as never;
    const inherited = resolveEffectiveSettings(jsonc, {}, {});
    expect(inherited.enabled).toEqual({ value: true, source: "jsonc" });
    expect(inherited.protectedTokens).toEqual({ value: 20_000, source: "jsonc" });
    expect(inherited.historianModel).toEqual({ value: "openai/gpt-x", source: "jsonc" });
    expect(inherited.executeThreshold.source).toBe("jsonc");

    const overridden = resolveEffectiveSettings(
      jsonc,
      { enabled: false, protectedTokens: 8_000, executeThresholdPercentage: 70, executeThresholdByModel: { "deepseek/deepseek-v4": 55 } },
      {},
    );
    expect(overridden.enabled).toEqual({ value: false, source: "dsh" });
    expect(overridden.protectedTokens.value).toBe(8_000);
    const value = overridden.executeThreshold.value as Record<string, number>;
    expect(value.default).toBe(70);
    // jsonc per-model keys survive the overlay; DSH keys add to them.
    expect(value["anthropic/claude-x"]).toBe(40);
    expect(value["deepseek/deepseek-v4"]).toBe(55);
  });

  it("defaults when neither source sets a field (core 65%)", () => {
    const eff = resolveEffectiveSettings(undefined, {}, {});
    expect(eff.enabled).toEqual({ value: true, source: "default" });
    expect(eff.executeThreshold).toEqual({ value: 65, source: "default" });
    expect(eff.historianAwaitAtTurnEndMs.value).toBe(0);
    const env = resolveEffectiveSettings(undefined, {}, { MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS: "4000" });
    expect(env.historianAwaitAtTurnEndMs.value).toBe(4000);
  });

  it("thresholds: per-model match + force band max(85, t+2) + 95% wall", () => {
    const eff = resolveEffectiveSettings(undefined, { executeThresholdByModel: { "deepseek/deepseek-v4": 50 } }, {});
    const match = resolveThresholds(eff, "deepseek/deepseek-v4");
    expect(match.executePercentage).toBe(50);
    expect(match.forcePercentage).toBe(85);
    expect(match.emergencyPercentage).toBe(95);
    const other = resolveThresholds(eff, "openai/gpt-x");
    expect(other.executePercentage).toBe(65);
    const high = resolveThresholds(resolveEffectiveSettings(undefined, { executeThresholdPercentage: 88 }, {}), undefined);
    expect(high.forcePercentage).toBe(90);
  });

  it("execute_threshold_tokens from jsonc switches to tokens mode when the window is known", () => {
    const eff = resolveEffectiveSettings({ execute_threshold_tokens: { default: 50_000 } } as never, {}, {});
    const t = resolveThresholds(eff, "x/y", 100_000);
    expect(t.mode).toBe("tokens");
    expect(t.executePercentage).toBe(50);
    expect(resolveThresholds(eff, "x/y").mode).toBe("percentage");
  });
});

describe("validateMagicSettingsOps", () => {
  it("accepts overlay set/unset and bounded values", () => {
    expect(
      validateMagicSettingsOps([
        { op: "set", path: ["enabled"], value: true },
        { op: "set", path: ["historianModel"], value: "opencode-go/deepseek-v4.1-flash" },
        { op: "set", path: ["executeThresholdByModel", "deepseek/deepseek-v4"], value: 50 },
        { op: "unset", path: ["protectedTokens"] },
      ]),
    ).toBeUndefined();
  });
  it("refuses foreign fields, bad paths and out-of-range values", () => {
    expect(validateMagicSettingsOps([{ op: "set", path: ["directory"], value: "/etc" }])).toContain("not editable");
    expect(validateMagicSettingsOps([{ op: "set", path: ["enabled", "x"], value: true }])).toContain("sub-path");
    expect(validateMagicSettingsOps([{ op: "set", path: ["executeThresholdPercentage"], value: 95 }])).toContain("[20, 90]");
    expect(validateMagicSettingsOps([{ op: "set", path: ["historianModel"], value: "no-slash" }])).toContain("provider/model");
    expect(validateMagicSettingsOps([{ op: "set", path: ["protectedTokens"], value: 4000.5 }])).toContain("integer");
    expect(validateMagicSettingsOps([])).toBe("ops is empty");
    expect(validateMagicSettingsOps("x")).toBe("ops must be an array");
  });
});

/** A dsh-settings stand-in with the real revision/conflict contract. */
function fakeForms(initial: Record<string, unknown> = {}) {
  let revision = 3;
  let user: Record<string, unknown> = { ...initial };
  const calls: unknown[] = [];
  const forms: SettingsFormsView & { bump(): void } = {
    writable: true,
    describe: () => [
      { ns: "other", revision: 1 },
      { ns: MAGIC_SETTINGS_NAMESPACE, revision, user: { ...user, directory: "/ignored" } },
    ],
    async mutate(ns, ops, expectedRevision) {
      calls.push({ ns, ops, expectedRevision });
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        const error = Object.assign(new Error("conflict"), {
          code: "SETTINGS_CONFLICT",
          expected: expectedRevision,
          actual: revision,
        });
        throw error;
      }
      for (const op of ops) {
        const [field, sub] = op.path;
        if (op.op === "unset") {
          if (sub === undefined) delete user[field!];
          else delete (user[field!] as Record<string, unknown>)[sub];
        } else if (sub === undefined) user[field!] = op.value;
        else user[field!] = { ...((user[field!] as Record<string, unknown>) ?? {}), [sub]: op.value };
      }
      revision += 1;
    },
    bump() {
      revision += 1;
    },
  };
  return { forms, calls, user: () => user };
}

const host = (overrides: Record<string, unknown> = {}): MagicContextHostService =>
  ({
    ready: Promise.resolve({ kind: "refused" }),
    canonicalKey: (id: string) => `dsh:test:${id}`,
    parseKey: () => undefined,
    registerSummarizeHook() {},
    summarizeHook: () => undefined,
    overrides: () => overrides,
  }) as never;

describe("magicContext/settings + updateSettings (remote)", () => {
  it("view carries revision, user layer (overlay fields only), effective values and precedence", () => {
    resetJsoncCache();
    const { forms } = fakeForms({ enabled: false });
    const view = buildSettingsView(forms, host({ enabled: false }));
    expect(view.available).toBe(true);
    expect(view.revision).toBe(3);
    expect(view.user).toEqual({ enabled: false });
    expect(view.effective.enabled.source).toBe("dsh");
    expect(view.precedence).toContain("never written");
  });

  it("writes through settings.mutate with the expected revision", async () => {
    const { forms, calls, user } = fakeForms();
    const result = await applySettingsUpdate(forms, host(), {
      ops: [{ op: "set", path: ["historianModel"], value: "  opencode-go/deepseek-v4.1-flash " }],
      expectedRevision: 3,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { ns: "magic-host", ops: [{ op: "set", path: ["historianModel"], value: "opencode-go/deepseek-v4.1-flash" }], expectedRevision: 3 },
    ]);
    expect(user()).toEqual({ historianModel: "opencode-go/deepseek-v4.1-flash" });
    if (result.ok) expect(result.view.revision).toBe(4);
  });

  it("a stale revision answers conflict with the fresh view (no write)", async () => {
    const { forms, user } = fakeForms();
    forms.bump();
    const result = await applySettingsUpdate(forms, host(), {
      ops: [{ op: "set", path: ["enabled"], value: false }],
      expectedRevision: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("conflict");
      expect(result.expected).toBe(3);
      expect(result.actual).toBe(4);
      expect(result.view?.revision).toBe(4);
    }
    expect(user()).toEqual({});
  });

  it("invalid ops never reach mutate; missing dsh-settings answers unavailable", async () => {
    const { forms, calls } = fakeForms();
    const bad = await applySettingsUpdate(forms, host(), { ops: [{ op: "set", path: ["port"], value: 1 }] });
    expect(bad.ok === false && bad.code).toBe("invalid");
    expect(calls).toEqual([]);
    const none = await applySettingsUpdate(undefined, host(), { ops: [{ op: "unset", path: ["enabled"] }] });
    expect(none.ok === false && none.code).toBe("unavailable");
    expect(buildSettingsView(undefined, host()).available).toBe(false);
  });

  it("read-only profiles refuse the write", async () => {
    const { forms } = fakeForms();
    (forms as { writable: boolean }).writable = false;
    const result = await applySettingsUpdate(forms, host(), { ops: [{ op: "unset", path: ["enabled"] }] });
    expect(result.ok === false && result.code).toBe("refused");
  });
});

describe("agent plane live settings", () => {
  it("re-reads the host overrides on every call (live edits, no remount)", () => {
    let overrides: Record<string, unknown> = {};
    const live = createLiveSettings({ overrides: () => overrides } as never, "/nonexistent-dir-for-test");
    expect(live.enabled()).toBe(true);
    const agent = { options: { provider: "deepseek", model: "deepseek-v4" } };
    const before = live.thresholdFor(agent);
    overrides = { enabled: false, executeThresholdByModel: { "deepseek/deepseek-v4": 42 } };
    expect(live.enabled()).toBe(false);
    expect(live.thresholdFor(agent)).toBe(42);
    expect(before).not.toBe(42);
  });

  it("host service dereferences volatile refs from its Config", () => {
    const schema = hostEntry.Config as (value: unknown) => Record<string, unknown>;
    const config = schema({ protectedTokens: 12_000 });
    const provided: Record<string, unknown> = {};
    const ctx = {
      provide: (name: string, value: unknown) => {
        provided[name] = value;
      },
      logger: undefined,
    };
    hostEntry.apply(ctx as never, { ...config, directory: "/tmp", homeHash: "abcd1234" } as never);
    const service = provided.magicContextHost as MagicContextHostService;
    expect(service.overrides?.()).toEqual({ protectedTokens: 12_000 });
  });
});
