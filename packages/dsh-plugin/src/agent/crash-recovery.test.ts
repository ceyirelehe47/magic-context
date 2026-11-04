/**
 * Round 23b P0-2 — process crash (SIGKILL) at five points, recovery in a NEW
 * process against the same SQLite DB and the DSH session log the crashed
 * process left behind.
 *
 * "Process A" is a real child (crash-recovery.fixture.ts) killed by the
 * e2e-only fault injection (MAGIC_CONTEXT_DSH_E2E=1 +
 * MAGIC_CONTEXT_DSH_E2E_CRASH_AT=<point>, agent/e2e-hooks.ts). "Process B" is
 * this test process: fresh module state (new context-plane state, new
 * coordinator), the DSH session restored from the durable event log.
 *
 * Checked after recovery: no duplicate compartment, no lease stuck on a dead
 * owner, unfinished saga rows settled (never left pending), tag numbers and
 * message identities stable (unique, contiguous, continue after restart), the
 * other session sharing the DB untouched, the raw DSH log intact.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@deepseek-ai/dsh-session";
import { acquireCompartmentLease, releaseCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createToolResultMessage, createUserMessage, deriveEventMessage, sessionEventAt } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState } from "./context-plane";
import {
  historianDepsFor,
  keyOf,
  planeDeps,
  planeStep,
  restoreSession,
  toolTurn,
} from "./crash-recovery.helpers";
import { getDshCompactionMarker, initializeDshAdapterTables, listOutboxBySession } from "./outbox";
import { isDshHistorianBusy, runDshHistorian } from "./historian";
import { readSessionContextDetails } from "../host/context-details";
import { resolveEffectiveSettings, resolveThresholds } from "../settings/magic-settings";

const FIXTURE = join(import.meta.dir, "crash-recovery.fixture.ts");

interface ChildResult {
  exitCode: number | null;
  signal: string | null;
  done: boolean;
  stderr: string;
}

function spawnArgs(mode: string, dir: string, sid: string, point: string | undefined) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.MAGIC_CONTEXT_DSH_E2E_CRASH_AT;
  if (point !== undefined) {
    env.MAGIC_CONTEXT_DSH_E2E = "1";
    env.MAGIC_CONTEXT_DSH_E2E_CRASH_AT = point;
  }
  const done = join(dir, `${sid}.done.json`);
  return {
    cmd: [process.execPath, "run", FIXTURE, mode, join(dir, "context.db"), join(dir, `${sid}.events.jsonl`), sid, done],
    cwd: dir,
    env,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    done,
  };
}

function runChild(mode: string, dir: string, sid: string, point?: string): ChildResult {
  const a = spawnArgs(mode, dir, sid, point);
  const r = Bun.spawnSync(a);
  return {
    exitCode: r.exitCode,
    signal: (r as unknown as { signalCode?: string | null }).signalCode ?? null,
    done: existsSync(a.done),
    stderr: r.stderr.toString(),
  };
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-crash-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tagRows(db: Database, key: string) {
  return db
    .prepare("SELECT tag_number, message_id, type, status FROM tags WHERE session_id = ? ORDER BY tag_number")
    .all(key) as Array<{ tag_number: number; message_id: string; type: string; status: string }>;
}

/** Tag numbers unique + contiguous 1..N, message identities unique. */
function expectTagIdentity(db: Database, key: string) {
  const rows = tagRows(db, key);
  const nums = rows.map((r) => r.tag_number);
  expect(nums.length).toBeGreaterThan(0);
  expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1));
  expect(new Set(rows.map((r) => r.message_id)).size).toBe(rows.length);
  return rows;
}

/** `§N§` prefixes on the model-visible surface: each number at most once, each a DB tag. */
function expectSurfaceTags(db: Database, session: Session, key: string) {
  const seen: number[] = [];
  for (const seq of session.surface.nodes) {
    const ev = sessionEventAt(session, seq);
    const m = ev ? deriveEventMessage(ev) : undefined;
    const blocks = (m as unknown as { content?: Array<{ text?: string; content?: Array<{ text?: string }> }> } | undefined)?.content ?? [];
    const texts = blocks.flatMap((b) => [b.text ?? "", ...(b.content ?? []).map((c) => c.text ?? "")]);
    for (const t of texts) for (const hit of t.matchAll(/\u00a7(\d+)\u00a7/g)) seen.push(Number(hit[1]));
  }
  const dup = seen.filter((n, i) => seen.indexOf(n) !== i);
  expect(dup).toEqual([]);
  const known = new Set(tagRows(db, key).map((r) => r.tag_number));
  expect(seen.filter((n) => !known.has(n))).toEqual([]);
  return seen;
}

function expectRawIntact(events: readonly unknown[], turns: readonly number[]) {
  const text = JSON.stringify(events);
  for (const i of turns) expect(text).toContain(`BODY${i} BODY${i} `);
}

function expectCompartmentsContiguous(db: Database, key: string) {
  const c = getCompartments(db, key).map((x) => [x.startMessage, x.endMessage] as const);
  const starts = c.map(([s]) => s);
  expect(new Set(starts).size).toBe(starts.length); // no duplicate compartment
  for (let i = 1; i < c.length; i += 1) expect(c[i]![0]).toBe(c[i - 1]![1] + 1); // no overlap / gap
  return c;
}

function expectIntegrity(db: Database) {
  const integrity = db.prepare("PRAGMA integrity_check").get() as Record<string, string>;
  expect(Object.values(integrity)[0]).toBe("ok");
}

function leaseRows(db: Database, key: string) {
  return db
    .prepare("SELECT holder_id, owner_pid, expires_at FROM compartment_state_lease WHERE session_id = ?")
    .all(key) as Array<{ holder_id: string; owner_pid: number; expires_at: number }>;
}

function inProgress(db: Database, key: string): number {
  const r = db.prepare("SELECT compartment_in_progress AS p FROM session_meta WHERE session_id = ?").get(key) as
    | { p: number | null }
    | undefined;
  return r?.p ?? 0;
}

function statusState(db: Database, key: string) {
  const effective = resolveEffectiveSettings(undefined, {}, {});
  return readSessionContextDetails({
    db,
    canonicalSessionId: key,
    sessionId: key,
    effective,
    thresholds: resolveThresholds(effective, undefined),
  }).historian.state;
}

/** Process B: restore the log, run passes with fresh state, add one turn. */
async function recoverPlane(dir: string, sid: string) {
  const key = keyOf(sid);
  const db = await createTestDb(join(dir, "context.db"));
  initializeDshAdapterTables(db);
  expectIntegrity(db);
  const { session, events } = restoreSession(sid, join(dir, `${sid}.events.jsonl`));
  const applied: string[] = [];
  const deps = planeDeps(db, (m) => {
    if (m.includes("applied plan")) applied.push(m);
  });
  const state = createContextPlaneState();
  const before = listOutboxBySession(db, key).map((r) => r.status);
  await planeStep(state, deps, session); // first step: reconcile + re-derive
  return { db, key, session, events, applied, deps, state, outboxBefore: before };
}

describe("crash recovery (round 23b P0-2): context-plane saga", () => {
  for (const point of ["outbox-pending", "surface-applied"] as const) {
    it(`SIGKILL at ${point}: the next process settles the saga row, keeps tag identity, and continues`, async () => {
      await withDir(async (dir) => {
        const sid = `sess-crash-${point}`;
        const a = runChild("plane", dir, sid, point);
        expect(a.done).toBe(false);
        expect(a.signal === "SIGKILL" || a.exitCode === 137 || a.exitCode === null).toBe(true);
        expect(a.stderr).toContain(`crash point ${point}`);

        const r = await recoverPlane(dir, sid);
        try {
          // The crashed op was left non-terminal; recovery closes it (never left pending/applied).
          expect(r.outboxBefore).toContain("pending");
          const statuses = listOutboxBySession(r.db, r.key).map((x) => x.status);
          expect(statuses.filter((s) => s === "pending" || s === "applied")).toEqual([]);
          const rows = expectTagIdentity(r.db, r.key);
          const surface = expectSurfaceTags(r.db, r.session, r.key);
          expect(surface.length).toBeGreaterThan(0);
          expectRawIntact(r.events, [1]);
          // Idempotent: another pass on the recovered surface changes nothing.
          const appliedBefore = r.applied.length;
          await planeStep(r.state, r.deps, r.session);
          expect(r.applied.length).toBe(appliedBefore);
          // Continue: three more turns get the next numbers, nothing reused or skipped.
          for (const i of [2, 3, 4]) {
            toolTurn(r.session, i, 1500);
            await planeStep(r.state, r.deps, r.session);
          }
          const after = expectTagIdentity(r.db, r.key);
          expect(after.length).toBeGreaterThan(rows.length);
          expect(after.slice(0, rows.length)).toEqual(rows);
          expectSurfaceTags(r.db, r.session, r.key);
          expect(listOutboxBySession(r.db, r.key).filter((x) => x.status === "pending" || x.status === "applied")).toEqual([]);
        } finally {
          r.db.close();
        }
      });
    }, 60_000);
  }
});

describe("crash recovery (round 27 C4): SIGKILL between the tail tool result and the landed replace (Y4 window)", () => {
  function toolRows(db: Database, key: string, callId: string) {
    return db
      .prepare("SELECT tag_number, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = ?")
      .all(key, callId) as Array<{ tag_number: number; tool_owner_message_id: string | null }>;
  }

  it("control: without the crash point the tail-fold run completes", async () => {
    await withDir(async (dir) => {
      const a = runChild("tailfold", dir, "sess-tailfold-control", undefined);
      expect(a.done).toBe(true);
    });
  }, 60_000);

  it("SIGKILL at tail-fold-pending: tags written, no replace landed; the next prompt keeps the call's tag number (one row, re-owned)", async () => {
    await withDir(async (dir) => {
      const sid = "sess-crash-tailfold";
      const key = keyOf(sid);
      const a = runChild("tailfold", dir, sid, "tail-fold-pending");
      expect(a.done).toBe(false);
      expect(a.signal === "SIGKILL" || a.exitCode === 137 || a.exitCode === null).toBe(true);
      expect(a.stderr).toContain("crash point tail-fold-pending");

      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      try {
        expectIntegrity(db);
        const { session, events } = restoreSession(sid, join(dir, `${sid}.events.jsonl`));
        expectRawIntact(events, [1, 2]);
        // In the window: the call is tagged under the synthetic tail owner, and
        // the surface still ends in the raw tool result (no Magic copy of it).
        const before = toolRows(db, key, "call-2");
        expect(before).toHaveLength(1);
        expect(before[0]!.tool_owner_message_id ?? "").toMatch(/^synth-user-/);
        const lastSeq = session.surface.nodes[session.surface.nodes.length - 1]!;
        expect(sessionEventAt(session, lastSeq)?.type).toBe("tool/result");

        // Restart: the next user prompt absorbs the unreplaced tail fold.
        const prompt = createUserMessage({ content: [{ type: "text", text: "Reply when done." }], source: { kind: "user" } });
        session.append("user/message", prompt as never, { surfaceOp: "append" });
        await planeStep(createContextPlaneState(), planeDeps(db), session);
        const after = toolRows(db, key, "call-2");
        expect(after).toHaveLength(1);
        expect(after[0]!.tag_number).toBe(before[0]!.tag_number);
        expect(after[0]!.tool_owner_message_id).toBe(prompt.id);
        expectTagIdentity(db, key);
        const surface = expectSurfaceTags(db, session, key);
        expect(surface).toContain(before[0]!.tag_number);
      } finally {
        db.close();
      }
    });
  }, 60_000);
});

describe("crash recovery (round 27b, e2e 41784617324 F1–F3): the killed tool result was NOT durable — DSH restores it as TOOL_OUTCOME_UNKNOWN", () => {
  // Real DSH (e2e 41784617324, scenario F): at the tail-fold-pending kill the
  // tool result existed only in memory; on restart DSH's restore appended
  // `interrupted-tool-result-<call>-<seq>` (isError, TOOL_OUTCOME_UNKNOWN) for
  // the same callId, and the next pre-step ran BEFORE the new user message was
  // in the view. The view's tail owner is therefore a NEW synthetic owner
  // (synth-user-interrupted-tool-result-…), not a real user message, and
  // reownAbsorbedTailToolTags (real-user targets only) did not apply: core
  // tagged the call a second time (§3§; the pre-kill §2§ row stayed active,
  // orphaned under the vanished owner). Same window, real-DSH log shape.
  it("restart over DSH's restored interrupted result keeps ONE tag row for the call with its pre-kill number", async () => {
    await withDir(async (dir) => {
      const sid = "sess-crash-tailfold-unknown";
      const key = keyOf(sid);
      const a = runChild("tailfold", dir, sid, "tail-fold-pending");
      expect(a.done).toBe(false);
      const eventsPath = join(dir, `${sid}.events.jsonl`);
      // Drop the in-memory-only tool result (DSH never made it durable).
      const lines = readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.trim() !== "");
      const lastResult = lines.map((l) => JSON.parse(l) as { type?: string }).map((e) => e.type).lastIndexOf("tool/result");
      writeFileSync(eventsPath, `${lines.filter((_, i) => i !== lastResult).join("\n")}\n`);
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      try {
        const before = db
          .prepare("SELECT tag_number, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = 'call-2'")
          .all(key) as Array<{ tag_number: number; tool_owner_message_id: string | null }>;
        expect(before).toHaveLength(1);
        expect(before[0]!.tool_owner_message_id ?? "").toMatch(/^synth-user-/);
        const { session } = restoreSession(sid, eventsPath);
        // DSH's restore: the interrupted result for the same call, new message id.
        const restored = {
          ...createToolResultMessage({
            callId: "call-2" as never,
            content: [{ type: "text", text: "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown." }],
            isError: true,
          }),
          id: `interrupted-tool-result-call-2-${session.surface.nodes.length}`,
        };
        session.append("tool/result", { turn: 2, step: 1, message: restored, error: { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" } } as never, { surfaceOp: "append" });
        // The restarted turn's first pre-step runs before its user message is in the view.
        await planeStep(createContextPlaneState(), planeDeps(db), session);
        const prompt = createUserMessage({ content: [{ type: "text", text: "Reply when done." }], source: { kind: "user" } });
        session.append("user/message", prompt as never, { surfaceOp: "append" });
        await planeStep(createContextPlaneState(), planeDeps(db), session);
        const after = db
          .prepare("SELECT tag_number, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = 'call-2'")
          .all(key) as Array<{ tag_number: number; tool_owner_message_id: string | null }>;
        expect(after).toHaveLength(1);
        expect(after[0]!.tag_number).toBe(before[0]!.tag_number);
        expect(after[0]!.tool_owner_message_id).not.toBe(before[0]!.tool_owner_message_id);
        expectTagIdentity(db, key);
        const surface = expectSurfaceTags(db, session, key);
        expect(surface).toContain(before[0]!.tag_number);
      } finally {
        db.close();
      }
    });
  }, 60_000);
});

async function recoverHistorian(dir: string, sid: string) {
  const key = keyOf(sid);
  const db = await createTestDb(join(dir, "context.db"));
  initializeDshAdapterTables(db);
  expectIntegrity(db);
  const { session, events } = restoreSession(sid, join(dir, `${sid}.events.jsonl`));
  return { db, key, session, events };
}

describe("crash recovery (round 23b P0-2): historian lease and publication", () => {
  it("SIGKILL after taking the lease: the dead owner's lease neither blocks nor reads as a running pass; the rerun publishes once", async () => {
    await withDir(async (dir) => {
      const sid = "sess-crash-leased";
      const a = runChild("historian", dir, sid, "historian-leased");
      expect(a.done).toBe(false);
      const r = await recoverHistorian(dir, sid);
      try {
        expect(leaseRows(r.db, r.key).length).toBe(1); // left behind by the dead process
        expect(getCompartments(r.db, r.key).length).toBe(0);
        // A dead holder is not a running pass (backstop deferral, /compact wait, status).
        expect(isDshHistorianBusy(r.db, r.key)).toBe(false);
        expect(await runDshHistorian(historianDepsFor(r.db, r.session, r.key))).toBe(true);
        const c = expectCompartmentsContiguous(r.db, r.key);
        expect(c.length).toBe(1);
        expect(leaseRows(r.db, r.key)).toEqual([]);
        expect(inProgress(r.db, r.key)).toBe(0);
        expectRawIntact(r.events, [1, 2, 3, 4, 5]);
      } finally {
        r.db.close();
      }
    });
  }, 60_000);

  it("SIGKILL inside the publish transaction (before COMMIT): nothing half-published; the rerun publishes exactly once", async () => {
    await withDir(async (dir) => {
      const sid = "sess-crash-publish";
      const a = runChild("historian", dir, sid, "historian-publish");
      expect(a.done).toBe(false);
      expect(a.stderr).toContain("crash point historian-publish");
      const r = await recoverHistorian(dir, sid);
      try {
        expect(getCompartments(r.db, r.key).length).toBe(0); // rolled back with the process
        expect(getDshCompactionMarker(r.db, r.key)).toBeNull(); // the API returns null when absent
        expect(isDshHistorianBusy(r.db, r.key)).toBe(false);
        expect(await runDshHistorian(historianDepsFor(r.db, r.session, r.key))).toBe(true);
        expect(expectCompartmentsContiguous(r.db, r.key).length).toBe(1);
        expect(getDshCompactionMarker(r.db, r.key)).not.toBeNull();
        // and a second rerun finds nothing new (no duplicate compartment)
        await runDshHistorian(historianDepsFor(r.db, r.session, r.key));
        expect(expectCompartmentsContiguous(r.db, r.key).length).toBe(1);
      } finally {
        r.db.close();
      }
    });
  }, 60_000);

  it("SIGKILL after COMMIT, before the lease release: published once, the stale lease/flag do not block, no duplicate on rerun", async () => {
    await withDir(async (dir) => {
      const sid = "sess-crash-published";
      const a = runChild("historian", dir, sid, "historian-published");
      expect(a.done).toBe(false);
      const r = await recoverHistorian(dir, sid);
      try {
        expect(expectCompartmentsContiguous(r.db, r.key).length).toBe(1);
        expect(leaseRows(r.db, r.key).length).toBe(1);
        expect(inProgress(r.db, r.key)).toBe(1); // flag left set by the dead pass
        expect(isDshHistorianBusy(r.db, r.key)).toBe(false);
        // /magic-context status must not show a dead pass as running
        expect(statusState(r.db, r.key)).not.toBe("running");
        // the lease can be taken right away (dead owner reclaimed), not after the 5-min TTL
        expect(acquireCompartmentLease(r.db, r.key, "probe")).not.toBeNull();
        releaseCompartmentLease(r.db, r.key, "probe");
        await runDshHistorian(historianDepsFor(r.db, r.session, r.key));
        expect(expectCompartmentsContiguous(r.db, r.key).length).toBe(1);
        expect(inProgress(r.db, r.key)).toBe(0);
      } finally {
        r.db.close();
      }
    });
  }, 60_000);
});

describe("crash recovery (round 23b P0-2): two sessions, two processes, one shared DB", () => {
  it("process A dies mid-publish on session A while process B works on session B: B completes untouched; A recovers", async () => {
    await withDir(async (dir) => {
      const sa = "sess-shared-a";
      const sb = "sess-shared-b";
      // The shared DB already exists (migrated once), as for any second DSH
      // process. Two processes racing the FIRST migration of a fresh file is a
      // separate core issue (round 23c: "table temporal_decisions already
      // exists" → storage unavailable for the loser), not this case.
      // (kept open: core caches the handle per path in this process)
      const db = await createTestDb(join(dir, "context.db"));
      initializeDshAdapterTables(db);
      const pa = spawnArgs("historian", dir, sa, "historian-publish");
      const pb = spawnArgs("plane", dir, sb, undefined);
      const childB = Bun.spawn(pb);
      const childA = Bun.spawn(pa);
      const [codeA, codeB] = await Promise.all([childA.exited, childB.exited]);
      const errB = await new Response(childB.stderr).text();
      const errA = await new Response(childA.stderr).text();
      expect(existsSync(pa.done)).toBe(false);
      expect(codeA).not.toBe(0);
      expect(errA).toContain("crash point historian-publish"); // died at the injected point, not of something else
      expect(codeB).toBe(0);
      expect(existsSync(pb.done)).toBe(true);
      expect(errB).not.toMatch(/SQLITE_BUSY|database is locked|malformed/i);

      try {
        const integrity = db.prepare("PRAGMA integrity_check").get() as Record<string, string>;
        expect(Object.values(integrity)[0]).toBe("ok");
        // B: complete and consistent
        const kb = keyOf(sb);
        const { session: sessB, events: evB } = restoreSession(sb, join(dir, `${sb}.events.jsonl`));
        expectTagIdentity(db, kb);
        expectSurfaceTags(db, sessB, kb);
        expect(listOutboxBySession(db, kb).filter((x) => x.status !== "committed")).toEqual([]);
        expectRawIntact(evB, [1, 2, 3, 4]);
        // A: nothing half-published, recovers
        const ka = keyOf(sa);
        const { session: sessA } = restoreSession(sa, join(dir, `${sa}.events.jsonl`));
        expect(getCompartments(db, ka).length).toBe(0);
        expect(await runDshHistorian(historianDepsFor(db, sessA, ka))).toBe(true);
        expect(expectCompartmentsContiguous(db, ka).length).toBe(1);
        // and B's rows were not touched by A's recovery
        expect(getCompartments(db, kb).length).toBe(0);
      } finally {
        db.close();
      }
    });
  }, 90_000);
});
