import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSessionKey, parseDshSessionKey } from "dsh-magic-context-adapter";
import { createTestDb } from "../test-utils";
import { initializeDshAdapterTables } from "../agent/outbox";
import { MagicContextRemoteService } from "./remote";

/**
 * Round 15 scan (web API input): `magicContext/diagnostics` queried with the
 * RAW session id although every Magic table is keyed by the canonical
 * `dsh:<homeHash>:<id>` key (so a DSH session id always read zeros), and
 * `magicContext/context` threw out of the RPC for an id containing ':'
 * (`canonicalSessionKey` rejects the separator) instead of answering empty.
 */
describe("remote endpoints resolve the wire session id to the canonical key", () => {
  async function withDb(fn: (host: unknown, db: import("../test-utils").Database) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "mc-remote-key-"));
    const db = await createTestDb(join(dir, "c.db"));
    initializeDshAdapterTables(db);
    try {
      const host = {
        ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
        canonicalKey: (id: string) => canonicalSessionKey("h1", id),
        parseKey: (key: string) => parseDshSessionKey(key),
        overrides: () => ({}),
      };
      await fn(host, db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("diagnostics counts the rows of the canonical key for a DSH session id (and accepts the canonical key itself)", async () => {
    await withDb(async (host, db) => {
      const ins = db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness) VALUES (?, ?, 'message', ?, 1, ?, 'dsh')",
      );
      ins.run("dsh:h1:s1", "m1", "active", 1);
      ins.run("dsh:h1:s1", "m2", "active", 2);
      ins.run("dsh:h1:s1", "m3", "dropped", 3);
      const self = { host } as unknown as MagicContextRemoteService;
      const byNative = await MagicContextRemoteService.prototype.diagnostics.call(self, { sessionId: "s1" });
      expect(byNative.tags).toEqual({ active: 2, dropped: 1 });
      const byCanonical = await MagicContextRemoteService.prototype.diagnostics.call(self, { sessionId: "dsh:h1:s1" });
      expect(byCanonical.tags).toEqual({ active: 2, dropped: 1 });
      // A key of another DSH home never reads this home's rows through a re-prefix.
      const foreign = await MagicContextRemoteService.prototype.diagnostics.call(self, { sessionId: "dsh:other:s1" });
      expect(foreign.tags).toEqual({ active: 0, dropped: 0 });
    });
  });

  it("context answers (no throw) for a malformed id containing the key separator", async () => {
    await withDb(async (host) => {
      const self = { host } as unknown as MagicContextRemoteService;
      const result = await MagicContextRemoteService.prototype.context.call(self, { sessionId: "a:b" });
      expect(result).toBeDefined();
    });
  });
});
