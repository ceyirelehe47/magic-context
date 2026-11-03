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
 * Round 10 (DSH-MAINTENANCE limitation 11, remaining edge 1): rc.5 appends
 * the runtime-context snapshot AFTER the pre-step, right before the model
 * call. When Magic tagged it, it took the next number on the following pass
 * — the number the model had already written as its own "highest + 1" reply
 * prefix, which stays verbatim in the raw assistant event (real round 9:
 * raw reply `§2§` vs runtime-context copy `§2§`). Replacing the snapshot also
 * nulls DSH's RuntimeContextProjection.retained, so DSH re-appended an
 * identical snapshot every turn. The snapshot is now a baseline: never
 * tagged, never replaced.
 */

const SESSION = "sess-runtime";
const KEY = `dsh:a1b2c3d4:${SESSION}`;

function texts(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of messages) {
    const content = (raw as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    for (const part of content) if (part.type === "text" && typeof part.text === "string") out.push(part.text);
  }
  return out;
}
const numbers = (list: string[]) => list.flatMap((t) => [...t.matchAll(/\u00a7(\d+)\u00a7/g)].map((m) => Number(m[1])));

function surfaceMessages(session: Session): unknown[] {
  return session.surface.nodes
    .map((seq) => sessionEventAt(session, seq))
    .map((event) => (event ? deriveEventMessage(event) : undefined))
    .filter((m) => m !== undefined) as unknown[];
}

function rawAssistantTexts(session: Session): string[] {
  const out: string[] = [];
  for (let seq = 0; seq < 10_000; seq += 1) {
    const event = sessionEventAt(session, seq);
    if (event === undefined) {
      if (seq > 0 && sessionEventAt(session, seq + 1) === undefined && sessionEventAt(session, seq + 2) === undefined) break;
      continue;
    }
    if ((event as { type?: string }).type !== "assistant/message") continue;
    const m = deriveEventMessage(event);
    if (m) out.push(...texts([m]));
  }
  return out;
}

async function withDb(fn: (db: Database, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-rc-"));
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

function rows(db: Database): Map<string, number> {
  return new Map(
    (
      db.prepare("SELECT message_id, tag_number FROM tags WHERE session_id = ? AND type = 'message'").all(KEY) as Array<{
        message_id: string;
        tag_number: number;
      }>
    ).map((r) => [r.message_id, r.tag_number]),
  );
}

/**
 * Drive N turns the way rc.5 does: pre-step payload = surface + new prompt;
 * after the waterfall DSH appends the prompt and the runtime-context
 * snapshot; the model replies with its own "highest + 1" prefix.
 */
async function runTurns(db: Database, dir: string, turns: number, withTool = false) {
  const session = Session.create(SessionId(SESSION));
  const deps: ContextPlaneDeps = {
    host: {
      ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
      canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
    },
    config: {},
    log: () => {},
  };
  const state = createContextPlaneState();
  const runtimeIds: string[] = [];
  const replies: Array<{ id: string; prefix: number }> = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const prompt = createUserMessage({ content: [{ type: "text", text: `turn ${turn} prompt` }], source: { kind: "user" } });
    const payload = [...surfaceMessages(session), prompt];
    await runContextPlaneStep(
      state,
      deps,
      { agent: { id: session.id, session } as never, messages: payload as never },
      async () => ({ reject: false, messages: [] } as never),
    );
    const highest = Math.max(0, ...numbers(texts(payload)));
    session.append("user/message", prompt as never, { surfaceOp: "append" });
    if (withTool && turn === 2) {
      const call = createAssistantMessage({
        content: [{ type: "text", text: "checking" }, { type: "tool-call", id: `call-${turn}` as never, name: "read_file", arguments: "{}" }],
        provider: "deepseek",
        model: "deepseek-chat",
        source: { kind: "model" } as never,
      });
      session.append("assistant/message", { turn, step: 1, message: call } as never, { surfaceOp: "append" });
      const result = createToolResultMessage({ callId: `call-${turn}` as never, content: [{ type: "text", text: "file body" }], isError: false });
      session.append("tool/result", { turn, step: 1, message: result } as never, { surfaceOp: "append" });
    }
    const runtime = createUserMessage({
      content: [{ type: "text", text: `Current runtime context. turn ${turn}` }],
      source: { kind: "runtime-context" } as never,
    });
    runtimeIds.push(runtime.id);
    session.append("user/message", runtime as never, { surfaceOp: "append" });
    const reply = createAssistantMessage({
      content: [{ type: "text", text: `\u00a7${highest + 1}\u00a7 reply ${turn}` }],
      provider: "deepseek",
      model: "deepseek-chat",
      source: { kind: "model" } as never,
    });
    replies.push({ id: reply.id, prefix: highest + 1 });
    session.append("assistant/message", { turn, step: 1, message: reply } as never, { surfaceOp: "append" });
  }
  // The pass that sees the last reply.
  await runContextPlaneStep(
    state,
    deps,
    { agent: { id: session.id, session } as never, messages: surfaceMessages(session) as never },
    async () => ({ reject: false, messages: [] } as never),
  );
  return { session, runtimeIds, replies };
}

describe("runtime-context snapshot is a baseline (no tag, no replace)", () => {
  it("the model's own reply prefix is the number core gives the reply; no number is owned twice across raw + surface", async () => {
    await withDb(async (db, dir) => {
      const { session, runtimeIds, replies } = await runTurns(db, dir, 3);
      const tagRows = rows(db);
      for (const reply of replies) expect(tagRows.get(`${reply.id}:p0`)).toBe(reply.prefix);
      // Every number in raw assistant events + the surface belongs to one text.
      const owners = new Map<number, Set<string>>();
      for (const text of [...rawAssistantTexts(session), ...texts(surfaceMessages(session))]) {
        for (const n of numbers([text])) {
          const body = text.replace(/^\u00a7\d+\u00a7 /, "");
          owners.set(n, (owners.get(n) ?? new Set()).add(body));
        }
      }
      for (const [n, bodies] of owners) expect([n, [...bodies]]).toEqual([n, [...bodies].slice(0, 1)]);
      for (const id of runtimeIds) expect([...tagRows.keys()].some((k) => k.startsWith(`${id}:`))).toBe(false);
      // The latest snapshot keeps its original event on the surface (DSH's
      // RuntimeContextProjection keeps it as `retained`, no re-append).
      const surfaceSources = surfaceMessages(session).map((m) => (m as { source?: { kind?: string } }).source?.kind);
      expect(surfaceSources.filter((k) => k === "runtime-context").length).toBe(3);
      const last = surfaceMessages(session).find((m) => (m as { id?: string }).id === runtimeIds[2]);
      expect(last).toBeDefined();
      expect(texts([last])[0]).toBe("Current runtime context. turn 3");
    });
  });

  it("a snapshot right after tool results does not swallow them: the results stay tagged, the snapshot untouched", async () => {
    await withDb(async (db, dir) => {
      const { session, runtimeIds } = await runTurns(db, dir, 3, true);
      const tagRows = rows(db);
      for (const id of runtimeIds) expect([...tagRows.keys()].some((k) => k.startsWith(`${id}:`))).toBe(false);
      const tool = db.prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND type = 'tool'").get(KEY) as { n: number };
      expect(tool.n).toBeGreaterThan(0);
      const all = texts(surfaceMessages(session));
      expect(all).toContain("Current runtime context. turn 2");
      expect(all.some((t) => /^\u00a7\d+\u00a7 checking/.test(t))).toBe(true);
      const shown = numbers(all);
      expect(new Set(shown).size).toBe(shown.length);
    });
  });
});
