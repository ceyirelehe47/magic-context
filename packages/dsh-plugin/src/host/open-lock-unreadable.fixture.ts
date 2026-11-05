/**
 * Round 35 — child for open-lock-unreadable.test.ts.
 *   bun run open-lock-unreadable.fixture.ts <dbPath> <maxWaitMs>
 * Acquires the DSH open lock with a short max wait, prints every log line and
 * "acquired <ms>" once acquire resolves. A synchronous spin inside acquire
 * never prints and is killed by the test's deadline.
 */
import { acquireDshOpenLock } from "./open-lock";

const [dbPath, maxWait] = process.argv.slice(2) as [string, string];
const started = Date.now();
const release = await acquireDshOpenLock(dbPath, (m) => process.stdout.write(`${m}\n`), { maxWaitMs: Number(maxWait) });
process.stdout.write(`acquired ${Date.now() - started}\n`);
release();
