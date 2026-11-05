/**
 * Round 31 — the bin runs when it is reached through a symlink. npm (and bun)
 * install a package bin on POSIX as a SYMLINK (node_modules/.bin/<name>,
 * the global bin dir) to dist/cli.js; node and bun keep that symlink path in
 * process.argv[1] while import.meta.url is the real file. The old direct-entry
 * check compared only the path / basename, so `dsh-magic-context doctor`
 * through a symlink exited 0 and printed nothing (已复现 round 31 with node 22
 * on dist/cli.js; pnpm's .bin shell shims call the real path, so the install
 * acceptance never saw it).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as cliModule from "./cli";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string };
const cli = join(import.meta.dir, "cli.ts");

function run(entry: string): { code: number | null; out: string } {
  const r = Bun.spawnSync([process.execPath, entry, "--version"], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
}

describe("dsh-magic-context bin entry (round 31)", () => {
  it("runs when executed directly", () => {
    expect(run(cli)).toEqual({ code: 0, out: pkg.version });
  });

  // node's view of a symlinked bin: argv[1] = the link, import.meta.url = file URL of the real file.
  it.skipIf(process.platform === "win32")("node semantics: a symlinked argv[1] is the direct entry (isDirectEntryFor)", () => {
    const isDirectEntryFor = (cliModule as Record<string, unknown>).isDirectEntryFor as
      | ((argv1: string | undefined, metaUrl: string) => boolean)
      | undefined;
    expect(typeof isDirectEntryFor).toBe("function");
    const dir = mkdtempSync(join(tmpdir(), "mc-bin-"));
    try {
      const real = join(dir, "pkg", "dist", "cli.js");
      Bun.spawnSync(["mkdir", "-p", join(dir, "pkg", "dist"), join(dir, ".bin"), join(dir, "sp ace")]);
      Bun.write(real, "");
      const link = join(dir, ".bin", "dsh-magic-context");
      symlinkSync(real, link);
      const url = pathToFileURL(real).href;
      expect(isDirectEntryFor?.(real, url)).toBe(true);
      expect(isDirectEntryFor?.(link, url)).toBe(true);
      // a different script that merely imports the module is not the entry
      const other = join(dir, "other.js");
      Bun.write(other, "");
      expect(isDirectEntryFor?.(other, url)).toBe(false);
      expect(isDirectEntryFor?.(undefined, url)).toBe(false);
      // a path with a space (percent-encoded in the URL)
      const spaced = join(dir, "sp ace", "cli.js");
      Bun.write(spaced, "");
      expect(isDirectEntryFor?.(spaced, pathToFileURL(spaced).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("runs when executed through a symlink with another name (npm/bun .bin)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-bin-"));
    try {
      const link = join(dir, "dsh-magic-context.ts");
      symlinkSync(cli, link);
      expect(run(link)).toEqual({ code: 0, out: pkg.version });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
