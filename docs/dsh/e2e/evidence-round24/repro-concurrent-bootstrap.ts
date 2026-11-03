/**
 * Round 24 — concurrent FIRST open of a fresh Magic DB by several DSH processes,
 * through the real DSH bootstrap (bootstrapDshStorage → core openDatabaseAsync
 * → migration worker). Run from packages/dsh-plugin:
 *
 *   bun run ../../docs/dsh/e2e/evidence-round24/repro-concurrent-bootstrap.ts <iterations> <procsPerIteration> <parallelIterations>
 *
 * Each iteration creates a fresh storage dir and starts <procs> fixture
 * processes on it at the same moment; an iteration is "bad" when any process
 * fails to open. Prints one line per bad process and the totals.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(process.cwd(), "src/host/bootstrap-open.fixture.ts");
const iterations = Number(process.argv[2] ?? 15);
const procs = Number(process.argv[3] ?? 2);
const parallel = Number(process.argv[4] ?? 3);
let badIterations = 0;
let badProcs = 0;
const reasons = new Map<string, number>();

async function iteration(i: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "race24-"));
  const children = Array.from({ length: procs }, (_, k) =>
    Bun.spawn({
      cmd: [process.execPath, "run", FIX, dir, join(dir, `proj-${k}`)],
      cwd: dir,
      env: { ...(process.env as Record<string, string>) },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const codes = await Promise.all(children.map((c) => c.exited));
  let bad = false;
  for (let k = 0; k < procs; k += 1) {
    if (codes[k] === 0) continue;
    bad = true;
    badProcs += 1;
    const err = (await new Response(children[k]!.stderr).text()).trim().split("\n").filter((l) => l.includes("open ")).pop() ?? "?";
    const key = err.replace(/\/tmp\/\S+/g, "<tmp>").slice(0, 160);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
    console.log(`iter ${i} proc ${k}: code=${codes[k]} ${key}`);
  }
  if (bad) badIterations += 1;
  rmSync(dir, { recursive: true, force: true });
}

for (let start = 0; start < iterations; start += parallel) {
  await Promise.all(
    Array.from({ length: Math.min(parallel, iterations - start) }, (_, j) => iteration(start + j)),
  );
}
console.log(`iterations ${iterations} procs/iteration ${procs} parallel ${parallel}`);
console.log(`bad iterations ${badIterations} bad processes ${badProcs}`);
for (const [k, v] of reasons) console.log(`  ${v} × ${k}`);
