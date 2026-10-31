/**
 * Test fixtures: a fake DSH 0.2 install + profiles on disk (setup/doctor
 * tests). Mirrors the real 0.2.1-rc.5 layout: a hoisted
 * `node_modules/@deepseek-ai/{dsh,dsh-base,dsh-web-app}` tree whose bundle
 * patch files are declared in `package.json` `dsh.bundle.patch`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dump as yamlDump } from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { DSH_COMPAT_EXPECTED_VERSION, MAGIC_CONTEXT_PACKAGE } from "./env";

type Row = Record<string, unknown>;

export const SHIPPED_PROFILE_PATCH =
  "# Your patch layer for this dsh profile, applied after every bundle layer:\n" +
  "# a top-level YAML array of loader patch entries.\n[]\n";

export function stockCompactionGroup(): Row {
  return {
    id: "compaction",
    name: "cordis:group",
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
      { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
      { id: "tool-result-pruner", name: "@deepseek-ai/dsh-compaction-tool-result-pruner" },
    ],
  };
}

function writePkg(dir: string, manifest: Row, patches: Record<string, Row[]> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [rel, rows] of Object.entries(patches)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, yamlDump(rows, { schema: entryListSchema }));
  }
}

export interface FakeInstallOptions {
  readonly version?: string;
  /** Mutate the base root rows (layout-mismatch tests). */
  readonly baseRows?: (rows: Row[]) => Row[];
  /** Mutate the web standard preset plugins. */
  readonly presetPlugins?: (rows: Row[]) => Row[];
}

/** Writes `<root>/node_modules/@deepseek-ai/*`; returns the dsh package dir. */
export function fakeDshInstall(root: string, options: FakeInstallOptions = {}): string {
  const scope = join(root, "node_modules", "@deepseek-ai");
  const dsh = join(scope, "dsh");
  writePkg(dsh, { name: "@deepseek-ai/dsh", version: options.version ?? DSH_COMPAT_EXPECTED_VERSION });
  const baseRows: Row[] = [
    { id: "token-meter", name: "@deepseek-ai/dsh-token-meter" },
    { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
    { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
  ];
  writePkg(
    join(scope, "dsh-base"),
    { name: "@deepseek-ai/dsh-base", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
    { "cordis.patch.yml": [{ insert: (options.baseRows ?? ((r) => r))(baseRows) }] },
  );
  const plugins: Row[] = [
    { id: "persona", name: "@deepseek-ai/dsh-persona" },
    stockCompactionGroup(),
    { id: "tool-ask-user", name: "@deepseek-ai/dsh-tool-ask-user" },
  ];
  writePkg(
    join(scope, "dsh-web-app"),
    {
      name: "@deepseek-ai/dsh-web-app",
      dsh: {
        bundle: {
          patch: ["./cordis.patch.yml", "./presets/standard.patch.yml", "./presets/minimal.patch.yml", "./presets/ptc.patch.yml"],
        },
      },
    },
    {
      "cordis.patch.yml": [{ id: "compaction-basic", disabled: true }],
      "presets/standard.patch.yml": [
        {
          insert: [
            {
              id: "preset-standard",
              name: "@deepseek-ai/dsh-agent-preset",
              config: { id: "standard", order: 1, plugins: (options.presetPlugins ?? ((r) => r))(plugins) },
            },
          ],
        },
      ],
      // minimal isolates only the compaction realm (no tool-result-pruner).
      "presets/minimal.patch.yml": [
        {
          insert: [
            {
              id: "preset-minimal",
              name: "@deepseek-ai/dsh-agent-preset",
              config: {
                id: "minimal",
                order: 3,
                plugins: [
                  { id: "persona", name: "@deepseek-ai/dsh-persona", config: { complete: true } },
                  {
                    id: "compaction",
                    name: "cordis:group",
                    group: true,
                    isolate: { compaction: true },
                    config: [
                      { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
                      { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
      "presets/ptc.patch.yml": [
        {
          insert: [
            {
              id: "preset-ptc",
              name: "@deepseek-ai/dsh-agent-preset",
              config: { id: "ptc", order: 2, plugins: [{ id: "persona", name: "@deepseek-ai/dsh-persona" }, stockCompactionGroup()] },
            },
          ],
        },
      ],
    },
  );
  return dsh;
}

export interface FakeProfileOptions {
  /** Install the Magic package into the profile's node_modules (default true). */
  readonly installed?: boolean;
  readonly patch?: string;
}

export function fakeDshProfile(
  dshHome: string,
  name: string,
  bundles: string[],
  options: FakeProfileOptions = {},
): string {
  const dir = join(dshHome, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `dsh-profile-${name}`, private: true, dsh: { profile: { bundles } } }, null, 2),
  );
  writeFileSync(join(dir, "cordis.patch.yml"), options.patch ?? SHIPPED_PROFILE_PATCH);
  if (options.installed !== false) {
    const pkg = join(dir, "node_modules", MAGIC_CONTEXT_PACKAGE);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: MAGIC_CONTEXT_PACKAGE }));
  }
  return dir;
}
