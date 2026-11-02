import { describe, expect, it } from "bun:test";
import { Database } from "@magic-context/core/shared/sqlite";
import { nudgeLevelOf, readSessionContextDetails } from "./context-details";
import { resolveEffectiveSettings, resolveThresholds } from "../settings/magic-settings";

function db() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE compartments (session_id TEXT, created_at INTEGER);
    CREATE TABLE pending_ops (session_id TEXT, operation TEXT);
    CREATE TABLE dsh_context_outbox (session_id TEXT, status TEXT);
    CREATE TABLE tags (session_id TEXT, status TEXT);
    CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, compartment_in_progress INTEGER, historian_failure_count INTEGER,
      historian_last_error TEXT, historian_last_failure_at INTEGER, last_nudge_band TEXT, last_nudge_level TEXT,
      last_nudge_tokens INTEGER, channel2_nudge_state TEXT, note_nudge_trigger_pending INTEGER, last_context_percentage REAL,
      memory_block_count INTEGER, cached_m0_bytes BLOB, cached_m1_bytes BLOB);
  `);
  return d;
}

const effective = resolveEffectiveSettings(undefined, { protectedTokens: 9000 }, {});
const input = (database: unknown) => ({
  db: database as never,
  canonicalSessionId: "dsh:h:s1",
  sessionId: "s1",
  effective,
  thresholds: resolveThresholds(effective, undefined),
});

describe("magicContext/context details", () => {
  it("reads compartments, historian state, pending drops, knowledge tokens and nudges", () => {
    const d = db();
    d.exec(`INSERT INTO compartments VALUES ('dsh:h:s1', 1000), ('dsh:h:s1', 2000), ('other', 5)`);
    d.exec(`INSERT INTO pending_ops VALUES ('dsh:h:s1', 'drop'), ('dsh:h:s1', 'drop'), ('dsh:h:s1', 'other')`);
    d.exec(`INSERT INTO dsh_context_outbox VALUES ('dsh:h:s1', 'pending'), ('dsh:h:s1', 'committed')`);
    d.exec(`INSERT INTO tags VALUES ('dsh:h:s1', 'active'), ('dsh:h:s1', 'dropped')`);
    d.prepare(`INSERT INTO session_meta VALUES ('dsh:h:s1', 0, 1, 'boom', 1500, 'soft', 'gentle', 42000, 'armed', 1, 70, 3, ?, ?)`).run(
      new TextEncoder().encode("x".repeat(400)),
      new TextEncoder().encode("y".repeat(40)),
    );
    const out = readSessionContextDetails(input(d));
    expect(out.compartments).toBe(2);
    // failure (1500) predates the newest compartment (2000) → idle, not failed.
    expect(out.historian).toMatchObject({ state: "idle", failureCount: 1, lastCompartmentAt: 2000, lastError: "boom" });
    expect(out.pending).toEqual({ drops: 2, outbox: 1 });
    expect(out.tags).toEqual({ active: 1, dropped: 1, truncated: 0 });
    expect(out.knowledge).toEqual({ m0Tokens: 100, m1Tokens: 10, memoryBlocks: 3 });
    expect(out.nudge).toEqual({ band: "soft", level: "gentle", lastTokens: 42000, channel2: "armed", notePending: true });
    expect(out.protectedTokens).toBe(9000);
    expect(out.thresholds.executePercentage).toBe(65);
    d.exec(`UPDATE session_meta SET historian_last_failure_at = 3000`);
    expect(readSessionContextDetails(input(d)).historian.state).toBe("failed");
    d.exec(`UPDATE session_meta SET compartment_in_progress = 1`);
    expect(readSessionContextDetails(input(d)).historian.state).toBe("running");
  });

  it("decodes core's JSON Channel 1 nudge state to the band name (seen raw on real 0.2.1-rc.5)", () => {
    expect(nudgeLevelOf('{"level":"","ordinal":0}')).toBeUndefined();
    expect(nudgeLevelOf('{"level":"firm","ordinal":4,"postReduceGracePending":true}')).toBe("firm");
    expect(nudgeLevelOf("gentle")).toBe("gentle");
    expect(nudgeLevelOf("")).toBeUndefined();
    expect(nudgeLevelOf("{broken")).toBeUndefined();
    const d = db();
    d.prepare(`INSERT INTO session_meta VALUES ('dsh:h:s1', 0, 0, NULL, 0, '', ?, 0, '', 0, 58, 0, NULL, NULL)`).run('{"level":"","ordinal":0}');
    expect(readSessionContextDetails(input(d)).nudge).toEqual({ notePending: false });
    d.exec(`UPDATE session_meta SET last_nudge_level = '{"level":"urgent","ordinal":2}'`);
    expect(readSessionContextDetails(input(d)).nudge.level).toBe("urgent");
  });

  it("degrades to empty fields without storage or tables", () => {
    expect(readSessionContextDetails(input(undefined)).storage).toBe("unavailable");
    const empty = readSessionContextDetails(input(new Database(":memory:")));
    expect(empty).toMatchObject({ compartments: 0, pending: { drops: 0, outbox: 0 }, historian: { state: "never" } });
  });
});

// Round 15 scan: a process killed mid-historian (headless one-shot exit after
// the drain timeout, crash, sandbox restart) leaves
// session_meta.compartment_in_progress = 1; the popover then showed the
// historian "running" forever. The flag only counts while a compartment
// lease is live (the pass holds it; it expires when the holder died).
describe("historian running state requires a live compartment lease", () => {
  it("a stale in-progress flag without a live lease is not 'running'; with a live lease it is", () => {
    const d = db();
    d.exec(`CREATE TABLE compartment_state_lease (session_id TEXT PRIMARY KEY, holder_id TEXT, owner_pid INTEGER, acquired_at INTEGER, expires_at INTEGER)`);
    d.prepare(`INSERT INTO session_meta (session_id, compartment_in_progress, historian_failure_count) VALUES ('dsh:h:s1', 1, 0)`).run();
    expect(readSessionContextDetails(input(d)).historian.state).not.toBe("running");
    d.prepare(`INSERT INTO compartment_state_lease VALUES ('dsh:h:s1', 'x', 1, ?, ?)`).run(Date.now() - 1000, Date.now() - 1);
    expect(readSessionContextDetails(input(d)).historian.state).not.toBe("running"); // expired
    d.exec(`UPDATE compartment_state_lease SET expires_at = ${Date.now() + 60_000}`);
    expect(readSessionContextDetails(input(d)).historian.state).toBe("running");
  });
});
