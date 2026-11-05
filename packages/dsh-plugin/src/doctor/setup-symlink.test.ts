/**
 * Round 35 scan (F2): setup writes the profile's `package.json` and
 * `cordis.patch.yml` with `writeFileAtomic` (temp file + rename). When the
 * target is a symlink — a profile kept in a dotfiles repo, `~/.dsh/profiles/x`
 * files linked from elsewhere — `rename` replaced the LINK with a regular file:
 * the linked file kept its old content (the dotfiles copy silently diverged)
 * and the link was gone for every later edit. Same for every later setup run
 * (preset add/remove, disable).
 *
 * Fix: `writeFileAtomic` resolves a symlinked target to its real path and does
 * the temp-file + rename next to the real file; the link stays a link. A
 * dangling link is written through to its target path (the link keeps pointing
 * at it). POSIX only (Windows symlinks need privileges; same skip as
 * cli-entry-symlink.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDshSetup } from "./setup";
import { MAGIC_CONTEXT_PACKAGE, writeFileAtomic } from "./env";
import { fakeDshInstall, fakeDshProfile } from "./fake-dsh";
import { MANAGED_BEGIN } from "../compat/dsh-0.1/profile-patch";

const posix = process.platform !== "win32";

describe("setup / writeFileAtomic through a symlink (round 35 F2)", () => {
  it.skipIf(!posix)("writeFileAtomic keeps a symlinked target a symlink and updates the real file", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-atomic-link-"));
    try {
      const real = join(root, "dotfiles", "cfg.yml");
      mkdirSync(join(root, "dotfiles"));
      writeFileAtomic(real, "old\n", 0o644);
      const link = join(root, "profile", "cfg.yml");
      mkdirSync(join(root, "profile"));
      symlinkSync(real, link);
      writeFileAtomic(link, "new\n", 0o644);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(real);
      expect(readFileSync(real, "utf8")).toBe("new\n");
      // a dangling link is written through to the path it names
      const target2 = join(root, "dotfiles", "later.yml");
      const link2 = join(root, "profile", "later.yml");
      symlinkSync(target2, link2);
      writeFileAtomic(link2, "x\n", 0o644);
      expect(lstatSync(link2).isSymbolicLink()).toBe(true);
      expect(readFileSync(target2, "utf8")).toBe("x\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!posix)("setup on a profile whose package.json and cordis.patch.yml are symlinks keeps both links", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-setup-link-"));
    process.env.XDG_CONFIG_HOME = join(root, "config");
    try {
      const dshHome = join(root, "dsh-home");
      const installDir = fakeDshInstall(join(root, "install"));
      const dir = fakeDshProfile(dshHome, "test", ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]);
      const dot = join(root, "dotfiles");
      mkdirSync(dot);
      for (const name of ["package.json", "cordis.patch.yml"]) {
        renameSync(join(dir, name), join(dot, name));
        symlinkSync(join(dot, name), join(dir, name));
      }
      const report = await runDshSetup(["--profile", "test"], {
        dshHome,
        dshInstallDir: installDir,
        env: { ...process.env, PATH: "/nonexistent-path", HOME: root, DSH_INSTALL_DIR: undefined },
      });
      expect(report.steps.filter((s) => s.status === "fail")).toEqual([]);
      for (const name of ["package.json", "cordis.patch.yml"]) {
        expect(lstatSync(join(dir, name)).isSymbolicLink()).toBe(true);
      }
      expect(JSON.parse(readFileSync(join(dot, "package.json"), "utf8")).dsh.profile.bundles).toContain(MAGIC_CONTEXT_PACKAGE);
      expect(readFileSync(join(dot, "cordis.patch.yml"), "utf8")).toContain(MANAGED_BEGIN);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
