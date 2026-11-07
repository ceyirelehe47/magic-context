/**
 * Round 23b P0-2 — shared builders for crash-recovery.test.ts and its child
 * process (crash-recovery.fixture.ts). Test support only (not imported by the
 * plugin).
 */
import { readFileSync } from "node:fs";
import { Session, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { ProtectedTailBoundarySnapshot } from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import type { RawMessageProvider, SessionChunk } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  sessionEventAt,
} from "../compat/dsh-0.1/session";
import { type ContextPlaneDeps, type ContextPlaneState, createContextPlaneState, runContextPlaneStep } from "./context-plane";
import type { HistorianDeps } from "./historian";
import { readDshTranscript } from "./transcript";

export const HOME_HASH = "a1b2c3d4";
export const keyOf = (dshSessionId: string) => `dsh:${HOME_HASH}:${dshSessionId}`;

/** A live DSH Session whose every committed event is also handed to `onEvent` (durable log stand-in). */
export function buildDurableSession(id: string, onEvent: (event: SessionEvent) => void): Session {
  const session = Session.create(SessionId(id));
  const append = session.append.bind(session) as (...args: unknown[]) => { seq: number };
  (session as unknown as { append: (...args: unknown[]) => unknown }).append = (...args: unknown[]) => {
    const result = append(...args);
    const event = sessionEventAt(session, result.seq);
    if (event !== undefined) onEvent(event);
    return result;
  };
  return session;
}

/** Restore the session a crashed process left behind from its durable event log. */
export function restoreSession(id: string, eventsPath: string): { session: Session; events: SessionEvent[] } {
  const events = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as SessionEvent);
  return { session: Session.create(SessionId(id), events), events };
}

/** One tool turn: user question, assistant tool call, tool result (`BODY<i> ` × size), assistant answer. */
export function toolTurn(session: Session, i: number, size: number): void {
  session.append(
    "user/message",
    createUserMessage({ content: [{ type: "text", text: `question ${i}` }], source: { kind: "user" } }) as never,
    { surfaceOp: "append" },
  );
  const call = createAssistantMessage({
    content: [{ type: "text", text: `reading ${i}` }, { type: "tool-call", id: `call-${i}` as never, name: "read", arguments: "{}" }],
    provider: "d",
    model: "m",
    source: { kind: "model", provider: "d", model: "m" } as never,
  } as never);
  session.append("assistant/message", { turn: i, step: 1, stream: [], message: call } as never, { surfaceOp: "append" });
  const result = createToolResultMessage({
    callId: `call-${i}` as never,
    content: [{ type: "text", text: `BODY${i} `.repeat(size) }],
    isError: false,
  });
  session.append("tool/result", { turn: i, step: 1, message: result } as never, { surfaceOp: "append" });
  const reply = createAssistantMessage({
    content: [{ type: "text", text: `answer ${i}` }],
    provider: "d",
    model: "m",
    source: { kind: "model", provider: "d", model: "m" } as never,
  } as never);
  session.append("assistant/message", { turn: i, step: 2, stream: [], message: reply } as never, { surfaceOp: "append" });
}

/** A user question, an assistant tool call and its result — no reply (the turn is still running). */
export function tailToolCall(session: Session, i: number, size: number): void {
  session.append(
    "user/message",
    createUserMessage({ content: [{ type: "text", text: `question ${i}` }], source: { kind: "user" } }) as never,
    { surfaceOp: "append" },
  );
  const call = createAssistantMessage({
    content: [{ type: "text", text: `reading ${i}` }, { type: "tool-call", id: `call-${i}` as never, name: "read", arguments: "{}" }],
    provider: "d",
    model: "m",
    source: { kind: "model", provider: "d", model: "m" } as never,
  } as never);
  session.append("assistant/message", { turn: i, step: 1, stream: [], message: call } as never, { surfaceOp: "append" });
  const result = createToolResultMessage({
    callId: `call-${i}` as never,
    content: [{ type: "text", text: `BODY${i} `.repeat(size) }],
    isError: false,
  });
  session.append("tool/result", { turn: i, step: 1, message: result } as never, { surfaceOp: "append" });
}

export function planeDeps(db: Database, log?: (m: string) => void): ContextPlaneDeps {
  return {
    host: {
      ready: Promise.resolve({ kind: "ok", db, storageDir: "", livenessPath: "" }),
      canonicalKey: keyOf,
    } as never,
    config: { nativeRoles: false }, // round 37: legacy fold view pinned (default is native for new sessions)
    ...(log ? { log } : {}),
  };
}

export async function planeStep(state: ContextPlaneState, deps: ContextPlaneDeps, session: Session): Promise<void> {
  await runContextPlaneStep(
    state,
    deps,
    { agent: { id: session.id, session } as never, messages: [] as never },
    async () => ({ reject: false, messages: [] }) as never,
  );
}

/** Add each turn, then run one context-plane pass (one process = one plane state). */
export async function runPlaneTurns(
  db: Database,
  session: Session,
  turns: readonly number[],
  addTurn: (session: Session, i: number) => void,
  log?: (m: string) => void,
): Promise<void> {
  const state = createContextPlaneState();
  const deps = planeDeps(db, log);
  for (const i of turns) {
    addTurn(session, i);
    await planeStep(state, deps, session);
  }
}

export function providerOf(session: Session, key: string): RawMessageProvider {
  const view = readDshTranscript({
    session: { events: session.snapshotEvents(), surface: session.surface, header: {} },
    canonicalSessionId: key,
  });
  return { readMessages: () => view.messages as never };
}

/** Whole session eligible (protectedTailStart = count + 1), fingerprint-less. */
export function boundaryFor(key: string, messages: readonly { ordinal: number; id: string }[]): ProtectedTailBoundarySnapshot {
  const count = messages.length;
  const idAt = (ordinal: number): string | null => messages.find((m) => m.ordinal === ordinal)?.id ?? null;
  return {
    sessionId: key,
    mode: "incremental-runner",
    offset: 1,
    offsetMessageId: idAt(1),
    protectedTailStart: count + 1,
    protectedTailStartMessageId: null,
    eligibleEndOrdinal: count + 1,
    eligibleEndMessageId: idAt(count),
    rawMessageCountAtTrigger: count,
    rawLastMessageIdAtTrigger: idAt(count),
    N: 0,
    usagePercentage: 0,
    usageInputTokens: 0,
    usageSource: "provisional-zero",
    contextLimit: 128_000,
    executeThresholdPercentage: 65,
    triggerBudget: 10_000,
    priorBoundaryOrdinal: count + 1,
    migrationFloorActive: false,
    providerShapeVersion: "opencode-v1",
    cacheNamespace: `test:${key}`,
    createdAt: Date.now(),
    rawRangeFingerprint: "",
    trueRawEligibleTokens: 0,
    oversizeAtomicUnit: false,
    boundaryReason: "test",
  } as ProtectedTailBoundarySnapshot;
}

/** Valid historian XML: one compartment over exactly the chunk it is given. */
export function chunkXml(chunk: SessionChunk): string {
  const { startIndex: s, endIndex: e } = chunk;
  return `<output>
<compartments>
<compartment start="${s}" end="${e}" title="work ${s}-${e}" episode_type="design" importance="50">
<p1>Narrative summary of ${s}-${e}.</p1>
<p2>Condensed ${s}-${e}.</p2>
<p3>Outcome ${s}-${e}.</p3>
<p4>Anchor ${s}-${e}.</p4>
</compartment>
</compartments>
<facts>
</facts>
<meta>
<messages_processed>${s}-${e}</messages_processed>
<unprocessed_from>${e + 1}</unprocessed_from>
</meta>
</output>`;
}

/** Background-pass deps (unique per-pass lease holder; no memory promotion). */
export function historianDepsFor(db: Database, session: Session, key: string, over: Partial<HistorianDeps> = {}): HistorianDeps {
  const provider = providerOf(session, key);
  return {
    db,
    sessionId: key,
    provider,
    summarize: async (chunk) => chunkXml(chunk),
    boundarySnapshot: boundaryFor(key, provider.readMessages() as never),
    ...over,
  };
}
