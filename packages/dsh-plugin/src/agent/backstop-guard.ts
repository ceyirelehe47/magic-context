/**
 * Round 24 (R10) — the MC main pressure backstop must not start a native
 * compaction whose Magic summary cannot be smaller than the region it shadows.
 *
 * Real rc.5 (e2e 41642823892 / 41640093586, scenario L): after a committed
 * backstop compaction the session was still above the backstop (the retained
 * tail alone is above it), so the next check selected the only node before the
 * retained tail — the previous checkpoint's op copy (`§9§ …`, 475 / 239 route
 * tokens). Magic renders the compartments that checkpoint's history range
 * overlaps (plus, when the checkpoint also stood for an uncovered tail, a
 * mini-historian compartment for it): 819 / 423 tokens. compaction-basic
 * rejected the summary ("summary is not smaller than the shadowed content")
 * AFTER writing compaction/start, leaving a failed compaction/end.
 *
 * The compaction engine (compat/dsh-0.1/compaction.ts) asks this guard, before
 * compaction-basic writes compaction/start, what the region would render to:
 * which surface nodes are checkpoint stand-ins, whether published compartments
 * already cover it, and the compartment text Magic would render for the covered
 * part (a LOWER bound of the summary: framing and any mini-historian output only
 * add). It skips when the summary provably cannot be smaller. The skip is per
 * pressure check, never a latch: every later check re-evaluates (new history
 * beyond the retained tail makes the region compactable again), and the
 * context-overflow trigger is not guarded at all. Each skip is recorded
 * durably (dsh_adapter_meta) for /ctx-status, so a session sitting above the
 * backstop without a usable region is never silent.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  buildCompartmentBlock,
  getCompartments,
  getLastCompartmentEndMessage,
  getSessionFacts,
} from "@magic-context/core/features/magic-context/compartment-storage";
import type { Database } from "@magic-context/core/shared/sqlite";
import { sessionEvents } from "../compat/dsh-0.1/session";
import { surfaceEventMessageId, transcriptRawMessageProvider } from "./historian-wiring";

export interface BackstopPreview {
  /** Region surface seqs that are native checkpoints (or their Magic op copies). */
  readonly standInSeqs: readonly number[];
  /** Published compartments already reach the region's last history ordinal. */
  readonly covered: boolean;
  /** Compartment block Magic renders today for the region (lower bound of the summary). */
  readonly renderText: string;
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
}

export interface BackstopSkipRecord {
  readonly at: number;
  /** Consecutive skips recorded since the last committed backstop compaction. */
  readonly count: number;
  readonly pct?: number;
  readonly thresholdPct?: number | string;
  readonly regionStartSeq: number;
  readonly regionTokens: number;
  /** Route tokens of region nodes that are NOT checkpoint stand-ins (new history). */
  readonly rawTokens: number;
  /** Lower bound of the Magic summary's tokens (compartment text, unframed). */
  readonly summaryTokensAtLeast: number;
  readonly reason: string;
}

export interface MagicBackstopGuard {
  preview(agent: Agent, startSeq: number, endSeq: number): BackstopPreview | undefined;
  recordSkip(agent: Agent, record: Omit<BackstopSkipRecord, "at" | "count">): BackstopSkipRecord | undefined;
  clearSkip(agent: Agent): void;
}

const META_PREFIX = "backstop-skip:";

function metaKey(sessionKey: string): string {
  return `${META_PREFIX}${sessionKey}`;
}

export function readBackstopSkip(db: Database, sessionKey: string): BackstopSkipRecord | null {
  try {
    const row = db.prepare("SELECT value FROM dsh_adapter_meta WHERE key = ?").get(metaKey(sessionKey)) as
      | { value: string }
      | null
      | undefined;
    if (row === null || row === undefined) return null;
    return JSON.parse(row.value) as BackstopSkipRecord;
  } catch {
    return null;
  }
}

function surfaceMessage(event: unknown): { id: string; role?: string } | undefined {
  const id = surfaceEventMessageId(event);
  if (id === undefined) return undefined;
  const data = (event as { data?: { role?: unknown; message?: { role?: unknown } } }).data;
  const role = typeof data?.role === "string" ? data.role : typeof data?.message?.role === "string" ? data.message.role : undefined;
  return { id, ...(role !== undefined ? { role } : {}) };
}

export function createBackstopGuard(deps: {
  db: () => Database | undefined;
  canonicalKey: (dshSessionId: string) => string;
  now?: () => number;
}): MagicBackstopGuard {
  const now = deps.now ?? Date.now;
  return {
    preview(agent, startSeq, endSeq) {
      const db = deps.db();
      if (db === undefined || typeof agent.id !== "string") return undefined;
      const sessionKey = deps.canonicalKey(agent.id);
      const nodes = agent.session.surface.nodes as readonly number[];
      const from = nodes.indexOf(startSeq);
      const to = nodes.indexOf(endSeq);
      if (from === -1 || to === -1 || from > to) return undefined;
      const events = sessionEvents(agent.session);
      const bySeq = new Map(events.map((event) => [Number((event as { seq?: unknown }).seq), event]));
      const provider = transcriptRawMessageProvider(agent, sessionKey);
      const standInSeqs: number[] = [];
      let first: number | null = null;
      let last: number | null = null;
      for (const seq of nodes.slice(from, to + 1)) {
        const message = surfaceMessage(bySeq.get(seq));
        if (message === undefined || message.role === "system") continue;
        if (provider.isCheckpointStandIn(message.id)) standInSeqs.push(seq);
        // Same range resolution as the summarize hook (historian.ts).
        const range = provider.readMessageOrdinalRangeById(message.id);
        if (range === null) continue;
        if (first === null || range.first < first) first = range.first;
        if (last === null || range.last > last) last = range.last;
      }
      if (first === null || last === null) return undefined;
      const lo = first;
      const hi = last;
      const covered = getLastCompartmentEndMessage(db, sessionKey) >= hi;
      const compartments = getCompartments(db, sessionKey).filter((c) => c.endMessage >= lo && c.startMessage <= hi);
      const renderText = buildCompartmentBlock(compartments, getSessionFacts(db, sessionKey));
      return { standInSeqs, covered, renderText, firstOrdinal: lo, lastOrdinal: hi };
    },
    recordSkip(agent, record) {
      const db = deps.db();
      if (db === undefined || typeof agent.id !== "string") return undefined;
      const sessionKey = deps.canonicalKey(agent.id);
      const previous = readBackstopSkip(db, sessionKey);
      const full: BackstopSkipRecord = { ...record, at: now(), count: (previous?.count ?? 0) + 1 };
      try {
        db.prepare("INSERT INTO dsh_adapter_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
          metaKey(sessionKey),
          JSON.stringify(full),
        );
      } catch {
        return full; // diagnostics only: the log line still carries it
      }
      return full;
    },
    clearSkip(agent) {
      const db = deps.db();
      if (db === undefined || typeof agent.id !== "string") return;
      try {
        db.prepare("DELETE FROM dsh_adapter_meta WHERE key = ?").run(metaKey(deps.canonicalKey(agent.id)));
      } catch {
        // diagnostics only
      }
    },
  };
}

/** /ctx-status block ('' when the backstop has not been skipped since its last compaction). */
export function backstopSkipStatusBlock(record: BackstopSkipRecord | null): string {
  if (record === null) return "";
  const when = new Date(record.at).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return (
    `\n\n### Native pressure backstop: skipped (${record.count}× since its last compaction)\n` +
    `- last: ${when} at pressure ${record.pct ?? "?"} % ≥ backstop ${record.thresholdPct ?? "?"} %\n` +
    `- why: ${record.reason} (region ${record.regionTokens} tokens, ${record.rawTokens} of them new history; Magic summary ≥ ${record.summaryTokensAtLeast} tokens)\n` +
    "- the session stays above the backstop until Magic's historian / drops / pressure truncation reduce it or new history makes a region compactable; every pressure check retries, and a provider context overflow still compacts"
  );
}
