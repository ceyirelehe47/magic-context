import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../test-utils";
import { getHarness, type HarnessId } from "@magic-context/core/shared/harness";
import { getPendingOps, queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";

/**
 * Round 10 item 3: core `HarnessId` gained `"dsh"`. Type-only — the adapter
 * already wrote `harness = 'dsh'` through a cast — so rows written before the
 * change and rows written after it are the same string, and core reads both.
 */
describe("core HarnessId 'dsh' keeps existing DSH rows compatible", () => {
  it("rows written the pre-change way (raw 'dsh') and via core today are read alike", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-harness-"));
    const db = await createTestDb(join(dir, "c.db"));
    try {
      const harness: HarnessId = getHarness();
      expect(harness).toBe("dsh");
      const key = "dsh:a1b2c3d4:sess-h";
      db.prepare("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 1, 'drop', 1, 'dsh')").run(key);
      queuePendingOp(db, key, 2, "drop", 2);
      const rows = db.prepare("SELECT tag_id, harness FROM pending_ops WHERE session_id = ? ORDER BY tag_id").all(key) as Array<{ tag_id: number; harness: string }>;
      expect(rows).toEqual([
        { tag_id: 1, harness: "dsh" },
        { tag_id: 2, harness: "dsh" },
      ]);
      expect(getPendingOps(db, key).map((op) => op.tagId).sort()).toEqual([1, 2]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
