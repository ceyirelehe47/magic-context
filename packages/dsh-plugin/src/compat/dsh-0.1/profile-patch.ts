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

/** Host-plane replacement of the stock token-meter row (entries/meter.ts). */
export const MAGIC_METER_ROW = { id: "magic-meter", name: "dsh-magic-context/meter" } as const;
/** Stock dsh-base root row the MC meter replaces (native composer meter). */
export const STOCK_TOKEN_METER_ROW_ID = "token-meter";
/** The single pseudo-preset of the flat (headless/tui) layout. */
export const FLAT_PRESET_NAME = "root";
/** Selection marker line written at the top of the managed block. */
export const SELECTION_MARKER = "# magic-presets:";

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
    { id: STOCK_TOKEN_METER_ROW_ID, disabled: true },
    {
      insert: [
        { ...MAGIC_ROWS.compaction, config: { ...MAGIC_ROWS.compaction.config } },
        { ...MAGIC_ROWS.agent },
        { ...MAGIC_METER_ROW, config: { flat: true } },
      ],
    },
  ];
}

/** Every `@deepseek-ai/dsh-agent-preset` row the given patch lists insert, by preset id. */
export function presetRowsOf(patchLists: readonly (readonly Row[])[]): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const patches of patchLists) {
    for (const row of insertedRows(patches)) {
      if (row.name !== AGENT_PRESET_PLUGIN) continue;
      const presetId = (row.config as { id?: unknown } | undefined)?.id;
      if (typeof presetId === "string" && typeof row.id === "string") out.set(presetId, row);
    }
  }
  return out;
}

/**
 * Relaxed per-preset contract scan (any stock preset, not just `standard`):
 * an isolated `compaction` group whose isolate carries `compaction` and whose
 * children hold the stock `compaction-basic` row. (`minimal` isolates only
 * `compaction`; `standard`/`ptc`/`cordis` add `toolResultPruner`.)
 */
export function scanPresetRow(row: Row): string | undefined {
  const plugins = (row.config as { plugins?: unknown } | undefined)?.plugins;
  if (!Array.isArray(plugins)) return `${String(row.id)}: config.plugins missing`;
  const group = (plugins as Row[]).find((entry) => entry.id === "compaction");
  if (group === undefined) return `${String(row.id)}: compaction group row missing`;
  if (group.name !== "cordis:group" || !group.group) return `${String(row.id)}: compaction row is not a cordis:group`;
  if ((group.isolate as { compaction?: unknown } | undefined)?.compaction !== true) {
    return `${String(row.id)}: compaction group does not isolate the compaction realm`;
  }
  const children = (group.config as Row[] | undefined) ?? [];
  const basic = children.find((entry) => entry.id === STOCK_COMPACTION_BASIC_ROW.id);
  if (basic === undefined) return `${String(row.id)}: compaction-basic row missing`;
  if (basic.name !== STOCK_COMPACTION_BASIC_ROW.name) return `${String(row.id)}: compaction-basic name mismatch`;
  return undefined;
}

/** The guarded compaction patch + the magic-agent row, applied to one preset's plugins. */
export function magicPresetPlugins(plugins: readonly Row[]): Row[] {
  return applyEntryPatches(
    structuredClone(plugins) as unknown as Parameters<typeof applyEntryPatches>[0],
    [
      { id: STOCK_COMPACTION_BASIC_ROW.id, name: STOCK_COMPACTION_BASIC_ROW.name, disabled: true },
      { id: "compaction", insert: [{ ...MAGIC_ROWS.compaction, config: { ...MAGIC_ROWS.compaction.config } }] },
      { insert: [{ ...MAGIC_ROWS.agent }] },
    ] as unknown as Parameters<typeof applyEntryPatches>[1],
    () => {},
  ) as unknown as Row[];
}

/** Normalise a preset selection (dedupe, stable order). */
export function normaliseSelection(selection: readonly string[]): string[] {
  return [...new Set(selection.map((name) => name.trim()).filter((name) => name.length > 0))].sort();
}

/** Selection marker line for the block body. */
export function selectionLine(selection: readonly string[]): string {
  return `${SELECTION_MARKER} ${normaliseSelection(selection).join(",")}`;
}

/**
 * The preset selection recorded in a managed block body. A pre-selection
 * block (setup ≤ round 5) carried no marker: it wired exactly the default
 * (web: the `magic-standard` clone; flat: the root tree).
 */
export function selectionOfBlock(body: string | undefined, layout: ProfileLayout): string[] | undefined {
  if (body === undefined) return undefined;
  const line = body.split("\n").find((candidate) => candidate.startsWith(SELECTION_MARKER));
  if (line === undefined) return [layout === "flat" ? FLAT_PRESET_NAME : MAGIC_PRESET_ID];
  return normaliseSelection(line.slice(SELECTION_MARKER.length).split(","));
}

/**
 * Managed entries for a preset selection.
 *
 *  - flat: `root` selected → disable compaction-basic + token-meter, insert
 *    magic-compaction / magic-agent / magic-meter at the root.
 *  - web: each selected STOCK preset row is patched in place (`{ id:
 *    preset-<id>, config }` restating the stock config with the guarded
 *    compaction patch + magic-agent); `magic-standard` inserts the generated
 *    clone of `standard`; the root token-meter row is disabled and
 *    magic-meter inserted (configured with the managed preset ids).
 *
 * Returns [] for an empty selection (setup then removes the block).
 */
export function buildMagicEntries(input: {
  readonly layout: ProfileLayout;
  readonly selection: readonly string[];
  /** web: stock preset rows by preset id (presetRowsOf). */
  readonly presets?: ReadonlyMap<string, Row>;
}): PatchEntry[] {
  const selection = normaliseSelection(input.selection);
  if (selection.length === 0) return [];
  if (input.layout === "flat") {
    const unknown = selection.filter((name) => name !== FLAT_PRESET_NAME);
    if (unknown.length > 0) {
      throw new Error(
        `flat (headless/tui) profiles have one root tree, no agent presets; unknown preset(s): ${unknown.join(", ")} (use \`${FLAT_PRESET_NAME}\`)`,
      );
    }
    return buildFlatProfileEntries();
  }
  const presets = input.presets ?? new Map<string, Row>();
  const entries: PatchEntry[] = [{ id: STOCK_TOKEN_METER_ROW_ID, disabled: true }];
  const inserts: Record<string, unknown>[] = [];
  for (const presetId of selection) {
    if (presetId === MAGIC_PRESET_ID) {
      const standard = presets.get("standard");
      if (standard === undefined) throw new Error("magic-standard: the stock `standard` preset row is missing");
      const issue = scanPresetRow(standard);
      if (issue !== undefined) throw new Error(`magic-standard: ${issue}`);
      const stockConfig = standard.config as { plugins: Row[] };
      inserts.push({
        id: MAGIC_PRESET_ROW_ID,
        name: AGENT_PRESET_PLUGIN,
        config: { ...stockConfig, id: MAGIC_PRESET_ID, order: 10, plugins: magicPresetPlugins(stockConfig.plugins) },
      });
      continue;
    }
    const row = presets.get(presetId);
    if (row === undefined) {
      throw new Error(
        `unknown agent preset \`${presetId}\` (known: ${[...presets.keys(), MAGIC_PRESET_ID].sort().join(", ")})`,
      );
    }
    const issue = scanPresetRow(row);
    if (issue !== undefined) throw new Error(issue);
    const stockConfig = row.config as { plugins: Row[] };
    entries.push({ id: String(row.id), config: { ...stockConfig, plugins: magicPresetPlugins(stockConfig.plugins) } });
  }
  inserts.push({ ...MAGIC_METER_ROW, config: { magicPresets: selection } });
  entries.push({ insert: inserts });
  return entries;
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

/**
 * Remove the managed block (selection emptied). A file left with no YAML
 * gets the shipped empty list back so the loader still reads a list.
 */
export function removeManagedBlock(existing: string): string {
  const begin = existing.indexOf(MANAGED_BEGIN);
  const end = existing.indexOf(MANAGED_END);
  if (begin < 0 || end <= begin) return existing;
  // The edit anchor goes with the block; an anchor the settings page has since
  // filled (`config:` lines below it) is the user's and stays (comment dropped).
  const after = existing
    .slice(end + MANAGED_END.length)
    .replace(/^\n/, "")
    .replace(`${EDIT_ANCHOR_COMMENT}\n${EDIT_ANCHOR_ROW}\n`, (match, offset: number, whole: string) =>
      /^[ \t]+\S/.test(whole.slice(offset + match.length)) ? `${EDIT_ANCHOR_ROW}\n` : "",
    )
    .replace(`${EDIT_ANCHOR_COMMENT}\n`, "");
  const rest = (existing.slice(0, begin) + after).replace(/\n*$/, "\n");
  const yamlLines = rest.split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  return yamlLines.length === 0 ? `${rest.replace(/\n*$/, "\n")}[]\n` : rest;
}

/**
 * Edit anchor kept AFTER the managed block.
 *
 * DSH's own settings writer (`@deepseek-ai/dsh-config-editor`, behind
 * `settings.mutate`) round-trips the profile `cordis.patch.yml` through the
 * `yaml` Document API: an edit of a row that is not in the file is
 * `document.add`ed to the END of the sequence — before a trailing comment. With
 * the managed block last in the file, that put foreign rows (e.g. the web
 * preview-notice ack `ui-settings-general`, or our own `magic-host` settings)
 * INSIDE the block (verified on 0.2.1-rc.5, round 7). A YAML item after the end
 * marker keeps every later append outside: an id-only `magic-host` row is a
 * no-op for the loader and is also the row the editor fills when the Magic
 * Context settings page saves (it matches `findLastIndex` on id with no name).
 */
export const EDIT_ANCHOR_COMMENT =
  "# dsh-magic-context: edit anchor — keeps DSH settings edits outside the managed block above (no-op row).";
export const EDIT_ANCHOR_ROW = "- id: magic-host";

/** True when at least one YAML list item follows the managed block. */
export function hasItemAfterManagedBlock(text: string): boolean {
  const end = text.indexOf(MANAGED_END);
  if (end < 0) return true;
  return text
    .slice(end + MANAGED_END.length)
    .split("\n")
    .some((line) => line.startsWith("-"));
}

/**
 * Place `afterBlock` (already-rendered YAML list items, e.g. foreign rows moved
 * out of the block) right after the end marker, then make sure an item follows
 * the block (edit anchor).
 */
export function finishManagedLayer(text: string, afterBlock?: string): string {
  const end = text.indexOf(MANAGED_END);
  if (end < 0) return text;
  const cut = end + MANAGED_END.length;
  let next = text;
  if (afterBlock !== undefined && afterBlock.trim() !== "") {
    const tail = text.slice(cut).replace(/^\n/, "");
    next = `${text.slice(0, cut)}\n${afterBlock.trimEnd()}\n${tail}`;
  }
  if (!hasItemAfterManagedBlock(next)) {
    next = `${next.replace(/\n*$/, "\n")}${EDIT_ANCHOR_COMMENT}\n${EDIT_ANCHOR_ROW}\n`;
  }
  return next;
}

/** Extract the managed block body (undefined when absent). */
export function readManagedBlock(text: string): string | undefined {
  const begin = text.indexOf(MANAGED_BEGIN);
  const end = text.indexOf(MANAGED_END);
  if (begin < 0 || end <= begin) return undefined;
  return text.slice(begin + MANAGED_BEGIN.length, end).replace(/^\n/, "");
}
