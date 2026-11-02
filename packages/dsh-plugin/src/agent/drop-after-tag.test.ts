import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createToolResultMessage, createUserMessage, deriveEventMessage, sessionEventAt } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";

/**
 * Round 10 item 4: Magic's own drops (ctx_reduce / heuristic cleanup) are
 * what replaces the native tool-result-pruner under Magic. Pre-fix, the
 * coordinator's surface copy of a tagged message (`mc-op:<opId>`, Magic
 * source) was read back as a knowledge baseline, so once a message had been
 * tagged — i.e. on the very first pass — no later drop could target it: the
 * pending op stayed queued forever and the surface never shrank.
 */

const SID = "sess-drop";
const KEY = `dsh:a1b2c3d4:${SID}`;

function surface(session: Session): string[] {
  return session.surface.nodes
    .map((seq) => sessionEventAt(session, seq))
    .map((event) => (event ? deriveEventMessage(event) : undefined))
    .filter((m) => m !== undefined)
    .map((m) => ((m as { content: Array<{ type: string; text?: string }> }).content.map((p) => p.text ?? `[${p.type}]`).join("|")));
}

async function scenario(fn: (ctx: {
  db: Database;
  session: Session;
  step: () => Promise<void>;
  applied: string[];
  tags: () => Array<{ tag_number: number; type: string; status: string; message_id: string }>;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-drop-"));
  const db = await createTestDb(join(dir, "c.db"));
  try {
    const session = Session.create(SessionId(SID));
    const applied: string[] = [];
    const deps: ContextPlaneDeps = {
      host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}` },
      config: {},
      log: (m) => {
        if (m.includes("applied plan")) applied.push(m);
      },
    };
    const state = createContextPlaneState();
    const step = async () => {
      await runContextPlaneStep(state, deps, { agent: { id: session.id, session } as never, messages: [] as never }, async () => ({ reject: false, messages: [] }));
    };
    const tags = () =>
      db.prepare("SELECT tag_number, type, status, message_id FROM tags WHERE session_id = ? ORDER BY tag_number").all(KEY) as Array<{
        tag_number: number;
        type: string;
        status: string;
        message_id: string;
      }>;
    await fn({ db, session, step, applied, tags });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addToolTurn(session: Session, i: number, size: number) {
  const u = createUserMessage({ content: [{ type: "text", text: `question ${i}` }], source: { kind: "user" } });
  session.append("user/message", u as never, { surfaceOp: "append" });
  const call = createAssistantMessage({
    content: [{ type: "text", text: `reading ${i}` }, { type: "tool-call", id: `call-${i}`, name: "read_file", arguments: "{}" }],
    provider: "d",
    model: "m",
    source: { kind: "model" },
  });
  session.append("assistant/message", { turn: i, step: 1, message: call } as never, { surfaceOp: "append" });
  const result = createToolResultMessage({ callId: `call-${i}`, content: [{ type: "text", text: `BODY${i} `.repeat(size) }], isError: false });
  session.append("tool/result", { turn: i, step: 1, message: result } as never, { surfaceOp: "append" });
  const reply = createAssistantMessage({ content: [{ type: "text", text: `answer ${i}` }], provider: "d", model: "m", source: { kind: "model" } });
  session.append("assistant/message", { turn: i, step: 2, message: reply } as never, { surfaceOp: "append" });
}

describe("drops land on messages that were already tagged (op copies are expanded, not baselines)", () => {
  it("a queued drop of an old message tag and an old tool tag (outside the token floor) replaces the surface copy", async () => {
    await scenario(async ({ db, session, step, tags }) => {
      for (let i = 1; i <= 4; i += 1) {
        addToolTurn(session, i, 3000);
        await step();
      }
      const before = tags();
      const msg = before.find((t) => t.type === "message")!;
      const tool = before.find((t) => t.type === "tool")!;
      expect(surface(session).some((t) => t.includes(`BODY1 BODY1`))).toBe(true);
      queuePendingOp(db, KEY, msg.tag_number, "drop", Date.now());
      queuePendingOp(db, KEY, tool.tag_number, "drop", Date.now());
      await step();
      const after = new Map(tags().map((t) => [t.tag_number, t.status]));
      expect(after.get(msg.tag_number)).toBe("dropped");
      expect(after.get(tool.tag_number)).toBe("dropped");
      const pending = db.prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?").get(KEY) as { n: number };
      expect(pending.n).toBe(0);
      const texts = surface(session);
      expect(texts.some((t) => t.includes(`[dropped \u00a7${msg.tag_number}\u00a7]`))).toBe(true);
      expect(texts.some((t) => t.includes("BODY1 BODY1"))).toBe(false);
      expect(texts.some((t) => t.includes("BODY4 BODY4"))).toBe(true);
      // Round 11: a dropped tool arc (call + result parts of one folded copy)
      // renders ONE placeholder, not one per part (real rc.5 showed
      // "[dropped §3§]\n\n[dropped §3§]").
      const marker = `[dropped \u00a7${tool.tag_number}\u00a7]`;
      expect(texts.join("\n").split(marker).length - 1).toBe(1);
    });
  });

  it("round 17: two dropped tool arcs of ONE parallel-call step render one placeholder each", async () => {
    // Real rc.5 (round 17 e2e, session seq 125): an assistant step with two
    // tool calls folds into one copy whose parts are [call A, call B,
    // result A, result B]; dropping both tags rendered
    // "[dropped §6§]\n\n[dropped §7§]\n\n[dropped §6§]\n\n[dropped §7§]".
    await scenario(async ({ db, session, step, tags }) => {
      const u = createUserMessage({ content: [{ type: "text", text: "question 0" }], source: { kind: "user" } });
      session.append("user/message", u as never, { surfaceOp: "append" });
      const calls = createAssistantMessage({
        content: [
          { type: "text", text: "two calls" },
          { type: "tool-call", id: "call-a", name: "read_file", arguments: "{}" },
          { type: "tool-call", id: "call-b", name: "read_file", arguments: "{}" },
        ],
        provider: "d",
        model: "m",
        source: { kind: "model" },
      });
      session.append("assistant/message", { turn: 0, step: 1, message: calls } as never, { surfaceOp: "append" });
      for (const id of ["call-a", "call-b"]) {
        const result = createToolResultMessage({ callId: id, content: [{ type: "text", text: `${id} `.repeat(400) }], isError: false });
        session.append("tool/result", { turn: 0, step: 1, message: result } as never, { surfaceOp: "append" });
      }
      const reply = createAssistantMessage({ content: [{ type: "text", text: "answer 0" }], provider: "d", model: "m", source: { kind: "model" } });
      session.append("assistant/message", { turn: 0, step: 2, message: reply } as never, { surfaceOp: "append" });
      await step();
      for (let i = 1; i <= 4; i += 1) {
        addToolTurn(session, i, 3000);
        await step();
      }
      const toolTags = tags().filter((t) => t.type === "tool").slice(0, 2);
      expect(toolTags.length).toBe(2);
      for (const t of toolTags) queuePendingOp(db, KEY, t.tag_number, "drop", Date.now());
      await step();
      const after = new Map(tags().map((t) => [t.tag_number, t.status]));
      const all = surface(session).join("\n");
      for (const t of toolTags) {
        expect(after.get(t.tag_number)).toBe("dropped");
        expect(all.split(`[dropped \u00a7${t.tag_number}\u00a7]`).length - 1).toBe(1);
      }
    });
  });

  it("steady state: once tagged, further passes write nothing and keep every number (no churn)", async () => {
    await scenario(async ({ session, step, applied, tags }) => {
      for (let i = 1; i <= 3; i += 1) {
        addToolTurn(session, i, 50);
        await step();
      }
      const tagsBefore = tags();
      const surfaceBefore = surface(session);
      const appliedBefore = applied.length;
      await step();
      await step();
      expect(applied.length).toBe(appliedBefore);
      expect(tags()).toEqual(tagsBefore);
      expect(surface(session)).toEqual(surfaceBefore);
      const nums = surfaceBefore.flatMap((t) => [...t.matchAll(/\u00a7(\d+)\u00a7/g)].map((m) => Number(m[1])));
      expect(new Set(nums).size).toBe(nums.length);
    });
  });
});
