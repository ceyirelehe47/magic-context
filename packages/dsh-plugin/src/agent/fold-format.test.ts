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
 * Round 28 (limitations 21/22): the round 27 framed record still carried a
 * `- called read (id call_N) with input {…}` / `returned:` template and was
 * copied verbatim (e2e 41792968900 h-a4). The fold now shows ONE past-tense
 * prose line ("earlier in this session 3 files were read …, use ctx_expand")
 * followed by the tagged result text; no call, id or input lines.
 *
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
    config: { nativeRoles: false }, // round 37: legacy fold view pinned (default is native for new sessions)
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

describe("folded tool calls render as one past-tense prose summary, no call / id / input lines (round 28, limitations 21/22)", () => {
  it("the landed copy carries no imitable call template: no `[tool: …]`, no framed record, no call id, no input", async () => {
    await withDb(async (db, dir) => {
      const session = buildFoldSession();
      await landFold(session, db, dir);
      const folded = surfaceTexts(session).find((t) => t.includes("CHECKSUM 4411"));
      expect(folded).toBeDefined();
      // Round 26 form (imitated in e2e 41769676548 R9/R11, 41777488761).
      expect(folded!).not.toMatch(/^\[tool( result)?: /m);
      expect(folded!).not.toMatch(/^input: \{/m);
      // Round 27 form (imitated verbatim in e2e 41792968900 h-a4).
      expect(folded!).not.toContain("recorded-tool-activity");
      expect(folded!).not.toMatch(/^\s*- called /m);
      expect(folded!).not.toMatch(/returned:/);
      // No structured call lines at all: no call id, no input JSON.
      expect(folded!).not.toContain("call_7");
      expect(folded!).not.toContain('"filePath"');
      expect(folded!).not.toMatch(/^\s*\{.*\}\s*$/m);
      // One past-tense prose sentence that NAMES what was done (round 28 v2: v1's
      // bare "1 file was read" made the model re-read the same file up to 8 times
      // in one turn, e2e 41828791422 t-1) and points at ctx_expand.
      expect(folded!).toMatch(/these tool calls already ran and finished; their results are merged below as plain reference text, in this order: read the file \/w\/p19\.txt\./);
      expect(folded!).toMatch(/Do not run them again/);
      expect(folded!).toContain("ctx_expand");
      expect(folded!.match(/Magic Context note/g)!.length).toBe(1);
      // The tagged result text is kept (the model still needs what it read), §N§ first.
      expect(folded!).toMatch(/\u00a7\d+\u00a7 willow orchard cobalt prism\nCHECKSUM 4411/);
      // The assistant's own text and the user's text stay outside the note.
      const note = folded!.indexOf("Magic Context note");
      expect(folded!.indexOf("Reading it.")).toBeLessThan(note);
      expect(folded!.indexOf("now p20.txt")).toBeGreaterThan(folded!.indexOf("CHECKSUM 4411"));
    });
  });

  it("the renderer is pure: one prose line naming each call's target in order, results verbatim, no ids or input JSON", () => {
    const items = [
      { kind: "call" as const, toolName: "read", callId: "call_1", input: { filePath: "/a" } },
      { kind: "call" as const, toolName: "read", callId: "call_2", input: { filePath: "/b" } },
      { kind: "call" as const, toolName: "read", callId: "call_3", input: { filePath: "/c" } },
      { kind: "call" as const, toolName: "bash", callId: "call_4", input: { command: "ls" } },
      { kind: "result" as const, toolName: "read", callId: "call_1", input: { filePath: "/a" }, output: "\u00a73\u00a7 body a" },
      { kind: "result" as const, toolName: "read", callId: "call_2", input: { filePath: "/b" }, output: "\u00a74\u00a7 body b" },
      { kind: "result" as const, toolName: "read", callId: "call_3", input: { filePath: "/c" }, output: "" },
      { kind: "result" as const, toolName: "bash", callId: "call_4", input: { command: "ls" }, output: "\u00a76\u00a7 x.txt" },
    ];
    const text = renderToolRecord(items);
    expect(renderToolRecord(items)).toBe(text);
    const first = text.split("\n")[0]!;
    expect(first).toBe(
      "Magic Context note: these tool calls already ran and finished; their results are merged below as plain reference text, in this order: read the file /a; read the file /b; read the file /c; ran the command `ls`. Do not run them again to get the same result; ctx_expand shows the original calls in full; call tools normally for new work.",
    );
    expect(text.match(/Magic Context note/g)!.length).toBe(1);
    expect(text).toBe([first, "\u00a73\u00a7 body a", "\u00a74\u00a7 body b", "\u00a76\u00a7 x.txt"].join("\n\n"));
    for (const id of ["call_1", "call_2", "call_3", "call_4"]) expect(text).not.toContain(id);
    expect(text).not.toContain('"command"');
    expect(text).not.toContain('"filePath"');
    expect(text).not.toMatch(/^\[tool|recorded-tool-activity|- called|returned/m);
  });

  it("other tools, long commands and calls without a result are named in plain words", () => {
    const one = (item: Parameters<typeof renderToolRecord>[0][number]) => renderToolRecord([item]).split("\n")[0]!;
    expect(one({ kind: "call", toolName: "grep", callId: "c1", input: { pattern: "TODO", path: "src" } })).toContain(
      'no result text is shown here: searched for "TODO" in src (no result recorded).',
    );
    expect(one({ kind: "call", toolName: "edit", callId: "c1", input: { filePath: "/w/x.ts", oldString: "a", newString: "b" } })).toContain(
      "edited the file /w/x.ts (no result recorded)",
    );
    expect(one({ kind: "call", toolName: "ctx_note", callId: "c3", input: {} })).toContain("used ctx_note (no result recorded)");
    const long = one({ kind: "call", toolName: "bash", callId: "c4", input: { command: `echo ${"x".repeat(300)}\nls` } });
    expect(long).toMatch(/ran the command `echo x+…`/);
    expect(long.length).toBeLessThan(400);
    const many = renderToolRecord(
      Array.from({ length: 15 }, (_, i) => ({ kind: "call" as const, toolName: "read", callId: `c${i}`, input: { file_path: `f${i}.txt` } })),
    ).split("\n")[0]!;
    expect(many).toContain("read the file f11.txt (no result recorded); and 3 more.");
    expect(many).not.toContain("f12.txt");
  });

  it("historian / FTS / ctx_expand input is unchanged by the fold format: raw messages before and after the landed replace are identical (call id + input included)", async () => {
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
      expect(all).not.toContain("Magic Context note");
      expect(all).toContain("willow orchard cobalt prism");
      // The details the folded copy no longer shows are still in the raw view.
      expect(all).toContain("call_7");
      expect(all).toContain("/w/p19.txt");
    });
  });
});
