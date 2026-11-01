/**
 * agent/legacy-tag-cleanup — one-time fold of the pre-fix bare-id `§N§` tags.
 *
 * Before 10181d774 the first-call payload preview allocated a `message` tag
 * under the BARE DSH source message id (a UUID, no `:` segment) in addition to
 * the tag core `tagTranscript` assigns under `${viewMessageId}:p${n}`. Those
 * bare rows are never bound to a transcript target again, but they still:
 *   - make `ctx_reduce` accept their numbers (the drop then hits nothing),
 *   - count as `active` tags in the context details / remote counts,
 *   - keep a second number alive for a message the model may still quote.
 *
 * This fold runs once per session per process (from the context plane, after
 * the view is derived) and removes them:
 *   - a still-pending op on a bare tag is retargeted onto the core tag of the
 *     same text (the view mapping gives the exact core key, including the
 *     folded tool-call assistant text; outside the view `${id}:p0` is used);
 *     when no core tag exists the op is discarded (its target never existed);
 *   - the bare row and its `source_contents` / `pending_ops` rows are deleted.
 * Dropped status is NOT propagated: a bare tag never had a target, so its
 * status says nothing about the real message. The tag counter is monotonic
 * (session_meta MAX upsert), so deleted numbers are never re-issued.
 *
 * Core never writes a `message` tag whose id lacks a `:` segment for DSH
 * (text `:pN`, file `:fileN`, summary marker `:p0`, inert-whitespace prefix
 * contains `:`), so `instr(message_id, ':') = 0` selects exactly the legacy rows.
 */

import type { Database } from "@magic-context/core/shared/sqlite";

export interface LegacyBareTagFoldResult {
  /** Bare tag numbers removed. */
  readonly removed: number[];
  /** Pending ops moved: bare tag number → core tag number. */
  readonly retargeted: Array<{ from: number; to: number }>;
  /** Pending ops discarded because no core tag exists for that text. */
  readonly discardedOps: number;
}

const EMPTY: LegacyBareTagFoldResult = { removed: [], retargeted: [], discardedOps: 0 };

export function foldLegacyBareMessageTags(
  db: Database,
  sessionId: string,
  contentIdsBySource?: ReadonlyMap<string, ReadonlyMap<number, string>>,
): LegacyBareTagFoldResult {
  const bare = db
    .prepare(
      `SELECT tag_number AS tagNumber, message_id AS messageId
       FROM tags
       WHERE session_id = ? AND type = 'message' AND instr(message_id, ':') = 0`,
    )
    .all(sessionId) as Array<{ tagNumber: number; messageId: string }>;
  if (bare.length === 0) return EMPTY;

  const removed: number[] = [];
  const retargeted: Array<{ from: number; to: number }> = [];
  let discardedOps = 0;
  const findTag = db.prepare(
    `SELECT tag_number AS tagNumber FROM tags
     WHERE session_id = ? AND type = 'message' AND message_id = ? LIMIT 1`,
  );
  const opsOf = db.prepare(
    "SELECT id, operation FROM pending_ops WHERE session_id = ? AND tag_id = ? ORDER BY id ASC",
  );
  const hasOp = db.prepare(
    "SELECT 1 FROM pending_ops WHERE session_id = ? AND tag_id = ? AND operation = ? LIMIT 1",
  );
  const moveOp = db.prepare("UPDATE pending_ops SET tag_id = ? WHERE session_id = ? AND id = ?");
  const deleteOp = db.prepare("DELETE FROM pending_ops WHERE session_id = ? AND id = ?");
  const deleteSource = db.prepare("DELETE FROM source_contents WHERE session_id = ? AND tag_id = ?");
  const deleteTag = db.prepare("DELETE FROM tags WHERE session_id = ? AND tag_number = ?");

  db.transaction(() => {
    for (const row of bare) {
      const coreKey = contentIdsBySource?.get(row.messageId)?.get(0) ?? `${row.messageId}:p0`;
      const survivor = findTag.get(sessionId, coreKey) as { tagNumber: number } | null | undefined;
      const ops = opsOf.all(sessionId, row.tagNumber) as Array<{ id: number; operation: string }>;
      for (const op of ops) {
        if (survivor && typeof survivor.tagNumber === "number" && !hasOp.get(sessionId, survivor.tagNumber, op.operation)) {
          moveOp.run(survivor.tagNumber, sessionId, op.id);
          retargeted.push({ from: row.tagNumber, to: survivor.tagNumber });
        } else {
          deleteOp.run(sessionId, op.id);
          discardedOps += 1;
        }
      }
      deleteSource.run(sessionId, row.tagNumber);
      deleteTag.run(sessionId, row.tagNumber);
      removed.push(row.tagNumber);
    }
  })();
  return { removed, retargeted, discardedOps };
}
