import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  sessionEvents,
} from "../compat/dsh-0.1/session";
import { readDshTranscript, textTagContentIdsBySource } from "./transcript";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { foldLegacyBareMessageTags } from "./legacy-tag-cleanup";

/**
 * Old-data compatibility for the duplicate `§N§` fix: a DB written by the
 * pre-fix preview holds extra `message` tags under BARE source ids. The
 * context plane folds them once per session: rows deleted, still-pending
 * drops moved onto the core `${viewId}:pN` tag of the same text (including
 * the tool-call assistant text that core keys under the next user message),
 * drops whose text has no core tag discarded.
 */

const SESSION = "sess-legacy";
const KEY = `dsh:a1b2c3d4:${SESSION}`;

function buildConversation() {
  const session = Session.create(SessionId(SESSION));
  const payload: unknown[] = [];
  const push = (type: "user/message" | "assistant/message" | "tool/result", message: unknown) => {
    session.append(
      type,
      type === "user/message" ? (message as never) : ({ turn: 1, step: 1, message } as never),
      { surfaceOp: "append" },
    );
    payload.push(message);
  };
  const user1 = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
  push("user/message", user1);
  const assistant1 = createAssistantMessage({
    content: [
      { type: "text", text: "let me check" },
      { type: "tool-call", id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' },
    ],
    provider: "deepseek",
    model: "deepseek-chat",
    source: { kind: "model" },
  });
  push("assistant/message", assistant1);
  const tool1 = createToolResultMessage({ callId: "call-1", content: [{ type: "text", text: "file contents" }], isError: false });
  push("tool/result", tool1);
  const user2 = createUserMessage({ content: [{ type: "text", text: "thanks" }], source: { kind: "user" } });
  push("user/message", user2);
  return { session, payload, ids: { user1: user1.id, assistant1: assistant1.id, tool1: tool1.id, user2: user2.id } };
}

async function withDb(fn: (db: Database, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-legacy-"));
  let db: Database | undefined;
  try {
    db = await createTestDb(join(dir, "context.db"));
    await fn(db, dir);
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function depsFor(db: Database, dir: string): ContextPlaneDeps {
  return {
    host: {
      ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
      canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
    },
    config: {},
    log: () => {},
  };
}

const step = (state: ReturnType<typeof createContextPlaneState>, deps: ContextPlaneDeps, session: Session, messages: unknown[]) =>
  runContextPlaneStep(
    state,
    deps,
    { agent: { id: session.id, session } as never, messages: messages as never },
    async () => ({ reject: false, messages: [] }),
  );

function tagRows(db: Database): Map<string, number> {
  const rows = db
    .prepare("SELECT message_id, tag_number FROM tags WHERE session_id = ? AND type = 'message'")
    .all(KEY) as Array<{ message_id: string; tag_number: number }>;
  return new Map(rows.map((r) => [r.message_id, r.tag_number]));
}

/** Write the rows the pre-fix preview wrote (bare source id, same tagger API). */
function writeLegacyBareTag(db: Database, messageId: string): number {
  const tagger = createTagger();
  tagger.initFromDb(KEY, db);
  const tag = tagger.assignTag(KEY, messageId, "message", 5, db);
  expect(typeof tag).toBe("number");
  return tag as number;
}

describe("legacy bare-id §N§ tags are folded once per session", () => {
  it("deletes bare rows and retargets pending drops onto the core tag of the same text", async () => {
    await withDb(async (db, dir) => {
      const { session, payload, ids } = buildConversation();
      const deps = depsFor(db, dir);
      const originalMapping = textTagContentIdsBySource(
        readDshTranscript({
          session: { events: sessionEvents(session), surface: session.surface, header: {} },
          canonicalSessionId: KEY,
        }),
      );
      await step(createContextPlaneState(), deps, session, [...payload]);
      const core = tagRows(db);
      const user1Core = core.get(`${ids.user1}:p0`);
      const folded = core.get(`${ids.user2}:p0`); // assistant1 text, folded under user2
      expect(user1Core).toBeDefined();
      expect(folded).toBeDefined();

      // Simulate a pre-fix DB: bare rows + model drops queued on bare numbers.
      const bareUser1 = writeLegacyBareTag(db, ids.user1);
      const bareAssistant1 = writeLegacyBareTag(db, ids.assistant1);
      const bareTool1 = writeLegacyBareTag(db, ids.tool1);
      queuePendingOp(db, KEY, bareUser1, "drop");
      queuePendingOp(db, KEY, bareAssistant1, "drop");
      queuePendingOp(db, KEY, bareTool1, "drop");
      const counterBefore = (
        db.prepare("SELECT counter FROM session_meta WHERE session_id = ?").get(KEY) as { counter: number }
      ).counter;

      // Direct call with the view mapping of the original (pre-replace) view;
      // on an already-replaced surface the folded assistant has no mapping and
      // its op is discarded instead (covered by the second case below).
      const result = foldLegacyBareMessageTags(db, KEY, originalMapping);
      expect(result.removed.sort((a, b) => a - b)).toEqual([bareUser1, bareAssistant1, bareTool1].sort((a, b) => a - b));
      expect(result.retargeted).toEqual([
        { from: bareUser1, to: user1Core as number },
        { from: bareAssistant1, to: folded as number },
      ]);
      expect(result.discardedOps).toBe(1); // tool-result text has no core message tag

      const after = tagRows(db);
      expect([...after.keys()].filter((k) => !k.includes(":"))).toEqual([]);
      const ops = db
        .prepare("SELECT tag_id FROM pending_ops WHERE session_id = ? ORDER BY tag_id")
        .all(KEY) as Array<{ tag_id: number }>;
      expect(ops.map((o) => o.tag_id).sort((a, b) => a - b)).toEqual(
        [user1Core as number, folded as number].sort((a, b) => a - b),
      );
      // Counter never moves backwards → deleted numbers are never re-issued.
      const counterAfter = (
        db.prepare("SELECT counter FROM session_meta WHERE session_id = ?").get(KEY) as { counter: number }
      ).counter;
      expect(counterAfter).toBe(counterBefore);
      // Idempotent.
      expect(foldLegacyBareMessageTags(db, KEY).removed).toEqual([]);
    });
  });

  it("the context plane runs the fold on the first pass of a process", async () => {
    await withDb(async (db, dir) => {
      const { session, payload, ids } = buildConversation();
      const deps = depsFor(db, dir);
      await step(createContextPlaneState(), deps, session, [...payload]);
      const bareUser1 = writeLegacyBareTag(db, ids.user1);
      const bareAssistant1 = writeLegacyBareTag(db, ids.assistant1);
      writeLegacyBareTag(db, ids.user2);
      queuePendingOp(db, KEY, bareUser1, "drop");
      queuePendingOp(db, KEY, bareAssistant1, "drop");
      expect([...tagRows(db).keys()].filter((k) => !k.includes(":")).length).toBe(3);
      const user1Core = tagRows(db).get(`${ids.user1}:p0`) as number;

      // New process (fresh state) → fold runs; tags never shown twice after.
      await step(createContextPlaneState(), deps, session, [...payload]);
      const rows = tagRows(db);
      expect([...rows.keys()].filter((k) => !k.includes(":"))).toEqual([]);
      const numbers = [...rows.values()];
      expect(new Set(numbers).size).toBe(numbers.length);
      // Every remaining message tag is a core positional key.
      for (const key of rows.keys()) expect(/:p\d+$/.test(key)).toBe(true);
      // Replaced surface: user1's drop follows `${id}:p0`; the folded
      // assistant text has no mapping any more, so its drop is discarded
      // (never applied to a different text).
      const ops = db.prepare("SELECT tag_id FROM pending_ops WHERE session_id = ?").all(KEY) as Array<{ tag_id: number }>;
      const dropped = db
        .prepare("SELECT tag_number FROM tags WHERE session_id = ? AND status = 'dropped'")
        .all(KEY) as Array<{ tag_number: number }>;
      const touched = new Set([...ops.map((o) => o.tag_id), ...dropped.map((d) => d.tag_number)]);
      expect(touched.has(user1Core)).toBe(true);
      expect(touched.has(bareAssistant1)).toBe(false);
      expect(touched.size).toBe(1);
    });
  });
});
