import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../test-utils";
import {
  applyPressureTruncation,
  initPressureTruncationTable,
  prunePressureTruncations,
  type TruncationCandidate,
} from "./pressure-truncation";

/**
 * Round 15 / S6: `dsh_pressure_truncations` used to grow forever. The prune
 * removes only rows that can never be replayed again — tags whose core status
 * is `dropped` / `compacted` (no path in core turns them back to active) and
 * sessions whose tags are gone entirely (cleared / deleted) — while keeping,
 * per surviving session, the row that carries the batch latch (max
 * basis_usage_seq), so the one-batch-per-pressure-sample rule is unchanged.
 * Rows of active tags are never touched, so replay stays byte-identical.
 */
describe("prunePressureTruncations (S6)", () => {
  it("drops unreplayable rows, keeps active ones and the latch row, and leaves the replay bytes unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-prune-"));
    const db = await createTestDb(join(dir, "context.db"));
    try {
      initPressureTruncationTable(db);
      const tag = db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness) VALUES (?, ?, 'tool', ?, 1, ?, 'dsh')",
      );
      const row = db.prepare(
        `INSERT INTO dsh_pressure_truncations
           (session_id, tag_number, head_chars, tail_chars, original_chars, original_sha, basis_usage_seq, created_at)
         VALUES (?, ?, 10, 10, 100, ?, ?, 1)`,
      );
      // Session A: tag 1 dropped (basis 5), tag 2 compacted (basis 9 = latch), tag 3 active (basis 9).
      tag.run("A", "m1", "dropped", 1);
      tag.run("A", "m2", "compacted", 2);
      tag.run("A", "m3", "active", 3);
      row.run("A", 1, "s1", 5);
      row.run("A", 2, "s2", 9);
      row.run("A", 3, "s3", 9);
      // Session B: tag 4 dropped and it alone holds the latch (basis 12).
      tag.run("B", "m4", "dropped", 4);
      tag.run("B", "m5", "dropped", 5);
      row.run("B", 4, "s4", 12);
      row.run("B", 5, "s5", 7);
      // Session C: no tags at all any more (cleared / deleted session).
      row.run("C", 1, "s6", 3);
      // Session D: a row whose tag row is missing while the session still has tags: keep (ambiguous).
      tag.run("D", "m7", "active", 1);
      row.run("D", 2, "s7", 4);

      const result = prunePressureTruncations(db);
      expect(result.deleted).toBe(4); // A:1, B:5, C:1 … and A keeps 2 or 3 as latch → see below
      const left = (
        db.prepare("SELECT session_id, tag_number FROM dsh_pressure_truncations ORDER BY session_id, tag_number").all() as Array<{
          session_id: string;
          tag_number: number;
        }>
      ).map((r) => `${r.session_id}:${r.tag_number}`);
      // A: tag 3 is active (kept) and already carries the latch (basis 9) → tag 2 goes.
      // B: tag 4 keeps the latch although dropped. C: gone. D: kept.
      expect(left).toEqual(["A:3", "B:4", "D:2"]);
      // Idempotent.
      expect(prunePressureTruncations(db).deleted).toBe(0);

      // The batch latch of B is unchanged: a pass with the SAME usage sample
      // over the force band must not decide a new batch.
      tag.run("B", "m6", "active", 6);
      const big = "y".repeat(60_000);
      let text = big;
      const candidate: TruncationCandidate = {
        tagNumber: 6,
        part: { getText: () => text, setToolOutput: (t) => ((text = t), true) },
      };
      const decision = applyPressureTruncation(db, "B", [candidate], {
        projectedTokens: 23_000,
        contextWindow: 24_000,
        outputReserveTokens: 4096,
        executePercentage: 65,
        forcePercentage: 85,
        usageSeq: 12,
      });
      expect(decision.decided).toEqual([]);
      expect(text).toBe(big);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
