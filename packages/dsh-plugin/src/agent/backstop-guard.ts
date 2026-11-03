/**
 * Round 24 (R10) — the MC main pressure backstop must not start a native
 * compaction whose Magic summary cannot be smaller than the region it shadows.
 * (RED stub: API only, not wired yet.)
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Database } from "@magic-context/core/shared/sqlite";

export interface BackstopPreview {
  readonly standInSeqs: readonly number[];
  readonly covered: boolean;
  readonly renderText: string;
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
}

export interface BackstopSkipRecord {
  readonly at: number;
  readonly count: number;
  readonly pct?: number;
  readonly thresholdPct?: number | string;
  readonly regionStartSeq: number;
  readonly regionTokens: number;
  readonly rawTokens: number;
  readonly summaryTokensAtLeast: number;
  readonly reason: string;
}

export interface MagicBackstopGuard {
  preview(agent: Agent, startSeq: number, endSeq: number): BackstopPreview | undefined;
  recordSkip(agent: Agent, record: Omit<BackstopSkipRecord, "at" | "count">): BackstopSkipRecord | undefined;
  clearSkip(agent: Agent): void;
}

export function createBackstopGuard(_deps: {
  db: () => Database | undefined;
  canonicalKey: (dshSessionId: string) => string;
}): MagicBackstopGuard {
  return { preview: () => undefined, recordSkip: () => undefined, clearSkip: () => {} };
}

export function readBackstopSkip(_db: Database, _sessionKey: string): BackstopSkipRecord | null {
  return null;
}

export function backstopSkipStatusBlock(_record: BackstopSkipRecord | null): string {
  return "";
}
