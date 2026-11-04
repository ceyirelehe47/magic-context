/**
 * Round 27 C2 (install acceptance 41775619062, finding (d)): after
 * `setup --disable-preset root` disabled the only preset, `doctor` exited 1
 * with "Profile patch layer: no Magic rows — compaction-basic still active"
 * and a "Run `dsh-magic-context setup`" fix — i.e. it told the user to undo
 * the disable they had just asked for. setup removes the managed block on an
 * empty selection, so the patch file alone could not tell "disabled on
 * purpose" from "never set up". setup now leaves a one-line disabled marker
 * (outside any managed block, a YAML comment) and doctor reports that state
 * explicitly, as a warn (exit 0). A profile that was never set up still fails.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDshSetup, parseEntryListYaml } from "./setup";
import { runDshDoctor } from "./doctor";
import { MAGIC_CONTEXT_PACKAGE } from "./env";
import { fakeDshInstall, fakeDshProfile } from "./fake-dsh";
import { readManagedBlock } from "../compat/dsh-0.1/profile-patch";

async function withProfile(
  flat: boolean,
  run: (ctx: { dshHome: string; installDir: string; dir: string; root: string; name: string }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "dsh-magic-doctor-disabled-"));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  try {
    const dshHome = join(root, "dsh-home");
    const installDir = fakeDshInstall(join(root, "install"));
    const name = flat ? "tui" : "web";
    const dir = fakeDshProfile(
      dshHome,
      name,
      flat ? ["@deepseek-ai/dsh-base", MAGIC_CONTEXT_PACKAGE] : ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", MAGIC_CONTEXT_PACKAGE],
    );
    await run({ dshHome, installDir, dir, root, name });
  } finally {
    delete process.env.XDG_CONFIG_HOME;
    rmSync(root, { recursive: true, force: true });
  }
}

const env = (root: string) => ({ ...process.env, PATH: "/nonexistent", HOME: root, DSH_INSTALL_DIR: undefined });

async function doctor(ctx: { dshHome: string; installDir: string; root: string }) {
  return runDshDoctor([], {
    dshHome: ctx.dshHome,
    dshInstallDir: ctx.installDir,
    directory: ctx.root,
    env: env(ctx.root),
    storageDirOverride: join(ctx.root, "storage"),
    dbPathOverride: join(ctx.root, "storage", "context.db"),
  });
}

const failing = (report: { checks: readonly { id: string; status: string }[] }) =>
  report.checks.filter((check) => check.status === "fail").map((check) => check.id).sort();

describe("doctor after Magic was disabled in every preset (round 27 C2)", () => {
  for (const flat of [true, false]) {
    const layout = flat ? "flat (root)" : "web presets";
    const disableArgs = flat ? ["--disable-preset", "root"] : ["--disable-preset", "standard"];
    const enableArgs = flat ? [] : ["--preset", "standard"];

    it(`${layout}: an explicit full disable is reported as disabled (warn), not as a broken install; exit code unchanged from the enabled state`, async () => {
      await withProfile(flat, async (ctx) => {
        const opts = { dshHome: ctx.dshHome, dshInstallDir: ctx.installDir, env: env(ctx.root) };
        expect((await runDshSetup(enableArgs, opts)).exitCode).toBe(0);
        const enabled = await doctor(ctx);
        expect(enabled.checks.find((c) => c.id === `profile-wiring.${ctx.name}`)?.status).toBe("ok");

        expect((await runDshSetup(disableArgs, opts)).exitCode).toBe(0);
        const text = readFileSync(join(ctx.dir, "cordis.patch.yml"), "utf8");
        // setup semantics unchanged: block gone, no Magic rows.
        expect(readManagedBlock(text)).toBeUndefined();
        expect(JSON.stringify(parseEntryListYaml(text))).not.toContain("magic");

        const after = await doctor(ctx);
        const wiring = after.checks.find((c) => c.id === `profile-wiring.${ctx.name}`)!;
        expect(wiring.status).toBe("warn");
        expect(wiring.detail).toContain("disabled in every preset");
        expect(wiring.detail).not.toContain("no Magic rows");
        expect(wiring.fix ?? "").toContain("--preset");
        // No new failure, and the exit code is the enabled state's one (41775619062: 1).
        expect(failing(after)).toEqual(failing(enabled));
        expect(after.exitCode).toBe(enabled.exitCode);
        expect(after.exitCode).toBe(0);
      });
    });

    it(`${layout}: a plain setup re-enables (marker cleared) and doctor is ok again`, async () => {
      await withProfile(flat, async (ctx) => {
        const opts = { dshHome: ctx.dshHome, dshInstallDir: ctx.installDir, env: env(ctx.root) };
        expect((await runDshSetup(enableArgs, opts)).exitCode).toBe(0);
        expect((await runDshSetup(disableArgs, opts)).exitCode).toBe(0);
        expect((await runDshSetup(enableArgs, opts)).exitCode).toBe(0);
        const text = readFileSync(join(ctx.dir, "cordis.patch.yml"), "utf8");
        expect(readManagedBlock(text)).toBeDefined();
        expect(text).not.toContain("disabled in every preset");
        expect((await doctor(ctx)).checks.find((c) => c.id === `profile-wiring.${ctx.name}`)?.status).toBe("ok");
      });
    });
  }

  it("a profile that carries the bundle but was never set up still FAILS (not loosened)", async () => {
    await withProfile(true, async (ctx) => {
      const report = await doctor(ctx);
      const wiring = report.checks.find((c) => c.id === `profile-wiring.${ctx.name}`)!;
      expect(wiring.status).toBe("fail");
      expect(wiring.detail).toContain("no Magic rows");
      expect(report.exitCode).toBe(1);
    });
  });

  it("a hand-copied marker next to live Magic rows changes nothing (rows win)", async () => {
    await withProfile(true, async (ctx) => {
      const opts = { dshHome: ctx.dshHome, dshInstallDir: ctx.installDir, env: env(ctx.root) };
      expect((await runDshSetup([], opts)).exitCode).toBe(0);
      expect((await runDshSetup(["--disable-preset", "root"], opts)).exitCode).toBe(0);
      const marker = readFileSync(join(ctx.dir, "cordis.patch.yml"), "utf8").split("\n").find((l) => l.includes("disabled in every preset"));
      expect(marker).toBeDefined();
      expect((await runDshSetup([], opts)).exitCode).toBe(0);
      const path = join(ctx.dir, "cordis.patch.yml");
      writeFileSync(path, `${readFileSync(path, "utf8")}${marker}\n`);
      expect((await doctor(ctx)).checks.find((c) => c.id === `profile-wiring.${ctx.name}`)?.status).not.toBe("fail");
      expect((await doctor(ctx)).checks.find((c) => c.id === `profile-wiring.${ctx.name}`)?.detail).not.toContain("disabled in every preset");
    });
  });
});
