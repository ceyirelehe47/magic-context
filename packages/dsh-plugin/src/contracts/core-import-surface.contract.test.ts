/**
 * Core import-surface contract (runtime).
 *
 * Scans every non-test adapter source file for value imports from
 * `@magic-context/core/*` and asserts each module still resolves and still
 * exports each named VALUE (functions, constants, classes) the adapter uses.
 * Type-only imports are covered by `tsc` (typecheck:dsh). This is what an
 * upstream sync (`.github/workflows/upstream-sync.yml`) trips on first when
 * core renames or deletes something the DSH layer calls — e.g. 0.49 removed
 * `shouldTriggerChannel2`, `runManagedUpgrade`, `sidekick/core`,
 * `DEFAULT_PROTECTED_TAGS`.
 *
 * The scan is self-maintaining: adding a core import to the adapter adds it
 * to this contract automatically.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_SRC = join(SRC, "..", "..", "plugin", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** module path → set of named value imports (type-only names excluded). */
export function collectCoreValueImports(files: readonly string[]): Map<string, Set<string>> {
  const surface = new Map<string, Set<string>>();
  const re = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']@magic-context\/core\/([^"']+)["']/g;
  const bare = /import\s+["']@magic-context\/core\/([^"']+)["']/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(re)) {
      const typeOnly = match[1] !== undefined;
      const module = match[3] as string;
      const names = surface.get(module) ?? new Set<string>();
      surface.set(module, names);
      if (typeOnly) continue;
      for (const raw of (match[2] as string).split(",")) {
        const spec = raw.trim();
        if (spec.length === 0 || spec.startsWith("type ")) continue;
        names.add(spec.split(/\s+as\s+/)[0]!.trim());
      }
    }
    for (const match of text.matchAll(bare)) {
      if (!surface.has(match[1] as string)) surface.set(match[1] as string, new Set());
    }
  }
  return surface;
}

const files = walk(SRC);
const surface = collectCoreValueImports(files);

describe("core import surface used by the DSH adapter", () => {
  it("scans a non-trivial surface (guards against a broken scanner)", () => {
    expect(surface.size).toBeGreaterThan(40);
    expect(surface.get("hooks/magic-context/ctx-reduce-nudge")?.has("decideChannel1")).toBe(true);
  });

  for (const [module, names] of [...surface.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    it(`@magic-context/core/${module} exports ${names.size === 0 ? "(module only)" : [...names].sort().join(", ")}`, async () => {
      const file = existsSync(join(CORE_SRC, `${module}.ts`))
        ? join(CORE_SRC, `${module}.ts`)
        : join(CORE_SRC, module, "index.ts");
      const mod = (await import(file)) as Record<string, unknown>;
      for (const name of names) {
        expect(mod[name], `${module}#${name}`).toBeDefined();
      }
    });
  }
});
