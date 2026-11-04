/**
 * Round 23b P0-2 — "process A" of crash-recovery.test.ts. Runs in a real child
 * process against a file DB; the parent sets MAGIC_CONTEXT_DSH_E2E=1 and
 * MAGIC_CONTEXT_DSH_E2E_CRASH_AT=<point>, so the e2e-only fault injection
 * (agent/e2e-hooks.ts e2eCrashPoint) SIGKILLs this process mid-operation.
 *
 *   bun run crash-recovery.fixture.ts <mode> <dbPath> <eventsPath> <dshSessionId> <donePath>
 *
 * mode "plane":     a DSH session with four tool turns; one context-plane pass
 *                   per turn (tagging plan → coordinator saga → surface replace).
 * mode "historian": a five-turn session; one background historian pass.
 * mode "tailfold":  one tool turn, then a turn ending in a tool result with no
 *                   reply (session-tail fold); a plane pass after each.
 *
 * Every DSH session event is appended to <eventsPath> as it is committed (the
 * DSH session log is durable per event), so the parent can restore the exact
 * log a crashed DSH process leaves behind. <donePath> is written only when the
 * run completes (no crash point hit).
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createTestDb } from "../test-utils";
import { initializeDshAdapterTables } from "./outbox";
import { buildDurableSession, historianDepsFor, keyOf, runPlaneTurns, tailToolCall, toolTurn } from "./crash-recovery.helpers";
import { runDshHistorian } from "./historian";

const [mode, dbPath, eventsPath, dshSessionId, donePath] = process.argv.slice(2) as [string, string, string, string, string];

const db = await createTestDb(dbPath);
initializeDshAdapterTables(db);
const session = buildDurableSession(dshSessionId, (event) => appendFileSync(eventsPath, `${JSON.stringify(event)}\n`));

if (mode === "plane") {
  await runPlaneTurns(db, session, [1, 2, 3, 4], (s, i) => toolTurn(s, i, 1500));
  writeFileSync(donePath, JSON.stringify({ ok: true }));
} else if (mode === "historian") {
  for (let turn = 1; turn <= 5; turn += 1) toolTurn(session, turn, 200);
  const published = await runDshHistorian(historianDepsFor(db, session, keyOf(dshSessionId)));
  writeFileSync(donePath, JSON.stringify({ ok: true, published }));
} else if (mode === "tailfold") {
  // Round 27 C4: one closed tool turn, then a turn that ends in a tool result
  // with no reply (the session-tail fold); one plane pass per state.
  toolTurn(session, 1, 200);
  await runPlaneTurns(db, session, [2], (s, i) => tailToolCall(s, i, 200));
  writeFileSync(donePath, JSON.stringify({ ok: true }));
} else {
  throw new Error(`unknown mode ${mode}`);
}
db.close();
