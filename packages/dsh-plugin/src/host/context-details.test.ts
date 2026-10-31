import { describe, expect, it } from "bun:test";
import { Database } from "@magic-context/core/shared/sqlite";
import { readSessionContextDetails } from "./context-details";
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
    expect(out.tags).toEqual({ active: 1, dropped: 1 });
    expect(out.knowledge).toEqual({ m0Tokens: 100, m1Tokens: 10, memoryBlocks: 3 });
    expect(out.nudge).toEqual({ band: "soft", level: "gentle", lastTokens: 42000, channel2: "armed", notePending: true });
    expect(out.protectedTokens).toBe(9000);
    expect(out.thresholds.executePercentage).toBe(65);
    d.exec(`UPDATE session_meta SET historian_last_failure_at = 3000`);
    expect(readSessionContextDetails(input(d)).historian.state).toBe("failed");
    d.exec(`UPDATE session_meta SET compartment_in_progress = 1`);
    expect(readSessionContextDetails(input(d)).historian.state).toBe("running");
  });

  it("degrades to empty fields without storage or tables", () => {
    expect(readSessionContextDetails(input(undefined)).storage).toBe("unavailable");
    const empty = readSessionContextDetails(input(new Database(":memory:")));
    expect(empty).toMatchObject({ compartments: 0, pending: { drops: 0, outbox: 0 }, historian: { state: "never" } });
  });
});
