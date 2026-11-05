/**
 * doctor/env — DSH environment discovery for the setup/doctor tools.
 *
 * Everything the bin scripts need to locate the machine's DSH install and the
 * shared Magic Context paths, plus small file helpers (atomic writes, flag
 * parsing). Path semantics follow dsh-reference:
 *
 *   - DSH home: `$DSH_HOME` (empty = unset) → `~/.dsh`            (H.3, I.1)
 *   - DSH install: the `@deepseek-ai/dsh` launcher package (`--dsh-install`,
 *     `$DSH_INSTALL_DIR`, the `dsh` executable on PATH, profile dirs, global
 *     roots). DSH 0.2 ships no `config/agent-presets` tree: bundle patch files
 *     are resolved from the launcher's dependency tree instead.
 *   - profile patch layer: `$DSH_HOME/profiles/<name>/cordis.patch.yml`.
 *   - user config: `~/.config/cortexkit/magic-context.jsonc`       (§2.1)
 *   - storage dir: `~/.local/share/cortexkit/magic-context/`       (§2.1)
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

/** npm package identity of this adapter (checked against profile bundles). */
export const MAGIC_CONTEXT_PACKAGE = "dsh-magic-context";

/**
 * The default DSH release: the lockfile / devDependencies and the default CI
 * lane run on it (compat/dsh-0.1 was written against it).
 */
export const DSH_COMPAT_EXPECTED_VERSION = "0.2.1-rc.5";

/**
 * Every DSH release this adapter declares support for (round 29, approved by
 * the user 2026-11-04; round 30 adds 0.2.2-rc.1, user-requested 2026-11-05):
 * an explicit list of exact versions, never a range, so an untested DSH
 * (e.g. 0.2.2-rc.2 or 0.2.2) is still refused. package.json's
 * `@deepseek-ai/dsh-*` peers carry the same list joined by `||`, which is the
 * form DSH's plugin manager judges (dsh-app-boot evaluatePluginCompatibility);
 * src/doctor/dsh-compat-declaration.test.ts keeps the two identical.
 */
export const DSH_COMPAT_SUPPORTED_VERSIONS: readonly string[] = ["0.2.1-rc.5", "0.2.2-alpha.3", "0.2.2-rc.1"];

/** Whether `version` is exactly one of the declared DSH releases. */
export function isSupportedDshVersion(version: string | undefined): boolean {
  return version !== undefined && DSH_COMPAT_SUPPORTED_VERSIONS.includes(version);
}

/** Human-readable list of the declared DSH releases ("0.2.1-rc.5 or 0.2.2-alpha.3 or 0.2.2-rc.1"). */
export const DSH_COMPAT_SUPPORTED_LABEL = DSH_COMPAT_SUPPORTED_VERSIONS.join(" or ");

/** Installed-package identity of the DSH runtime. */
export const DSH_PACKAGE = "@deepseek-ai/dsh";

/**
 * Resolve the DSH home directory. Priority: `$DSH_HOME` (empty string counts
 * as unset) → `~/.dsh` (dsh-home-paths semantics).
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_HOME;
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  return join(homedir(), ".dsh");
}

export type DshInstallSource = "flag" | "env" | "launcher" | "profiles" | "global";

export interface DshInstallLocateResult {
  /** Package root of the resolved `@deepseek-ai/dsh` install (if found). */
  readonly dshInstallDir?: string;
  /** Installed launcher version (package.json `version`). */
  readonly version?: string;
  /** How the install was found. */
  readonly source?: DshInstallSource;
  /** Every candidate probed, for the fail diagnosis. */
  readonly tried: readonly string[];
}

export interface DshInstallLocateOptions {
  readonly dshHome: string;
  /** Explicit install dir override (tests / `--dsh-install`). */
  readonly dshInstallDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Locate the DSH install the user's `dsh` launcher runs from (DSH 0.2: the
 * launcher package `@deepseek-ai/dsh` carries every bundle as a dependency;
 * there is no `config/agent-presets` tree any more). Candidate order:
 *   1. `--dsh-install <dir>`, then env `DSH_INSTALL_DIR`;
 *   2. the `dsh` executable on PATH, realpath'd and walked up to its package
 *      root (the launcher anchor — what `dsh` actually boots);
 *   3. `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh` and every
 *      `$DSH_HOME/profiles/<name>/node_modules/@deepseek-ai/dsh`;
 *   4. common global roots (bun global, npm prefix dirs).
 */
export function locateDshInstall(
  opts: DshInstallLocateOptions,
): DshInstallLocateResult {
  const env = opts.env ?? process.env;
  const tried: string[] = [];
  const candidates: Array<[string, DshInstallSource]> = [];
  if (opts.dshInstallDir !== undefined) candidates.push([opts.dshInstallDir, "flag"]);
  const envInstall = env.DSH_INSTALL_DIR;
  if (envInstall !== undefined && envInstall.trim() !== "") candidates.push([envInstall, "env"]);
  for (const dir of findDshInstallOnPath(env)) candidates.push([dir, "launcher"]);
  candidates.push([join(opts.dshHome, "profiles", "node_modules", DSH_PACKAGE), "profiles"]);
  try {
    const profilesRoot = join(opts.dshHome, "profiles");
    if (existsSync(profilesRoot)) {
      for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "node_modules") continue;
        candidates.push([join(profilesRoot, entry.name, "node_modules", DSH_PACKAGE), "profiles"]);
      }
    }
  } catch {
    // Unreadable profiles dir — the global fallbacks still apply.
  }
  const home = env.HOME ?? homedir();
  for (const root of [
    join(home, ".bun", "install", "global", "node_modules"),
    join(home, ".npm-global", "lib", "node_modules"),
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
  ]) {
    candidates.push([join(root, DSH_PACKAGE), "global"]);
  }
  for (const [candidate, source] of candidates) {
    tried.push(candidate);
    if (!isDshInstallRoot(candidate)) continue;
    let dir = candidate;
    try {
      dir = realpathSync(candidate);
    } catch {
      // keep the given path
    }
    return { dshInstallDir: dir, version: readPackageVersion(dir), source, tried };
  }
  return { tried };
}

/** `version` of the package.json in `dir` (undefined when unreadable). */
export function readPackageVersion(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the package dir of one `@deepseek-ai/*` bundle as the launcher
 * sees it: nested under the install, or hoisted next to it.
 */
export function resolveDshPackageDir(dshInstallDir: string, packageName: string): string | undefined {
  const scoped = packageName.split("/");
  const candidates = [
    join(dshInstallDir, "node_modules", ...scoped),
    // hoisted: <root>/node_modules/@deepseek-ai/dsh → <root>/node_modules/@deepseek-ai/<x>
    join(dirname(dirname(dshInstallDir)), ...scoped),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return undefined;
}

/** Bundle patch files of one package (`package.json` `dsh.bundle.patch`). */
export function bundlePatchFiles(packageDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      dsh?: { bundle?: { patch?: unknown } };
    };
    const raw = parsed.dsh?.bundle?.patch;
    const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.map(String) : [];
    return list.map((rel) => join(packageDir, rel));
  } catch {
    return [];
  }
}

/** `$DSH_HOME/profiles/<name>` */
export function profileDir(dshHome: string, profile: string): string {
  return join(dshHome, "profiles", profile);
}

/** `$DSH_HOME/profiles/<name>/cordis.patch.yml` (the user patch layer). */
export function profilePatchPath(dshHome: string, profile: string): string {
  return join(profileDir(dshHome, profile), "cordis.patch.yml");
}

/** Whether a directory is the `@deepseek-ai/dsh` package root. */
export function isDshInstallRoot(dir: string): boolean {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
    return parsed.name === DSH_PACKAGE;
  } catch {
    return false;
  }
}

/** PATH lookup for the `dsh` launcher, resolved to its package root. */
function findDshInstallOnPath(env: NodeJS.ProcessEnv): string[] {
  const pathVar = env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".ps1"] : [""];
  const found: string[] = [];
  for (const segment of pathVar.split(sep)) {
    const dir = segment.trim();
    if (dir === "") continue;
    for (const ext of exts) {
      const bin = join(dir, `dsh${ext}`);
      if (!existsSync(bin)) continue;
      const resolved = resolvePackageRoot(bin);
      if (resolved !== undefined && !found.includes(resolved)) found.push(resolved);
    }
  }
  return found;
}

/** Walk up from an executable to the nearest `@deepseek-ai/dsh` package root. */
function resolvePackageRoot(binPath: string): string | undefined {
  let current: string;
  try {
    current = realpathSync(binPath);
  } catch {
    current = binPath;
  }
  let dir = dirname(current);
  for (let depth = 0; depth < 10 && dir !== dirname(dir); depth += 1) {
    if (isDshInstallRoot(dir)) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

// ── Magic Context paths ─────────────────────────────────────────────────────

/** `$DSH_HOME/.agent-presets` — user preset root (dsh-reference §A.6). */
export function agentPresetsRoot(dshHome: string): string {
  return join(dshHome, ".agent-presets");
}

/** `$DSH_HOME/.agent-presets/magic-standard` — this adapter's thin preset. */
export function magicStandardDir(dshHome: string): string {
  return join(agentPresetsRoot(dshHome), "magic-standard");
}

export function magicStandardAgentCordisPath(dshHome: string): string {
  return join(magicStandardDir(dshHome), "agent.cordis.yml");
}

export function magicStandardPresetYamlPath(dshHome: string): string {
  return join(magicStandardDir(dshHome), "preset.yml");
}

// ── file helpers ────────────────────────────────────────────────────────────

/**
 * Atomic write: write a temp file in the target directory, then rename over
 * the target (same-filesystem rename is atomic on POSIX and Windows). Mode is
 * applied to the temp file before rename so the target never exists with
 * looser permissions (0600 for generated secrets/config).
 */
export function writeFileAtomic(
  target: string,
  content: string,
  mode = 0o600,
): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${target.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  writeFileSync(tmp, content, { encoding: "utf8", mode });
  try {
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Tiny flag parser for the bin scripts: `--name` (value `true`), `--name=value`
 * and `--name value`. Anything else is collected as a positional.
 */
export function parseFlags(
  argv: readonly string[],
): { flags: Record<string, string | true>; positionals: string[] } {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

/**
 * Every value of a repeatable flag (`--preset a --preset b,c` → [a, b, c]).
 * parseFlags keeps only the last occurrence, so list flags read argv directly.
 */
export function listFlag(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    let value: string | undefined;
    if (token === `--${name}`) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        value = next;
        i += 1;
      }
    } else if (token.startsWith(`--${name}=`)) {
      value = token.slice(name.length + 3);
    }
    if (value !== undefined) out.push(...value.split(",").map((part) => part.trim()).filter((part) => part.length > 0));
  }
  return out;
}

/** Stable human-readable error text for a thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Read one flag as an optional string (boolean flags yield undefined). */
export function stringFlag(
  flags: Record<string, string | true>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** Absolute path of one bundled entry file (`dist/entries/<name>.js`) of THIS package. */
export function magicEntryPath(
  entry: "agent" | "compaction" | "commands" | "tools" | "remote" | "preset-include",
): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12 && dir !== dirname(dir); depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
        if (parsed.name === MAGIC_CONTEXT_PACKAGE) {
          return join(dir, "dist", "entries", `${entry}.js`);
        }
      } catch {
        // Unparseable manifest — keep walking up.
      }
    }
    dir = dirname(dir);
  }
  throw new Error(
    `cannot locate ${MAGIC_CONTEXT_PACKAGE} package root from ${import.meta.url}`,
  );
}
