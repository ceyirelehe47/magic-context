/**
 * Round 37 phase 2 — REAL ctx_expand acceptance.
 *
 * D4 (default-native-roles.test.ts) appends a hand-written `ctx_expand` call and
 * a fixed result: it proves the message protocol continues, not that expand
 * works. Here every step goes through the production path:
 *
 *   - a real DSH `Session` tagged by the real context plane (native roles, the
 *     default for a new session);
 *   - the plugin's ctx_* tools registered by `registerCtxTools` into the REAL
 *     DSH tool registry (`@deepseek-ai/dsh-tools` ToolRuntime) and called
 *     through `ToolRuntime.execute` — the entry the agent loop uses;
 *   - a real drop: `ctx_reduce` through the registry, landed by the context
 *     plane on a cache-cold ride (the tool output becomes `[dropped …]`);
 *   - a real compaction: the production MagicCompactionEngine region
 *     transaction (compaction-basic) over turns 1-2;
 *   - `ctx_expand` (verbose range → one message by ordinal) through the
 *     registry: the recovered text must be the ORIGINAL tool output bytes from
 *     the session's durable event log, absent from everything the provider gets;
 *   - the model continues: its ctx_expand call and the registry's materialized
 *     result are appended, then two more tool steps; the provider view keeps the
 *     tool protocol, roles, reasoning and replay metadata.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
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
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { NATIVE_ROLES_ENV } from "./tag-scheme";
import { registerCtxTools } from "./tools";

const WINDOW = 100_000;
const HOME = "a1b2c3d4";
const NONCE = Math.random().toString(36).slice(2, 10);
const ORIG = (i: number) => `ORIG-${i}-${NONCE}`;
const bodyOf = (i: number) => `${ORIG(i)} line of the original tool output ${i}\n`.repeat(250);

let savedEnv: string | undefined;
beforeAll(() => {
  savedEnv = process.env[NATIVE_ROLES_ENV];
  delete process.env[NATIVE_ROLES_ENV];
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env[NATIVE_ROLES_ENV];
  else process.env[NATIVE_ROLES_ENV] = savedEnv;
});

type Wire = { role: string; content: string; toolCallId?: string; calls?: Array<{ id: string; name: string }>; reasoning?: string[]; replay?: string };
function wire(session: Session): Wire[] {
  return (session.deriveMessages() as unknown as Array<Record<string, unknown>>).map((m) => {
    const blocks = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
    const calls = blocks.filter((b) => b.type === "tool-call").map((b) => ({ id: String(b.id), name: String(b.name) }));
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
function protocolViolations(w: Wire[]): string[] {
  const out: string[] = [];
  let open: Set<string> | null = null;
  for (let i = 0; i < w.length; i += 1) {
    const m = w[i]!;
    if (m.role === "tool") {
      if (open === null || m.toolCallId === undefined || !open.delete(m.toolCallId)) out.push(`#${i} tool ${m.toolCallId} answers no open call`);
      continue;
    }
    if (open !== null && open.size > 0) out.push(`calls ${[...open].join(",")} unanswered before #${i}`);
    open = m.role === "assistant" && m.calls ? new Set(m.calls.map((c) => c.id)) : null;
  }
  return out;
}

const SRC = { kind: "model", provider: "d", model: "m" };
const replayOf = (i: number | string) => ({ response: { kind: "pi-ai", version: 2, responseId: `resp-${i}`, stopReason: "toolUse" }, blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" }] });
function addUser(s: Session, text: string) {
  s.append("user/message", createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }) as never, { surfaceOp: "append" });
}
function addCall(s: Session, i: number | string, calls: Array<{ id: string; name: string; args: unknown }>) {
  const content: unknown[] = [{ type: "reasoning", text: `thinking about step ${i}` }];
  for (const c of calls) content.push({ type: "tool-call", id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
  s.append(
    "assistant/message",
    { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content, provider: "d", model: "m", source: { ...SRC, replayState: replayOf(i) } } as never) } as never,
    { surfaceOp: "append" },
  );
}
function addResult(s: Session, callId: string, content: unknown[]) {
  s.append("tool/result", { turn: 1, step: 1, message: createToolResultMessage({ callId: callId as never, content: content as never, isError: false }) } as never, { surfaceOp: "append" });
}
function addReply(s: Session, i: number) {
  s.append(
    "assistant/message",
    {
      turn: i,
      step: 2,
      stream: [],
      message: createAssistantMessage({ content: [{ type: "reasoning", text: `wrapping up ${i}` }, { type: "text", text: `answer ${i}` }], provider: "d", model: "m", source: { ...SRC, replayState: replayOf(`r${i}`) } } as never),
    } as never,
    { surfaceOp: "append" },
  );
}

/** The real DSH tool registry with the plugin's ctx_* tools registered as in production. */
async function realToolRuntime(db: unknown) {
  const ctx = new Context();
  (ctx as unknown as { plugin(p: unknown): unknown }).plugin({ name: "system-prompt-stub", apply: (c: Context) => void c.provide("systemPrompt", { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 }) } as never);
  (ctx as unknown as { plugin(p: unknown): unknown }).plugin(ToolRuntime as never);
  for (let i = 0; i < 50 && ctx.get("tools") === undefined; i += 1) await new Promise((r) => setTimeout(r, 10));
  const runtime = ctx.get("tools") as ToolRuntime;
  if (runtime === undefined) throw new Error("ToolRuntime did not start");
  registerCtxTools(ctx, {
    db: db as never,
    canonicalKey: (id: string) => `dsh:${HOME}:${id}`,
    resolveProjectIdentity: () => "git:/tmp/dsh-expand-real",
    embeddingEnabled: false,
    memoryEnabled: true,
    dreamerEnabled: false,
  });
  return runtime;
}

/** Model-facing text of a registry result (what the agent loop writes into tool/result). */
function resultText(result: unknown): { text: string; content: unknown[]; isError: boolean } {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean; status?: string };
  const content = Array.isArray(r.content) ? r.content : [];
  return { text: content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""), content, isError: r.isError === true || r.status === "error" };
}

describe("round 37 phase 2: real ctx_expand after a real drop and a real compaction", () => {
  it("X1 expand through the DSH tool registry recovers the original stored output, then the model continues with valid protocol", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-expand-real-"));
    const db = await createTestDb(join(dir, "context.db"));
    const sid = `sess-expand-real-${NONCE}`;
    const key = `dsh:${HOME}:${sid}`;
    try {
      const session = Session.create(SessionId(sid));
      const agent = { id: sid, session, options: { provider: "d", model: "m" } };
      let nowOffset = 0;
      const logs: string[] = [];
      const deps = {
        host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: (id: string) => `dsh:${HOME}:${id}` },
        config: { protectedTokens: 4000 },
        historian: { config: { enabled: false, executeThresholdPercentage: 65 }, readPressure: () => ({ projectedTokens: Math.round(0.2 * WINDOW), contextWindow: WINDOW }), fire: () => {} },
        cacheTtl: "5m",
        now: () => Date.now() + nowOffset,
        log: (m: string) => logs.push(m),
      } as unknown as ContextPlaneDeps;
      const state = createContextPlaneState();
      const step = () => runContextPlaneStep(state, deps, { agent: agent as never, messages: [] as never }, async () => ({ reject: false, messages: [] }) as never);
      const runtime = await realToolRuntime(db);
      let callSeq = 0;
      const exec = async (name: string, args: unknown) => {
        callSeq += 1;
        return resultText(await runtime.execute({ callId: `exec-${callSeq}` as never, name, arguments: args, agent: agent as never, signal: new AbortController().signal }));
      };

      for (let i = 1; i <= 6; i += 1) {
        addUser(session, `question ${i}`);
        addCall(session, i, [{ id: `call-${i}`, name: "read_file", args: { file_path: `f${i}.ts` } }]);
        addResult(session, `call-${i}`, [{ type: "text", text: bodyOf(i) }]);
        addReply(session, i);
        await step();
      }
      const storedBody = (callId: string) =>
        sessionEvents(session)
          .filter((e) => e.type === "tool/result")
          .map((e) => (e as unknown as { data: { message: { toolCallId: string; content: Array<{ text?: string }> } } }).data.message)
          .find((m) => m.toolCallId === callId)!.content.map((b) => b.text ?? "").join("");
      expect(storedBody("call-3")).toBe(bodyOf(3));

      // ── real drop: ctx_reduce through the registry, landed on a cache-cold ride
      // turn 3: outside the protected tail (protectedTokens 4000), outside the compacted region (turns 1-2)
      const tag3 = (db.prepare("SELECT tag_number FROM tags WHERE session_id = ? AND message_id = ? AND type = 'tool'").get(key, "call-3") as { tag_number: number }).tag_number;
      const reduce = await exec("ctx_reduce", { drop: String(tag3) });
      expect(reduce.isError).toBe(false);
      expect(reduce.text).toContain(`§${tag3}§`);
      nowOffset = 6 * 60_000;
      await step();
      nowOffset = 0;
      let w = wire(session);
      expect(w.find((m) => m.toolCallId === "call-3")!.content).toMatch(/\[dropped/);
      expect(w.some((m) => m.content.includes(ORIG(3)))).toBe(false);

      // ── real compaction: the production engine's region transaction over turns 1-2
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
      const cctx = new Context();
      const engine = new MagicCompactionEngine(cctx as never, { auto: false } as never);
      const hook = async () => ({ summary: [{ type: "text", text: "<session-history>turns 1-2 summarized</session-history>" }], provider: "d", model: "m" });
      Object.defineProperty(engine, "ctx", {
        value: Object.assign(Object.create(cctx), {
          llm: { resolveModelInfo: async () => ({ context: { contextWindow: WINDOW }, defaultMaxTokens: 4096 }) },
          logger: { info: () => {}, warn: () => {} },
          tokenMeter: meter,
          get: (name: string) => (name === "magicContextHost" ? { summarizeHook: () => hook } : undefined),
        }),
        configurable: true,
      });
      (session.append as unknown as (t: string, d: unknown) => unknown).call(session, "turn/start", { turn: 7 });
      const nodes = [...session.surface.nodes];
      await engine.compactRegion(nodes[0]! as never, nodes[7]! as never, agent as never, new AbortController().signal);
      await step();
      w = wire(session);
      expect(w.some((m) => m.content.includes("turns 1-2 summarized"))).toBe(true);
      expect(w.some((m) => m.content.includes(ORIG(1)))).toBe(false);
      expect(protocolViolations(w)).toEqual([]);

      // ── ctx_expand through the registry: list, then recover one message by ordinal
      const listing = await exec("ctx_expand", { start: 1, end: 40, verbose: true });
      expect(listing.isError).toBe(false);
      // the listing names each message by ordinal; the tool step of turn i is the block with its reasoning
      const blocks = listing.text.split(/\n(?=\[\d+\] )/);
      const ordinalOf = (marker: string) => {
        const block = blocks.find((b) => b.includes(marker));
        expect(block).toBeDefined();
        return Number(/^\[(\d+)\]/.exec(block!)![1]);
      };
      // the tool OUTPUT of turn i: the message at / right after the step's assistant that carries call-i's output
      const recover = async (i: number) => {
        const at = ordinalOf(`thinking about step ${i}`);
        for (const ord of [at, at + 1]) {
          const r = await exec("ctx_expand", { message: ord });
          if (r.text.includes(`#call-${i}]`) && /output:/.test(r.text)) return { ...r, ordinal: ord };
        }
        throw new Error(`no ordinal near ${at} carries the output of call-${i}`);
      };
      const full3 = await recover(3);
      const full1 = await recover(1);
      const ord3 = full3.ordinal;
      for (const [full, i] of [[full3, 3], [full1, 1]] as const) {
        expect(full.isError).toBe(false);
        expect(full.text).toContain("full recovery");
        // the complete original bytes, as stored in the durable session log
        expect(full.text).toContain(storedBody(`call-${i}`).trimEnd());
        expect(full.text.split(ORIG(i)).length - 1).toBe(250);
      }
      // ... and nowhere in what the provider receives (it came from the store, not the context)
      w = wire(session);
      expect(w.some((m) => m.content.includes(ORIG(3)) || m.content.includes(ORIG(1)))).toBe(false);

      // ── the model continues: its expand call + the registry's materialized result, then two more tool steps
      addUser(session, "question 7");
      addCall(session, 7, [{ id: "call-7", name: "ctx_expand", args: { message: ord3 } }]);
      addResult(session, "call-7", full3.content);
      await step();
      addCall(session, 8, [
        { id: "call-8-0", name: "read_file", args: { file_path: "a.ts" } },
        { id: "call-8-1", name: "read_file", args: { file_path: "b.ts" } },
      ]);
      addResult(session, "call-8-0", [{ type: "text", text: "A ".repeat(30) }]);
      addResult(session, "call-8-1", [{ type: "text", text: "B ".repeat(30) }]);
      await step();
      w = wire(session);
      expect(protocolViolations(w)).toEqual([]);
      const roles = w.map((m) => (m.calls ? "assistant+calls" : m.role));
      expect(roles.slice(-6)).toEqual(["user", "assistant+calls", "tool", "assistant+calls", "tool", "tool"]);
      const expandResult = w.find((m) => m.toolCallId === "call-7")!;
      expect(expandResult.content).toContain(ORIG(3));
      for (const a of w.filter((m) => m.role === "assistant")) {
        expect(a.reasoning?.length ?? 0).toBe(1);
        expect(a.replay).toBeDefined();
      }
      expect(logs.some((l) => /failed|abandoned/.test(l))).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
