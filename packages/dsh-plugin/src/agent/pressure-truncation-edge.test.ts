import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
  applyPressureTruncation,
  PRESSURE_TRUNCATION_MARKER,
  type PressureTruncationInput,
  type TruncationCandidate,
} from "./pressure-truncation";

/** Round 12 review of the round 11 pressure-truncation stage (edge cases). */

function body(name: string, lines = 600): string {
  const out: string[] = [];
  for (let i = 1; i <= lines; i += 1) out.push(`${i}: ${name} line ${i} ${"y".repeat(40)}`);
  return out.join("\n");
}

function part(text: string) {
  let current = text;
  return {
    get text() {
      return current;
    },
    getText: () => current,
    setToolOutput: (next: string) => {
      const changed = next !== current;
      current = next;
      return changed;
    },
  };
}

async function withDb(fn: (db: Database) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-trunc-edge-"));
  const db = await createTestDb(join(dir, "c.db"));
  try {
    await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const input = (over: Partial<PressureTruncationInput> = {}): PressureTruncationInput => ({
  projectedTokens: 20_000,
  contextWindow: 24_000,
  outputReserveTokens: 4096,
  executePercentage: 65,
  forcePercentage: 85,
  usageSeq: 10,
  ...over,
});

describe("pressure truncation edges (round 12)", () => {
  it("output reserve is capped like core's window geometry (OPENCODE_OUTPUT_CAP 32k): a 64k maxTokens does not truncate at 30 % input", async () => {
    await withDb((db) => {
      const a = part(body("a"));
      const b = part(body("b"));
      const c: TruncationCandidate[] = [
        { tagNumber: 1, part: a },
        { tagNumber: 2, part: b },
      ];
      // window 100k, force 85k; input 30k + 64k reserve = 94k (≥ force) but
      // input 30k + capped 32k = 62k (< force).
      const r = applyPressureTruncation(db, "S", c, input({ contextWindow: 100_000, projectedTokens: 30_000, outputReserveTokens: 64_000 }));
      expect(r.decided).toEqual([]);
      expect(a.text).not.toContain(PRESSURE_TRUNCATION_MARKER);
      // a real squeeze with the capped reserve still truncates
      const r2 = applyPressureTruncation(db, "S", c, input({ contextWindow: 100_000, projectedTokens: 60_000, outputReserveTokens: 64_000 }));
      expect(r2.decided.length).toBeGreaterThan(0);
    });
  });

  it("sessions are isolated: one session's rows and latch never affect another", async () => {
    await withDb((db) => {
      const a1 = part(body("a"));
      const a2 = part(body("b"));
      applyPressureTruncation(db, "A", [{ tagNumber: 1, part: a1 }, { tagNumber: 2, part: a2 }], input({ usageSeq: 50 }));
      expect(a1.text).toContain(PRESSURE_TRUNCATION_MARKER);
      // Session B: same tag numbers, lower usage seq, different text.
      const b1 = part(body("other-1"));
      const b2 = part(body("other-2"));
      const rb = applyPressureTruncation(db, "B", [{ tagNumber: 1, part: b1 }, { tagNumber: 2, part: b2 }], input({ usageSeq: 3 }));
      expect(rb.skipped).toEqual([]);
      expect(rb.decided).toContain(1);
      // Replay in B with no input: only B's rows, byte-identical.
      const again = part(body("other-1"));
      const replay = applyPressureTruncation(db, "B", [{ tagNumber: 1, part: again }], undefined);
      expect(replay.replayed).toEqual([1]);
      expect(again.text).toBe(b1.text);
    });
  });

  it("a row whose digest no longer matches does not pin its tag forever: the next pressure sample may truncate the new output", async () => {
    await withDb((db) => {
      const first = part(body("v1"));
      const keep = part(body("newest"));
      applyPressureTruncation(db, "S", [{ tagNumber: 4, part: first }, { tagNumber: 9, part: keep }], input({ usageSeq: 10 }));
      expect(first.text).toContain(PRESSURE_TRUNCATION_MARKER);
      // The output under tag 4 changed (e.g. a re-render): replay skips it ...
      const changed = part(body("v2"));
      const fresh = part(body("newest"));
      const replay = applyPressureTruncation(db, "S", [{ tagNumber: 4, part: changed }, { tagNumber: 9, part: fresh }], undefined);
      expect(replay.skipped).toEqual([4]);
      expect(changed.text).not.toContain(PRESSURE_TRUNCATION_MARKER);
      // ... but a NEWER pressure sample still over the band may decide it again.
      const later = applyPressureTruncation(db, "S", [{ tagNumber: 4, part: changed }, { tagNumber: 9, part: fresh }], input({ usageSeq: 20 }));
      expect(later.decided).toContain(4);
      expect(changed.text).toContain(PRESSURE_TRUNCATION_MARKER);
      // and from then on the new digest replays byte-identically
      const v2 = part(body("v2"));
      const replay2 = applyPressureTruncation(db, "S", [{ tagNumber: 4, part: v2 }], undefined);
      expect(replay2.replayed).toEqual([4]);
      expect(v2.text).toBe(changed.text);
    });
  });
});
