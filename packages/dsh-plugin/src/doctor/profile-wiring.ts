/**
 * doctor/profile-wiring — derive the Magic wiring for one DSH 0.2 profile.
 * Shared by `setup` (writes it) and `doctor` (diffs it).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { readJsoncFile } from "@magic-context/core/shared/jsonc-parser";
import {
  BASE_BUNDLE,
  WEB_APP_BUNDLE,
  buildFlatProfileEntries,
  buildWebPresetEntries,
  profileLayoutOf,
  scanFlatBaseLayout,
  scanWebPresetLayout,
  type ProfileLayout,
} from "../compat/dsh-0.1/profile-patch";
import {
  bundlePatchFiles,
  errorMessage,
  profileDir,
  profilePatchPath,
  resolveDshPackageDir,
} from "./env";

export interface ProfileWiringPlan {
  readonly profile: string;
  readonly profileDir: string;
  readonly packageJsonPath: string;
  readonly patchPath: string;
  readonly bundles: readonly string[];
  readonly layout: ProfileLayout;
  /** The stock file the contract scan read. */
  readonly scannedFile?: string;
  /** Rendered managed-block body (YAML list items). */
  readonly blockBody?: string;
  /** Contract / discovery failure (fail closed: nothing is written). */
  readonly issue?: string;
}

export function parseEntryListYaml(text: string): Record<string, unknown>[] {
  const parsed = yamlLoad(text, { schema: entryListSchema });
  return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
}

export function dumpEntryListYaml(entries: readonly unknown[]): string {
  return yamlDump(entries, { schema: entryListSchema, lineWidth: 120 });
}

export function readProfileBundles(dshHome: string, profile: string): string[] | undefined {
  const pkg = join(profileDir(dshHome, profile), "package.json");
  if (!existsSync(pkg)) return undefined;
  const parsed = readJsoncFile<{ dsh?: { profile?: { bundles?: unknown } } }>(pkg);
  const raw = parsed?.dsh?.profile?.bundles;
  return Array.isArray(raw) ? raw.map(String) : [];
}

/** Find a stock patch file of `pkg` whose basename matches `fileName`. */
function stockPatchFile(installDir: string, pkg: string, fileName: string): string | undefined {
  const dir = resolveDshPackageDir(installDir, pkg);
  if (dir === undefined) return undefined;
  return bundlePatchFiles(dir).find((file) => file.replace(/\\/g, "/").endsWith(fileName));
}

export function planProfileWiring(opts: {
  readonly dshHome: string;
  readonly dshInstallDir: string;
  readonly profile: string;
}): ProfileWiringPlan {
  const dir = profileDir(opts.dshHome, opts.profile);
  const base = {
    profile: opts.profile,
    profileDir: dir,
    packageJsonPath: join(dir, "package.json"),
    patchPath: profilePatchPath(opts.dshHome, opts.profile),
  };
  const bundles = readProfileBundles(opts.dshHome, opts.profile);
  if (bundles === undefined) {
    return {
      ...base,
      bundles: [],
      layout: "flat",
      issue: `profile ${opts.profile} not found (${base.packageJsonPath} missing); boot it once with \`dsh --profile ${opts.profile} --dump-config\``,
    };
  }
  const layout = profileLayoutOf(bundles);
  try {
    if (layout === "flat") {
      const file = stockPatchFile(opts.dshInstallDir, BASE_BUNDLE, "cordis.patch.yml");
      if (file === undefined) {
        return { ...base, bundles, layout, issue: `${BASE_BUNDLE} bundle patch not found under ${opts.dshInstallDir}` };
      }
      const issue = scanFlatBaseLayout(parseEntryListYaml(readFileSync(file, "utf8")));
      if (issue !== undefined) return { ...base, bundles, layout, scannedFile: file, issue };
      return { ...base, bundles, layout, scannedFile: file, blockBody: dumpEntryListYaml(buildFlatProfileEntries()) };
    }
    const file = stockPatchFile(opts.dshInstallDir, WEB_APP_BUNDLE, "presets/standard.patch.yml");
    if (file === undefined) {
      return { ...base, bundles, layout, issue: `${WEB_APP_BUNDLE} presets/standard.patch.yml not found under ${opts.dshInstallDir}` };
    }
    const patches = parseEntryListYaml(readFileSync(file, "utf8"));
    const issue = scanWebPresetLayout(patches);
    if (issue !== undefined) return { ...base, bundles, layout, scannedFile: file, issue };
    return { ...base, bundles, layout, scannedFile: file, blockBody: dumpEntryListYaml(buildWebPresetEntries(patches)) };
  } catch (error) {
    return { ...base, bundles, layout, issue: errorMessage(error) };
  }
}
