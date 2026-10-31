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
  FLAT_PRESET_NAME,
  MAGIC_PRESET_ID,
  WEB_APP_BUNDLE,
  buildMagicEntries,
  normaliseSelection,
  presetRowsOf,
  profileLayoutOf,
  readManagedBlock,
  scanFlatBaseLayout,
  scanPresetRow,
  scanWebPresetLayout,
  selectionLine,
  selectionOfBlock,
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
  /** Presets Magic can be enabled in (web: stock ids + `magic-standard`; flat: `root`). */
  readonly availablePresets: readonly string[];
  /** Selection recorded in the existing managed block (undefined = no block). */
  readonly currentSelection?: readonly string[];
  /** Selection this plan wires (empty = Magic disabled everywhere → remove the block). */
  readonly selection: readonly string[];
  /** Stock presets whose rows fail the per-preset contract scan (cannot be enabled). */
  readonly unsupportedPresets?: Readonly<Record<string, string>>;
}

/** How a setup run changes the preset selection. */
export interface PresetSelectionChange {
  /** `--preset <name>` (repeatable / comma list). */
  readonly add?: readonly string[];
  /** `--disable-preset <name>` (repeatable / comma list). */
  readonly remove?: readonly string[];
  /** `--all-presets`: every stock preset that passes the scan (web) / root (flat). */
  readonly all?: boolean;
}

/** Apply a selection change over the current selection (or the default). */
export function applySelectionChange(
  layout: ProfileLayout,
  current: readonly string[] | undefined,
  change: PresetSelectionChange,
  stockPresetIds: readonly string[],
): string[] {
  const touched = (change.add?.length ?? 0) > 0 || (change.remove?.length ?? 0) > 0 || change.all === true;
  const fallback = layout === "flat" ? [FLAT_PRESET_NAME] : [MAGIC_PRESET_ID];
  const base = new Set(current ?? (touched ? [] : fallback));
  if (change.all === true) {
    for (const id of layout === "flat" ? [FLAT_PRESET_NAME] : stockPresetIds) base.add(id);
  }
  for (const id of change.add ?? []) base.add(id);
  for (const id of change.remove ?? []) base.delete(id);
  return normaliseSelection([...base]);
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

/** Every patch file the web-app bundle ships that declares agent presets. */
function webPresetPatchFiles(installDir: string): string[] {
  const dir = resolveDshPackageDir(installDir, WEB_APP_BUNDLE);
  if (dir === undefined) return [];
  return bundlePatchFiles(dir).filter((file) => /presets\/[^/]+\.patch\.yml$/.test(file.replace(/\\/g, "/")));
}

export function planProfileWiring(opts: {
  readonly dshHome: string;
  readonly dshInstallDir: string;
  readonly profile: string;
  /** Selection change (setup flags); absent = keep the recorded selection (doctor). */
  readonly change?: PresetSelectionChange;
}): ProfileWiringPlan {
  const dir = profileDir(opts.dshHome, opts.profile);
  const base = {
    profile: opts.profile,
    profileDir: dir,
    packageJsonPath: join(dir, "package.json"),
    patchPath: profilePatchPath(opts.dshHome, opts.profile),
  };
  const existingText = existsSync(base.patchPath) ? readFileSync(base.patchPath, "utf8") : "";
  const bundles = readProfileBundles(opts.dshHome, opts.profile);
  if (bundles === undefined) {
    return {
      ...base,
      bundles: [],
      layout: "flat",
      availablePresets: [],
      selection: [],
      issue: `profile ${opts.profile} not found (${base.packageJsonPath} missing); boot it once with \`dsh --profile ${opts.profile} --dump-config\``,
    };
  }
  const layout = profileLayoutOf(bundles);
  const currentSelection = selectionOfBlock(readManagedBlock(existingText), layout);
  const render = (selection: string[], entries: unknown[]) =>
    selection.length === 0 ? undefined : `${selectionLine(selection)}\n${dumpEntryListYaml(entries)}`;
  try {
    if (layout === "flat") {
      const availablePresets = [FLAT_PRESET_NAME];
      const selection = applySelectionChange(layout, currentSelection, opts.change ?? {}, availablePresets);
      const file = stockPatchFile(opts.dshInstallDir, BASE_BUNDLE, "cordis.patch.yml");
      const common = { ...base, bundles, layout, availablePresets, currentSelection, selection };
      if (file === undefined) {
        return { ...common, issue: `${BASE_BUNDLE} bundle patch not found under ${opts.dshInstallDir}` };
      }
      const issue = scanFlatBaseLayout(parseEntryListYaml(readFileSync(file, "utf8")));
      if (issue !== undefined) return { ...common, scannedFile: file, issue };
      return { ...common, scannedFile: file, blockBody: render(selection, buildMagicEntries({ layout, selection })) };
    }
    const standardFile = stockPatchFile(opts.dshInstallDir, WEB_APP_BUNDLE, "presets/standard.patch.yml");
    const files = webPresetPatchFiles(opts.dshInstallDir);
    const presets = presetRowsOf(files.map((file) => parseEntryListYaml(readFileSync(file, "utf8"))));
    const unsupported: Record<string, string> = {};
    for (const [presetId, row] of presets) {
      const issue = scanPresetRow(row);
      if (issue !== undefined) unsupported[presetId] = issue;
    }
    const stockIds = [...presets.keys()].filter((id) => unsupported[id] === undefined).sort();
    const availablePresets = [...stockIds, MAGIC_PRESET_ID].sort();
    const selection = applySelectionChange(layout, currentSelection, opts.change ?? {}, stockIds);
    const common = {
      ...base,
      bundles,
      layout,
      availablePresets,
      currentSelection,
      selection,
      ...(Object.keys(unsupported).length > 0 ? { unsupportedPresets: unsupported } : {}),
    };
    if (standardFile === undefined) {
      return { ...common, issue: `${WEB_APP_BUNDLE} presets/standard.patch.yml not found under ${opts.dshInstallDir}` };
    }
    const issue = scanWebPresetLayout(parseEntryListYaml(readFileSync(standardFile, "utf8")));
    if (issue !== undefined) return { ...common, scannedFile: standardFile, issue };
    const unknown = selection.filter((id) => !availablePresets.includes(id));
    if (unknown.length > 0) {
      return {
        ...common,
        scannedFile: standardFile,
        issue: `unknown or unsupported agent preset(s): ${unknown
          .map((id) => (unsupported[id] !== undefined ? `${id} (${unsupported[id]})` : id))
          .join(", ")}; available: ${availablePresets.join(", ")}`,
      };
    }
    return {
      ...common,
      scannedFile: standardFile,
      blockBody: render(selection, buildMagicEntries({ layout, selection, presets })),
    };
  } catch (error) {
    return { ...base, bundles, layout, availablePresets: [], selection: [], issue: errorMessage(error) };
  }
}
