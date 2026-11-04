/**
 * entries/preset-include — no-write file-backed loader tree for SHIPPED
 * compositions (the stock `standard` preset the thin preset includes).
 *
 * WHY: the loader's dispose handler writes a tree back to its source file
 * whenever it decides the config changed — a plugin self-disposing is enough,
 * and tearing an agent down disposes its whole subtree. The raw
 * `@deepseek-ai/cordis-plugin-include` tree inherits that write, so including
 * the SHIPPED stock composition through it truncates the stock file to `[]`
 * the first time a session ends. `@deepseek-ai/dsh-agent-presets` documents
 * exactly this hazard and defends against it with `PresetTree.write() = no-op`
 * ("A preset is an input, never a persistence target"); this entry is the same
 * defense for the thin preset's include row. The shipped composition is
 * read-only input; user state lives elsewhere, so dropping the write also
 * drops nothing that a session could persist.
 *
 * Round 28b (DSH 0.2.2-alpha.3): cordis-plugin-loader 1.0.7 no longer calls
 * `tree.write()`; it persists every tree-side change through
 * `EntryTree.commit(change)` (create/remove/update, a plugin's own config
 * commit, and a self-unload marking the entry `disabled: true`), and
 * cordis-plugin-include 1.0.11's `commit` journals the change and renames the
 * new YAML over the source file. DSH moved its own PresetTree from
 * `write() {}` to `commit(_change) {}` in that release. Both hooks are no-ops
 * here: `write()` for DSH 0.2.1 (loader 1.0.6), `commit()` for 0.2.2-alpha.3;
 * each is simply never called by the other loader.
 *
 * The row's `name` must be this entry's absolute file path (the thin preset
 * emits it via `magicEntryPath("preset-include")`) so the loader resolves the
 * class from THIS package instead of the stock directory's module walk.
 */
import { Include } from "@deepseek-ai/cordis-plugin-include";

export default class MagicPresetInclude extends Include {
  /** A shipped composition is an input, never a persistence target. */
  write(): void {
    // Intentionally empty: never rewrite the included stock file.
  }

  /** Same defense for cordis-plugin-loader >= 1.0.7 (DSH 0.2.2-alpha.3). */
  commit(_change?: unknown): void {
    // Intentionally empty: no journal, so Include never writes the stock file.
  }
}
