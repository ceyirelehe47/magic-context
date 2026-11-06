/**
 * Round 36 line G — plan N (native roles) on a REAL @deepseek-ai/dsh-session
 * Session, driven through the real pre-step body (`runContextPlaneStep`).
 *
 * With the switch on (`context.nativeRoles`, env
 * `MAGIC_CONTEXT_DSH_NATIVE_ROLES`), a NEW session keeps every surface node's
 * role: tool results are rewritten in place with a single-node, content-only
 * `tool/result` replace, user text with a single-node `user/message` replace,
 * each preceded by a `compaction/prune` shadow price; assistant nodes are
 * never written and their text is never tagged. Write-back follows
 * pi-plugin's `transcript-pi.ts` commit (per source node), see
 * docs/dsh/design/native-roles-plan.md §7.
 *
 * Off (default) and for sessions Magic already worked on, nothing changes:
 * the existing suite is the regression guard (no assertion changed).
 */
import { describe, expect, it } from "bun:test";
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
import { stageDshCompactionMarker } from "./outbox";
import { observedProtectionWindow } from "./protection";

const WINDOW = 100_000;

type TagRow = { tag_number: number; type: string; status: string; message_id: string };
type Wire = { role: string; content: string; toolCallId?: string; calls?: Array<{ id: string; name: string; arguments: string }> };

/** What the provider sees of each message (role, text, tool pairing). */
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
    return {
      role: String(m.role),
      content: text,
      ...(typeof m.toolCallId === "string" ? { toolCallId: m.toolCallId } : {}),
      ...(calls.length > 0 ? { calls } : {}),
    };
  });
}
const bytes = (w: Wire[]) => w.map((m) => JSON.stringify(m));
const roles = (w: Wire[]) => w.map((m) => (m.calls ? "assistant+calls" : m.role));

function events(session: Session): Array<SessionEvent & { surfaceOp?: unknown; sourceEventSeqs?: number[] }> {
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
  step: (opts?: { fresh?: boolean; messages?: unknown[] }) => Promise<void>;
  tags: () => TagRow[];
  pending: () => number[];
  setPressure: (pct: number) => void;
  setNowOffset: (ms: number) => void;
  setNative: (on: boolean | undefined) => void;
}

let seqId = 0;
async function scenario(
  fn: (h: Harness) => Promise<void>,
  opts: { native?: boolean; pressure?: { projectedTokens: number; contextWindow: number } } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-native-"));
  const db = await createTestDb(join(dir, "c.db"));
  seqId += 1;
  const sid = `sess-native-${seqId}`;
  const key = `dsh:a1b2c3d4:${sid}`;
  try {
    const session = Session.create(SessionId(sid));
    let pressurePct = 20;
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
        readPressure: () =>
          opts.pressure !== undefined
            ? { ...opts.pressure }
            : { projectedTokens: Math.round((pressurePct / 100) * WINDOW), contextWindow: WINDOW },
        fire: () => {},
      },
      cacheTtl: "5m",
      now: () => Date.now() + nowOffset,
      log: (m: string) => logs.push(m),
    } as unknown as ContextPlaneDeps;
    let state = createContextPlaneState();
    const step = async (o?: { fresh?: boolean; messages?: unknown[] }) => {
      if (o?.fresh === true) state = createContextPlaneState();
      await runContextPlaneStep(
        state,
        deps,
        { agent: { id: session.id, session, options: { provider: "d", model: "m" } } as never, messages: (o?.messages ?? []) as never },
        async () => ({ reject: false, messages: [] }) as never,
      );
    };
    const tags = () =>
      db
        .prepare("SELECT tag_number, type, status, message_id FROM tags WHERE session_id = ? ORDER BY tag_number")
        .all(key) as TagRow[];
    const pending = () =>
      (db.prepare("SELECT tag_id FROM pending_ops WHERE session_id = ? ORDER BY tag_id").all(key) as Array<{ tag_id: number }>).map(
        (r) => r.tag_id,
      );
    await fn({
      db,
      session,
      key,
      logs,
      step,
      tags,
      pending,
      setPressure: (pct) => {
        pressurePct = pct;
      },
      setNowOffset: (ms) => {
        nowOffset = ms;
      },
      setNative: (on) => {
        if (on === undefined) delete config.nativeRoles;
        else config.nativeRoles = on;
      },
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addUser(session: Session, text: string) {
  session.append(
    "user/message",
    createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }) as never,
    { surfaceOp: "append" },
  );
}
function addCall(session: Session, i: number, opts: { text?: string; args?: string; name?: string } = {}) {
  const content: unknown[] = [];
  if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
  content.push({ type: "tool-call", id: `call-${i}`, name: opts.name ?? "read_file", arguments: opts.args ?? JSON.stringify({ file_path: `f${i}.ts` }) });
  session.append(
    "assistant/message",
    { turn: i, step: 1, stream: [], message: createAssistantMessage({ content, provider: "d", model: "m", source: { kind: "model", provider: "d", model: "m" } } as never) } as never,
    { surfaceOp: "append" },
  );
}
function addResult(session: Session, i: number, body: string) {
  session.append(
    "tool/result",
    { turn: i, step: 1, message: createToolResultMessage({ callId: `call-${i}` as never, content: [{ type: "text", text: body }], isError: false }) } as never,
    { surfaceOp: "append" },
  );
}
function addReply(session: Session, i: number, text = `answer ${i}`) {
  session.append(
    "assistant/message",
    { turn: i, step: 2, stream: [], message: createAssistantMessage({ content: [{ type: "text", text }], provider: "d", model: "m", source: { kind: "model", provider: "d", model: "m" } } as never) } as never,
    { surfaceOp: "append" },
  );
}
/** user, assistant(text + call), tool result, assistant reply. */
function addToolTurn(session: Session, i: number, size: number) {
  addUser(session, `question ${i}`);
  addCall(session, i, { text: `reading ${i}` });
  addResult(session, i, `BODY${i} `.repeat(size));
  addReply(session, i);
}

async function buildTurns(h: Harness, n: number, size = 1500): Promise<{ unprotected: number[]; protectedTools: number[] }> {
  for (let i = 1; i <= n; i += 1) {
    addToolTurn(h.session, i, size);
    await h.step();
  }
  const window = observedProtectionWindow(h.db, h.key, { protectedTokens: 4000, contextWindow: WINDOW });
  const prot = new Set(window.protectedTagNumbers);
  const tools = h.tags().filter((t) => t.type === "tool" && t.status === "active").map((t) => t.tag_number);
  return { unprotected: tools.filter((t) => !prot.has(t)), protectedTools: tools.filter((t) => prot.has(t)) };
}

const TAG = /^\u00a7(\d+)\u00a7 /;

describe("round 36 line G: native roles (plan N), switch on, new session", () => {
  it("N1 role sequence and tool_call pairing are what DSH produced; §N§ lands only on user and tool nodes", async () => {
    await scenario(
      async (h) => {
        addToolTurn(h.session, 1, 50);
        await h.step();
        // live turn: question, tool call, result, no reply yet
        addUser(h.session, "question 2");
        addCall(h.session, 2, { text: "reading 2" });
        addResult(h.session, 2, "BODY2 ".repeat(50));
        await h.step();
        const w = wire(h.session);
        expect(roles(w)).toEqual(["user", "assistant+calls", "tool", "assistant", "user", "assistant+calls", "tool"]);
        expect(w[1]!.calls!.map((c) => c.id)).toEqual(["call-1"]);
        expect(w[2]!.toolCallId).toBe("call-1");
        expect(w[5]!.calls!.map((c) => c.id)).toEqual(["call-2"]);
        expect(w[6]!.toolCallId).toBe("call-2");
        // §N§ on user and tool nodes, never on assistant text
        for (const i of [0, 2, 4, 6]) expect(w[i]!.content).toMatch(TAG);
        for (const i of [1, 3, 5]) expect(w[i]!.content).not.toMatch(/\u00a7\d+\u00a7/);
        expect(w[1]!.content).toBe("reading 1");
        expect(w[3]!.content).toBe("answer 1");
        // no folded record note anywhere
        expect(w.some((m) => m.content.includes("Magic Context note"))).toBe(false);
        // surface stays one node per message
        expect(h.session.surface.nodes.length).toBe(7);
      },
      { native: true },
    );
  });

  it("N2 tagging a new tool result leaves every byte of the already-served prefix unchanged", async () => {
    await scenario(
      async (h) => {
        addToolTurn(h.session, 1, 50);
        await h.step();
        addUser(h.session, "question 2");
        addCall(h.session, 2, { text: "reading 2" });
        await h.step();
        const served = bytes(wire(h.session));
        // the model acted: a new result arrives, next pre-step tags it
        addResult(h.session, 2, "BODY2 ".repeat(50));
        await h.step();
        const now = bytes(wire(h.session));
        expect(now.slice(0, served.length)).toEqual(served);
        expect(now.length).toBe(served.length + 1);
        expect(JSON.parse(now.at(-1)!).content).toMatch(TAG);
        // a further step with nothing new writes nothing
        const before = sessionEvents(h.session).length;
        await h.step();
        expect(sessionEvents(h.session).length).toBe(before);
      },
      { native: true },
    );
  });

  it("N3 a drop rewrites only that tool node; core chose skeleton_real (call and real arguments kept); assistant nodes untouched", async () => {
    await scenario(
      async (h) => {
        const { unprotected } = await buildTurns(h, 6);
        const victim = unprotected[0]!;
        const before = wire(h.session);
        queuePendingOp(h.db, h.key, victim, "drop", Date.now());
        // a ride: idle past cache_ttl
        h.setNowOffset(6 * 60_000);
        await h.step();
        const after = wire(h.session);
        expect(after.length).toBe(before.length);
        const changed = after.map((m, i) => (JSON.stringify(m) === JSON.stringify(before[i]) ? -1 : i)).filter((i) => i >= 0);
        expect(changed.length).toBe(1);
        const idx = changed[0]!;
        expect(after[idx]).toEqual({ role: "tool", content: `[dropped \u00a7${victim}\u00a7]`, toolCallId: before[idx]!.toolCallId });
        // the paired call stays, with its real arguments
        const call = after[idx - 1]!;
        expect(call.role).toBe("assistant");
        expect(call.calls![0]!.id).toBe(before[idx]!.toolCallId!);
        expect(call.calls![0]!.arguments).toBe(before[idx - 1]!.calls![0]!.arguments);
        expect(roles(after)).toEqual(roles(before));
        expect(h.tags().find((t) => t.tag_number === victim)?.status).toBe("dropped");
      },
      { native: true },
    );
  });

  it("N4 assistant nodes are never replaced and their text never gets a tag row", async () => {
    await scenario(
      async (h) => {
        await buildTurns(h, 4, 200);
        const assistantSeqs = events(h.session)
          .filter((e) => e.type === "assistant/message")
          .map((e) => e.seq as number);
        // every assistant event is still the live surface node
        for (const seq of assistantSeqs) expect(h.session.surface.nodes).toContain(seq as never);
        // no replace ever targeted an assistant node or produced one
        for (const e of replaces(h.session)) {
          expect(e.type).not.toBe("assistant/message");
          const op = e.surfaceOp as { startSeq: number; endSeq: number };
          expect(op.startSeq).toBe(op.endSeq);
          expect(assistantSeqs).not.toContain(op.startSeq);
        }
        // tag rows: message tags only for user text, tool tags for calls
        const assistantIds = new Set(
          assistantSeqs.map((seq) => String((deriveEventMessage(sessionEventAt(h.session, seq)!) as { id: string }).id)),
        );
        for (const row of h.tags()) {
          if (row.type !== "message") continue;
          const owner = row.message_id.replace(/:p\d+$/, "");
          expect(assistantIds.has(owner)).toBe(false);
        }
        expect(h.tags().filter((t) => t.type === "message").length).toBe(4);
      },
      { native: true },
    );
  });

  it("N5 every replace is immediately preceded by its compaction/prune and the real token-meter re-prices (C3)", async () => {
    await scenario(
      async (h) => {
        const { unprotected } = await buildTurns(h, 6);
        queuePendingOp(h.db, h.key, unprotected[0]!, "drop", Date.now());
        h.setNowOffset(6 * 60_000);
        await h.step();
        const all = events(h.session);
        const reps = replaces(h.session);
        expect(reps.length).toBeGreaterThan(0);
        for (const e of reps) {
          const prev = all[all.indexOf(e) - 1] as unknown as { type: string; data: { shadowedRange: { start: number; end: number }; shadowedSeqs: number[]; shadowedTokenCount: number } };
          expect(prev.type).toBe("compaction/prune");
          const op = e.surfaceOp as { startSeq: number; endSeq: number };
          expect(prev.data.shadowedRange).toEqual({ start: op.startSeq, end: op.endSeq });
          expect(prev.data.shadowedSeqs).toEqual([op.startSeq]);
          const shadowed = deriveEventMessage(sessionEventAt(h.session, op.startSeq)!);
          expect(prev.data.shadowedTokenCount).toBe(
            (TokenMeter.prototype as unknown as { estimateMessage(m: unknown): number }).estimateMessage(shadowed),
          );
        }
        // real contextBreakdown fold == a fresh pricing of the live surface (no drift)
        const defs = new Map<string, any>();
        const ctx = new Context();
        ctx.provide("sessionProjections", { register(d: any) { defs.set(d.key, d); return () => defs.delete(d.key); } } as never);
        (ctx as any).plugin(TokenMeter);
        for (let i = 0; i < 40 && !defs.has("contextBreakdown"); i++) await new Promise((r) => setTimeout(r, 5));
        const def = defs.get("contextBreakdown");
        const folded = def.wire.view((all as unknown[]).reduce((st: unknown, e) => def.apply(st, e), def.init())).messageTokens as number;
        const est = (TokenMeter.prototype as unknown as { estimateMessage(m: unknown): number }).estimateMessage;
        const live = (h.session.deriveMessages() as unknown[]).reduce((n: number, m) => n + est(m), 0);
        expect(folded).toBe(live);
      },
      { native: true },
    );
  });

  it("N6 replay: a restored session derives byte-identical model input, and a fresh process writes nothing", async () => {
    await scenario(
      async (h) => {
        const { unprotected } = await buildTurns(h, 5, 300);
        queuePendingOp(h.db, h.key, unprotected[0]!, "drop", Date.now());
        h.setNowOffset(6 * 60_000);
        await h.step();
        h.setNowOffset(0);
        const live = bytes(wire(h.session));
        const restored = Session.create(SessionId(String(h.session.id)), [...sessionEvents(h.session)] as never);
        expect(bytes(wire(restored))).toEqual(live);
        const before = sessionEvents(h.session).length;
        await h.step({ fresh: true });
        await h.step();
        expect(sessionEvents(h.session).length).toBe(before);
        expect(bytes(wire(h.session))).toEqual(live);
      },
      { native: true },
    );
  });

  it("N7 only a drop-gate ride lands a queued drop (no ride → queued, prefix unchanged)", async () => {
    await scenario(
      async (h) => {
        const { unprotected } = await buildTurns(h, 6);
        const victims = unprotected.slice(0, 2);
        for (const t of victims) queuePendingOp(h.db, h.key, t, "drop", Date.now());
        let before = bytes(wire(h.session));
        for (let k = 7; k <= 8; k += 1) {
          addToolTurn(h.session, k, 50);
          await h.step();
          const after = bytes(wire(h.session));
          expect(after.slice(0, before.length)).toEqual(before);
          before = after;
        }
        expect(h.pending()).toEqual([...victims].sort((a, b) => a - b));
        expect(wire(h.session).some((m) => m.content.startsWith("[dropped"))).toBe(false);
        // historian publication is a ride
        await new Promise((r) => setTimeout(r, 3));
        stageDshCompactionMarker(h.db, h.key, { ordinal: 2, endMessageId: "m-2", tokensBefore: 1000, summary: "s" });
        await h.step();
        const dropped = wire(h.session).filter((m) => m.content.startsWith("[dropped"));
        expect(dropped.map((m) => m.role)).toEqual(["tool", "tool"]);
        expect(h.pending()).toEqual([]);
      },
      { native: true },
    );
  });

  it("N8 pressure truncation writes only tool nodes (never assistant text or tool_use input)", async () => {
    const pressure = { projectedTokens: 1000, contextWindow: 24_000 };
    await scenario(
      async (h) => {
        const body = (name: string) =>
          Array.from({ length: 300 }, (_, i) => `${i + 1}: ${name} line ${i + 1} ${"x".repeat(32)}`).join("\n");
        for (const [i, name] of [[1, "alpha"], [2, "beta"], [3, "gamma"]] as const) {
          addUser(h.session, `Turn ${i}: read file ${i}`);
          h.session.append("request/header", { header: { config: { provider: "d", model: "m", maxTokens: 4096 } } } as never);
          addCall(h.session, i, { args: JSON.stringify({ file_path: `f${i}.ts` }), name: "read" });
          addResult(h.session, i, body(name));
          addReply(h.session, i);
          pressure.projectedTokens = i === 1 ? 9_000 : i === 2 ? 14_000 : 19_100;
          if (i === 3) {
            h.session.append(
              "assistant/message",
              { turn: 4, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: "text", text: "" }], provider: "d", model: "m", source: { kind: "model", provider: "d", model: "m" } } as never), usage: { inputTokens: 19_100, outputTokens: 1 } } as never,
              { surfaceOp: "append" },
            );
          }
          await h.step();
        }
        const w = wire(h.session);
        const alpha = w.find((m) => m.content.includes("alpha line 1 "))!;
        expect(alpha.role).toBe("tool");
        expect(alpha.content).toMatch(/truncated by Magic Context/);
        for (const m of w.filter((x) => x.role === "assistant")) {
          expect(m.content).not.toMatch(/truncated by Magic Context|\u00a7\d+\u00a7/);
          for (const c of m.calls ?? []) expect(c.arguments).toMatch(/^\{"file_path":"f\d\.ts"\}$/);
        }
        for (const e of replaces(h.session)) expect(["tool/result", "user/message"]).toContain(e.type);
      },
      { native: true, pressure },
    );
  });

  it("N9 historian (native compaction-basic transaction) still replaces the whole region with ONE user/message", async () => {
    await scenario(
      async (h) => {
        await buildTurns(h, 4, 200);
        const nodes = [...h.session.surface.nodes];
        // region: turns 1-3 (12 nodes, tool/result rewrites included)
        const start = nodes[0]!;
        const end = nodes[11]!;
        // The meter's own fixed estimator, over the live surface (the real
        // service also needs the agent loop's step/start events).
        const est = (m: unknown) => (TokenMeter.prototype as unknown as { estimateMessage(x: unknown): number }).estimateMessage(m);
        const meter = {
          estimateMessage: est,
          measure: (s: Session) => {
            const nodes = s.surface.nodes.map((seq) => {
              const t = est(deriveEventMessage(sessionEventAt(s, seq)!));
              return { seq, tokens: t, heuristicTokens: t };
            });
            return { nodes, totalTokens: nodes.reduce((n, x) => n + x.tokens, 0) };
          },
        };
        const ctx = new Context();
        const engine = new MagicCompactionEngine(ctx as never, { auto: false } as never);
        const hook = async () => ({ summary: [{ type: "text", text: "<session-history>turns 1-3</session-history>" }], provider: "d", model: "m" });
        const host = { summarizeHook: () => hook };
        Object.defineProperty(engine, "ctx", {
          value: Object.assign(Object.create(ctx), {
            llm: { resolveModelInfo: async () => ({ context: { contextWindow: WINDOW }, defaultMaxTokens: 4096 }) },
            logger: { info: () => {}, warn: () => {} },
            tokenMeter: meter,
            get: (name: string) => (name === "magicContextHost" ? host : undefined),
          }),
          configurable: true,
        });
        (h.session.append as unknown as (t: string, d: unknown) => unknown).call(h.session, "turn/start", { turn: 5 });
        const from = sessionEvents(h.session).length;
        const agent = { id: h.session.id, session: h.session, options: { provider: "d", model: "m" } };
        await engine.compactRegion(start as never, end as never, agent as never, new AbortController().signal);
        const added = events(h.session).slice(from);
        const surfaceAdds = added.filter((e) => e.surfaceOp !== null && typeof e.surfaceOp === "object");
        expect(surfaceAdds.length).toBe(1);
        expect(surfaceAdds[0]!.type).toBe("user/message");
        expect(surfaceAdds[0]!.surfaceOp).toMatchObject({ op: "replace", startSeq: start, endSeq: end });
        expect(added.map((e) => e.type)).toContain("compaction/summary");
        // the next pass is clean on the checkpointed surface
        const before = sessionEvents(h.session).length;
        await h.step();
        const after = events(h.session).slice(before);
        for (const e of after) expect(e.type).not.toBe("assistant/message");
        expect(roles(wire(h.session)).slice(1)).toEqual(["user", "assistant+calls", "tool", "assistant"]);
        expect(h.logs.some((l) => /failed|abandoned/.test(l))).toBe(false);
      },
      { native: true },
    );
  });

  it("N10 the first-call preview tags a new user input under the key core will use (no fold offset)", async () => {
    await scenario(
      async (h) => {
        addToolTurn(h.session, 1, 50);
        await h.step();
        addUser(h.session, "question 2");
        addCall(h.session, 2, { text: "reading 2" });
        addResult(h.session, 2, "BODY2 ".repeat(20));
        await h.step();
        const input = createUserMessage({ content: [{ type: "text", text: "question 3" }], source: { kind: "user" } }) as unknown as {
          id: string;
          content: Array<{ text: string }>;
        };
        const messages: unknown[] = [input];
        await h.step({ messages });
        const previewed = (messages[0] as { content: Array<{ text: string }> }).content[0]!.text;
        const m = TAG.exec(previewed);
        expect(m).not.toBeNull();
        const row = h.tags().find((t) => t.tag_number === Number(m![1]));
        expect(row?.message_id).toBe(`${input.id}:p0`);
      },
      { native: true },
    );
  });
});

describe("round 36 line G: tag scheme is frozen when the session is first seen", () => {
  it("S1 a session Magic already worked on stays on the fold view when the switch is turned on", async () => {
    await scenario(async (h) => {
      addToolTurn(h.session, 1, 50);
      await h.step();
      addToolTurn(h.session, 2, 50);
      h.setNative(true);
      await h.step();
      // fold view: the tool-call assistant + result are folded into a Magic user copy
      expect(wire(h.session).some((m) => m.content.includes("Magic Context note"))).toBe(true);
      expect(replaces(h.session).some((e) => e.type === "tool/result")).toBe(false);
      expect(events(h.session).some((e) => e.type === "compaction/prune")).toBe(false);
    });
  });

  it("S2 a native session stays native when the switch is turned off later", async () => {
    await scenario(
      async (h) => {
        addToolTurn(h.session, 1, 50);
        await h.step();
        h.setNative(false);
        addToolTurn(h.session, 2, 50);
        await h.step({ fresh: true });
        const w = wire(h.session);
        expect(roles(w)).toEqual(["user", "assistant+calls", "tool", "assistant", "user", "assistant+calls", "tool", "assistant"]);
        expect(w[6]!.content).toMatch(TAG);
        expect(w.some((m) => m.content.includes("Magic Context note"))).toBe(false);
      },
      { native: true },
    );
  });

  it("S3 switch off (default): a new session gets the legacy fold view", async () => {
    await scenario(async (h) => {
      addToolTurn(h.session, 1, 50);
      await h.step();
      expect(wire(h.session).some((m) => m.content.includes("Magic Context note"))).toBe(true);
      expect(events(h.session).some((e) => e.type === "compaction/prune")).toBe(false);
    });
  });
});
