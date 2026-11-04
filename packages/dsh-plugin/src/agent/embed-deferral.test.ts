/**
 * Round 27b (C5 remainder) — the automatic compartment-embedding backfill is
 * deferred while core's message-history FTS index does not yet cover the last
 * compartment (embedding-wiring `messageIndexCoversCompartments`). Before this
 * round the deferral was completely silent: if the index never caught up
 * (indexer wedged, index row lost, ordinals renumbered), auto-embed was
 * skipped on every pre-step forever and nothing — no log line, no status —
 * said why the compartment (semantic) lane of ctx_search stayed empty.
 *
 * Now:
 *  1. after EMBED_DEFERRAL_DIAGNOSTIC_AFTER consecutive deferrals, ONE
 *     diagnostic log line names the session, the compartment end and the
 *     indexed ordinal (not once per step: no log spam);
 *  2. the state is recorded durably (dsh_adapter_meta) and /ctx-status shows
 *     an "Auto-embed: deferred" block with the count and both ordinals;
 *  3. once the index covers the compartments, the record is cleared and
 *     /ctx-status no longer shows the block; a later stall logs again.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { canonicalSessionKey } from "dsh-magic-context-adapter";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { CommandResult } from "../compat/dsh-0.1/commands";
import { createTestDb } from "../test-utils";
import { registerCtxCommands } from "./commands";
import {
  EMBED_DEFERRAL_DIAGNOSTIC_AFTER,
  readEmbedDeferral,
  scheduleDshAutoEmbed,
} from "./embedding-wiring";
import { initializeDshAdapterTables } from "./outbox";

const HOME_HASH = "a1b2c3d4";
const SID = "deferral-1";
const KEY = canonicalSessionKey(HOME_HASH, SID);
const savedXdg = process.env.XDG_CONFIG_HOME;
let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-embed-deferral-"));
  process.env.XDG_CONFIG_HOME = join(root, "xdg"); // no user embedding config
});
afterAll(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(root, { recursive: true, force: true });
});

function fakeCtx() {
  const registered: Array<{ name: string; handler: (i: unknown) => Promise<CommandResult> | CommandResult }> = [];
  const commands = {
    register: (d: (typeof registered)[number]) => {
      registered.push(d);
      return () => {};
    },
  };
  return { registered, ctx: { get: (n: string) => (n === "commands" ? commands : undefined) } as unknown as Context };
}

async function status(db: Database, agent: Agent): Promise<string> {
  const { ctx, registered } = fakeCtx();
  registerCtxCommands(ctx, {
    db,
    canonicalKey: (id: string) => canonicalSessionKey(HOME_HASH, id),
    resolveProjectIdentity: () => "dir:/tmp/x",
    protectedTags: 20,
  });
  const cmd = registered.find((r) => r.name === "ctx-status")!;
  const result = (await cmd.handler({ agent, rawInput: "", signal: new AbortController().signal })) as CommandResult;
  expect(result.kind).toBe("success");
  return result.kind === "success" ? (result.text ?? "") : "";
}

function setIndexed(db: Database, n: number): void {
  db.prepare(
    `INSERT INTO message_history_index (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness)
     VALUES (?, ?, 0, ?, 'dsh') ON CONFLICT(session_id) DO UPDATE SET last_indexed_ordinal = excluded.last_indexed_ordinal`,
  ).run(KEY, n, Date.now());
}

describe("auto-embed deferral diagnostic (round 27b C5)", () => {
  it("logs once after N consecutive deferrals, shows it in /ctx-status, clears on catch-up", async () => {
    const projectDir = mkdtempSync(join(root, "proj-"));
    const db = await createTestDb(join(root, "context.db"));
    try {
      initializeDshAdapterTables(db);
      appendCompartments(db, KEY, [
        {
          sequence: 0, startMessage: 1, endMessage: 40, startMessageId: "m1", endMessageId: "m40",
          title: "t", content: "c", p1: "p1", p2: "p2", p3: "p3", p4: "p4", importance: 50, episodeType: "design",
        },
      ] as never);
      setIndexed(db, 12); // index stalled far behind the compartment end (40)
      const agent = {
        id: SID,
        options: { provider: "deepseek", model: "deepseek-chat" },
        session: { header: { id: SID, cwd: projectDir }, deriveMessages: () => [] },
        followup: () => {},
      } as unknown as Agent;
      const logs: string[] = [];
      const log = (m: string) => logs.push(m);
      const deferralLogs = () => logs.filter((l) => l.includes("auto-embed deferred"));

      for (let i = 0; i < EMBED_DEFERRAL_DIAGNOSTIC_AFTER - 1; i += 1) scheduleDshAutoEmbed(db, KEY, agent, projectDir, log);
      expect(deferralLogs()).toHaveLength(0); // below N: silent (normal async lag)
      expect(readEmbedDeferral(db, KEY)).toBeNull();

      scheduleDshAutoEmbed(db, KEY, agent, projectDir, log); // N-th
      expect(deferralLogs()).toHaveLength(1);
      expect(deferralLogs()[0]).toContain(KEY);
      expect(deferralLogs()[0]).toContain("indexed 12");
      expect(deferralLogs()[0]).toContain("compartments end at 40");
      const rec = readEmbedDeferral(db, KEY);
      expect(rec?.count).toBe(EMBED_DEFERRAL_DIAGNOSTIC_AFTER);
      expect(rec?.indexed).toBe(12);
      expect(rec?.compartmentEnd).toBe(40);

      for (let i = 0; i < 3 * EMBED_DEFERRAL_DIAGNOSTIC_AFTER; i += 1) scheduleDshAutoEmbed(db, KEY, agent, projectDir, log);
      expect(deferralLogs()).toHaveLength(1); // no spam
      expect(readEmbedDeferral(db, KEY)!.count).toBeGreaterThan(EMBED_DEFERRAL_DIAGNOSTIC_AFTER);

      const text = await status(db, agent);
      expect(text).toContain("### Auto-embed: deferred");
      expect(text).toContain("message index at ordinal 12");
      expect(text).toContain("compartments end at 40");

      setIndexed(db, 40); // index catches up
      scheduleDshAutoEmbed(db, KEY, agent, projectDir, log);
      expect(readEmbedDeferral(db, KEY)).toBeNull();
      expect(await status(db, agent)).not.toContain("Auto-embed: deferred");

      setIndexed(db, 12); // a later stall diagnoses again (counter restarted)
      for (let i = 0; i < EMBED_DEFERRAL_DIAGNOSTIC_AFTER; i += 1) scheduleDshAutoEmbed(db, KEY, agent, projectDir, log);
      expect(deferralLogs()).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
