import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createToolResultMessage, createUserMessage, deriveEventMessage, sessionEventAt } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createContextPlaneState, previewTagPayloadMessages, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { deriveMutationPlan, endsInPendingFold, pendingFoldTextCount, readDshTranscript, textTagContentIdsBySource } from "./transcript";

/**
 * Round 10 item 2: a new user message that follows a tool call / tool result
 * with no closing user message absorbs them (walkDshLog fold), so core keys
 * its own text `${id}:p${n}` with n = the tool-call assistant's text blocks.
 * The preview now pre-assigns exactly that key instead of skipping (payload
 * fold) or using `:p0` (session-tail fold), which handed the absorbed
 * assistant text the number the model had been shown for the new message.
 */

const SESSION = "sess-fold";
const KEY = `dsh:a1b2c3d4:${SESSION}`;

async function withDb(fn: (db: Database, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-fold-"));
  let db: Database | undefined;
  try {
    db = await createTestDb(join(dir, "context.db"));
    await fn(db, dir);
  } finally {
    try {
      db?.close();
    } catch {
      // closed
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const tagRows = (db: Database) =>
  new Map(
    (db.prepare("SELECT message_id, tag_number FROM tags WHERE session_id = ? AND type = 'message'").all(KEY) as Array<{
      message_id: string;
      tag_number: number;
    }>).map((r) => [r.message_id, r.tag_number]),
  );
const textOf = (m: unknown) => ((m as { content: Array<{ type: string; text?: string }> }).content.find((p) => p.type === "text")?.text ?? "");

function viewOf(session: Session) {
  const events: unknown[] = [];
  for (let seq = 0; seq < 1000; seq += 1) {
    const e = sessionEventAt(session, seq);
    if (e !== undefined) events.push(e);
  }
  return readDshTranscript({ session: { events, surface: session.surface, header: {} } as never, canonicalSessionId: KEY });
}

function toolCall(text: string, callId: string) {
  return createAssistantMessage({
    content: [{ type: "text", text }, { type: "tool-call", id: callId as never, name: "read_file", arguments: "{}" }],
    provider: "deepseek",
    model: "deepseek-chat",
    source: { kind: "model" } as never,
  } as never);
}

describe("new input after a pending fold is pre-tagged under core's exact :pN key", () => {
  it("payload fold (tool-call + result + steer in the payload): steer pre-tagged at :p1 and core keeps that number", async () => {
    await withDb(async (db, dir) => {
      const session = Session.create(SessionId(SESSION));
      const first = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
      session.append("user/message", first as never, { surfaceOp: "append" });
      const deps: ContextPlaneDeps = {
        host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}` },
        config: { nativeRoles: false }, // round 37: legacy fold view pinned (default is native for new sessions)
        log: () => {},
      };
      const state = createContextPlaneState();
      const call = toolCall("checking", "call-9");
      const result = createToolResultMessage({ callId: "call-9" as never, content: [{ type: "text", text: "ok" }], isError: false });
      const steer = createUserMessage({ content: [{ type: "text", text: "steer" }], source: { kind: "user" } });
      const payload = [call, result, steer];
      await runContextPlaneStep(state, deps, { agent: { id: session.id, session } as never, messages: payload as never }, async () => ({ reject: false, messages: [] } as never));
      const preview = tagRows(db).get(`${steer.id}:p1`);
      expect(preview).toBeDefined();
      expect(tagRows(db).has(`${steer.id}:p0`)).toBe(false);
      expect(textOf(payload[2])).toBe(`\u00a7${preview}\u00a7 steer`);
      // Append in payload order; the next pass (core tagTranscript) binds the
      // same number to the steer text and a NEW one to the absorbed text.
      session.append("assistant/message", { turn: 1, step: 1, message: call } as never, { surfaceOp: "append" });
      session.append("tool/result", { turn: 1, step: 1, message: result } as never, { surfaceOp: "append" });
      session.append("user/message", { ...steer, content: [{ type: "text", text: "steer" }] } as never, { surfaceOp: "append" });
      deriveMutationPlan(viewOf(session), { db });
      const after = tagRows(db);
      expect(after.get(`${steer.id}:p1`)).toBe(preview);
      expect(after.get(`${steer.id}:p0`)).toBeDefined();
      expect(after.get(`${steer.id}:p0`)).not.toBe(preview);
    });
  });

  it("session-tail fold left unreplaced: the new prompt is keyed after the absorbed assistant text", async () => {
    await withDb(async (db) => {
      const session = Session.create(SessionId(SESSION));
      const first = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
      session.append("user/message", first as never, { surfaceOp: "append" });
      const call = toolCall("checking", "call-7");
      session.append("assistant/message", { turn: 1, step: 1, message: call } as never, { surfaceOp: "append" });
      const result = createToolResultMessage({ callId: "call-7" as never, content: [{ type: "text", text: "body" }], isError: false });
      session.append("tool/result", { turn: 1, step: 1, message: result } as never, { surfaceOp: "append" });
      const v = viewOf(session);
      expect(endsInPendingFold(v)).toBe(true);
      expect(pendingFoldTextCount(v)).toBe(1);
      // Tags exist for the tail (derive), but the replace did NOT land (e.g.
      // stale-input / generation mismatch): the surface still ends in the fold.
      deriveMutationPlan(v, { db });
      const prompt = createUserMessage({ content: [{ type: "text", text: "next prompt" }], source: { kind: "user" } });
      const payload = [prompt];
      previewTagPayloadMessages(db, KEY, payload, textTagContentIdsBySource(v), {
        pending: endsInPendingFold(v),
        textCount: pendingFoldTextCount(v),
      });
      const preview = tagRows(db).get(`${prompt.id}:p1`);
      expect(preview).toBeDefined();
      expect(textOf(payload[0])).toBe(`\u00a7${preview}\u00a7 next prompt`);
      session.append("user/message", { ...prompt, content: [{ type: "text", text: "next prompt" }] } as never, { surfaceOp: "append" });
      deriveMutationPlan(viewOf(session), { db });
      const after = tagRows(db);
      expect(after.get(`${prompt.id}:p1`)).toBe(preview);
      expect(after.get(`${prompt.id}:p0`)).not.toBe(preview);
    });
  });

  it("after a landed replace the tail is no longer a fold: the new prompt stays at :p0 (real rc.5 path)", async () => {
    await withDb(async (db, dir) => {
      const session = Session.create(SessionId(SESSION));
      const first = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
      session.append("user/message", first as never, { surfaceOp: "append" });
      const call = toolCall("checking", "call-8");
      session.append("assistant/message", { turn: 1, step: 1, message: call } as never, { surfaceOp: "append" });
      const result = createToolResultMessage({ callId: "call-8" as never, content: [{ type: "text", text: "body" }], isError: false });
      session.append("tool/result", { turn: 1, step: 1, message: result } as never, { surfaceOp: "append" });
      const deps: ContextPlaneDeps = {
        host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}` },
        config: { nativeRoles: false }, // round 37: legacy fold view pinned (default is native for new sessions)
        log: () => {},
      };
      const prompt = createUserMessage({ content: [{ type: "text", text: "steer now" }], source: { kind: "user" } });
      const payload = [prompt];
      await runContextPlaneStep(createContextPlaneState(), deps, { agent: { id: session.id, session } as never, messages: payload as never }, async () => ({ reject: false, messages: [] } as never));
      expect(endsInPendingFold(viewOf(session))).toBe(false);
      const preview = tagRows(db).get(`${prompt.id}:p0`);
      expect(preview).toBeDefined();
      session.append("user/message", { ...prompt, content: [{ type: "text", text: "steer now" }] } as never, { surfaceOp: "append" });
      deriveMutationPlan(viewOf(session), { db });
      expect(tagRows(db).get(`${prompt.id}:p0`)).toBe(preview);
      const texts = session.surface.nodes.map((s) => sessionEventAt(session, s)).map((e) => (e ? deriveEventMessage(e) : undefined)).filter(Boolean).map(textOf);
      const nums = texts.flatMap((t) => [...t.matchAll(/\u00a7(\d+)\u00a7/g)].map((m) => Number(m[1])));
      expect(new Set(nums).size).toBe(nums.length);
    });
  });
});

describe("tool tags of an unreplaced session-tail fold keep their number when the next user message absorbs them (round 26 Y4)", () => {
  it("kill between the tail tool result and the landed replace: the absorbing user message re-owns the synthetic tail's tool tag", async () => {
    await withDb(async (db) => {
      const session = Session.create(SessionId(SESSION));
      const first = createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } });
      session.append("user/message", first as never, { surfaceOp: "append" });
      const call = toolCall("checking", "call-34");
      session.append("assistant/message", { turn: 1, step: 1, message: call } as never, { surfaceOp: "append" });
      const result = createToolResultMessage({ callId: "call-34" as never, content: [{ type: "text", text: "interrupted" }], isError: true });
      session.append("tool/result", { turn: 1, step: 1, message: result } as never, { surfaceOp: "append" });
      deriveMutationPlan(viewOf(session), { db });
      const toolRows = () =>
        db.prepare("SELECT tag_number, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = 'call-34'").all(KEY) as Array<{
          tag_number: number;
          tool_owner_message_id: string | null;
        }>;
      const before = toolRows();
      expect(before).toHaveLength(1);
      // (process killed here: the replace never landed) — restart, next prompt.
      const prompt = createUserMessage({ content: [{ type: "text", text: "Reply when done." }], source: { kind: "user" } });
      session.append("user/message", prompt as never, { surfaceOp: "append" });
      deriveMutationPlan(viewOf(session), { db });
      const after = toolRows();
      // e2e 41771964169 Y4: a second tag (3 -> 4) for the same call; the model saw §4§ for a §3§ result.
      expect(after).toHaveLength(1);
      expect(after[0]!.tag_number).toBe(before[0]!.tag_number);
      expect(after[0]!.tool_owner_message_id).toBe(prompt.id);
    });
  });
});
