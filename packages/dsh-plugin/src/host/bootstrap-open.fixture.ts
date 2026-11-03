/**
 * Round 24 — one DSH process opening the shared DB through the real DSH
 * bootstrap (`bootstrapDshStorage`). Used by bootstrap-concurrent-open.test.ts
 * and docs/dsh/e2e/evidence-round24/repro-concurrent-bootstrap.ts to start
 * several processes on the same FRESH storage dir at once.
 *
 *   bun run bootstrap-open.fixture.ts <storageDir> <projectDir>
 *
 * Exit 0 and prints "open ok v<schema>" on success; prints the error and exits 1
 * on a failed/refused open.
 */
import { join } from "node:path";
import { bootstrapDshStorage } from "./bootstrap";

const [storageDir, projectDir] = process.argv.slice(2) as [string, string];
try {
  const outcome = await bootstrapDshStorage({
    directory: projectDir,
    port: 0,
    dbPath: join(storageDir, "context.db"),
    storageDirOverride: storageDir,
    homeHash: "a1b2c3d4",
    log: (m) => {
      if (m.includes("open lock")) console.error(m);
    },
  });
  if (outcome.kind !== "ok") {
    console.error(`open refused: ${outcome.reason} ${JSON.stringify(outcome.detail)}`);
    process.exit(1);
  }
  const row = outcome.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
  outcome.release?.();
  outcome.db.close();
  console.log(`open ok v${row.v}`);
  process.exit(0);
} catch (error) {
  console.error(`open failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
