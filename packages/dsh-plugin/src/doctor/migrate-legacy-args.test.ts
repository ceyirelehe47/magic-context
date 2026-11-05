/**
 * Round 35 scan (F3): migrate-legacy value flags without a value.
 *
 * `flag()` returned `argv[i + 1]` blindly: `--db` / `--storage-dir` as the
 * last token gave `undefined` and the command fell back to the DEFAULT storage
 * DB (`--apply --db` migrated the user's real context.db instead of the one
 * they meant); a value flag followed by another flag took that flag as its
 * value (`--db --apply` → "no database at --apply — nothing to migrate",
 * exit 0); `--restore` without a path silently ran a scan. Now each of these
 * is a usage error (exit 2) before any DB is opened, and the default DB is
 * untouched.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database as SqliteDatabase } from "@magic-context/core/shared/sqlite";
import { runMigrateLegacy } from "./migrate-legacy";

function storage(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-migrate-args-"));
  const db = new SqliteDatabase(join(dir, "context.db"));
  db.exec("CREATE TABLE t (x)");
  db.close();
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function run(argv: string[], dir: string): Promise<{ code: number; text: string }> {
  const out: string[] = [];
  const code = await runMigrateLegacy(argv, { out: (l) => out.push(l), storageDir: () => dir });
  return { code, text: out.join("\n") };
}

describe("migrate-legacy: value flags need a value (round 35 F3)", () => {
  for (const argv of [
    ["--apply", "--db"],
    ["--db", "--apply"],
    ["--db="],
    ["--backup", "--storage-dir"],
    ["--storage-dir", "--apply"],
    ["--restore"],
    ["--restore", "--force"],
  ]) {
    it(`${argv.join(" ")} → usage error, nothing opened or written`, async () => {
      const s = storage();
      try {
        const r = await run(argv, s.dir);
        expect(r.code).toBe(2);
        expect(r.text).toMatch(/needs a value/);
        expect(existsSync(join(s.dir, "backups"))).toBe(false);
        expect(readdirSync(s.dir).sort()).toEqual(["context.db"]);
      } finally {
        s.cleanup();
      }
    });
  }

  it("a value flag with a value still works (--db <path> scan)", async () => {
    const s = storage();
    try {
      const r = await run(["--db", join(s.dir, "context.db")], s.dir);
      expect(r.code).toBe(0);
    } finally {
      s.cleanup();
    }
  });
});
