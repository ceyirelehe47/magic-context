/**
 * Round 37 phase 2 — the two PROCESSES of cold-resume.test.ts (test support only).
 *
 *   bun run cold-resume.fixture.ts a <native|fold> <dbPath> <eventsPath> <sessionId> <outPath>
 *   bun run cold-resume.fixture.ts b <native|fold> <dbPath> <eventsPath> <sessionId> <outPath>
 *
 * a: a DSH session (every committed event appended to <eventsPath>, the durable
 *    log stand-in) with one finished tool turn, then a turn whose assistant
 *    opened a tool call that has NO result yet; one context-plane pass after
 *    each state; writes what the provider would get and EXITS (the call stays
 *    unfinished in the log).
 * b: a NEW process: reopens the Magic DB and restores the session from the
 *    log, fresh plugin state; appends the call's result, runs a pass, then the
 *    model continues (one more tool step + a reply), a pass after each; writes
 *    the provider view per stage.
 *
 * "fold" = a session Magic already processed in the legacy fold view before
 * round 37 (process a pins `context.nativeRoles: false`, no scheme row);
 * process b runs with NO setting (the new default) and must keep it fold.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import type { Session } from "@deepseek-ai/dsh-session";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createAssistantMessage, createToolResultMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { buildDurableSession, keyOf, restoreSession } from "./crash-recovery.helpers";
import { initializeDshAdapterTables } from "./outbox";

export type Wire = {
  role: string;
  content: string;
  toolCallId?: string;
  calls?: Array<{ id: string; name: string; arguments: string }>;
  reasoning?: string[];
  replay?: string;
};

export function wire(session: Session): Wire[] {
  return (session.deriveMessages() as unknown as Array<Record<string, unknown>>).map((m) => {
    const blocks = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
    const calls = blocks.filter((b) => b.type === "tool-call").map((b) => ({ id: String(b.id), name: String(b.name), arguments: String(b.arguments) }));
    const reasoning = blocks.filter((b) => b.type === "reasoning").map((b) => String(b.text ?? ""));
    const source = m.source as { replayState?: unknown } | undefined;
    return {
      role: String(m.role),
      content: blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("|"),
      ...(typeof m.toolCallId === "string" ? { toolCallId: m.toolCallId } : {}),
      ...(calls.length > 0 ? { calls } : {}),
      ...(reasoning.length > 0 ? { reasoning } : {}),
      ...(source?.replayState !== undefined ? { replay: JSON.stringify(source.replayState) } : {}),
    };
  });
}

const SRC = { kind: "model", provider: "d", model: "m" };
const replayOf = (i: string) => ({ response: { kind: "pi-ai", version: 2, responseId: `resp-${i}`, stopReason: "toolUse" }, blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" }] });
/** Provider-shaped id: must survive the restart byte-for-byte. */
export const CALL_ID = "call_00_unfinished_r37";

function user(s: Session, text: string) {
  s.append("user/message", createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }) as never, { surfaceOp: "append" });
}
function assistant(s: Session, tag: string, parts: Array<{ text?: string; call?: { id: string; name: string; args: unknown } }>) {
  const content: unknown[] = [{ type: "reasoning", text: `reasoning ${tag}` }];
  for (const p of parts) {
    if (p.text !== undefined) content.push({ type: "text", text: p.text });
    if (p.call) content.push({ type: "tool-call", id: p.call.id, name: p.call.name, arguments: JSON.stringify(p.call.args) });
  }
  s.append(
    "assistant/message",
    { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content, provider: "d", model: "m", source: { ...SRC, replayState: replayOf(tag) } } as never) } as never,
    { surfaceOp: "append" },
  );
}
function result(s: Session, callId: string, text: string) {
  s.append("tool/result", { turn: 1, step: 1, message: createToolResultMessage({ callId: callId as never, content: [{ type: "text", text }], isError: false }) } as never, { surfaceOp: "append" });
}

function deps(db: Database, mode: "native" | "fold", proc: "a" | "b", logs: string[]): ContextPlaneDeps {
  const config: Record<string, unknown> = { protectedTokens: 4000 };
  // the legacy session was processed with the fold view pinned; after the upgrade no setting is set
  if (mode === "fold" && proc === "a") config.nativeRoles = false;
  return {
    host: { ready: Promise.resolve({ kind: "ok", db, storageDir: "", livenessPath: "" }), canonicalKey: keyOf } as never,
    config,
    historian: { config: { enabled: false, executeThresholdPercentage: 65 }, readPressure: () => ({ projectedTokens: 20_000, contextWindow: 100_000 }), fire: () => {} },
    cacheTtl: "5m",
    log: (m: string) => logs.push(m),
  } as unknown as ContextPlaneDeps;
}

function scheme(db: Database, key: string): string | null {
  try {
    const row = db.prepare("SELECT scheme FROM dsh_session_tag_scheme WHERE session_id = ?").get(key) as { scheme: string } | null | undefined;
    return row?.scheme ?? null;
  } catch {
    return null;
  }
}

export async function processA(mode: "native" | "fold", dbPath: string, eventsPath: string, sid: string, close = true) {
  const db = await createTestDb(dbPath);
  initializeDshAdapterTables(db);
  const logs: string[] = [];
  const session = buildDurableSession(sid, (event) => appendFileSync(eventsPath, `${JSON.stringify(event)}\n`));
  const state = createContextPlaneState();
  const d = deps(db, mode, "a", logs);
  const step = () => runContextPlaneStep(state, d, { agent: { id: sid, session, options: { provider: "d", model: "m" } } as never, messages: [] as never }, async () => ({ reject: false, messages: [] }) as never);
  user(session, "question 1");
  assistant(session, "1", [{ text: "reading 1", call: { id: "call-1", name: "read_file", args: { file_path: "a.ts" } } }]);
  result(session, "call-1", "BODY1 ".repeat(300));
  assistant(session, "r1", [{ text: "answer 1" }]);
  await step();
  user(session, "question 2");
  assistant(session, "2", [{ text: "about to read", call: { id: CALL_ID, name: "read_file", args: { file_path: "b.ts" } } }]);
  await step(); // the pre-step while the call is still running
  const out = { pid: process.pid, served: wire(session), scheme: scheme(db, keyOf(sid)), logs };
  if (close) db.close(); // the in-process reference keeps the (cached) handle for processB
  return out;
}

export async function processB(mode: "native" | "fold", dbPath: string, eventsPath: string, sid: string) {
  const db = await createTestDb(dbPath);
  initializeDshAdapterTables(db);
  const logs: string[] = [];
  const restored = restoreSession(sid, eventsPath).session;
  const state = createContextPlaneState();
  const d = deps(db, mode, "b", logs);
  const step = () => runContextPlaneStep(state, d, { agent: { id: sid, session: restored, options: { provider: "d", model: "m" } } as never, messages: [] as never }, async () => ({ reject: false, messages: [] }) as never);
  const reopened = wire(restored);
  const schemeAtOpen = scheme(db, keyOf(sid));
  result(restored, CALL_ID, "BODY2 ".repeat(300));
  await step();
  const afterResult = wire(restored);
  assistant(restored, "3", [{ call: { id: "call-3", name: "grep", args: { pattern: "x" } } }]);
  result(restored, "call-3", "BODY3 ".repeat(50));
  await step();
  assistant(restored, "r2", [{ text: "answer 2" }]);
  await step();
  const final = wire(restored);
  const out = { pid: process.pid, reopened, schemeAtOpen, afterResult, final, scheme: scheme(db, keyOf(sid)), logs };
  db.close();
  return out;
}

if (import.meta.main) {
  const [proc, mode, dbPath, eventsPath, sid, outPath] = process.argv.slice(2) as [string, "native" | "fold", string, string, string, string];
  const out = proc === "a" ? await processA(mode, dbPath, eventsPath, sid) : await processB(mode, dbPath, eventsPath, sid);
  writeFileSync(outPath, JSON.stringify(out));
}
