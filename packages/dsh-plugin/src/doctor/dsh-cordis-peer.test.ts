/**
 * Round 31 — the cordis peers must be satisfiable by the cordis that every
 * declared DSH installs, under npm's strict peer resolution (no
 * includePrerelease). Before round 31 the peers were `~4.0.5` / `~1.0.10`
 * (rc.5 only): `npm install` of the plugin next to DSH 0.2.2-rc.1 (cordis
 * 4.1.0, cordis-plugin-include 1.1.0) failed with ERESOLVE (已复现 round 31,
 * npm 10.9.9), and 0.2.2-alpha.3 (4.0.6-alpha.2 / 1.0.11-alpha.2) the same.
 * pnpm only warned, which is why the install acceptance stayed green.
 *
 * Versions are what each DSH's own `@deepseek-ai/dsh` package depends on
 * (npm view @deepseek-ai/dsh@<v> dependencies, 2026-11-05):
 *   0.2.1-rc.5    cordis ~4.0.5          plugin-include ~1.0.10        → 4.0.5 / 1.0.10
 *   0.2.2-alpha.3 cordis ~4.0.6-alpha.2  plugin-include ~1.0.11-alpha.2 → 4.0.6-alpha.2 / 1.0.11-alpha.2
 *   0.2.2-rc.1    cordis ~4.1.0          plugin-include ~1.1.0         → 4.1.0 / 1.1.0
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DSH_COMPAT_SUPPORTED_VERSIONS } from "./env";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
  peerDependencies: Record<string, string>;
};

const CORDIS_BY_DSH: Record<string, { cordis: string; include: string }> = {
  "0.2.1-rc.5": { cordis: "4.0.5", include: "1.0.10" },
  "0.2.2-alpha.3": { cordis: "4.0.6-alpha.2", include: "1.0.11-alpha.2" },
  "0.2.2-rc.1": { cordis: "4.1.0", include: "1.1.0" },
};

describe("cordis peers vs the declared DSH versions (round 31)", () => {
  test("the table covers exactly the declared DSH versions", () => {
    expect(Object.keys(CORDIS_BY_DSH)).toEqual([...DSH_COMPAT_SUPPORTED_VERSIONS]);
  });

  test("each declared DSH's cordis and cordis-plugin-include satisfy the peers (strict, no includePrerelease)", () => {
    const cordis = pkg.peerDependencies["@deepseek-ai/cordis"];
    const include = pkg.peerDependencies["@deepseek-ai/cordis-plugin-include"];
    for (const [dsh, v] of Object.entries(CORDIS_BY_DSH)) {
      expect(`${dsh}: cordis ${v.cordis} ${Bun.semver.satisfies(v.cordis, cordis)}`).toBe(`${dsh}: cordis ${v.cordis} true`);
      expect(`${dsh}: include ${v.include} ${Bun.semver.satisfies(v.include, include)}`).toBe(`${dsh}: include ${v.include} true`);
    }
  });

  test("an untested cordis line stays outside the peers", () => {
    const cordis = pkg.peerDependencies["@deepseek-ai/cordis"];
    const include = pkg.peerDependencies["@deepseek-ai/cordis-plugin-include"];
    for (const v of ["4.2.0", "5.0.0", "4.0.4", "4.0.6-alpha.1", "3.9.0"]) expect(`${v} ${Bun.semver.satisfies(v, cordis)}`).toBe(`${v} false`);
    for (const v of ["1.2.0", "2.0.0", "1.0.9", "1.0.11-alpha.1"]) expect(`${v} ${Bun.semver.satisfies(v, include)}`).toBe(`${v} false`);
  });
});
