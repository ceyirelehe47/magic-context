/**
 * Per-preset enable/disable (B): setup `--preset` / `--all-presets` /
 * `--disable-preset`, the persisted selection marker, and doctor's per-preset
 * report + expectation flags.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDshSetup, parseEntryListYaml } from "./setup";
import { runDshDoctor } from "./doctor";
import { MAGIC_CONTEXT_PACKAGE, listFlag } from "./env";
import { fakeDshInstall, fakeDshProfile, SHIPPED_PROFILE_PATCH } from "./fake-dsh";
import { applySelectionChange } from "./profile-wiring";
import { readManagedBlock, removeManagedBlock, selectionOfBlock, scanPresetRow } from "../compat/dsh-0.1/profile-patch";

type Row = Record<string, unknown>;

async function withWeb(run: (ctx: { dshHome: string; installDir: string; dir: string; root: string }) => Promise<void>, flat = false) {
  const root = mkdtempSync(join(tmpdir(), "dsh-magic-presets-"));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  try {
    const dshHome = join(root, "dsh-home");
    const installDir = fakeDshInstall(join(root, "install"));
    const dir = fakeDshProfile(
      dshHome,
      flat ? "tui" : "web",
      flat ? ["@deepseek-ai/dsh-base", MAGIC_CONTEXT_PACKAGE] : ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", MAGIC_CONTEXT_PACKAGE],
    );
    await run({ dshHome, installDir, dir, root });
  } finally {
    delete process.env.XDG_CONFIG_HOME;
    rmSync(root, { recursive: true, force: true });
  }
}

const env = (root: string) => ({ ...process.env, PATH: "/nonexistent", HOME: root, DSH_INSTALL_DIR: undefined });

function presetEntries(dir: string): { patched: Row[]; inserted: Row[]; meter?: Row; tokenMeterOff: boolean } {
  const rows = parseEntryListYaml(readFileSync(join(dir, "cordis.patch.yml"), "utf8"));
  const inserted = rows.flatMap((row) => (Array.isArray(row.insert) ? (row.insert as Row[]) : []));
  return {
    patched: rows.filter((row) => typeof row.id === "string" && String(row.id).startsWith("preset-")),
    inserted,
    meter: inserted.find((row) => row.id === "magic-meter"),
    tokenMeterOff: rows.some((row) => row.id === "token-meter" && row.disabled === true),
  };
}

const compactionChildren = (row: Row) =>
  ((row.config as { plugins: Row[] }).plugins.find((p) => p.id === "compaction")!.config as Row[]);

describe("setup --preset / --all-presets / --disable-preset (web)", () => {
  it("--preset standard patches the stock row in place (no magic-standard clone)", async () => {
    await withWeb(async ({ dshHome, installDir, dir, root }) => {
      const report = await runDshSetup(["--preset", "standard"], { dshHome, dshInstallDir: installDir, env: env(root) });
      expect(report.exitCode).toBe(0);
      const { patched, inserted, meter, tokenMeterOff } = presetEntries(dir);
      expect(patched.map((row) => row.id)).toEqual(["preset-standard"]);
      expect(inserted.some((row) => row.id === "preset-magic-standard")).toBe(false);
      const children = compactionChildren(patched[0]!);
      expect(children.find((row) => row.id === "compaction-basic")?.disabled).toBe(true);
      expect(children.some((row) => row.id === "magic-compaction")).toBe(true);
      expect((patched[0]!.config as { plugins: Row[]; id: string; order: number }).plugins.some((row) => row.id === "magic-agent")).toBe(true);
      expect((patched[0]!.config as { id: string }).id).toBe("standard");
      expect(meter?.config).toEqual({ magicPresets: ["standard"] });
      expect(tokenMeterOff).toBe(true);
      expect(report.steps.find((step) => step.title === "Preset selection")?.detail).toContain("Magic enabled in: standard");
    });
  });

  it("selection persists across runs; --disable-preset removes one; empty selection removes the block", async () => {
    await withWeb(async ({ dshHome, installDir, dir, root }) => {
      const opts = { dshHome, dshInstallDir: installDir, env: env(root) };
      expect((await runDshSetup(["--preset", "standard,minimal"], opts)).exitCode).toBe(0);
      expect(presetEntries(dir).patched.map((row) => row.id).sort()).toEqual(["preset-minimal", "preset-standard"]);
      // minimal isolates only `compaction` — the relaxed scan accepts it.
      expect(compactionChildren(presetEntries(dir).patched.find((r) => r.id === "preset-minimal")!).some((r) => r.id === "magic-compaction")).toBe(true);

      // A plain re-run keeps the recorded selection (idempotent).
      const again = await runDshSetup([], opts);
      expect(again.generatedFiles).toEqual([]);

      expect((await runDshSetup(["--disable-preset", "minimal"], opts)).exitCode).toBe(0);
      expect(presetEntries(dir).patched.map((row) => row.id)).toEqual(["preset-standard"]);
      expect(presetEntries(dir).meter?.config).toEqual({ magicPresets: ["standard"] });

      expect((await runDshSetup(["--disable-preset", "standard"], opts)).exitCode).toBe(0);
      const text = readFileSync(join(dir, "cordis.patch.yml"), "utf8");
      expect(readManagedBlock(text)).toBeUndefined();
      expect(parseEntryListYaml(text)).toEqual([]);
      expect(text).toContain("# Your patch layer");
    });
  });

  it("--all-presets enables every stock preset that passes the scan (not the clone)", async () => {
    await withWeb(async ({ dshHome, installDir, dir, root }) => {
      const report = await runDshSetup(["--all-presets"], { dshHome, dshInstallDir: installDir, env: env(root) });
      expect(report.exitCode).toBe(0);
      const { patched, meter } = presetEntries(dir);
      expect(patched.map((row) => row.id).sort()).toEqual(["preset-minimal", "preset-ptc", "preset-standard"]);
      expect(meter?.config).toEqual({ magicPresets: ["minimal", "ptc", "standard"] });
    });
  });

  it("an unknown preset fails closed and writes nothing", async () => {
    await withWeb(async ({ dshHome, installDir, dir, root }) => {
      const report = await runDshSetup(["--preset", "nope"], { dshHome, dshInstallDir: installDir, env: env(root) });
      expect(report.exitCode).toBe(1);
      expect(report.steps.find((step) => step.status === "fail")?.detail).toContain("nope");
      expect(readFileSync(join(dir, "cordis.patch.yml"), "utf8")).toBe(SHIPPED_PROFILE_PATCH);
    });
  });
});

describe("flat layout", () => {
  it("--disable-preset root removes the rows; --preset other fails", async () => {
    await withWeb(async ({ dshHome, installDir, dir, root }) => {
      const opts = { dshHome, dshInstallDir: installDir, env: env(root) };
      expect((await runDshSetup([], opts)).exitCode).toBe(0);
      expect(selectionOfBlock(readManagedBlock(readFileSync(join(dir, "cordis.patch.yml"), "utf8")), "flat")).toEqual(["root"]);
      const bad = await runDshSetup(["--preset", "standard"], opts);
      expect(bad.exitCode).toBe(1);
      expect(bad.steps.find((step) => step.status === "fail")?.detail).toContain("flat");
      expect((await runDshSetup(["--disable-preset", "root"], opts)).exitCode).toBe(0);
      expect(readManagedBlock(readFileSync(join(dir, "cordis.patch.yml"), "utf8"))).toBeUndefined();
    }, true);
  });
});

describe("doctor per-preset report", () => {
  it("lists enabled/disabled presets and the meter swap; --preset expectations fail when unmet", async () => {
    await withWeb(async ({ dshHome, installDir, root }) => {
      await runDshSetup(["--preset", "standard"], { dshHome, dshInstallDir: installDir, env: env(root) });
      const report = await runDshDoctor([], { dshHome, dshInstallDir: installDir, directory: root, env: env(root) });
      const preset = report.checks.find((check) => check.id === "preset-state.web")!;
      expect(preset.status).toBe("ok");
      expect(preset.detail).toContain("standard: enabled");
      expect(preset.detail).toContain("minimal: disabled");
      expect(preset.detail).toContain("magic-standard: disabled");
      expect(preset.detail).toContain("Magic Context meter");
      expect(report.checks.find((check) => check.id === "profile-wiring.web")?.status).toBe("ok");

      const expecting = await runDshDoctor(["--preset", "minimal", "--disable-preset", "standard"], {
        dshHome,
        dshInstallDir: installDir,
        directory: root,
        env: env(root),
      });
      const failed = expecting.checks.find((check) => check.id === "preset-state.web")!;
      expect(failed.status).toBe("fail");
      expect(failed.detail).toContain("expected enabled but disabled: minimal");
      expect(failed.detail).toContain("expected disabled but enabled: standard");
    });
  });

  it("a pre-selection (round-5) block is reported stale so setup refreshes it", async () => {
    await withWeb(async ({ dshHome, installDir, dir, root }) => {
      await runDshSetup([], { dshHome, dshInstallDir: installDir, env: env(root) });
      const path = join(dir, "cordis.patch.yml");
      const text = readFileSync(path, "utf8").replace(/# magic-presets: [^\n]*\n/, "");
      await Bun.write(path, text);
      const report = await runDshDoctor([], { dshHome, dshInstallDir: installDir, directory: root, env: env(root) });
      expect(report.checks.find((check) => check.id === "profile-wiring.web")?.status).toBe("fail");
      // ...and still reads its implicit selection (the clone).
      expect(report.checks.find((check) => check.id === "preset-state.web")?.detail).toContain("magic-standard: enabled");
    });
  });
});

describe("selection helpers", () => {
  it("listFlag collects repeated and comma-separated values", () => {
    expect(listFlag(["--preset", "a", "--x", "--preset=b,c", "--preset"], "preset")).toEqual(["a", "b", "c"]);
  });
  it("applySelectionChange: default only when no flag is given", () => {
    expect(applySelectionChange("preset", undefined, {}, ["standard"])).toEqual(["magic-standard"]);
    expect(applySelectionChange("preset", undefined, { add: ["standard"] }, ["standard"])).toEqual(["standard"]);
    expect(applySelectionChange("preset", ["magic-standard"], { all: true }, ["minimal", "standard"])).toEqual([
      "magic-standard",
      "minimal",
      "standard",
    ]);
    expect(applySelectionChange("flat", undefined, { remove: ["root"] }, [])).toEqual([]);
  });
  it("removeManagedBlock keeps user rows and restores [] when nothing is left", () => {
    expect(removeManagedBlock("# c\n# >>> dsh-magic-context (managed by `dsh-magic-context setup`; do not edit inside) >>>\n- id: a\n# <<< dsh-magic-context <<<\n")).toBe("# c\n[]\n");
  });
  it("scanPresetRow rejects a preset without a compaction realm", () => {
    expect(scanPresetRow({ id: "preset-x", config: { plugins: [{ id: "persona" }] } })).toContain("compaction group row missing");
  });
});
