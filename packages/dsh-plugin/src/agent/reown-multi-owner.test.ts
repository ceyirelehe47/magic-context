/**
 * Round 28 (task 2): reownAbsorbedTailToolTags when ONE call already has two or
 * more tag rows under stale synthetic owners.
 *
 * The round 26/27b re-own moves a call's tag only when it has exactly one row
 * (`stale.length !== 1 || owners.length !== 1` → skip). Two rows for one call
 * under two vanished `synth-user-…` owners are what the pre-374a7e978 code
 * (round 26 releases, dsh.3 / dsh.4) wrote over a double crash in the tail
 * window: the first kill left §2§ under synth-user-A; the restart's first
 * pre-step walked the restored tail as synth-user-B and core minted §3§ (old
 * re-own: real-user targets only); a second kill before the replace landed. The
 * next user message absorbs the call, the re-own skips (two owners), and core
 * mints a THIRD number for the same result — the model sees a new §N§ again,
 * and two active orphans stay in the tag table (static inference for how the
 * state arises; the state itself is constructed here exactly).
 *
 * Fix: with ≥ 2 stale synthetic owners and no row for the absorbing owner, the
 * LOWEST number (the first the call ever had, the pre-kill number) is re-owned
 * and every other stale row is folded into it through core's own
 * `adoptPiFallbackToolOwnerTag` (sizes merged, queued ops re-targeted, the
 * duplicate row deleted). When the absorbing owner already has a row (an old
 * duplicate), stale synthetic rows are folded into THAT row (its number is the
 * one on the surface). Owners still in the view, or non-synthetic, are never
 * touched.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createToolResultMessage, createUserMessage, deriveEventMessage, sessionEventAt } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { reownAbsorbedTailToolTags } from "./transcript";

const SID = "dsh:a1b2c3d4:sess-reown-multi";

async function withDb(fn: (db: Database) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-reown-multi-"));
  const db = await createTestDb(join(dir, "context.db"));
  try {
    await fn(db);
  } finally {
    try {
      db.close();
    } catch {
      // closed
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function tag(db: Database, n: number, call: string, owner: string, status = "active", bytes = 100): void {
  db.prepare(
    "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness, tool_owner_message_id, tool_name) VALUES (?, ?, 'tool', ?, ?, ?, 'dsh', ?, 'read')",
  ).run(SID, call, status, bytes, n, owner);
}

function rows(db: Database, call: string) {
  return db
    .prepare("SELECT tag_number AS n, tool_owner_message_id AS owner, status FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = ? ORDER BY tag_number")
    .all(SID, call) as Array<{ n: number; owner: string; status: string }>;
}

function userWithResult(id: string, call: string): RawMessage {
  return {
    id,
    role: "user",
    parts: [
      { type: "tool", callID: call, tool: "read", state: { status: "completed", input: { filePath: "/w/a" }, output: "body" } },
      { type: "text", text: "next" },
    ],
  } as unknown as RawMessage;
}

describe("reownAbsorbedTailToolTags: one call with two or more stale owners (round 28)", () => {
  it("two stale synthetic owners: the lowest (pre-kill) number moves to the absorbing user, the other is folded into it, queued ops follow", async () => {
    await withDb((db) => {
      tag(db, 2, "call-2", "synth-user-A", "active", 100);
      tag(db, 3, "call-2", "synth-user-interrupted-tool-result-call-2-7", "active", 120);
      db.prepare("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 3, 'drop', ?, 'dsh')").run(SID, Date.now());
      const moved = reownAbsorbedTailToolTags(db, SID, [userWithResult("user-9", "call-2")]);
      expect(moved).toBeGreaterThan(0);
      expect(rows(db, "call-2")).toEqual([{ n: 2, owner: "user-9", status: "active" }]);
      const ops = db.prepare("SELECT tag_id FROM pending_ops WHERE session_id = ?").all(SID) as Array<{ tag_id: number }>;
      expect(ops.map((o) => o.tag_id)).toEqual([2]);
    });
  });

  it("three stale synthetic owners collapse to one row with the lowest number", async () => {
    await withDb((db) => {
      tag(db, 5, "call-5", "synth-user-B");
      tag(db, 4, "call-5", "synth-user-A");
      tag(db, 6, "call-5", "synth-user-C");
      reownAbsorbedTailToolTags(db, SID, [userWithResult("user-1", "call-5")]);
      expect(rows(db, "call-5")).toEqual([{ n: 4, owner: "user-1", status: "active" }]);
    });
  });

  it("an old duplicate already owned by the absorbing user keeps ITS number; stale synthetic orphans are folded into it", async () => {
    await withDb((db) => {
      tag(db, 2, "call-2", "synth-user-A");
      tag(db, 3, "call-2", "user-9");
      reownAbsorbedTailToolTags(db, SID, [userWithResult("user-9", "call-2")]);
      expect(rows(db, "call-2")).toEqual([{ n: 3, owner: "user-9", status: "active" }]);
    });
  });

  it("never touches an owner still in the view or a non-synthetic owner", async () => {
    await withDb((db) => {
      tag(db, 2, "call-2", "synth-user-A");
      tag(db, 3, "call-2", "assistant-real-1");
      reownAbsorbedTailToolTags(db, SID, [userWithResult("user-9", "call-2")]);
      expect(rows(db, "call-2")).toEqual([
        { n: 2, owner: "synth-user-A", status: "active" },
        { n: 3, owner: "assistant-real-1", status: "active" },
      ]);
      // Still-visible synthetic owner: not stale.
      tag(db, 7, "call-7", "synth-user-X");
      tag(db, 8, "call-7", "synth-user-Y");
      const view = [userWithResult("user-9", "call-7"), { id: "synth-user-X", role: "user", parts: [] } as unknown as RawMessage];
      reownAbsorbedTailToolTags(db, SID, view);
      expect(rows(db, "call-7").map((r) => r.owner)).toEqual(["synth-user-X", "synth-user-Y"]);
    });
  });

  it("control: the single-stale-owner case (round 26/27b) is unchanged", async () => {
    await withDb((db) => {
      tag(db, 2, "call-2", "synth-user-A");
      expect(reownAbsorbedTailToolTags(db, SID, [userWithResult("user-9", "call-2")])).toBe(1);
      expect(rows(db, "call-2")).toEqual([{ n: 2, owner: "user-9", status: "active" }]);
    });
  });

  it("through the context plane: a real fold over a call with two stale synthetic rows mints NO third number; the surface shows the pre-kill number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-reown-multi-plane-"));
    const db = await createTestDb(join(dir, "context.db"));
    try {
      const sid = "sess-reown-multi-plane";
      const key = `dsh:a1b2c3d4:${sid}`;
      const session = Session.create(SessionId(sid));
      session.append("user/message", createUserMessage({ content: [{ type: "text", text: "read p19.txt" }], source: { kind: "user" } }) as never, { surfaceOp: "append" });
      const call = createAssistantMessage({
        content: [{ type: "tool-call", id: "call_7" as never, name: "read", arguments: JSON.stringify({ filePath: "/w/p19.txt" }) }],
        provider: "deepseek",
        model: "deepseek-chat",
        source: { kind: "model" } as never,
      } as never);
      session.append("assistant/message", { turn: 1, step: 1, message: call } as never, { surfaceOp: "append" });
      const result = createToolResultMessage({ callId: "call_7" as never, content: [{ type: "text", text: "willow orchard\nCHECKSUM 4411" }], isError: false });
      session.append("tool/result", { turn: 1, step: 1, message: result } as never, { surfaceOp: "append" });
      session.append("user/message", createUserMessage({ content: [{ type: "text", text: "now p20.txt" }], source: { kind: "user" } }) as never, { surfaceOp: "append" });
      // State a double crash under the pre-374a7e978 code leaves: two rows, two vanished owners.
      const ins = db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness, tool_owner_message_id, tool_name) VALUES (?, 'call_7', 'tool', 'active', 30, ?, 'dsh', ?, 'read')",
      );
      ins.run(key, 50, "synth-user-gone-a");
      ins.run(key, 51, "synth-user-interrupted-tool-result-call_7-3");
      const deps = {
        host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}` },
        config: {},
        log: () => {},
      } as ContextPlaneDeps;
      const prompt = createUserMessage({ content: [{ type: "text", text: "go on" }], source: { kind: "user" } });
      await runContextPlaneStep(createContextPlaneState(), deps, { agent: { id: session.id, session } as never, messages: [prompt] as never }, async () => ({ reject: false, messages: [] }) as never);
      const after = db.prepare("SELECT tag_number AS n FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = 'call_7'").all(key) as Array<{ n: number }>;
      expect(after.map((r) => r.n)).toEqual([50]);
      const texts = session.surface.nodes
        .map((seq) => sessionEventAt(session, seq))
        .map((e) => (e ? deriveEventMessage(e) : undefined))
        .filter(Boolean)
        .map((m) => (m as { content: Array<{ type: string; text?: string }> }).content.map((p) => p.text ?? "").join("\n"))
        .join("\n");
      expect(texts).toMatch(/\u00a750\u00a7 willow orchard/);
      expect(texts).not.toMatch(/\u00a75[1-9]\u00a7 willow orchard/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

