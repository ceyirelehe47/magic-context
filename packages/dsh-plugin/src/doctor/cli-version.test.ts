import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string };

describe("dsh-magic-context --version", () => {
  it("prints the package.json version (no second hand-kept copy)", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      expect(await main(["--version"])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual([pkg.version]);
  });

  it("follows the downstream naming <upstream>-dsh.N (DSH-MAINTENANCE 版本命名)", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+-dsh\.\d+$/);
  });
});
