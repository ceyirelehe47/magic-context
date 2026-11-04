#!/usr/bin/env node
/**
 * doctor/cli — `dsh-magic-context` bin entry.
 *
 * Subcommands:
 *   setup    locate DSH + generate the magic-standard thin preset + bootstrap
 *            the user config (see ./setup)
 *   doctor   run the adapter checklist (see ./doctor)
 *   migrate-legacy  scan / back up / dry-run / apply / restore the repair of
 *            data written by earlier dsh builds (see ./migrate-legacy)
 *   --version / -v
 *
 * Built to dist/cli.js by `bun run build` and wired as package.json bin
 * `dsh-magic-context`. The lib functions (runDshSetup / runDshDoctor) stay
 * console-free so tests drive them directly.
 */
import { runDshSetup, type SetupReport } from "./setup";
import { runDshDoctor, type DoctorReport } from "./doctor";
import { MAGIC_CONTEXT_PACKAGE } from "./env";
import { runMigrateLegacy, setLegacyIdentityResolver } from "./migrate-legacy";
// Single source of truth: the package version (bundled into dist/cli.js by
// `bun build`), never a hand-kept copy that drifts on a release bump.
import packageJson from "../../package.json";

const VERSION: string = packageJson.version;

export function printSetupReport(report: SetupReport): void {
  for (const step of report.steps) {
    const mark = step.status === "ok" ? "ok  " : step.status === "warn" ? "warn" : "FAIL";
    console.log(`[${mark}] ${step.title}`);
    for (const line of step.detail.split("\n")) console.log(`       ${line}`);
  }
  if (report.nextSteps.length > 0) {
    console.log("\nNext steps:");
    for (const line of report.nextSteps) console.log(`  - ${line}`);
  }
}

export function printDoctorReport(report: DoctorReport): void {
  for (const check of report.checks) {
    const mark = check.status === "ok" ? "ok  " : check.status === "warn" ? "warn" : "FAIL";
    console.log(`[${mark}] ${check.title}`);
    for (const line of check.detail.split("\n")) console.log(`       ${line}`);
    if (check.fix !== undefined) console.log(`       fix: ${check.fix}`);
  }
}

function usage(): void {
  console.log(
    [
      `${MAGIC_CONTEXT_PACKAGE} — Magic Context DSH adapter tools`,
      "",
      "Usage:",
      "  dsh-magic-context setup   [--dsh-home <dir>] [--dsh-install <dir>]",
      "                            [--profile <name>] [--dry-run]",
      "                            [--preset <id>[,<id>]]... [--all-presets] [--disable-preset <id>]...",
      "  dsh-magic-context doctor  [--dsh-home <dir>] [--dsh-install <dir>]",
      "                            [--profile <name>] [--directory <dir>]",
      "                            [--preset <id>]... [--all-presets] [--disable-preset <id>]...  (expectations)",
      "",
      "  Presets: web profiles — stock agent preset ids (standard, ptc, minimal, cordis, …) patched in place,",
      "  or `magic-standard` (generated clone of standard; the default when no preset flag was ever given).",
      "  Flat (headless/tui) profiles have one pseudo-preset: `root`. The selection is recorded in the",
      "  managed block, so later runs add/remove relative to it; an empty selection removes the block.",
      "  dsh-magic-context migrate-legacy [--db <context.db>] [--storage-dir <dir>] [--json]",
      "                            (default: read-only scan) | --backup | --dry-run | --apply [--keep-similar-active]",
      "                            | --restore <backup.db>   [--force: ignore live DSH/OpenCode/Pi processes]",
      "  dsh-magic-context --version",
      "",
    ].join("\n"),
  );
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case "setup": {
      const report = await runDshSetup(rest);
      printSetupReport(report);
      return report.exitCode;
    }
    case "doctor": {
      const report = await runDshDoctor(rest);
      printDoctorReport(report);
      return report.exitCode;
    }
    case "migrate-legacy": {
      const [{ resolveProjectIdentityForSession }, { getMagicContextStorageDir }] = await Promise.all([
        import("@magic-context/core/features/magic-context/memory/project-identity"),
        import("@magic-context/core/shared/data-path"),
      ]);
      setLegacyIdentityResolver((raw) => resolveProjectIdentityForSession(raw));
      return runMigrateLegacy(rest, { out: (line) => console.log(line), storageDir: getMagicContextStorageDir });
    }
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    default:
      usage();
      return command === undefined ? 0 : 2;
  }
}

// Direct execution (also used by the built dist/cli.js bin).
function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const normalized = entry.replace(/\\/g, "/");
  // Under node ESM import.meta.url is file:///<path>; under bun it is the
  // absolute path. Comparing the tail keeps both runtimes working.
  return (
    import.meta.url.endsWith(normalized) ||
    import.meta.url.endsWith(normalized.split("/").pop() ?? "")
  );
}

if (isDirectEntry()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
