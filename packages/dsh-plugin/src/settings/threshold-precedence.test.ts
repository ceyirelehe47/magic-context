import { describe, expect, it } from "bun:test";
import { resolveEffectiveSettings, resolveThresholds } from "./magic-settings";

// Round 14 scan: a DSH per-model override written in the DSH-native spelling
// (`deepseek-official/…`) must beat a jsonc key for the same model written in
// the canonical spelling (`deepseek/…`). resolveThresholds tries the canonical
// key FIRST, so the canonical alias of a DSH key has to carry the DSH value.
describe("executeThresholdByModel: DSH override beats jsonc across key spellings", () => {
  const jsonc = { execute_threshold_percentage: { default: 60, "deepseek/deepseek-v4": 70 } } as never;

  it("DSH-native key overrides the jsonc canonical key of the same model", () => {
    const eff = resolveEffectiveSettings(jsonc, { executeThresholdByModel: { "deepseek-official/deepseek-v4": 50 } }, {});
    expect(resolveThresholds(eff, "deepseek-official/deepseek-v4").executePercentage).toBe(50);
    expect(resolveThresholds(eff, "deepseek/deepseek-v4").executePercentage).toBe(50);
    // unrelated models keep the jsonc default
    expect(resolveThresholds(eff, "openai/gpt-x").executePercentage).toBe(60);
  });

  it("an explicit DSH canonical key wins over the alias of a DSH-native key", () => {
    const eff = resolveEffectiveSettings(
      jsonc,
      { executeThresholdByModel: { "deepseek/deepseek-v4": 45, "deepseek-official/deepseek-v4": 50 } },
      {},
    );
    expect(resolveThresholds(eff, "deepseek/deepseek-v4").executePercentage).toBe(45);
  });

  it("without a jsonc key the DSH-native key still matches (unchanged behaviour)", () => {
    const eff = resolveEffectiveSettings(undefined, { executeThresholdByModel: { "deepseek-official/deepseek-v4": 50 } }, {});
    expect(resolveThresholds(eff, "deepseek-official/deepseek-v4").executePercentage).toBe(50);
  });
});
