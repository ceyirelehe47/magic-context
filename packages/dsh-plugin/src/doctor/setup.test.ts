import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseJsonc } from "@magic-context/core/shared/jsonc-parser";
import { runDshSetup, parseEntryListYaml, RECOMMENDED_CONFIG_KEYS } from "./setup";
import { MAGIC_CONTEXT_PACKAGE } from "./env";
import { fakeDshInstall, fakeDshProfile, SHIPPED_PROFILE_PATCH } from "./fake-dsh";
import {
  MANAGED_BEGIN,
  MANAGED_END,
  mergeManagedBlock,
  readManagedBlock,
} from "../compat/dsh-0.1/profile-patch";

interface TestEnv {
  root: string;
  dshHome: string;
  installDir: string;
  configHome: string;
}

function makeEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "dsh-magic-setup-"));
  return {
    root,
    dshHome: join(root, "dsh-home"),
    installDir: fakeDshInstall(join(root, "install")),
    configHome: join(root, "config"),
  };
}

async function cleanup(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const isolatedEnv = (root: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: "/nonexistent-path",
  HOME: root,
  DSH_INSTALL_DIR: undefined,
});

type Row = Record<string, unknown>;

async function withEnv(run: (env: TestEnv) => Promise<void>): Promise<void> {
  const env = makeEnv();
  process.env.XDG_CONFIG_HOME = env.configHome;
  try {
    await run(env);
  } finally {
    delete process.env.XDG_CONFIG_HOME;
    await cleanup(env.root);
  }
}

describe("dsh-magic-context setup (DSH 0.2 profile layer)", () => {
  it("flat profile: adds the bundle and writes the managed rows (= the hand overlay)", async () => {
    await withEnv(async (env) => {
      const dir = fakeDshProfile(env.dshHome, "test", ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]);
      const report = await runDshSetup(["--profile", "test"], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        env: isolatedEnv(env.root),
      });
      expect(report.steps.filter((step) => step.status === "fail")).toEqual([]);
      expect(report.exitCode).toBe(0);

      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      expect(pkg.dsh.profile.bundles).toEqual([
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        MAGIC_CONTEXT_PACKAGE,
      ]);

      const patchText = readFileSync(join(dir, "cordis.patch.yml"), "utf8");
      expect(patchText).toContain(MANAGED_BEGIN);
      expect(patchText).toContain("# Your patch layer"); // shipped comments kept
      const rows = parseEntryListYaml(patchText);
      expect(rows).toEqual([
        { id: "compaction-basic", disabled: true },
        { id: "token-meter", disabled: true },
        {
          insert: [
            { id: "magic-compaction", name: "dsh-magic-context/compaction", config: { auto: true } },
            { id: "magic-agent", name: "dsh-magic-context/agent" },
            { id: "magic-meter", name: "dsh-magic-context/meter", config: { flat: true } },
          ],
        },
        // edit anchor after the block (keeps DSH settings edits outside it)
        { id: "magic-host" },
      ]);
      expect(readManagedBlock(patchText)?.startsWith("# magic-presets: root\n")).toBe(true);

      // Idempotent second run.
      const again = await runDshSetup(["--profile", "test"], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        env: isolatedEnv(env.root),
      });
      expect(again.exitCode).toBe(0);
      expect(again.generatedFiles).toEqual([]);
      expect(readFileSync(join(dir, "cordis.patch.yml"), "utf8")).toBe(patchText);
    });
  });

  it("web profile: inserts a magic-standard agent preset with the guarded compaction patch", async () => {
    await withEnv(async (env) => {
      const dir = fakeDshProfile(env.dshHome, "web", [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        MAGIC_CONTEXT_PACKAGE,
      ]);
      const report = await runDshSetup([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        env: isolatedEnv(env.root),
      });
      expect(report.exitCode).toBe(0);
      const rows = parseEntryListYaml(readFileSync(join(dir, "cordis.patch.yml"), "utf8"));
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual({ id: "token-meter", disabled: true });
      expect(rows[2]).toEqual({ id: "magic-host" });
      const inserted = rows[1].insert as Row[];
      expect(inserted[1]).toEqual({ id: "magic-meter", name: "dsh-magic-context/meter", config: { magicPresets: ["magic-standard"] } });
      const preset = inserted[0];
      expect(preset.id).toBe("preset-magic-standard");
      expect(preset.name).toBe("@deepseek-ai/dsh-agent-preset");
      const config = preset.config as { id: string; plugins: Row[] };
      expect(config.id).toBe("magic-standard");
      const group = config.plugins.find((row) => row.id === "compaction")!;
      const children = group.config as Row[];
      expect(children.find((row) => row.id === "compaction-basic")?.disabled).toBe(true);
      expect(children.some((row) => row.id === "magic-compaction")).toBe(true);
      expect(config.plugins.some((row) => row.id === "magic-agent")).toBe(true);
    });
  });

  it("fails closed on a stock layout mismatch and writes nothing", async () => {
    await withEnv(async (env) => {
      const installDir = fakeDshInstall(join(env.root, "install2"), {
        baseRows: (rows) => rows.map((row) => (row.id === "compaction-basic" ? { ...row, name: "other" } : row)),
      });
      const dir = fakeDshProfile(env.dshHome, "test", ["@deepseek-ai/dsh-base"]);
      const report = await runDshSetup(["--profile", "test"], {
        dshHome: env.dshHome,
        dshInstallDir: installDir,
        env: isolatedEnv(env.root),
      });
      expect(report.exitCode).toBe(1);
      expect(report.generatedFiles).toEqual([]);
      expect(report.steps.find((step) => step.title.includes("contract scan"))?.status).toBe("fail");
      expect(readFileSync(join(dir, "cordis.patch.yml"), "utf8")).toBe(SHIPPED_PROFILE_PATCH);
      expect(existsSync(join(env.configHome, "cortexkit", "magic-context.jsonc"))).toBe(false);
    });
  });

  it("refuses to wire a profile where the package is not installed", async () => {
    await withEnv(async (env) => {
      const dir = fakeDshProfile(env.dshHome, "test", ["@deepseek-ai/dsh-base"], { installed: false });
      const report = await runDshSetup(["--profile", "test"], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        env: isolatedEnv(env.root),
      });
      expect(report.exitCode).toBe(1);
      const step = report.steps.find((s) => s.title === "Profile bundle");
      expect(step?.status).toBe("fail");
      expect(step?.detail).toContain("dsh plugin --profile test add");
      expect(readFileSync(join(dir, "cordis.patch.yml"), "utf8")).toBe(SHIPPED_PROFILE_PATCH);
    });
  });

  it("asks for --profile when several profiles exist", async () => {
    await withEnv(async (env) => {
      fakeDshProfile(env.dshHome, "a", ["@deepseek-ai/dsh-base"]);
      fakeDshProfile(env.dshHome, "b", ["@deepseek-ai/dsh-base"]);
      const report = await runDshSetup([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        env: isolatedEnv(env.root),
      });
      expect(report.exitCode).toBe(1);
      expect(report.steps.find((s) => s.title === "Profile")?.detail).toContain("--profile");
    });
  });

  it("creates the user config once and never overwrites an existing one", async () => {
    await withEnv(async (env) => {
      fakeDshProfile(env.dshHome, "test", ["@deepseek-ai/dsh-base"]);
      const configPath = join(env.configHome, "cortexkit", "magic-context.jsonc");
      const first = await runDshSetup(["--profile", "test"], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        env: isolatedEnv(env.root),
      });
      expect(first.generatedFiles).toContain(configPath);
      expect((parseJsonc(readFileSync(configPath, "utf8")) as Row).enabled).toBe(true);

      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, '{\n  "enabled": false,\n  "custom": 1\n}\n', "utf8");
      const report = await runDshSetup(["--profile", "test"], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        env: isolatedEnv(env.root),
      });
      expect(report.exitCode).toBe(0);
      expect(readFileSync(configPath, "utf8")).toContain('"custom": 1');
      const configStep = report.steps.find((step) => step.title.includes("user config"));
      expect(configStep?.status).toBe("warn");
      expect(configStep?.detail).toContain(RECOMMENDED_CONFIG_KEYS.filter((key) => key !== "enabled")[0]);
    });
  });

  it("writes nothing on --dry-run", async () => {
    await withEnv(async (env) => {
      const dir = fakeDshProfile(env.dshHome, "test", ["@deepseek-ai/dsh-base"]);
      const report = await runDshSetup(["--dry-run", "--profile", "test"], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        env: isolatedEnv(env.root),
      });
      expect(report.exitCode).toBe(0);
      expect(report.generatedFiles).toEqual([]);
      expect(readFileSync(join(dir, "cordis.patch.yml"), "utf8")).toBe(SHIPPED_PROFILE_PATCH);
      expect(existsSync(join(env.configHome, "cortexkit", "magic-context.jsonc"))).toBe(false);
    });
  });

  it("reports a diagnosis when the DSH install cannot be found", async () => {
    await withEnv(async (env) => {
      const report = await runDshSetup([], {
        dshHome: env.dshHome,
        dshInstallDir: join(env.root, "missing-install"),
        env: isolatedEnv(env.root),
      });
      expect(report.exitCode).toBe(1);
      const installStep = report.steps.find((step) => step.title.includes("DSH install"));
      expect(installStep?.status).toBe("fail");
      expect(installStep?.detail).toContain("Probed");
    });
  });
});

describe("mergeManagedBlock", () => {
  it("replaces an existing block in place and keeps user rows", () => {
    const user = "- id: tools\n  config:\n    mode: x\n";
    const once = mergeManagedBlock(user, "- id: a\n  disabled: true\n");
    expect(once.startsWith(user)).toBe(true);
    const twice = mergeManagedBlock(once + "- id: after\n", "- id: b\n  disabled: true\n");
    expect(readManagedBlock(twice)).toBe("- id: b\n  disabled: true\n");
    expect(twice).toContain("- id: after");
    expect(twice).not.toContain("- id: a\n");
    expect(twice.split(MANAGED_END).length).toBe(2);
    expect(parseEntryListYaml(twice).map((row) => row.id)).toEqual(["tools", "b", "after"]);
  });

  it("refuses a flow-style non-empty list", () => {
    expect(() => mergeManagedBlock("[{id: x}]\n", "- id: a\n")).toThrow();
  });
});
