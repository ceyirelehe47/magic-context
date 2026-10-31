/**
 * Packaging guards found by the real-DSH (0.2.1-rc.5) install run:
 *
 *  1. The packed tarball must not carry a runtime dependency on the
 *     unpublished `dsh-magic-context-adapter` (it is inlined by `bun build`);
 *     a `workspace:*` dependency is rewritten to a registry version on pack
 *     and the install 404s.
 *  2. The core opens the shared DB through `migration-worker.js` resolved next
 *     to the importing chunk (`new URL("./migration-worker.js", import.meta.url)`).
 *     Host chunks live in `dist/`, agent-plane chunks in `dist/entries/`, so
 *     every worker entry must be emitted into BOTH directories, or the host
 *     fails with "storage unavailable: the migration worker could not start".
 *  3. The `dsh-magic-context` bin (setup/doctor) runs outside DSH, where the
 *     DSH-owned `@deepseek-ai/cordis` is not resolvable from the profile's
 *     node_modules (pnpm `autoInstallPeers: false`), so it must be inlined.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts: Record<string, string>;
};

const WORKERS = [
  "migration-worker.ts",
  "embedding-worker.ts",
  "embedding-worker-process.ts",
  "auto-search-worker.ts",
  "raw-ordinal-warmup-worker.ts",
  "compaction-marker-candidates-worker.ts",
  "chunk-embedding-write-worker.ts",
];

describe("dsh-plugin packaging", () => {
  test("no workspace:* runtime dependencies (adapter is bundled)", () => {
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      expect(`${name}@${range}`).not.toContain("workspace:");
    }
    expect(pkg.dependencies?.["dsh-magic-context-adapter"]).toBeUndefined();
    expect(pkg.devDependencies?.["dsh-magic-context-adapter"]).toBe("workspace:*");
  });

  test("build emits every core worker into dist/ and dist/entries/", () => {
    expect(pkg.scripts.build).toContain("bun run build:workers");
    const workers = pkg.scripts["build:workers"];
    expect(workers).toBeDefined();
    for (const w of WORKERS) expect(workers).toContain(w);
    expect(workers).toContain("--outdir dist ");
    expect(workers).toContain("--outdir dist/entries ");
    expect(workers).toContain("--entry-naming '[name].[ext]'");
  });

  test("setup/doctor bin inlines @deepseek-ai/cordis", () => {
    const cli = pkg.scripts.build.match(/bun build src\/doctor\/cli\.ts[^&]*/)?.[0];
    expect(cli).toBeDefined();
    expect(cli).not.toContain("--external @deepseek-ai/cordis");
  });
});
