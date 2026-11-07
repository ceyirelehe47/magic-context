/**
 * Round 37 (I3) — the DEFAULT history presentation of a NEW session must keep
 * the model's tool-execution and reasoning continuity.
 *
 * Evidence (evo bench 42274076026 @ dc916285b, DSH 0.2.1-rc.5, opencode-go
 * deepseek-v4.1-flash, 1M window): with the shipped default (fold view) none of
 * the 177 main requests carried a historical `assistant`, `tool`, native
 * `tool_calls` or `reasoning_content`: every finished tool step was rewritten
 * into ONE `user/message` replace whose text renders the calls as a note
 * (`flushSynthetic` → synthetic user, `RecordingPart.render()` → null for
 * reasoning). Reasoning per main request: median 10 704 tokens (native view:
 * 120), 15 / 15 turns timed out, 0 compactions. DeepSeek thinking mode with
 * `tools` expects every earlier `reasoning_content` to be passed back
 * (api-docs.deepseek.com/guides/thinking_mode).
 *
 * The native-role view (round 36 G, plan N) already keeps every surface node's
 * role, never writes assistant nodes (their reasoning blocks and replay
 * metadata stay as DSH recorded them) and rewrites tool results in place. It
 * was behind a switch that defaulted to off, so no real session got it.
 *
 * These cases run with NO switch set (no `context.nativeRoles`, no env) and
 * assert on what the provider is built from (`session.deriveMessages()`):
 *   D1 single + consecutive tool steps: roles, call ↔ result pairing, reasoning
 *      and replay metadata on every assistant node, no Magic note;
 *   D2 one assistant with reasoning + text + two parallel calls, one result an
 *      error: both results paired in order, both tagged in place;
 *   D3 an unfinished call survives a pass and a process restart (fresh state,
 *      session restored from its events); the served prefix never changes;
 *   D4 drop (ride) → historian region compaction → expand-style tool call →
 *      more tool calls: protocol stays valid, reasoning after the region kept;
 *   D5 repeating the same pass writes nothing (no re-injection / rewrite);
 *   C1 a session Magic already processed in the fold view (before this change:
 *      no scheme row) stays fold under the new default — no silent migration,
 *      no mixed write rules;
 *   C2 the explicit opt-out (`context.nativeRoles: false` or env `0`) keeps the
 *      legacy fold view for new sessions.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  deriveEventMessage,
  sessionEventAt,
  sessionEvents,
} from "../compat/dsh-0.1/session";
import { MagicCompactionEngine } from "../compat/dsh-0.1/compaction";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { observedProtectionWindow } from "./protection";
import { NATIVE_ROLES_ENV } from "./tag-scheme";

const WINDOW = 100_000;
const TAG = /^\u00a7(\d+)\u00a7 /;

let savedEnv: string | undefined;
beforeAll(() => {
  savedEnv = process.env[NATIVE_ROLES_ENV];
  delete process.env[NATIVE_ROLES_ENV];
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env[NATIVE_ROLES_ENV];
  else process.env[NATIVE_ROLES_ENV] = savedEnv;
});

type Wire = {
  role: string;
  content: string;
  toolCallId?: string;
  isError?: boolean;
  calls?: Array<{ id: string; name: string; arguments: string }>;
  reasoning?: string[];
  replay?: string;
};

/** What the provider request is built from: role, text, pairing, reasoning, replay metadata. */
function wire(session: Session): Wire[] {
  return (session.deriveMessages() as unknown as Array<Record<string, unknown>>).map((m) => {
    const blocks = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("|");
    const calls = blocks
      .filter((b) => b.type === "tool-call")
      .map((b) => ({ id: String(b.id), name: String(b.name), arguments: String(b.arguments) }));
    const reasoning = blocks.filter((b) => b.type === "reasoning").map((b) => String(b.text ?? ""));
    const source = m.source as { replayState?: unknown } | undefined;
    return {
      role: String(m.role),
      content: text,
      ...(typeof m.toolCallId === "string" ? { toolCallId: m.toolCallId } : {}),
      ...(m.isError === true ? { isError: true } : {}),
      ...(calls.length > 0 ? { calls } : {}),
      ...(reasoning.length > 0 ? { reasoning } : {}),
      ...(source?.replayState !== undefined ? { replay: JSON.stringify(source.replayState) } : {}),
    };
  });
}
const bytes = (w: Wire[]) => w.map((m) => JSON.stringify(m));
const roles = (w: Wire[]) => w.map((m) => (m.calls ? "assistant+calls" : m.role));

/**
 * Chat-completions tool protocol over the derived messages: every tool message
 * answers a call of the assistant that opened its run (no user / assistant in
 * between), each call is answered at most once, and every call is answered
 * before the next non-tool message (only the trailing run may be open).
 */
function protocolViolations(w: Wire[]): string[] {
  const out: string[] = [];
  let open: Set<string> | null = null;
  let openAt = -1;
  for (let i = 0; i < w.length; i += 1) {
    const m = w[i]!;
    if (m.role === "tool") {
      if (open === null) out.push(`#${i} tool ${m.toolCallId} without an open assistant tool_calls run`);
      else if (m.toolCallId === undefined || !open.delete(m.toolCallId)) out.push(`#${i} tool ${m.toolCallId} answers no open call of #${openAt}`);
      continue;
    }
    if (open !== null && open.size > 0) out.push(`#${openAt} calls ${[...open].join(",")} unanswered before #${i} (${m.role})`);
    open = null;
    if (m.role === "assistant" && m.calls) {
      open = new Set(m.calls.map((c) => c.id));
      openAt = i;
    }
  }
  return out;
}

function events(session: Session): Array<SessionEvent & { surfaceOp?: unknown }> {
  return sessionEvents(session) as never;
}
function replaces(session: Session) {
  return events(session).filter((e) => e.surfaceOp !== null && typeof e.surfaceOp === "object");
}

interface Harness {
  db: Database;
  session: Session;
  key: string;
  logs: string[];
  step: (opts?: { fresh?: boolean; session?: Session }) => Promise<void>;
  tags: () => Array<{ tag_number: number; type: string; status: string; message_id: string }>;
  pending: () => number[];
  setNowOffset: (ms: number) => void;
  setNative: (on: boolean | undefined) => void;
  scheme: () => string | undefined;
}

let seqId = 0;
async function scenario(fn: (h: Harness) => Promise<void>, opts: { native?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-default-native-"));
  const db = await createTestDb(join(dir, "c.db"));
  seqId += 1;
  const sid = `sess-default-native-${seqId}-${Date.now()}`;
  const key = `dsh:a1b2c3d4:${sid}`;
  try {
    const session = Session.create(SessionId(sid));
    let nowOffset = 0;
    const logs: string[] = [];
    const config: Record<string, unknown> = { protectedTokens: 4000 };
    if (opts.native !== undefined) config.nativeRoles = opts.native;
    const deps = {
      host: {
        ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
        canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
      },
      config,
      historian: {
        config: { enabled: false, executeThresholdPercentage: 65 },
        readPressure: () => ({ projectedTokens: Math.round(0.2 * WINDOW), contextWindow: WINDOW }),
        fire: () => {},
      },
      cacheTtl: "5m",
      now: () => Date.now() + nowOffset,
      log: (m: string) => logs.push(m),
    } as unknown as ContextPlaneDeps;
    let state = createContextPlaneState();
    const h: Harness = {
      db,
      session,
      key,
      logs,
      step: async (o) => {
        if (o?.fresh === true) state = createContextPlaneState();
        const s = o?.session ?? h.session;
        await runContextPlaneStep(
          state,
          deps,
          { agent: { id: s.id, session: s, options: { provider: "d", model: "m" } } as never, messages: [] as never },
          async () => ({ reject: false, messages: [] }) as never,
        );
      },
      tags: () =>
        db
          .prepare("SELECT tag_number, type, status, message_id FROM tags WHERE session_id = ? ORDER BY tag_number")
          .all(key) as Array<{ tag_number: number; type: string; status: string; message_id: string }>,
      pending: () =>
        (db.prepare("SELECT tag_id FROM pending_ops WHERE session_id = ? ORDER BY tag_id").all(key) as Array<{ tag_id: number }>).map(
          (r) => r.tag_id,
        ),
      setNowOffset: (ms) => {
        nowOffset = ms;
      },
      setNative: (on) => {
        if (on === undefined) delete config.nativeRoles;
        else config.nativeRoles = on;
      },
      scheme: () => {
        try {
          const row = db.prepare("SELECT scheme FROM dsh_session_tag_scheme WHERE session_id = ?").get(key) as
            | { scheme: string }
            | null
            | undefined;
          return row?.scheme;
        } catch {
          return undefined;
        }
      },
    };
    await fn(h);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const SRC = { kind: "model", provider: "d", model: "m" };
function replayOf(i: number | string) {
  return { response: { kind: "pi-ai", version: 2, responseId: `resp-${i}`, stopReason: "toolUse" }, blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" }] };
}

function addUser(session: Session, text: string) {
  session.append(
    "user/message",
    createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }) as never,
    { surfaceOp: "append" },
  );
}
/** assistant: reasoning + optional text + one or more tool calls (ids `call-<i>` / `call-<i>-<k>`). */
function addCalls(session: Session, i: number, opts: { text?: string; n?: number; name?: string } = {}) {
  const n = opts.n ?? 1;
  const content: unknown[] = [{ type: "reasoning", text: `thinking about step ${i}` }];
  if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
  for (let k = 0; k < n; k += 1) {
    const id = n === 1 ? `call-${i}` : `call-${i}-${k}`;
    content.push({ type: "tool-call", id, name: opts.name ?? "read_file", arguments: JSON.stringify({ file_path: `f${i}-${k}.ts` }) });
  }
  session.append(
    "assistant/message",
    {
      turn: i,
      step: 1,
      stream: [],
      message: createAssistantMessage({ content, provider: "d", model: "m", source: { ...SRC, replayState: replayOf(i) } } as never),
    } as never,
    { surfaceOp: "append" },
  );
}
function addResult(session: Session, callId: string, body: string, isError = false) {
  session.append(
    "tool/result",
    { turn: 1, step: 1, message: createToolResultMessage({ callId: callId as never, content: [{ type: "text", text: body }], isError }) } as never,
    { surfaceOp: "append" },
  );
}
function addReply(session: Session, i: number, text = `answer ${i}`) {
  session.append(
    "assistant/message",
    {
      turn: i,
      step: 2,
      stream: [],
      message: createAssistantMessage({
        content: [
          { type: "reasoning", text: `wrapping up ${i}` },
          { type: "text", text },
        ],
        provider: "d",
        model: "m",
        source: { ...SRC, replayState: replayOf(`r${i}`) },
      } as never),
    } as never,
    { surfaceOp: "append" },
  );
}
function addToolTurn(session: Session, i: number, size: number) {
  addUser(session, `question ${i}`);
  addCalls(session, i, { text: `reading ${i}` });
  addResult(session, `call-${i}`, `BODY${i} `.repeat(size));
  addReply(session, i);
}

/** Every assistant node the provider gets still carries its reasoning and replay metadata. */
function expectAssistantContinuity(w: Wire[]) {
  const assistants = w.filter((m) => m.role === "assistant");
  expect(assistants.length).toBeGreaterThan(0);
  for (const a of assistants) {
    expect(a.reasoning?.length ?? 0).toBe(1);
    expect(a.replay).toBeDefined();
    expect(a.content).not.toMatch(/\u00a7\d+\u00a7/);
  }
}

describe("round 37 I3: a new session's DEFAULT view keeps tool execution + reasoning continuity", () => {
  it("D1 single and consecutive tool steps keep native roles, pairing, reasoning and replay metadata (no switch set)", async () => {
    await scenario(async (h) => {
      addToolTurn(h.session, 1, 50);
      await h.step();
      // live turn, two consecutive tool steps, no reply yet
      addUser(h.session, "question 2");
      addCalls(h.session, 2, { text: "reading 2" });
      addResult(h.session, "call-2", "BODY2 ".repeat(50));
      await h.step();
      addCalls(h.session, 3);
      addResult(h.session, "call-3", "BODY3 ".repeat(50));
      await h.step();
      const w = wire(h.session);
      expect(roles(w)).toEqual(["user", "assistant+calls", "tool", "assistant", "user", "assistant+calls", "tool", "assistant+calls", "tool"]);
      expect(protocolViolations(w)).toEqual([]);
      expect(w[2]!.toolCallId).toBe("call-1");
      expect(w[6]!.toolCallId).toBe("call-2");
      expect(w[8]!.toolCallId).toBe("call-3");
      expectAssistantContinuity(w);
      expect(w[1]!.reasoning).toEqual(["thinking about step 1"]);
      expect(w[1]!.content).toBe("reading 1");
      expect(w[7]!.reasoning).toEqual(["thinking about step 3"]);
      for (const i of [2, 6, 8]) expect(w[i]!.content).toMatch(TAG);
      expect(w.some((m) => m.content.includes("Magic Context note"))).toBe(false);
      expect(replaces(h.session).some((e) => e.type === "assistant/message")).toBe(false);
      expect(h.scheme()).toBe("native");
    });
  });

  it("D2 one assistant with reasoning + text + two parallel calls (one result an error): both paired in order, both tagged in place", async () => {
    await scenario(async (h) => {
      addUser(h.session, "question 1");
      addCalls(h.session, 1, { text: "reading two files", n: 2 });
      addResult(h.session, "call-1-0", "FIRST ".repeat(40));
      addResult(h.session, "call-1-1", "ENOENT: no such file", true);
      await h.step();
      addCalls(h.session, 2);
      addResult(h.session, "call-2", "SECOND ".repeat(40));
      await h.step();
      const w = wire(h.session);
      expect(roles(w)).toEqual(["user", "assistant+calls", "tool", "tool", "assistant+calls", "tool"]);
      expect(protocolViolations(w)).toEqual([]);
      expect(w[1]!.calls!.map((c) => c.id)).toEqual(["call-1-0", "call-1-1"]);
      expect(w[1]!.content).toBe("reading two files");
      expect(w[2]!.toolCallId).toBe("call-1-0");
      expect(w[3]!.toolCallId).toBe("call-1-1");
      expect(w[3]!.isError).toBe(true);
      expect(w[2]!.content).toMatch(TAG);
      expect(w[3]!.content).toMatch(TAG);
      expect(w[3]!.content).toContain("ENOENT: no such file");
      expectAssistantContinuity(w);
      const toolTags = h.tags().filter((t) => t.type === "tool").map((t) => t.message_id);
      expect(toolTags).toEqual(expect.arrayContaining(["call-1-0", "call-1-1", "call-2"]));
    });
  });

  it("D3 an unfinished call survives a pass and a process restart; the served prefix never changes", async () => {
    await scenario(async (h) => {
      addToolTurn(h.session, 1, 50);
      await h.step();
      addUser(h.session, "question 2");
      addCalls(h.session, 2, { text: "about to read" });
      // pre-step while the call is still running (no result yet)
      await h.step();
      const served = bytes(wire(h.session));
      expect(roles(wire(h.session)).at(-1)).toBe("assistant+calls");
      // process restart: session rebuilt from its events, fresh plugin state
      const restored = Session.create(SessionId(String(h.session.id)), [...sessionEvents(h.session)] as never);
      expect(bytes(wire(restored))).toEqual(served);
      h.session = restored;
      addResult(restored, "call-2", "BODY2 ".repeat(50));
      await h.step({ fresh: true });
      const w = wire(restored);
      expect(bytes(w).slice(0, served.length)).toEqual(served);
      expect(roles(w)).toEqual(["user", "assistant+calls", "tool", "assistant", "user", "assistant+calls", "tool"]);
      expect(protocolViolations(w)).toEqual([]);
      expect(w[6]!.toolCallId).toBe("call-2");
      expect(w[6]!.content).toMatch(TAG);
      expectAssistantContinuity(w);
      expect(h.scheme()).toBe("native");
    });
  });

  it("D4 drop on a ride, historian region compaction, an expand-style call, then more tool calls: protocol valid, reasoning after the region kept", async () => {
    await scenario(async (h) => {
      for (let i = 1; i <= 6; i += 1) {
        addToolTurn(h.session, i, 1500);
        await h.step();
      }
      const window = observedProtectionWindow(h.db, h.key, { protectedTokens: 4000, contextWindow: WINDOW });
      const prot = new Set(window.protectedTagNumbers);
      const unprotected = h.tags().filter((t) => t.type === "tool" && t.status === "active" && !prot.has(t.tag_number));
      const victim = unprotected[0]!.tag_number;
      queuePendingOp(h.db, h.key, victim, "drop", Date.now());
      h.setNowOffset(6 * 60_000); // idle past cache TTL: a ride
      await h.step();
      h.setNowOffset(0);
      let w = wire(h.session);
      const dropped = w.filter((m) => m.content.startsWith("[dropped"));
      expect(dropped.map((m) => m.role)).toEqual(["tool"]);
      expect(protocolViolations(w)).toEqual([]);
      expectAssistantContinuity(w);

      // historian: the native compaction-basic transaction over turns 1-3
      const nodes = [...h.session.surface.nodes];
      const est = (m: unknown) => (TokenMeter.prototype as unknown as { estimateMessage(x: unknown): number }).estimateMessage(m);
      const meter = {
        estimateMessage: est,
        measure: (s: Session) => {
          const list = s.surface.nodes.map((seq) => {
            const t = est(deriveEventMessage(sessionEventAt(s, seq)!));
            return { seq, tokens: t, heuristicTokens: t };
          });
          return { nodes: list, totalTokens: list.reduce((n, x) => n + x.tokens, 0) };
        },
      };
      const ctx = new Context();
      const engine = new MagicCompactionEngine(ctx as never, { auto: false } as never);
      const hook = async () => ({ summary: [{ type: "text", text: "<session-history>turns 1-3</session-history>" }], provider: "d", model: "m" });
      Object.defineProperty(engine, "ctx", {
        value: Object.assign(Object.create(ctx), {
          llm: { resolveModelInfo: async () => ({ context: { contextWindow: WINDOW }, defaultMaxTokens: 4096 }) },
          logger: { info: () => {}, warn: () => {} },
          tokenMeter: meter,
          get: (name: string) => (name === "magicContextHost" ? { summarizeHook: () => hook } : undefined),
        }),
        configurable: true,
      });
      (h.session.append as unknown as (t: string, d: unknown) => unknown).call(h.session, "turn/start", { turn: 7 });
      const agent = { id: h.session.id, session: h.session, options: { provider: "d", model: "m" } };
      await engine.compactRegion(nodes[0]! as never, nodes[11]! as never, agent as never, new AbortController().signal);
      await h.step();
      w = wire(h.session);
      expect(w.length).toBeLessThan(24);
      expect(w.some((m) => m.content.includes("turns 1-3"))).toBe(true);
      expect(protocolViolations(w)).toEqual([]);

      // expand-style call (its own tool result), then two more tool steps
      addUser(h.session, "question 7");
      addCalls(h.session, 7, { name: "ctx_expand" });
      addResult(h.session, "call-7", "expanded history 1-3 ".repeat(20));
      await h.step();
      addCalls(h.session, 8, { n: 2 });
      addResult(h.session, "call-8-0", "A ".repeat(30));
      addResult(h.session, "call-8-1", "B ".repeat(30));
      await h.step();
      w = wire(h.session);
      expect(protocolViolations(w)).toEqual([]);
      expect(roles(w).slice(-6)).toEqual(["user", "assistant+calls", "tool", "assistant+calls", "tool", "tool"]);
      // every assistant still on the surface (after the region) keeps its reasoning + replay metadata
      expectAssistantContinuity(w);
      expect(w.some((m) => m.content.includes("Magic Context note"))).toBe(false);
      expect(replaces(h.session).some((e) => e.type === "assistant/message")).toBe(false);
      expect(h.logs.some((l) => /failed|abandoned/.test(l))).toBe(false);
    });
  });

  it("D5 repeating the same pass (same process and a fresh one) writes nothing and keeps every byte", async () => {
    await scenario(async (h) => {
      for (let i = 1; i <= 3; i += 1) {
        addToolTurn(h.session, i, 200);
        await h.step();
      }
      const live = bytes(wire(h.session));
      const before = sessionEvents(h.session).length;
      await h.step();
      await h.step({ fresh: true });
      await h.step();
      expect(sessionEvents(h.session).length).toBe(before);
      expect(bytes(wire(h.session))).toEqual(live);
      expect(h.scheme()).toBe("native");
    });
  });
});

describe("round 37 I3: sessions already worked on in the fold view keep it", () => {
  it("C1 a session Magic processed in the fold view (no scheme row, as before this change) stays fold under the new default; no mixed write rules", async () => {
    await scenario(
      async (h) => {
        // the pre-change default: fold, nothing written to dsh_session_tag_scheme
        addToolTurn(h.session, 1, 50);
        await h.step();
        expect(h.scheme()).toBeUndefined();
        // upgrade: the explicit setting goes away, the new default applies
        h.setNative(undefined);
        addToolTurn(h.session, 2, 50);
        await h.step({ fresh: true });
        expect(h.scheme()).toBe("fold");
        const w = wire(h.session);
        expect(w.some((m) => m.content.includes("Magic Context note"))).toBe(true);
        // fold write rules only: no per-node tool/result replace, no shadow price
        expect(replaces(h.session).some((e) => e.type === "tool/result")).toBe(false);
        expect(events(h.session).some((e) => e.type === "compaction/prune")).toBe(false);
        expect(protocolViolations(w)).toEqual([]);
      },
      { native: false },
    );
  });

  it("C2 the explicit opt-out keeps the legacy fold view for a new session (setting false, or env 0)", async () => {
    await scenario(
      async (h) => {
        addToolTurn(h.session, 1, 50);
        await h.step();
        expect(wire(h.session).some((m) => m.content.includes("Magic Context note"))).toBe(true);
      },
      { native: false },
    );
    process.env[NATIVE_ROLES_ENV] = "0";
    try {
      await scenario(async (h) => {
        addToolTurn(h.session, 1, 50);
        await h.step();
        expect(wire(h.session).some((m) => m.content.includes("Magic Context note"))).toBe(true);
        expect(h.scheme()).not.toBe("native");
      });
    } finally {
      delete process.env[NATIVE_ROLES_ENV];
    }
  });
});
