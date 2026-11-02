import { describe, expect, it } from "bun:test";
import { validateMagicSettingsOps } from "./magic-settings";

/**
 * Round 15 scan (web settings API input): per-model threshold keys were not
 * validated at all — any string (including "__proto__", whitespace, a bare
 * model name that can never match a `provider/model` ref) was stored in the
 * profile; the whole-object form had no entry cap and historianModel no
 * length cap, so one request could write an arbitrarily large overlay row.
 */
describe("validateMagicSettingsOps input bounds (round 15)", () => {
  const set = (path: string[], value: unknown) => [{ op: "set", path, value }];

  it("rejects per-model keys that are not provider/model, or reserved object keys", () => {
    expect(validateMagicSettingsOps(set(["executeThresholdByModel", "__proto__"], 50))).toBeDefined();
    expect(validateMagicSettingsOps(set(["executeThresholdByModel", "constructor"], 50))).toBeDefined();
    expect(validateMagicSettingsOps(set(["executeThresholdByModel", "deepseek-chat"], 50))).toBeDefined();
    expect(validateMagicSettingsOps(set(["executeThresholdByModel", " deepseek/x"], 50))).toBeDefined();
    expect(validateMagicSettingsOps(set(["executeThresholdByModel"], JSON.parse('{"__proto__": 50}')))).toBeDefined();
    expect(validateMagicSettingsOps(set(["executeThresholdByModel"], { "no-slash": 50 }))).toBeDefined();
    // Valid forms still pass (DSH-native and canonical spellings).
    expect(validateMagicSettingsOps(set(["executeThresholdByModel", "deepseek-official/deepseek-chat"], 50))).toBeUndefined();
    expect(validateMagicSettingsOps(set(["executeThresholdByModel"], { "deepseek/deepseek-chat": 60 }))).toBeUndefined();
    expect(validateMagicSettingsOps([{ op: "unset", path: ["executeThresholdByModel", "deepseek/deepseek-chat"] }])).toBeUndefined();
  });

  it("caps the whole-object entry count and the model-ref length", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 65; i++) many[`p/m${i}`] = 50;
    expect(validateMagicSettingsOps(set(["executeThresholdByModel"], many))).toBeDefined();
    expect(validateMagicSettingsOps(set(["historianModel"], `p/${"m".repeat(300)}`))).toBeDefined();
    expect(validateMagicSettingsOps(set(["historianModel"], "opencode-go/deepseek-v4-flash"))).toBeUndefined();
  });
});
