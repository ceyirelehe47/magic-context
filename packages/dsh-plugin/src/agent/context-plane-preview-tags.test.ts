import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  deriveEventMessage,
  sessionEventAt,
} from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";

/**
 * Regression for the round 7/8 duplicate `§N§` observation (DSH-MAINTENANCE
 * known limitation 11): the first-call payload preview assigned a tag under
 * the BARE message id while core `tagTranscript` assigned another under
 * `${id}:p0`, so one message owned two tag numbers and the number the model
 * saw on the first call differed from the one on the surface afterwards.
 */

const SESSION = "sess-preview";
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
  const tool1 = createToolResultMessage({
    callId: "call-1",
    content: [{ type: "text", text: "file contents" }],
    isError: false,
  });
  push("tool/result", tool1);
  const user2 = createUserMessage({ content: [{ type: "text", text: "thanks" }], source: { kind: "user" } });
  push("user/message", user2);
  const assistant2 = createAssistantMessage({
    content: [{ type: "text", text: "done" }],
    provider: "deepseek",
    model: "deepseek-chat",
    source: { kind: "model" },
  });
  push("assistant/message", assistant2);
  const user3 = createUserMessage({
    content: [{ type: "text", text: "turn three question" }],
    source: { kind: "user" },
  });
  push("user/message", user3);
  return { session, payload, ids: { user1: user1.id, assistant1: assistant1.id, user2: user2.id, assistant2: assistant2.id, user3: user3.id } };
}

function tagNumbersIn(text: string): number[] {
  return [...text.matchAll(/\u00a7(\d+)\u00a7/g)].map((m) => Number(m[1]));
}

function textsOf(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of messages) {
    const content = (raw as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    for (const part of content) {
      if (part.type === "text" && typeof part.text === "string") out.push(part.text);
    }
  }
  return out;
}

function surfaceTexts(session: Session): string[] {
  const out: string[] = [];
  for (const seq of session.surface.nodes) {
    const event = sessionEventAt(session, seq);
    const message = event ? deriveEventMessage(event) : undefined;
    if (message) out.push(...textsOf([message]));
  }
  return out;
}

async function withDb(fn: (db: Database, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-preview-"));
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

describe("first-call §N§ preview uses the core tag key (one tag per message)", () => {
  it("never allocates a bare-id tag and shows the same number the surface shows", async () => {
    await withDb(async (db, dir) => {
      const { session, payload, ids } = buildConversation();
      const deps: ContextPlaneDeps = {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
          canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
        },
        config: {},
        log: () => {},
      };
      const state = createContextPlaneState();
      await runContextPlaneStep(
        state,
        deps,
        { agent: { id: session.id, session } as never, messages: payload as never },
        async () => ({ reject: false, messages: [] }),
      );

      const rows = db
        .prepare("SELECT message_id, tag_number FROM tags WHERE session_id = ? AND type = 'message'")
        .all(KEY) as Array<{ message_id: string; tag_number: number }>;
      expect(rows.length).toBeGreaterThan(0);
      // 1. Only core positional keys — no bare-id rows.
      const bare = rows.filter((row) => !/:p\d+$/.test(row.message_id));
      expect(bare).toEqual([]);
      const tagOf = new Map(rows.map((row) => [row.message_id, row.tag_number]));

      // 2. Preview numbers equal the core key's tag (incl. the folded
      //    tool-call assistant text, which core keys under the next user).
      const previewTexts = textsOf(payload);
      const expected: Array<[string, string]> = [
        [`${ids.user1}:p0`, "hello"],
        [`${ids.user2}:p0`, "let me check"],
        [`${ids.user2}:p1`, "thanks"],
        [`${ids.assistant2}:p0`, "done"],
        [`${ids.user3}:p0`, "turn three question"],
      ];
      for (const [key, text] of expected) {
        const tag = tagOf.get(key);
        expect(tag).toBeDefined();
        expect(previewTexts).toContain(`\u00a7${tag}\u00a7 ${text}`);
      }

      // 3. No number is shown on two different texts in the preview.
      const previewNumbers = previewTexts.flatMap(tagNumbersIn);
      expect(new Set(previewNumbers).size).toBe(previewNumbers.length);

      // 4. The surface copies written by the plan carry the SAME numbers.
      const surfaceNumbers = new Set(surfaceTexts(session).flatMap(tagNumbersIn));
      for (const n of previewNumbers) expect(surfaceNumbers.has(n)).toBe(true);

      // 5. A second pass (now on the replaced surface) allocates nothing new
      //    and never shows a number twice.
      const before = rows.length;
      const payload2 = session.surface.nodes
        .map((seq) => sessionEventAt(session, seq))
        .map((event) => (event ? deriveEventMessage(event) : undefined))
        .filter((m) => m !== undefined) as unknown[];
      await runContextPlaneStep(
        state,
        deps,
        { agent: { id: session.id, session } as never, messages: payload2 as never },
        async () => ({ reject: false, messages: [] }),
      );
      const after = (
        db.prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND type = 'message'").get(KEY) as {
          n: number;
        }
      ).n;
      expect(after).toBe(before);
      const shown = textsOf(payload2).flatMap(tagNumbersIn);
      expect(new Set(shown).size).toBe(shown.length);
    });
  });

  it("tags the step's new input (not yet in the session) under the key core will use, so the model's next number is right", async () => {
    await withDb(async (db, dir) => {
      const { session, payload } = buildConversation();
      const deps: ContextPlaneDeps = {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
          canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
        },
        config: {},
        log: () => {},
      };
      const state = createContextPlaneState();
      const run = (messages: unknown[]) =>
        runContextPlaneStep(
          state,
          deps,
          { agent: { id: session.id, session } as never, messages: messages as never },
          async () => ({ reject: false, messages: [] }),
        );
      await run([...payload]);

      // Real rc.5 order: the new prompt and the runtime-context snapshot are
      // in the payload but appended to the session log only after the
      // pre-step.
      const prompt = createUserMessage({ content: [{ type: "text", text: "turn four prompt" }], source: { kind: "user" } });
      const runtime = createUserMessage({
        content: [{ type: "text", text: "Current runtime context." }],
        source: { kind: "runtime-context" } as never,
      });
      const historyNow = session.surface.nodes
        .map((seq) => sessionEventAt(session, seq))
        .map((event) => (event ? deriveEventMessage(event) : undefined))
        .filter((m) => m !== undefined) as unknown[];
      const payload2 = [...historyNow, prompt, runtime];
      await run(payload2);
      const rowsOf = () =>
        new Map(
          (
            db
              .prepare("SELECT message_id, tag_number FROM tags WHERE session_id = ? AND type = 'message'")
              .all(KEY) as Array<{ message_id: string; tag_number: number }>
          ).map((row) => [row.message_id, row.tag_number]),
        );
      const rows = rowsOf();
      const promptTag = rows.get(`${prompt.id}:p0`);
      const runtimeTag = rows.get(`${runtime.id}:p0`);
      expect(promptTag).toBeDefined();
      // Runtime-context snapshots are baselines (round 10): never tagged.
      expect(runtimeTag).toBeUndefined();
      expect([...rows.keys()].filter((k) => !/:p\d+$/.test(k))).toEqual([]);
      const shown = textsOf(payload2);
      expect(shown).toContain(`\u00a7${promptTag}\u00a7 turn four prompt`);
      expect(shown).toContain("Current runtime context.");
      const numbers = shown.flatMap(tagNumbersIn);
      expect(new Set(numbers).size).toBe(numbers.length);
      const highest = Math.max(...numbers);
      expect(highest).toBe(promptTag as number);

      // Once appended, core binds the SAME numbers (no second allocation), and
      // the model's "highest + 1" reply gets exactly that number.
      session.append("user/message", prompt as never, { surfaceOp: "append" });
      session.append("user/message", runtime as never, { surfaceOp: "append" });
      const reply = createAssistantMessage({
        content: [{ type: "text", text: `\u00a7${highest + 1}\u00a7 reply four` }],
        provider: "deepseek",
        model: "deepseek-chat",
        source: { kind: "model" },
      });
      session.append("assistant/message", { turn: 4, step: 1, message: reply } as never, { surfaceOp: "append" });
      const payload3 = session.surface.nodes
        .map((seq) => sessionEventAt(session, seq))
        .map((event) => (event ? deriveEventMessage(event) : undefined))
        .filter((m) => m !== undefined) as unknown[];
      await run(payload3);
      const after = rowsOf();
      expect(after.get(`${prompt.id}:p0`)).toBe(promptTag);
      expect(after.get(`${runtime.id}:p0`)).toBeUndefined();
      expect(after.get(`${reply.id}:p0`)).toBe(highest + 1);
      const surfaceNumbers = surfaceTexts(session).flatMap(tagNumbersIn);
      expect(new Set(surfaceNumbers).size).toBe(surfaceNumbers.length);
    });
  });

  it("pre-assigns a new user message that follows an unfolded tool call under the folded ordinal (:p1, round 10)", async () => {
    await withDb(async (db, dir) => {
      const { session, payload } = buildConversation();
      const deps: ContextPlaneDeps = {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
          canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
        },
        config: {},
        log: () => {},
      };
      const state = createContextPlaneState();
      const callAssistant = createAssistantMessage({
        content: [
          { type: "text", text: "checking" },
          { type: "tool-call", id: "call-9", name: "read_file", arguments: "{}" },
        ],
        provider: "deepseek",
        model: "deepseek-chat",
        source: { kind: "model" },
      });
      const result = createToolResultMessage({ callId: "call-9", content: [{ type: "text", text: "ok" }], isError: false });
      const steer = createUserMessage({ content: [{ type: "text", text: "steer" }], source: { kind: "user" } });
      const messages = [...payload, callAssistant, result, steer];
      await runContextPlaneStep(
        state,
        deps,
        { agent: { id: session.id, session } as never, messages: messages as never },
        async () => ({ reject: false, messages: [] }),
      );
      const keys = (
        db.prepare("SELECT message_id FROM tags WHERE session_id = ? AND type = 'message'").all(KEY) as Array<{
          message_id: string;
        }>
      ).map((r) => r.message_id);
      // The tool-call assistant's "checking" folds into the steer message
      // (core key `${steer}:p0`), so the steer text is `${steer}:p1`.
      expect(keys).toContain(`${steer.id}:p1`);
      expect(keys).not.toContain(`${steer.id}:p0`);
      expect(textsOf(messages).some((t) => /^\u00a7\d+\u00a7 steer$/.test(t))).toBe(true);
    });
  });
});

