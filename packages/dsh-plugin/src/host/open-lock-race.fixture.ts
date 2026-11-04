/**
 * Round 27 C5 — one racer of open-lock-race.test.ts (a real child process).
 *   bun run open-lock-race.fixture.ts <dbPath> <startAtMs> <outFile>
 * Spins until startAt (aligned start), takes the DSH open lock, then claims an
 * O_EXCL "inside" file for 30 ms: a second holder at the same time finds it
 * taken and records OVERLAP.
 */
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { acquireDshOpenLock } from "./open-lock";

const [dbPath, startAt, outFile] = process.argv.slice(2) as [string, string, string];
while (Date.now() < Number(startAt)) {
  // busy-wait: every racer leaves the gate in the same millisecond
}
const release = await acquireDshOpenLock(dbPath, () => {});
const inside = `${dbPath}.inside`;
let overlap = false;
try {
  writeFileSync(inside, String(process.pid), { flag: "wx" });
} catch {
  overlap = true;
}
await new Promise((resolve) => setTimeout(resolve, 30));
if (!overlap) rmSync(inside, { force: true });
release();
appendFileSync(outFile, `${process.pid} ${overlap ? "OVERLAP" : "ok"}\n`);
