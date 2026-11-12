/**
 * agent/pressure-truncation — DSH emergency tier for protected large tool
 * results (round 11).
 *
 * Problem (real rc.5, round 10, 24k window): core's token-floor protection
 * always keeps the newest three tool tags, DSH's native `tool-result-pruner`
 * is only ever called by `compaction-basic` (disabled under Magic), and core's
 * own emergency drop yields only at ≥95 % — measured on INPUT alone. With two
 * ~15 kB reads the input sat at ~80 % and the model's `maxTokens` (4096) no
 * longer fitted: every step ended `max-tokens` after one output token, so the
 * model could not even call `ctx_reduce`. Deadlock.
 *
 * Fix: when the projected input reaches the force band of the available
 * window (`window − maxTokens` of the latest `request/header`; round 37 seg 12,
 * was `input + min(32 000, maxTokens)` of the whole window), or the separate
 * near-window trigger fires (limitation 35 option B), middle-truncate active tool results —
 * protected ones included, oldest first, the newest only if the rest is not
 * enough — down to a head + tail window that keeps the result's `§N§` prefix.
 * The original output stays in the DSH event log (the historian, `ctx_expand`
 * and re-running the tool still see it); only the model-visible surface copy
 * shrinks.
 *
 * Cache/consistency contract (core `drop_mode` semantics):
 *   - the decision is PERSISTED (`dsh_pressure_truncations`) with its exact
 *     head/tail sizes and the digest of the untruncated output, and replayed
 *     byte-identically by every later pass (and after a restart) — so the
 *     rebuilt view never re-renders the full output and the coordinator sees
 *     the surface already current (no op, no new event, no cache bust);
 *   - a tag is truncated at most once per output (rows are never re-decided
 *     while their digest matches; a stale-digest row is replaced by the next
 *     decision instead of pinning the tag);
 *   - one batch per pressure sample: a new batch needs a NEWER usage-bearing
 *     assistant message than the previous batch's basis (no trickle);
 *   - a dropped tag (ctx_reduce / historian / cleanup) is never replayed —
 *     the drop wins; a digest mismatch (the output changed under the tag)
 *     skips the row instead of truncating unrelated content.
 */
import { createHash } from "node:crypto";
import type { Database } from "@magic-context/core/shared/sqlite";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { magicAvailableWindow } from "../compat/dsh-0.1/pressure-policy";

/*
 * Round 37 seg 12 (S9 fix A): the output reserve is no longer capped here.
 * The round 12 cap (`min(32 000, maxTokens)`, mirroring core's
 * `OPENCODE_OUTPUT_CAP`) priced a different budget than the rest of MC; MC now
 * prices every pressure line against the available window
 * (`magicAvailableWindow` = window − maxTokens, one place), and the decision
 * below is `projected ≥ force % × available`. (A 64k maxTokens on a 100k
 * window: available 36k, force at 30.6k input — the native backstop there is
 * min(90k, 36k) = 36k, so MC still acts first.)
 */

/** Inputs for one pass's decision. Absent = replay only. */
export interface PressureTruncationInput {
  /** Projected request input tokens (token-meter projection or last usage). */
  readonly projectedTokens: number;
  readonly contextWindow: number;
  /** Output room the request reserves (`maxTokens` of the latest request header). */
  readonly outputReserveTokens: number;
  readonly executePercentage: number;
  readonly forcePercentage: number;
  /** Seq of the latest usage-bearing assistant message (batch latch). */
  readonly usageSeq: number;
  /**
   * Limitation 35 option B: the separate near-window trigger fired
   * (agent/near-window). Pressure is treated as at least the force band, and
   * the batch also frees at least `excessTokens` pi-estimated tokens.
   */
  readonly nearWindow?: { readonly excessTokens: number; readonly reason?: string };
}

/** A tool-result part the stage can read and rewrite (RecordingPart shape). */
export interface TruncatablePart {
  getText(): string | undefined;
  setToolOutput(text: string): boolean;
}

export interface TruncationCandidate {
  readonly tagNumber: number;
  readonly part: TruncatablePart;
}

export interface PressureTruncationResult {
  readonly decided: readonly number[];
  readonly replayed: readonly number[];
  readonly skipped: readonly number[];
}

export const PRESSURE_TRUNCATION_MARKER = "truncated by Magic Context";

const initialized = new WeakSet<object>();

export function initPressureTruncationTable(db: Database): void {
  if (initialized.has(db as object)) return;
  initialized.add(db as object);
  db.exec(`
    CREATE TABLE IF NOT EXISTS dsh_pressure_truncations (
      session_id      TEXT NOT NULL,
      tag_number      INTEGER NOT NULL,
      head_chars      INTEGER NOT NULL,
      tail_chars      INTEGER NOT NULL,
      original_chars  INTEGER NOT NULL,
      original_sha    TEXT NOT NULL,
      basis_usage_seq INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      PRIMARY KEY (session_id, tag_number)
    );
  `);
}

interface Row {
  tag_number: number;
  head_chars: number;
  tail_chars: number;
  original_sha: string;
  basis_usage_seq: number;
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Kept characters for a window: ~8 % of the window in chars, 1.2k..12k. */
export function keepBudgetChars(contextWindow: number): { head: number; tail: number } {
  const keep = Math.max(1200, Math.min(12_000, Math.round(contextWindow * 0.08)));
  const head = Math.round(keep * 0.75);
  return { head, tail: keep - head };
}

/**
 * Round 23b (P0-1): per-output keep window. The budget is CHARACTERS sized for
 * ordinary text (~4 chars/token); dense output (Chinese ≈ 1.06 chars/token,
 * digit listings ≈ 2) would keep 2–4× the intended tokens and — worse — the
 * eligibility floor (3× the kept size) is a CHAR floor, so three 5 000-char
 * Chinese reads (≈ 4.7k tokens each, enough to overflow a 24k window
 * together) were never eligible. Text whose real token count exceeds its
 * chars/4 price by more than 25 % gets the same TOKEN budget instead: head and
 * tail scaled by (chars/4) / tokens, eligible at 3× the kept tokens. Ordinary
 * text keeps the round 11 rule unchanged.
 */
export function keepFor(
  text: string,
  budget: { head: number; tail: number },
): { head: number; tail: number; eligible: boolean } {
  const keep = budget.head + budget.tail;
  if (text.length < keep) return { ...budget, eligible: false };
  const exact = estimateTokens(text);
  const priced = text.length / 4;
  if (exact <= priced * 1.25) return { ...budget, eligible: text.length >= keep * 3 };
  const factor = priced / exact;
  const head = Math.max(1, Math.round(budget.head * factor));
  const tail = Math.max(1, Math.round(budget.tail * factor));
  return { head, tail, eligible: exact >= (keep / 4) * 3 };
}

/** Never split a UTF-16 surrogate pair. */
function safeCut(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

/**
 * Pure, deterministic head + marker + tail rendering. Cuts snap to line
 * boundaries when one is near (keeps whole numbered lines of a `read`).
 */
export function truncateOutput(original: string, headChars: number, tailChars: number, tagNumber: number): string {
  if (original.length <= headChars + tailChars) return original;
  let headEnd = safeCut(original, headChars);
  const nl = original.lastIndexOf("\n", headEnd);
  if (nl > headChars * 0.5) headEnd = nl; // drop the partial line
  let tailStart = safeCut(original, original.length - tailChars);
  const nl2 = original.indexOf("\n", tailStart);
  if (nl2 !== -1 && nl2 < original.length - tailChars * 0.5) tailStart = nl2 + 1;
  if (tailStart <= headEnd) return original;
  const omitted = tailStart - headEnd;
  const firstLine = lineOf(original, headEnd) + (original.charCodeAt(headEnd) === 10 ? 1 : 0);
  const lastLine = lineOf(original, tailStart) - 1;
  // A numbered listing (`N: …`, the DSH read tool) reports ITS numbers, so the
  // model can re-read exactly the omitted range.
  const omittedText = original.slice(headEnd, tailStart).replace(/^\n/, "");
  const numbered = /^(\d+): /.exec(omittedText);
  const lastNumbered = /(?:^|\n)(\d+): [^\n]*\n?$/.exec(omittedText);
  const lines =
    numbered !== null && lastNumbered !== null && Number(lastNumbered[1]) >= Number(numbered[1])
      ? ` (numbered lines ${numbered[1]}-${lastNumbered[1]})`
      : lastLine >= firstLine
        ? ` (output lines ${firstLine}-${lastLine})`
        : "";
  return (
    original.slice(0, headEnd) +
    `\n[… \u00a7${tagNumber}\u00a7 ${PRESSURE_TRUNCATION_MARKER} under context pressure: ${omitted} of ${original.length} characters omitted${lines}. ` +
    `The full output is kept in the session log; re-run the tool on a narrower range if you need the omitted part. …]\n` +
    original.slice(tailStart)
  );
}

function readRows(db: Database, sessionId: string): Row[] {
  return db
    .prepare(
      "SELECT tag_number, head_chars, tail_chars, original_sha, basis_usage_seq FROM dsh_pressure_truncations WHERE session_id = ? ORDER BY tag_number",
    )
    .all(sessionId) as Row[];
}

/**
 * Replay persisted truncations, then (when `input` crosses the force band and
 * the latch allows) decide one new batch. `candidates` are the ACTIVE tool
 * tags' result parts on this pass, in any order; dropped tags must not be
 * passed (the drop wins).
 */
export function applyPressureTruncation(
  db: Database,
  sessionId: string,
  candidates: readonly TruncationCandidate[],
  input: PressureTruncationInput | undefined,
  log?: (message: string) => void,
): PressureTruncationResult {
  initPressureTruncationTable(db);
  const rows = readRows(db, sessionId);
  const byTag = new Map(candidates.map((c) => [c.tagNumber, c]));
  const replayed: number[] = [];
  const skipped: number[] = [];
  const truncated = new Set<number>();
  for (const row of rows) {
    const candidate = byTag.get(row.tag_number);
    if (candidate === undefined) {
      truncated.add(row.tag_number); // dropped / off the surface
      continue;
    }
    const original = candidate.part.getText() ?? "";
    if (sha(original) !== row.original_sha) {
      // The output under the tag changed: never truncate unrelated content
      // with the old decision, but do not pin the tag either — it is
      // eligible for a NEW decision (latch permitting), which replaces the row.
      skipped.push(row.tag_number);
      continue;
    }
    truncated.add(row.tag_number);
    candidate.part.setToolOutput(truncateOutput(original, row.head_chars, row.tail_chars, row.tag_number));
    replayed.push(row.tag_number);
  }

  const decided: number[] = [];
  if (input === undefined) return { decided, replayed, skipped };
  const window = input.contextWindow;
  if (!(window > 0) || !(input.projectedTokens > 0)) return { decided, replayed, skipped };
  const available = magicAvailableWindow(window, input.outputReserveTokens);
  const nearWindow = input.nearWindow;
  const forceTokens = (input.forcePercentage / 100) * available;
  if (nearWindow === undefined && input.projectedTokens * 100 < input.forcePercentage * available) return { decided, replayed, skipped };
  const effective = nearWindow === undefined ? input.projectedTokens : Math.max(input.projectedTokens, forceTokens);
  const latestBasis = rows.reduce((max, row) => Math.max(max, row.basis_usage_seq), -Infinity);
  if (rows.length > 0 && input.usageSeq <= latestBasis) return { decided, replayed, skipped };

  const budget = keepBudgetChars(window);
  const pool = candidates
    .filter((c) => !truncated.has(c.tagNumber))
    .map((c) => {
      const text = c.part.getText() ?? "";
      return { c, text, ...keepFor(text, budget) };
    })
    .filter((x) => x.eligible)
    .sort((a, b) => a.c.tagNumber - b.c.tagNumber);
  if (pool.length === 0) return { decided, replayed, skipped };
  const target = (input.executePercentage / 100) * available;
  const force = forceTokens;
  let remaining = effective;
  // Near-window: pi-estimated tokens (chars / 3.5) the batch must also free.
  const piNeed = nearWindow === undefined ? 0 : Math.max(0, nearWindow.excessTokens);
  let piFreed = 0;
  const saving = (x: { text: string; head: number; tail: number; c: TruncationCandidate }) =>
    Math.max(0, estimateTokens(x.text) - estimateTokens(truncateOutput(x.text, x.head, x.tail, x.c.tagNumber)));
  const piSaving = (x: { text: string; head: number; tail: number; c: TruncationCandidate }) =>
    Math.max(0, Math.ceil((x.text.length - truncateOutput(x.text, x.head, x.tail, x.c.tagNumber).length) / 3.5));
  const chosen: Array<(typeof pool)[number]> = [];
  // Oldest first, holding back the newest result (the one the model is most
  // likely answering about) unless the others cannot get under the force band.
  const newest = pool[pool.length - 1]!;
  for (const x of pool.slice(0, -1)) {
    if (remaining <= target && piFreed >= piNeed) break;
    chosen.push(x);
    remaining -= saving(x);
    piFreed += piSaving(x);
  }
  if (remaining >= force || piFreed < piNeed) {
    chosen.push(newest);
    remaining -= saving(newest);
    piFreed += piSaving(newest);
  }
  if (chosen.length === 0) return { decided, replayed, skipped };
  const insert = db.prepare(
    `INSERT OR REPLACE INTO dsh_pressure_truncations
       (session_id, tag_number, head_chars, tail_chars, original_chars, original_sha, basis_usage_seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  db.transaction(() => {
    for (const x of chosen) {
      insert.run(sessionId, x.c.tagNumber, x.head, x.tail, x.text.length, sha(x.text), input.usageSeq, now);
    }
  })();
  for (const x of chosen) {
    x.c.part.setToolOutput(truncateOutput(x.text, x.head, x.tail, x.c.tagNumber));
    decided.push(x.c.tagNumber);
  }
  log?.(
    `[magic-context] pressure truncation: ${decided.length} tool result(s) [${decided.join(",")}] ` +
      `(input ${Math.round(input.projectedTokens)} of usable ${Math.round(available)} (window ${window} − reserve ${Math.max(0, input.outputReserveTokens)}) ` +
      (nearWindow !== undefined
        ? `near-window ${nearWindow.reason ?? "trigger"} (pi excess ${Math.round(piNeed)}, freed ≈${piFreed}) → force ${input.forcePercentage}%`
        : `≥ force ${input.forcePercentage}%`) +
      `; est. after ≈${Math.round(remaining)})`,
  );
  return { decided, replayed, skipped };
}

/** Count of persisted truncations (details popover / diagnostics). */
export function countPressureTruncations(db: Pick<Database, "prepare"> | { prepare(sql: string): { get(...params: unknown[]): unknown } }, sessionId: string): number {
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM dsh_pressure_truncations WHERE session_id = ?").get(sessionId) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * S6 cleanup (round 15): delete persisted truncations that can never be
 * replayed again, without changing what any later pass renders.
 *
 *   - a row whose tag is `dropped` / `compacted` in core `tags` — such a tag is
 *     never a candidate again (no core path turns it back to active; the drop
 *     replaces the content), so its row only mattered for the batch latch;
 *   - every row of a session that has no `tags` rows at all (session cleared
 *     or deleted; a re-tagged session gets new numbers and the digest check
 *     would skip the old rows anyway).
 *
 * Kept on purpose: rows of active tags (the byte-identical replay), rows whose
 * tag row is missing while the session still has tags (ambiguous), and — per
 * session — one row carrying the max `basis_usage_seq` (the one-batch-per-
 * pressure-sample latch reads the max over the session's rows; deleting it
 * would let a stale sample decide a second batch).
 * Idempotent; one IMMEDIATE transaction, safe with concurrent processes.
 */
export function prunePressureTruncations(db: Database): { deleted: number } {
  initPressureTruncationTable(db);
  let deleted = 0;
  db.transaction(() => {
    const orphanSessions = db
      .prepare(
        `DELETE FROM dsh_pressure_truncations
          WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.session_id = dsh_pressure_truncations.session_id)`,
      )
      .run() as { changes?: number };
    deleted += orphanSessions.changes ?? 0;
    const dead = db
      .prepare(
        `SELECT p.session_id, p.tag_number, p.basis_usage_seq
           FROM dsh_pressure_truncations p
           JOIN tags t ON t.session_id = p.session_id AND t.tag_number = p.tag_number
          WHERE t.status IN ('dropped', 'compacted')`,
      )
      .all() as Array<{ session_id: string; tag_number: number; basis_usage_seq: number }>;
    if (dead.length === 0) return;
    const deadKeys = new Set(dead.map((r) => `${r.session_id}\0${r.tag_number}`));
    const all = db
      .prepare(
        `SELECT session_id, tag_number, basis_usage_seq FROM dsh_pressure_truncations
          WHERE session_id IN (SELECT DISTINCT p.session_id FROM dsh_pressure_truncations p
                                 JOIN tags t ON t.session_id = p.session_id AND t.tag_number = p.tag_number
                                WHERE t.status IN ('dropped', 'compacted'))`,
      )
      .all() as Array<{ session_id: string; tag_number: number; basis_usage_seq: number }>;
    const bySession = new Map<string, typeof all>();
    for (const r of all) {
      const list = bySession.get(r.session_id) ?? [];
      list.push(r);
      bySession.set(r.session_id, list);
    }
    const del = db.prepare("DELETE FROM dsh_pressure_truncations WHERE session_id = ? AND tag_number = ?");
    for (const [sessionId, rows] of bySession) {
      const max = rows.reduce((m, r) => Math.max(m, r.basis_usage_seq), -Infinity);
      const latchSurvives = rows.some(
        (r) => r.basis_usage_seq === max && !deadKeys.has(`${sessionId}\0${r.tag_number}`),
      );
      // Keep the highest-numbered dead row at the latch when no live row holds it.
      const latchKeeper = latchSurvives
        ? undefined
        : rows
            .filter((r) => r.basis_usage_seq === max)
            .reduce((best, r) => (best === undefined || r.tag_number > best.tag_number ? r : best), undefined as
              | (typeof rows)[number]
              | undefined);
      for (const r of rows) {
        if (!deadKeys.has(`${sessionId}\0${r.tag_number}`)) continue;
        if (latchKeeper !== undefined && r.tag_number === latchKeeper.tag_number) continue;
        const res = del.run(sessionId, r.tag_number) as { changes?: number };
        deleted += res.changes ?? 0;
      }
    }
  }).immediate();
  return { deleted };
}
