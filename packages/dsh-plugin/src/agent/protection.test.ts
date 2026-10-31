import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { deriveDefaultProtectedTokens } from "@magic-context/core/config/schema/magic-context";
import { computeProtectionWindow } from "@magic-context/core/features/magic-context/protection-window";
import {
  getPersistedEpochFloor,
  resetEpochFloorRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { createTestDb, createTestStorageDir, type Database } from "../test-utils";
import {
  DSH_DEFAULT_USABLE_SOFT,
  dshUsableSoft,
  observedProtectionWindow,
  resolveDshProtectionFloor,
  tokenProtectionWindow,
} from "./protection";

const SESSION = "dsh:test:protection";

async function openDb(): Promise<{ db: Database; dir: string }> {
  const dir = createTestStorageDir();
  return { db: await createTestDb(join(dir, "context.db")), dir };
}

function insertTag(
  db: Database,
  tagNumber: number,
  type: "tool" | "message",
  tokenCount: number | null,
  status = "active",
): void {
  db.prepare(
    `INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, token_count, status)
     VALUES (?, ?, ?, 100, ?, 'dsh', ?, ?)`,
  ).run(SESSION, `m${tagNumber}:p0`, type, tagNumber, tokenCount, status);
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  resetEpochFloorRegistryForTest();
});

async function fixture(): Promise<Database> {
  const { db, dir } = await openDb();
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

describe("DSH token-floor protection window (core parity)", () => {
  it("usable window falls back to the shared 128k default", () => {
    expect(dshUsableSoft(undefined)).toBe(DSH_DEFAULT_USABLE_SOFT);
    expect(dshUsableSoft(0)).toBe(DSH_DEFAULT_USABLE_SOFT);
    expect(dshUsableSoft(1_000_000)).toBe(1_000_000);
  });

  it("returns a null cutoff and an empty set without persisted tool rows", async () => {
    const db = await fixture();
    insertTag(db, 1, "message", 50_000);
    const window = tokenProtectionWindow(db, SESSION, { protectedTokens: 8_000 });
    expect(window.protectedCutoff).toBeNull();
    expect(window.protectedTagNumbers.size).toBe(0);
  });

  it("protects newest tool rows until their token mass reaches the floor (not a tag count)", async () => {
    const db = await fixture();
    // 10 tool tags of 2k tokens each, interleaved with message tags.
    for (let n = 1; n <= 20; n++) insertTag(db, n, n % 2 === 0 ? "tool" : "message", 2_000);
    // Floor 8_000 → the newest four tool tags (20,18,16,14 = 8k) are protected.
    const window = tokenProtectionWindow(db, SESSION, { protectedTokens: 8_000 });
    expect([...window.protectedTagNumbers].sort((a, b) => a - b)).toEqual([14, 16, 18, 20]);
    expect(window.protectedCutoff).toBe(14);
    expect(window.floor).toBe(8_000);
    // A larger floor protects proportionally more mass, irrespective of count.
    resetEpochFloorRegistryForTest();
    const db2 = await fixture();
    for (let n = 1; n <= 20; n++) insertTag(db2, n, n % 2 === 0 ? "tool" : "message", 2_000);
    const wider = tokenProtectionWindow(db2, SESSION, { protectedTokens: 12_000 });
    expect([...wider.protectedTagNumbers].sort((a, b) => a - b)).toEqual([10, 12, 14, 16, 18, 20]);
  });

  it("matches the core pure walk exactly (same membership/cutoff)", async () => {
    const db = await fixture();
    const masses = [500, 9_000, 300, 4_000, 7_000, 100, 2_500];
    masses.forEach((mass, index) => insertTag(db, index + 1, "tool", mass));
    const window = tokenProtectionWindow(db, SESSION, { protectedTokens: 10_000 });
    const core = computeProtectionWindow(
      masses.map((mass, index) => ({ tagNumber: index + 1, type: "tool", tokenCount: mass })),
      10_000,
    );
    expect(window.protectedCutoff).toBe(core.cutoff);
    expect([...window.protectedTagNumbers]).toEqual([...core.protectedTagNumbers]);
  });

  it("keeps the structural minimum of the newest three tool tags even when one row exceeds the floor", async () => {
    const db = await fixture();
    insertTag(db, 1, "tool", 1_000);
    insertTag(db, 2, "tool", 1_000);
    insertTag(db, 3, "tool", 1_000);
    insertTag(db, 4, "tool", 90_000);
    const window = tokenProtectionWindow(db, SESSION, { protectedTokens: 4_000 });
    expect([...window.protectedTagNumbers].sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  it("derives the default floor from the DSH context window when protected_tokens is unset", async () => {
    const db = await fixture();
    insertTag(db, 1, "tool", 1_000);
    expect(resolveDshProtectionFloor(db, SESSION, { contextWindow: 1_000_000 })).toBe(
      deriveDefaultProtectedTokens(1_000_000),
    );
    expect(deriveDefaultProtectedTokens(1_000_000)).toBe(50_000);
  });

  it("follows the core epoch lifecycle: persisted only on a bust, read verbatim on defer passes", async () => {
    const db = await fixture();
    insertTag(db, 1, "tool", 1_000);
    // Defer pass before any snapshot: no persisted floor yet.
    expect(resolveDshProtectionFloor(db, SESSION, { protectedTokens: 8_000 })).toBe(8_000);
    expect(getPersistedEpochFloor(db, SESSION)).toBeNull();
    // Bust: resolve + persist.
    resolveDshProtectionFloor(db, SESSION, { protectedTokens: 8_000, cacheBusting: true });
    expect(getPersistedEpochFloor(db, SESSION)).toBe(8_000);
    // Config change mid-epoch is ignored on defer passes…
    expect(resolveDshProtectionFloor(db, SESSION, { protectedTokens: 20_000 })).toBe(8_000);
    // …and applied on the next bust.
    expect(resolveDshProtectionFloor(db, SESSION, { protectedTokens: 20_000, cacheBusting: true })).toBe(20_000);
  });

  it("a project tier may raise but never lower the trusted user floor", async () => {
    const db = await fixture();
    insertTag(db, 1, "tool", 1_000);
    const lowered = resolveDshProtectionFloor(db, SESSION, {
      tierOverrides: { user: 16_000, project: 8_000 },
      cacheBusting: true,
      log: () => {},
    });
    expect(lowered).toBe(16_000);
    const raised = resolveDshProtectionFloor(db, SESSION, {
      tierOverrides: { user: 16_000, project: 24_000 },
      cacheBusting: true,
    });
    expect(raised).toBe(24_000);
  });

  it("read-only window uses the observed epoch floor without writing state", async () => {
    const db = await fixture();
    for (let n = 1; n <= 6; n++) insertTag(db, n, "tool", 5_000);
    const before = observedProtectionWindow(db, SESSION, { protectedTokens: 10_000 });
    expect(before.floor).toBe(10_000);
    expect(getPersistedEpochFloor(db, SESSION)).toBeNull();
    resolveDshProtectionFloor(db, SESSION, { protectedTokens: 20_000, cacheBusting: true });
    const after = observedProtectionWindow(db, SESSION, { protectedTokens: 10_000 });
    expect(after.floor).toBe(20_000);
    expect([...after.protectedTagNumbers].sort((a, b) => a - b)).toEqual([3, 4, 5, 6]);
  });

  it("token_count is the ai-tokenizer estimate written by the shared tagger", () => {
    // The window's mass unit is tags.token_count, which tagTranscript fills via
    // core estimateTokens (ai-tokenizer). Sanity-check the estimator is real.
    const tokens = estimateTokens("The quick brown fox jumps over the lazy dog.");
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(20);
  });
});
