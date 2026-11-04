/**
 * Round 28 — crash-residue repro for open-lock-residue.test.ts (a real child).
 *   bun run open-lock-residue.fixture.ts <dbPath>
 * Takes and releases the DSH open lock in a tight loop until SIGKILLed. A kill
 * between createExclusive's temp write and its rm leaves `<lock>.<pid>.<r>.tmp`
 * (or `<lock>.takeover.<pid>.<r>.tmp`); a kill inside the takeover mutex
 * leaves `<lock>.takeover`.
 */
import { acquireDshOpenLock } from "./open-lock";

const [dbPath] = process.argv.slice(2) as [string];
process.stdout.write("ready\n");
for (;;) {
  const release = await acquireDshOpenLock(dbPath, () => {});
  release();
}
