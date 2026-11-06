import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  deriveEventMessage,
  magicUserMessage,
  replaceSurfaceRange,
  sessionEventAt,
} from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { executeFlush } from "@magic-context/core/hooks/magic-context/execute-flush";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { stageDshCompactionMarker } from "./outbox";
import { observedProtectionWindow } from "./protection";

/**
 * Round 36 line C — drop application gated like core.
 *
 * Core (OpenCode `transform-postprocess-phase.ts`, Pi `context-handler.ts`)
 * applies queued drops (`applyPendingOperations`) only on a pass that may
 * rewrite the prefix anyway: `reclaimRidePermitted(rideSignals, gate)` —
 * hardFold (fold / first render / cache-TTL idle expiry), force band,
 * explicit flush, freshly published history, subagent execute, the bounded
 * executeReclaim, served-shape repair. Below 95 % the protected tail stays
 * protected; at ≥ 95 % it does not. Before this fix the DSH adapter applied
 * pending ops on EVERY pre-step, so one ctx_reduce became one cache break per
 * step as each deferred tag left the protection window (round 36 line B,
 * cache-bench run 42142782133: 75 / 75 prefix divergences were new
 * `[dropped §N§]` placeholders).
 *
 * These tests drive the real pre-step body (`runContextPlaneStep`) on a real
 * DSH `Session` and look at the model-visible surface.
 */

const SID = "sess-drop-gate";
const KEY = `dsh:a1b2c3d4:${SID}`;
const WINDOW = 100_000;

type TagRow = { tag_number: number; type: string; status: string; message_id: string };

interface Harness {
  db: Database;
  session: Session;
  /** One pre-step pass (same process state unless `fresh`). */
  step: (opts?: { fresh?: boolean }) => Promise<void>;
  tags: () => TagRow[];
  pending: () => number[];
  setPressure: (pct: number) => void;
  setNowOffset: (ms: number) => void;
}

function surface(session: Session): string[] {
  return session.surface.nodes
    .map((seq) => sessionEventAt(session, seq))
    .map((event) => (event ? deriveEventMessage(event) : undefined))
    .filter((m) => m !== undefined)
    .map((m) =>
      (m as unknown as { content: Array<{ type: string; text?: string }> }).content
        .map((p) => p.text ?? `[${p.type}]`)
        .join("|"),
    );
}

function placeholders(session: Session): number[] {
  const all = surface(session).join("\n");
  return [...all.matchAll(/\[dropped \u00a7(\d+)\u00a7\]/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
}

async function scenario(fn: (h: Harness) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-drop-gate-"));
  const db = await createTestDb(join(dir, "c.db"));
  try {
    const session = Session.create(SessionId(SID));
    let pressurePct = 20;
    let nowOffset = 0;
    const deps: ContextPlaneDeps = {
      host: {
        ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
        canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
      },
      // Smallest legal floor: only the newest output stays protected.
      config: { protectedTokens: 4000 },
      historian: {
        // Trigger off: these tests feed the pressure reading only.
        config: { enabled: false, executeThresholdPercentage: 65 },
        readPressure: () => ({ projectedTokens: Math.round((pressurePct / 100) * WINDOW), contextWindow: WINDOW }),
        fire: () => {},
      },
      cacheTtl: "5m",
      now: () => Date.now() + nowOffset,
    } as ContextPlaneDeps;
    let state = createContextPlaneState();
    const step = async (opts?: { fresh?: boolean }) => {
      if (opts?.fresh === true) state = createContextPlaneState();
      await runContextPlaneStep(
        state,
        deps,
        { agent: { id: session.id, session, options: { provider: "d", model: "m" } } as never, messages: [] as never },
        async () => ({ reject: false, messages: [] }) as never,
      );
    };
    const tags = () =>
      db
        .prepare("SELECT tag_number, type, status, message_id FROM tags WHERE session_id = ? ORDER BY tag_number")
        .all(KEY) as TagRow[];
    const pending = () =>
      (db.prepare("SELECT tag_id FROM pending_ops WHERE session_id = ? ORDER BY tag_id").all(KEY) as Array<{ tag_id: number }>).map(
        (r) => r.tag_id,
      );
    await fn({
      db,
      session,
      step,
      tags,
      pending,
      setPressure: (pct) => {
        pressurePct = pct;
      },
      setNowOffset: (ms) => {
        nowOffset = ms;
      },
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addToolTurn(session: Session, i: number, size: number) {
  const u = createUserMessage({ content: [{ type: "text", text: `question ${i}` }], source: { kind: "user" } });
  session.append("user/message", u as never, { surfaceOp: "append" });
  const call = createAssistantMessage({
    content: [{ type: "text", text: `reading ${i}` }, { type: "tool-call", id: `call-${i}` as never, name: "read_file", arguments: "{}" }],
    provider: "d",
    model: "m",
    source: { kind: "model" } as never,
  } as never);
  session.append("assistant/message", { turn: i, step: 1, message: call } as never, { surfaceOp: "append" });
  const result = createToolResultMessage({
    callId: `call-${i}` as never,
    content: [{ type: "text", text: `BODY${i} `.repeat(size) }],
    isError: false,
  });
  session.append("tool/result", { turn: i, step: 1, message: result } as never, { surfaceOp: "append" });
  const reply = createAssistantMessage({
    content: [{ type: "text", text: `answer ${i}` }],
    provider: "d",
    model: "m",
    source: { kind: "model" } as never,
  } as never);
  session.append("assistant/message", { turn: i, step: 2, message: reply } as never, { surfaceOp: "append" });
}

/** Build `n` tagged tool turns; returns tool tags split into unprotected / protected. */
async function buildTurns(h: Harness, n: number): Promise<{ unprotected: number[]; protectedTools: number[] }> {
  for (let i = 1; i <= n; i += 1) {
    addToolTurn(h.session, i, 1500);
    await h.step();
  }
  const window = observedProtectionWindow(h.db, KEY, { protectedTokens: 4000, contextWindow: WINDOW });
  const prot = new Set(window.protectedTagNumbers);
  const tools = h.tags().filter((t) => t.type === "tool" && t.status === "active").map((t) => t.tag_number);
  return { unprotected: tools.filter((t) => !prot.has(t)), protectedTools: tools.filter((t) => prot.has(t)) };
}

function queueDrops(db: Database, tagNumbers: readonly number[]) {
  for (const t of tagNumbers) queuePendingOp(db, KEY, t, "drop", Date.now());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("round 36 line C: pending drops wait for a core reclaim ride", () => {
  it("1. no ride: pending drops stay queued and the served prefix bytes do not change over several pre-steps", async () => {
    await scenario(async (h) => {
      const { unprotected } = await buildTurns(h, 6);
      expect(unprotected.length).toBeGreaterThanOrEqual(3);
      const victims = unprotected.slice(0, 3);
      queueDrops(h.db, victims);
      let before = surface(h.session);
      for (let k = 6; k <= 8; k += 1) {
        // A new turn arrives (the window moves, as in a real tool loop).
        addToolTurn(h.session, k, 50);
        await h.step();
        const after = surface(h.session);
        // Append-only: every node the previous request carried is byte-identical.
        expect(after.slice(0, before.length)).toEqual(before);
        before = after;
      }
      const status = new Map(h.tags().map((t) => [t.tag_number, t.status]));
      for (const t of victims) expect(status.get(t)).toBe("active");
      expect(h.pending()).toEqual([...victims].sort((a, b) => a - b));
      expect(placeholders(h.session)).toEqual([]);
    });
  });

  it("2a. historian publication is a ride: every eligible pending drop lands in that one pass", async () => {
    await scenario(async (h) => {
      const { unprotected, protectedTools } = await buildTurns(h, 6);
      const victims = unprotected.slice(0, 4);
      queueDrops(h.db, [...victims, ...protectedTools]);
      await h.step();
      await h.step();
      expect(placeholders(h.session)).toEqual([]);
      await sleep(3);
      stageDshCompactionMarker(h.db, KEY, { ordinal: 2, endMessageId: "m-2", tokensBefore: 1000, summary: "s" });
      await h.step();
      const status = new Map(h.tags().map((t) => [t.tag_number, t.status]));
      for (const t of victims) expect(status.get(t)).toBe("dropped");
      // Below 95 % the protected tail stays protected (still queued).
      for (const t of protectedTools) expect(status.get(t)).toBe("active");
      expect(h.pending()).toEqual([...protectedTools].sort((a, b) => a - b));
      expect(placeholders(h.session)).toEqual(expect.arrayContaining(victims));
    });
  });

  it("2b. force band is a ride (all eligible land together); the next pass without a ride lands nothing new", async () => {
    await scenario(async (h) => {
      const { unprotected } = await buildTurns(h, 6);
      const first = unprotected.slice(0, 2);
      const later = unprotected.slice(2, 4);
      queueDrops(h.db, first);
      await h.step();
      expect(placeholders(h.session)).toEqual([]);
      h.setPressure(88);
      await h.step();
      expect(placeholders(h.session)).toEqual(expect.arrayContaining(first));
      h.setPressure(20);
      queueDrops(h.db, later);
      const before = surface(h.session);
      await h.step();
      expect(surface(h.session)).toEqual(before);
      const status = new Map(h.tags().map((t) => [t.tag_number, t.status]));
      for (const t of later) expect(status.get(t)).toBe("active");
    });
  });

  it("2c. cache-TTL idle expiry and a rewritten served prefix are rides; /ctx-flush lands at once without one", async () => {
    await scenario(async (h) => {
      const { unprotected } = await buildTurns(h, 8);
      expect(unprotected.length).toBeGreaterThanOrEqual(5);
      const [a, b, c, d, e] = unprotected;
      queueDrops(h.db, [a!, b!]);
      await h.step();
      expect(placeholders(h.session)).toEqual([]);
      // Idle past cache_ttl (5m): the provider prefix is cold anyway.
      h.setNowOffset(6 * 60_000);
      await h.step();
      expect(placeholders(h.session)).toEqual(expect.arrayContaining([a!, b!]));
      h.setNowOffset(0);
      // A served node rewritten since the last request (a compaction /
      // checkpoint / system change in DSH): ride.
      queueDrops(h.db, [c!]);
      await h.step();
      expect(placeholders(h.session)).not.toContain(c!);
      addToolTurn(h.session, 9, 50);
      await h.step();
      expect(placeholders(h.session)).not.toContain(c!);
      const first = h.session.surface.nodes[0]!;
      replaceSurfaceRange(
        h.session,
        first,
        first,
        magicUserMessage("checkpoint: earlier conversation summarised", {
          kind: "magic-context",
          plugin: "magic-context",
          messageId: "test-checkpoint",
        } as never),
        [first],
      );
      await h.step();
      expect(placeholders(h.session)).toContain(c!);
      // The rewritten prefix is a ride only until the next request is served
      // (a new response closes that window).
      addToolTurn(h.session, 10, 50);
      await h.step();
      // Explicit flush (/ctx-flush → core executeFlush) needs no ride.
      queueDrops(h.db, [d!, e!]);
      await h.step();
      expect(placeholders(h.session)).not.toContain(d!);
      executeFlush(h.db, KEY);
      await h.step();
      expect(placeholders(h.session)).toEqual(expect.arrayContaining([d!, e!]));
    });
  });

  it("3. at ≥ 95 % the protected tail is not protected (core parity); at the force band below 95 % it is", async () => {
    await scenario(async (h) => {
      const { unprotected, protectedTools } = await buildTurns(h, 5);
      expect(protectedTools.length).toBeGreaterThanOrEqual(1);
      queueDrops(h.db, [unprotected[0]!, ...protectedTools]);
      h.setPressure(90);
      await h.step();
      let status = new Map(h.tags().map((t) => [t.tag_number, t.status]));
      expect(status.get(unprotected[0]!)).toBe("dropped");
      for (const t of protectedTools) expect(status.get(t)).toBe("active");
      h.setPressure(96);
      await h.step();
      status = new Map(h.tags().map((t) => [t.tag_number, t.status]));
      for (const t of protectedTools) expect(status.get(t)).toBe("dropped");
      expect(h.pending()).toEqual([]);
    });
  });

  it("4. replay invariant: landed drops replay on every pass (and in a fresh process) and never revert; new queued drops still wait", async () => {
    await scenario(async (h) => {
      const { unprotected } = await buildTurns(h, 6);
      const landed = unprotected.slice(0, 2);
      queueDrops(h.db, landed);
      h.setNowOffset(6 * 60_000);
      await h.step();
      h.setNowOffset(0);
      expect(placeholders(h.session)).toEqual(expect.arrayContaining(landed));
      const afterRide = surface(h.session);
      queueDrops(h.db, [unprotected[2]!]);
      await h.step();
      await h.step({ fresh: true });
      addToolTurn(h.session, 7, 50);
      await h.step({ fresh: true });
      const now = surface(h.session);
      expect(now.slice(0, afterRide.length)).toEqual(afterRide);
      const status = new Map(h.tags().map((t) => [t.tag_number, t.status]));
      for (const t of landed) expect(status.get(t)).toBe("dropped");
      expect(status.get(unprotected[2]!)).toBe("active");
      expect(h.pending()).toEqual([unprotected[2]!]);
      const marks = placeholders(h.session);
      for (const t of landed) expect(marks.filter((m) => m === t).length).toBe(1);
    });
  });

  it("5. execute band: core executeReclaim rides only when no historian summary can come", async () => {
    await scenario(async (h) => {
      const { unprotected } = await buildTurns(h, 6);
      queueDrops(h.db, unprotected.slice(0, 3));
      updateSessionMeta(h.db, KEY, { compartmentInProgress: true });
      h.setPressure(70);
      await h.step();
      expect(placeholders(h.session)).toEqual([]);
      updateSessionMeta(h.db, KEY, { compartmentInProgress: false });
      await h.step();
      expect(placeholders(h.session)).toEqual(expect.arrayContaining(unprotected.slice(0, 3)));
    });
  });
});
