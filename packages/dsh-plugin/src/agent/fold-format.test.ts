import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createAssistantMessage, createToolResultMessage, createUserMessage, deriveEventMessage, sessionEventAt } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { readDshTranscript, renderToolRecord } from "./transcript";

/**
 * Round 27 (limitation 21, e2e 41769676548 R9/R11): the DSH adapter folds a
 * tool-call assistant + its tool results into the following user message
 * (limitation 1) and rendered them as `[tool: read #call_N]\ninput: …\n\n
 * [tool result: read #call_N]\noutput:\n…` — a bracketed, transcript-like
 * syntax the real model continued as plain assistant TEXT (fabricated
 * `[tool: read …]` call + invented file body, until max-tokens).
 *
 * The format is the adapter's own (`agent/transcript.ts` RecordingPart.render;
 * OpenCode/Pi mutate real tool parts and never render them as text), so the fix
 * belongs here: a framed record that names itself history and not a callable
 * syntax. Historian / FTS read the event log through the surface walk (op copies
 * expand back to their source events), so their content must not change.
 */

const SESSION = "sess-foldfmt";
const KEY = `dsh:a1b2c3d4:${SESSION}`;

async function withDb(fn: (db: Database, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-foldfmt-"));
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

const textOf = (m: unknown) =>
  ((m as { content: Array<{ type: string; text?: string }> }).content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n"));

function viewOf(session: Session) {
  const events: unknown[] = [];
  for (let seq = 0; seq < 1000; seq += 1) {
    const e = sessionEventAt(session, seq);
    if (e !== undefined) events.push(e);
  }
  return readDshTranscript({ session: { events, surface: session.surface, header: {} } as never, canonicalSessionId: KEY });
}

function surfaceTexts(session: Session): string[] {
  return session.surface.nodes
    .map((s) => sessionEventAt(session, s))
    .map((e) => (e ? deriveEventMessage(e) : undefined))
    .filter(Boolean)
    .map(textOf);
}

/** A user turn, a `read` call with its result, then the next user message (the fold target). */
function buildFoldSession(): Session {
  const session = Session.create(SessionId(SESSION));
  session.append("user/message", createUserMessage({ content: [{ type: "text", text: "read p19.txt" }], source: { kind: "user" } }) as never, { surfaceOp: "append" });
  const call = createAssistantMessage({
    content: [
      { type: "text", text: "Reading it." },
      { type: "tool-call", id: "call_7" as never, name: "read", arguments: JSON.stringify({ filePath: "/w/p19.txt" }) },
    ],
    provider: "deepseek",
    model: "deepseek-chat",
    source: { kind: "model" } as never,
  } as never);
  session.append("assistant/message", { turn: 1, step: 1, message: call } as never, { surfaceOp: "append" });
  const result = createToolResultMessage({ callId: "call_7" as never, content: [{ type: "text", text: "willow orchard cobalt prism\nCHECKSUM 4411" }], isError: false });
  session.append("tool/result", { turn: 1, step: 1, message: result } as never, { surfaceOp: "append" });
  session.append("user/message", createUserMessage({ content: [{ type: "text", text: "now p20.txt" }], source: { kind: "user" } }) as never, { surfaceOp: "append" });
  return session;
}

function planeDeps(db: Database, dir: string): ContextPlaneDeps {
  return {
    host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}` },
    config: {},
    log: () => {},
  } as ContextPlaneDeps;
}

async function landFold(session: Session, db: Database, dir: string): Promise<void> {
  const prompt = createUserMessage({ content: [{ type: "text", text: "go on" }], source: { kind: "user" } });
  await runContextPlaneStep(
    createContextPlaneState(),
    planeDeps(db, dir),
    { agent: { id: session.id, session } as never, messages: [prompt] as never },
    async () => ({ reject: false, messages: [] }) as never,
  );
}

describe("folded tool calls render as a framed, non-callable history record (round 27, limitation 21)", () => {
  it("the landed copy no longer carries the imitable `[tool: …]` / `[tool result: …]` syntax", async () => {
    await withDb(async (db, dir) => {
      const session = buildFoldSession();
      await landFold(session, db, dir);
      const folded = surfaceTexts(session).find((t) => t.includes("CHECKSUM 4411"));
      expect(folded).toBeDefined();
      // Old format (imitated by the model in e2e 41769676548 R9/R11).
      expect(folded!).not.toMatch(/^\[tool( result)?: /m);
      expect(folded!).not.toMatch(/^input: \{/m);
      // New: one framed record that names itself history, not a callable format.
      expect(folded!).toContain("<recorded-tool-activity");
      expect(folded!).toContain("</recorded-tool-activity>");
      expect(folded!).toMatch(/already executed/);
      expect(folded!).toMatch(/not a (tool-call|callable) (syntax|format)/);
      // Content kept: tool name, call id, input, the tagged output.
      expect(folded!).toContain("read");
      expect(folded!).toContain("call_7");
      expect(folded!).toContain('"filePath":"/w/p19.txt"');
      expect(folded!).toMatch(/\u00a7\d+\u00a7 willow orchard cobalt prism\nCHECKSUM 4411/);
      // The assistant's own text and the user's text stay outside the record.
      const open = folded!.indexOf("<recorded-tool-activity");
      const close = folded!.indexOf("</recorded-tool-activity>");
      expect(folded!.indexOf("Reading it.")).toBeLessThan(open);
      expect(folded!.indexOf("now p20.txt")).toBeGreaterThan(close);
    });
  });

  it("the renderer is pure and frames call + result in one record", () => {
    const text = renderToolRecord([
      { kind: "call", toolName: "read", callId: "call_1", input: { filePath: "/a" } },
      { kind: "result", toolName: "read", callId: "call_1", input: { filePath: "/a" }, output: "\u00a73\u00a7 body" },
    ]);
    expect(text.startsWith("<recorded-tool-activity")).toBe(true);
    expect(text.endsWith("</recorded-tool-activity>")).toBe(true);
    expect(text.match(/<recorded-tool-activity/g)!.length).toBe(1);
    expect(text).toContain("\u00a73\u00a7 body");
    expect(text).not.toMatch(/^\[tool/m);
  });

  it("historian / FTS input is unchanged by the fold format: raw messages before and after the landed replace are identical", async () => {
    await withDb(async (db, dir) => {
      const session = buildFoldSession();
      const before = viewOf(session).messages;
      await landFold(session, db, dir);
      const after = viewOf(session).messages;
      // The copy expands back to its source events: same ids, roles, parts.
      expect(after.length).toBe(before.length);
      for (let i = 0; i < before.length; i += 1) {
        expect(after[i]!.id).toBe(before[i]!.id);
        expect(after[i]!.role).toBe(before[i]!.role);
        expect(JSON.stringify(after[i]!.parts)).toBe(JSON.stringify(before[i]!.parts));
      }
      const all = JSON.stringify(after);
      expect(all).not.toContain("recorded-tool-activity");
      expect(all).toContain("willow orchard cobalt prism");
    });
  });
});
