import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../test-utils";
import {
  baseRideSignals,
  decideDropRide,
  isCacheIdleExpired,
  readServedPrefixState,
  type DshDropRideInput,
} from "./drop-gate";

const magic = (messageId: string) => ({ source: { kind: "magic-context", plugin: "magic-context", messageId } });

describe("drop-gate: served prefix from the DSH log", () => {
  it("uses the latest request/header as the served boundary and finds a later non-Magic replace of a served node", () => {
    const events = [
      { seq: 0, type: "system/message", surfaceOp: "append", time: 1 },
      { seq: 1, type: "user/message", surfaceOp: "append", time: 2 },
      { seq: 2, type: "request/header", time: 3 },
      { seq: 3, type: "assistant/message", surfaceOp: "append", time: 4, data: {} },
      { seq: 4, type: "tool/result", surfaceOp: "append", time: 5 },
      // Magic tags copy of served node 1: NOT a rewrite (bytes were previewed).
      { seq: 5, type: "user/message", surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 }, data: magic("mc-op:x") },
      // Magic copy of new nodes only: not a served node.
      { seq: 6, type: "user/message", surfaceOp: { op: "replace", startSeq: 3, endSeq: 4 }, data: magic("mc-op:y") },
    ];
    const s = readServedPrefixState(events);
    expect(s.servedBoundarySeq).toBe(2);
    expect(s.servedAt).toBe(3);
    expect(s.lastResponseAt).toBe(4);
    expect(s.rewrittenBySeq).toBeNull();
    const compacted = [
      ...events,
      { seq: 7, type: "compaction/summary", surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 }, data: {} },
    ];
    expect(readServedPrefixState(compacted).rewrittenBySeq).toBe(7);
    expect(readServedPrefixState(compacted).rewrittenByType).toBe("compaction/summary");
    // After the next request is served, the same replace is history.
    const served = [...compacted, { seq: 8, type: "request/header", time: 9 }];
    expect(readServedPrefixState(served).rewrittenBySeq).toBeNull();
  });

  it("falls back to the last appended assistant/message, ignores replaced copies, and reports nothing served", () => {
    expect(readServedPrefixState([]).servedBoundarySeq).toBe(-1);
    const events = [
      { seq: 0, type: "user/message", surfaceOp: "append", time: 10 },
      { seq: 1, type: "assistant/message", surfaceOp: "append", time: 20, data: {} },
      { seq: 2, type: "assistant/message", surfaceOp: "append", time: 30, data: { interrupted: true } },
      { seq: 3, type: "assistant/message", surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 }, time: 40, data: magic("mc-op:z") },
    ];
    const s = readServedPrefixState(events);
    expect(s.servedBoundarySeq).toBe(2);
    expect(s.servedAt).toBe(30);
    expect(s.lastResponseAt).toBe(20);
  });

  it("cache-TTL idle expiry follows core resolveCacheTtl/parseCacheTtl (\"never\" disables it)", () => {
    expect(isCacheIdleExpired(0, 10_000_000, "5m", undefined)).toBe(false);
    expect(isCacheIdleExpired(1_000, 1_000 + 5 * 60_000 - 1, "5m", undefined)).toBe(false);
    expect(isCacheIdleExpired(1_000, 1_000 + 5 * 60_000 + 1, "5m", undefined)).toBe(true);
    expect(isCacheIdleExpired(1_000, 1_000 + 2 * 3_600_000, "1h", undefined)).toBe(true);
    expect(isCacheIdleExpired(1_000, 1_000 + 2 * 3_600_000, "never", undefined)).toBe(false);
  });
});

describe("drop-gate: core ride signals", () => {
  const served = { servedBoundarySeq: 10, servedAt: 1_000, lastResponseAt: 1_000, rewrittenBySeq: null, rewrittenByType: null };
  const input = (over: Partial<DshDropRideInput>): DshDropRideInput => ({
    served,
    cacheExpired: false,
    historianPublishedAt: 0,
    contextPercentage: 30,
    fromEstimate: false,
    executePercentage: 65,
    forcePercentage: 85,
    usableWindow: 100_000,
    summaryCanCome: false,
    ...over,
  });

  it("maps each DSH observation onto core's signal and gate shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-drop-gate-"));
    const db = await createTestDb(join(dir, "c.db"));
    try {
      const sid = "dsh:x:s";
      expect(baseRideSignals(db, sid, undefined).signals).toMatchObject({ hardFold: false, force: false, publishedHistory: false });
      const none = baseRideSignals(db, sid, input({}));
      expect(Object.values(none.signals).some(Boolean)).toBe(false);
      expect(none.gate).toEqual({ signedThinkingHold: false, firstRender: false, idleExpiry: false, emergency: false });
      expect(baseRideSignals(db, sid, input({ served: { ...served, servedBoundarySeq: -1 } })).signals.hardFold).toBe(true);
      expect(baseRideSignals(db, sid, input({ served: { ...served, rewrittenBySeq: 12 } })).signals.hardFold).toBe(true);
      const idle = baseRideSignals(db, sid, input({ cacheExpired: true }));
      expect(idle.signals.hardFold).toBe(true);
      expect(idle.gate.idleExpiry).toBe(true);
      expect(baseRideSignals(db, sid, input({ historianPublishedAt: 999 })).signals.publishedHistory).toBe(false);
      expect(baseRideSignals(db, sid, input({ historianPublishedAt: 1_000 })).signals.publishedHistory).toBe(true);
      // Force band: a local estimate below 95 % waits for a provider reading (core guard).
      expect(baseRideSignals(db, sid, input({ contextPercentage: 86 })).signals.force).toBe(true);
      expect(baseRideSignals(db, sid, input({ contextPercentage: 86, fromEstimate: true })).signals.force).toBe(false);
      expect(baseRideSignals(db, sid, input({ contextPercentage: 95, fromEstimate: true })).signals.force).toBe(true);
      expect(baseRideSignals(db, sid, input({ contextPercentage: 84 })).signals.force).toBe(false);
      // No pending drops → no executeReclaim origination; no ride.
      const d = decideDropRide({ db, sessionId: sid, input: input({ contextPercentage: 70 }), pendingOps: [], tags: [], targets: new Map(), protectedTagNumbers: new Set() });
      expect(d.permitted).toBe(false);
      expect(d.label).toBe("ride=none");
      const f = decideDropRide({ db, sessionId: sid, input: input({ contextPercentage: 96 }), pendingOps: [], tags: [], targets: new Map(), protectedTagNumbers: new Set() });
      expect(f.permitted).toBe(true);
      expect(f.unprotectTail).toBe(true);
      expect(f.label).toBe("ride=force");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
