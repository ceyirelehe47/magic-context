import { describe, expect, it } from "bun:test";
import { countProtectionWindow } from "./protection";

const tag = (tagNumber: number, type: "tool" | "message" | "file") => ({ tagNumber, type });

describe("countProtectionWindow (newest-N → core protection window)", () => {
  it("returns a null cutoff when the session has no tool tags", () => {
    expect(countProtectionWindow([tag(1, "message"), tag(2, "message")], 5)).toEqual({
      protectedTagNumbers: new Set(),
      protectedCutoff: null,
    });
  });

  it("protects the tool tags inside the newest-N suffix and cuts at its lowest tag", () => {
    const tags = [tag(1, "tool"), tag(2, "message"), tag(3, "tool"), tag(4, "message"), tag(5, "tool")];
    const window = countProtectionWindow(tags, 3);
    expect(window.protectedCutoff).toBe(3);
    expect([...window.protectedTagNumbers].sort()).toEqual([3, 5]);
  });

  it("count 0 protects nothing (cutoff above the newest tag)", () => {
    const window = countProtectionWindow([tag(1, "tool"), tag(2, "tool")], 0);
    expect(window.protectedTagNumbers.size).toBe(0);
    expect(window.protectedCutoff).toBe(3);
  });
});
