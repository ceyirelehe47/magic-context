/**
 * compat/dsh-0.1/profile-patch — DSH 0.2 profile wiring for the Magic rows.
 *
 * DSH 0.2 dropped `config/agent-presets/standard` (and the thin-preset include
 * the 0.1 setup generated). A profile is now an ordered stack of bundle patch
 * layers + the profile's own `cordis.patch.yml` (+ `--patch` overlays):
 *
 *   - headless / tui ("flat" layout): the agent layer is flat in the root
 *     tree. `@deepseek-ai/dsh-base` inserts `compaction-basic` as a root row.
 *     Magic wiring = disable that row + insert `magic-compaction` and
 *     `magic-agent` at the root (exactly the overlay we used to hand-write).
 *   - web ("preset" layout): `@deepseek-ai/dsh-web-app` disables the root
 *     agent rows and declares presets as `@deepseek-ai/dsh-agent-preset` rows
 *     (`preset-standard`, …) whose `config.plugins` carry the agent layer,
 *     including an isolated `compaction` group. Magic wiring = insert a NEW
 *     preset row `preset-magic-standard` (id `magic-standard`) whose plugins are
 *     the stock standard plugins with the guarded compaction patch applied.
 *
 * `setup` writes these entries as a marker-delimited managed block in the
 * profile's `cordis.patch.yml` (user layer); `doctor` re-derives and diffs.
 */
import { applyEntryPatches } from "@deepseek-ai/cordis-plugin-include";
import {
  STOCK_COMPACTION_BASIC_ROW,
  scanStockPresetLayout,
  type PatchEntry,
} from "./preset";

export type ProfileLayout = "flat" | "preset";

export const WEB_APP_BUNDLE = "@deepseek-ai/dsh-web-app";
export const BASE_BUNDLE = "@deepseek-ai/dsh-base";
export const AGENT_PRESET_PLUGIN = "@deepseek-ai/dsh-agent-preset";
export const STOCK_PRESET_ROW_ID = "preset-standard";
export const MAGIC_PRESET_ROW_ID = "preset-magic-standard";
export const MAGIC_PRESET_ID = "magic-standard";

/** Package specifiers of the Magic agent-plane rows (resolved from the profile). */
export const MAGIC_ROWS = {
  compaction: { id: "magic-compaction", name: "dsh-magic-context/compaction", config: { auto: true } },
  agent: { id: "magic-agent", name: "dsh-magic-context/agent" },
} as const;

export const MANAGED_BEGIN = "# >>> dsh-magic-context (managed by `dsh-magic-context setup`; do not edit inside) >>>";
export const MANAGED_END = "# <<< dsh-magic-context <<<";

/** Profile layout from its bundle list. */
export function profileLayoutOf(bundles: readonly string[]): ProfileLayout {
  return bundles.includes(WEB_APP_BUNDLE) ? "preset" : "flat";
}

type Row = Record<string, unknown>;

/** Every row a patch list inserts, depth-first (top-level `insert` lists). */
function insertedRows(patches: readonly Row[]): Row[] {
  const rows: Row[] = [];
  for (const patch of patches) {
    if (Array.isArray(patch.insert)) rows.push(...(patch.insert as Row[]));
  }
  return rows;
}

/**
 * Contract-scan the base bundle patch for the flat layout: the root
 * `compaction-basic` row must exist with the expected package name.
 */
export function scanFlatBaseLayout(basePatches: readonly Row[]): string | undefined {
  const basic = insertedRows(basePatches).find((row) => row.id === STOCK_COMPACTION_BASIC_ROW.id);
  if (basic === undefined) return `${BASE_BUNDLE}: root compaction-basic row missing`;
  if (basic.name !== STOCK_COMPACTION_BASIC_ROW.name) {
    return `${BASE_BUNDLE}: compaction-basic name mismatch (${String(basic.name)})`;
  }
  return undefined;
}

/** Flat-layout entries (headless / tui). */
export function buildFlatProfileEntries(): PatchEntry[] {
  return [
    { id: STOCK_COMPACTION_BASIC_ROW.id, disabled: true },
    { insert: [{ ...MAGIC_ROWS.compaction, config: { ...MAGIC_ROWS.compaction.config } }, { ...MAGIC_ROWS.agent }] },
  ];
}

/** Find the stock `preset-standard` row in the web preset patch list. */
export function findStockPresetRow(presetPatches: readonly Row[]): Row | undefined {
  return insertedRows(presetPatches).find(
    (row) => row.id === STOCK_PRESET_ROW_ID && row.name === AGENT_PRESET_PLUGIN,
  );
}

/** Contract-scan the web standard preset declaration. */
export function scanWebPresetLayout(presetPatches: readonly Row[]): string | undefined {
  const row = findStockPresetRow(presetPatches);
  if (row === undefined) return `${STOCK_PRESET_ROW_ID} (${AGENT_PRESET_PLUGIN}) row missing`;
  const plugins = (row.config as { plugins?: unknown } | undefined)?.plugins;
  if (!Array.isArray(plugins)) return `${STOCK_PRESET_ROW_ID}: config.plugins missing`;
  return scanStockPresetLayout(plugins as Row[]);
}

/** Preset-layout entries (web): one new agent-preset row. */
export function buildWebPresetEntries(presetPatches: readonly Row[]): PatchEntry[] {
  const issue = scanWebPresetLayout(presetPatches);
  if (issue !== undefined) throw new Error(`magic-standard: web preset layout ${issue}`);
  const stock = findStockPresetRow(presetPatches)!;
  const stockConfig = stock.config as { plugins: Row[]; order?: unknown };
  const plugins = applyEntryPatches(
    structuredClone(stockConfig.plugins) as unknown as Parameters<typeof applyEntryPatches>[0],
    [
      { id: STOCK_COMPACTION_BASIC_ROW.id, name: STOCK_COMPACTION_BASIC_ROW.name, disabled: true },
      { id: "compaction", insert: [{ ...MAGIC_ROWS.compaction, config: { ...MAGIC_ROWS.compaction.config } }] },
      { insert: [{ ...MAGIC_ROWS.agent }] },
    ] as unknown as Parameters<typeof applyEntryPatches>[1],
    () => {},
  ) as unknown as Row[];
  return [
    {
      insert: [
        {
          id: MAGIC_PRESET_ROW_ID,
          name: AGENT_PRESET_PLUGIN,
          config: { ...stockConfig, id: MAGIC_PRESET_ID, order: 10, plugins },
        },
      ],
    },
  ];
}

/**
 * Merge a rendered managed block (YAML list items, no surrounding `[]`) into
 * a profile `cordis.patch.yml`:
 *   - an existing managed block is replaced in place;
 *   - a file whose only YAML is `[]` (the shipped empty layer) gets the block
 *     instead of the `[]`, comments kept;
 *   - a block-style list gets the block appended;
 *   - anything else (flow-style non-empty list, a mapping) is refused.
 */
export function mergeManagedBlock(existing: string | undefined, blockBody: string): string {
  const block = `${MANAGED_BEGIN}\n${blockBody.trimEnd()}\n${MANAGED_END}\n`;
  if (existing === undefined || existing.trim() === "") return block;
  const begin = existing.indexOf(MANAGED_BEGIN);
  const end = existing.indexOf(MANAGED_END);
  if (begin >= 0 && end > begin) {
    return existing.slice(0, begin) + block + existing.slice(end + MANAGED_END.length).replace(/^\n/, "");
  }
  const lines = existing.split("\n");
  const yamlLines = lines.filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  if (yamlLines.length === 1 && yamlLines[0].trim() === "[]") {
    const idx = lines.findIndex((line) => line.trim() === "[]");
    lines.splice(idx, 1, block.trimEnd());
    return lines.join("\n").replace(/\n*$/, "\n");
  }
  if (yamlLines.length === 0 || yamlLines.every((line) => /^(-|\s)/.test(line))) {
    return existing.replace(/\n*$/, "\n") + block;
  }
  throw new Error(
    "profile cordis.patch.yml is not a block-style YAML list; add the managed block by hand",
  );
}

/** Extract the managed block body (undefined when absent). */
export function readManagedBlock(text: string): string | undefined {
  const begin = text.indexOf(MANAGED_BEGIN);
  const end = text.indexOf(MANAGED_END);
  if (begin < 0 || end <= begin) return undefined;
  return text.slice(begin + MANAGED_BEGIN.length, end).replace(/^\n/, "");
}
