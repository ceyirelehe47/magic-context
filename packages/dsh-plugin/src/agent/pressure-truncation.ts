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
 * Fix: when `projected input + output reserve` (the latest `request/header`
 * `maxTokens`) reaches the force band, middle-truncate active tool results —
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

/**
 * Cap on the output reserve, mirroring core's window geometry
 * (`OPENCODE_OUTPUT_CAP` in shared/window-geometry: usable = window −
 * min(maxTokens, 32 000)). An uncapped 64k `maxTokens` would otherwise put a
 * 100k window over the force band at ~30 % input.
 */
export const PRESSURE_OUTPUT_RESERVE_CAP = 32_000;

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
  const effective =
    input.projectedTokens + Math.min(PRESSURE_OUTPUT_RESERVE_CAP, Math.max(0, input.outputReserveTokens));
  if (effective * 100 < input.forcePercentage * window) return { decided, replayed, skipped };
  const latestBasis = rows.reduce((max, row) => Math.max(max, row.basis_usage_seq), -Infinity);
  if (rows.length > 0 && input.usageSeq <= latestBasis) return { decided, replayed, skipped };

  const { head, tail } = keepBudgetChars(window);
  const minChars = (head + tail) * 3;
  const pool = candidates
    .filter((c) => !truncated.has(c.tagNumber))
    .map((c) => ({ c, text: c.part.getText() ?? "" }))
    .filter((x) => x.text.length >= minChars)
    .sort((a, b) => a.c.tagNumber - b.c.tagNumber);
  if (pool.length === 0) return { decided, replayed, skipped };
  const target = (input.executePercentage / 100) * window;
  const force = (input.forcePercentage / 100) * window;
  let remaining = effective;
  const saving = (text: string, tagNumber: number) =>
    Math.max(0, estimateTokens(text) - estimateTokens(truncateOutput(text, head, tail, tagNumber)));
  const chosen: Array<{ c: TruncationCandidate; text: string }> = [];
  // Oldest first, holding back the newest result (the one the model is most
  // likely answering about) unless the others cannot get under the force band.
  const newest = pool[pool.length - 1]!;
  for (const x of pool.slice(0, -1)) {
    if (remaining <= target) break;
    chosen.push(x);
    remaining -= saving(x.text, x.c.tagNumber);
  }
  if (remaining >= force) {
    chosen.push(newest);
    remaining -= saving(newest.text, newest.c.tagNumber);
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
      insert.run(sessionId, x.c.tagNumber, head, tail, x.text.length, sha(x.text), input.usageSeq, now);
    }
  })();
  for (const x of chosen) {
    x.c.part.setToolOutput(truncateOutput(x.text, head, tail, x.c.tagNumber));
    decided.push(x.c.tagNumber);
  }
  log?.(
    `[magic-context] pressure truncation: ${decided.length} tool result(s) [${decided.join(",")}] ` +
      `(input ${Math.round(input.projectedTokens)} + reserve ${Math.min(PRESSURE_OUTPUT_RESERVE_CAP, input.outputReserveTokens)} of ${window} ≥ force ${input.forcePercentage}%; est. after ≈${Math.round(remaining)})`,
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
