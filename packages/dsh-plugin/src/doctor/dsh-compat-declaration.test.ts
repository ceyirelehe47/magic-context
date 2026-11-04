/**
 * Round 29 — the DSH versions this adapter declares (DSH 0.2.1-rc.5 and
 * 0.2.2-alpha.3, user-approved 2026-11-04 23:25 CST), checked the way DSH's
 * own plugin manager judges a bundle: `@deepseek-ai/dsh-app-boot`
 * `evaluatePluginCompatibility` (identical in 0.2.1-rc.5 and 0.2.2-alpha.3)
 * reads `engines.dsh` when present, else every `@deepseek-ai/dsh` /
 * `@deepseek-ai/dsh-*` peer, and requires
 * `semver.satisfies(runtime, range, { includePrerelease: true })`.
 *
 * The declaration is an explicit list of exact versions joined by `||`, so
 * an untested DSH (0.2.2-rc.1, the next alpha, 0.2.2 final …) is NOT
 * accepted. The default path stays on 0.2.1-rc.5 (devDependencies + lockfile).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as env from "./env";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  engines?: Record<string, string>;
};

const SUPPORTED = ["0.2.1-rc.5", "0.2.2-alpha.3"];
const UNTESTED = [
  "0.2.2-rc.1",
  "0.2.2-alpha.2",
  "0.2.2-alpha.4",
  "0.2.2",
  "0.2.1",
  "0.2.1-rc.4",
  "0.2.1-rc.6",
  "0.2.3-alpha.0",
  "0.3.0",
];
const isDsh = (name: string) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-");
const dshPeers = () => Object.entries(pkg.peerDependencies).filter(([name]) => isDsh(name));

/** DSH's requirement rule (app-boot `unmetRequirements`), on Bun's semver. */
function unmet(runtime: string): string[] {
  const engine = pkg.engines?.dsh;
  if (engine !== undefined) return Bun.semver.satisfies(runtime, engine) ? [] : ["engines.dsh"];
  return dshPeers()
    .filter(([, range]) => !(range.trim() !== "" && Bun.semver.satisfies(runtime, range)))
    .map(([name]) => name);
}

describe("DSH version declaration (round 29)", () => {
  test("env exports the supported list; the pinned default stays 0.2.1-rc.5", () => {
    const list = (env as Record<string, unknown>).DSH_COMPAT_SUPPORTED_VERSIONS;
    expect(list).toEqual(SUPPORTED);
    expect(env.DSH_COMPAT_EXPECTED_VERSION).toBe("0.2.1-rc.5");
    const isSupported = (env as Record<string, unknown>).isSupportedDshVersion as ((v: string) => boolean) | undefined;
    expect(typeof isSupported).toBe("function");
    for (const v of SUPPORTED) expect(isSupported?.(v)).toBe(true);
    for (const v of UNTESTED) expect(isSupported?.(v)).toBe(false);
  });

  test("every DSH peer is exactly the supported list as '||'-joined exact versions", () => {
    expect(dshPeers().length).toBeGreaterThan(0);
    for (const [name, range] of dshPeers()) {
      const alternatives = range.split("||").map((part) => part.trim());
      expect(`${name}: ${alternatives.join(" | ")}`).toBe(`${name}: ${SUPPORTED.join(" | ")}`);
      for (const alt of alternatives) expect(alt).toMatch(/^\d+\.\d+\.\d+-[0-9A-Za-z.]+$/);
    }
    // engines.dsh would make DSH ignore the peers: keep the one declaration.
    expect(pkg.engines?.dsh).toBeUndefined();
  });

  test("DSH's own rule accepts 0.2.1-rc.5 and 0.2.2-alpha.3", () => {
    for (const v of SUPPORTED) expect(`${v}: ${unmet(v).join(",")}`).toBe(`${v}: `);
  });

  test("DSH's own rule rejects every untested DSH version", () => {
    for (const v of UNTESTED) expect(unmet(v).length).toBe(dshPeers().length);
  });

  test("devDependencies (lockfile, default CI path) stay pinned to 0.2.1-rc.5", () => {
    const dev = Object.entries(pkg.devDependencies).filter(([name]) => isDsh(name));
    expect(dev.length).toBeGreaterThan(0);
    for (const [name, range] of dev) expect(`${name}@${range}`).toBe(`${name}@0.2.1-rc.5`);
  });
});
