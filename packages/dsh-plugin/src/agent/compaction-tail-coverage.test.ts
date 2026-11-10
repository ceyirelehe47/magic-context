/**
 * Round 37 phase 2, segment 9 (known limitation 36) — after a native
 * compaction, every message the checkpoint shadows must stay visible either
 * through a compartment the checkpoint renders, verbatim as raw history, or as
 * a line of the checkpoint's `<unsummarized_tail>` (acceptance 5: summary and
 * raw history never both invisible).
 *
 * Evidence (evo bench 42729564554 @ d5158e995, turn 6, main request 215 = first
 * request after compaction 1): the mini-historian covered 322–323 and left
 * 324–327 as `<unprocessed_from>`; turn-06.log:118 says
 * "[magic-context] summarize: unsummarized tail 324-327 not carried (budget
 * 300377 chars of region 395183)". 324–327 are two tool-only round trips
 * (reasoning + `read` call on files.py, no assistant text; tool output). The
 * tail renderer keeps user/assistant TEXT only, so it rendered nothing and the
 * hook dropped the block: for 89 main requests (215–308) those four messages
 * were neither summarized nor raw (only ctx_expand / the history view had them).
 *
 * Rig: the PRODUCTION pre-step chain in DSH order (knowledge gate → context
 * plane → native pressure backstop = production MagicCompactionEngine over the
 * real compaction-basic transaction, real DSH TokenMeter, the real Magic
 * summarize hook with a stubbed historian LLM that, like the real one, covers
 * through the last message with user-facing text) on a real DSH Session and a
 * file DB — the rig of checkpoint-baseline-overlap.test.ts (O1–O7) plus
 * tool-only steps inside one long turn.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { appendCompartments, getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { queueDropsForCompartmentalizedMessages } from "@magic-context/core/hooks/magic-context/compartment-runner-drop-queue";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { Database } from "@magic-context/core/shared/sqlite";
import { MagicCompactionEngine } from "../compat/dsh-0.1/compaction";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  sessionEvents,
} from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createBackstopGuard } from "./backstop-guard";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { createMagicSummarizeHook, renderUnsummarizedTail, UNSUMMARIZED_TAIL_MAX_CHARS, type DshSummarizeCall } from "./historian";
import { historyContentProvider, transcriptRawMessageProvider } from "./historian-wiring";
import { createKnowledgeGateState, runKnowledgeGateStep, type KnowledgeGateDeps } from "./knowledge-gate";
import { initializeDshAdapterTables, stageDshCompactionMarker } from "./outbox";
import { NATIVE_ROLES_ENV } from "./tag-scheme";

const HOME = "c0ffee01";
const ROUTE = { provider: "opencode-go-40k", model: "deepseek-v4.1-flash" };
const WINDOW = 40_000;
/** Backstop at 8 % of the window (3 200 tokens), small retained tail (the rig's turns are ~470 tokens each). */
const POLICY = { ...ROUTE, headroomTokens: 0, thresholdRatio: 0.08, retainTokens: 1200, maxTokens: 4096 };

let savedEnv: string | undefined;
let savedDebug: string | undefined;
beforeAll(() => {
  savedEnv = process.env[NATIVE_ROLES_ENV];
  delete process.env[NATIVE_ROLES_ENV];
  savedDebug = process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN;
  delete process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN;
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env[NATIVE_ROLES_ENV];
  else process.env[NATIVE_ROLES_ENV] = savedEnv;
  if (savedDebug === undefined) delete process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN;
  else process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN = savedDebug;
});

type Wire = {
  role: string;
  content: string;
  sourceKind?: string;
  sourceId?: string;
  toolCallId?: string;
  calls?: string[];
  reasoning?: number;
  replay?: boolean;
};

function wire(session: Session): Wire[] {
  return (session.deriveMessages() as unknown as Array<Record<string, unknown>>).map((m) => {
    const blocks = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
    const source = (m.source ?? {}) as { kind?: unknown; messageId?: unknown; replayState?: unknown };
    const calls = blocks.filter((b) => b.type === "tool-call").map((b) => String(b.id));
    const reasoning = blocks.filter((b) => b.type === "reasoning").length;
    return {
      role: String(m.role),
      content: blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("|"),
      ...(typeof source.kind === "string" ? { sourceKind: source.kind } : {}),
      ...(typeof source.messageId === "string" ? { sourceId: source.messageId } : {}),
      ...(typeof m.toolCallId === "string" ? { toolCallId: m.toolCallId } : {}),
      ...(calls.length > 0 ? { calls } : {}),
      ...(reasoning > 0 ? { reasoning } : {}),
      ...(source.replayState !== undefined ? { replay: true } : {}),
    };
  });
}

function protocolViolations(w: Wire[]): string[] {
  const out: string[] = [];
  let open: Set<string> | null = null;
  for (let i = 0; i < w.length; i += 1) {
    const m = w[i]!;
    if (m.role === "tool") {
      if (open === null || m.toolCallId === undefined || !open.delete(m.toolCallId)) out.push(`#${i} tool ${m.toolCallId} unpaired`);
      continue;
    }
    if (open !== null && open.size > 0) out.push(`calls ${[...open].join(",")} unanswered before #${i}`);
    open = m.role === "assistant" && m.calls ? new Set(m.calls) : null;
  }
  return out;
}

const SRC = { kind: "model", provider: ROUTE.provider, model: ROUTE.model };
const replayOf = (i: number | string) => ({
  response: { kind: "pi-ai", version: 2, responseId: `resp-${i}`, stopReason: "toolUse" },
  blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" }],
});

/** Every compartment title is unique (`ARC-…` historian, `CPK-…` backstop mini-historian). */
const TITLE = /\b(?:ARC|CPK)-[A-Z0-9-]+\b/g;

interface Published {
  title: string;
  start: number;
  end: number;
  /** Turns whose question/answer ordinals lie inside [start, end]. */
  turns: number[];
}

interface Snapshot {
  label: string;
  wire: Wire[];
  /** Messages (indices) carrying compartment content: the live full-history summaries. */
  summaries: number[];
  visibleTitles: Set<string>;
  /** Ordinals of the history view when the request was sent. */
  ordinals: Set<number>;
}

interface Rig {
  db: Database;
  key: string;
  session: Session;
  logs: string[];
  requests: Snapshot[];
  /** One user turn: prompt step (request) → call + result → reply step (request) → reply. */
  turn: (
    i: number,
    opts?: { text?: string; size?: number; compactAt?: "prompt" | "reply" | "both"; toolSteps?: number; compactAtToolStep?: number },
  ) => Promise<void>;
  /** A pre-step without new input (request). */
  pass: (opts?: { compact?: boolean; label?: string }) => Promise<void>;
  publish: (title: string, throughTurn: number) => Promise<void>;
  restart: () => void;
  compactions: () => number;
  published: () => Published[];
  checkpointLive: () => number;
}

let seq = 0;
async function rig(fn: (r: Rig) => Promise<void>, opts: { retainTokens?: number; coverAll?: boolean; coverReading?: boolean; fold?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-ckpt-overlap-"));
  const db: Database = await createTestDb(join(dir, "context.db"));
  initializeDshAdapterTables(db);
  seq += 1;
  const sid = `sess-ckpt-overlap-${seq}-${Date.now()}`;
  const key = `dsh:${HOME}:${sid}`;
  const header = { id: SessionId(sid), version: 4, createdAt: Date.now(), isSeeded: false, cwd: dir };
  const logs: string[] = [];
  const requests: Snapshot[] = [];
  let backstopCalls = 0;
  try {
    const host = {
      ready: Promise.resolve({ kind: "ok" as const, db, storageDir: dir, livenessPath: "" }),
      canonicalKey: (id: string) => `dsh:${HOME}:${id}`,
    };
    const kDeps = {
      host,
      config: { injectDocs: false, compactionOff: false },
      autoSearch: { enabled: false },
      log: (m: string) => logs.push(m),
    } as unknown as KnowledgeGateDeps;
    const pDeps = {
      host,
      config: { protectedTokens: 1500, ...(opts.fold === true ? { nativeRoles: false } : {}) },
      historian: {
        config: { enabled: false, executeThresholdPercentage: 65 },
        readPressure: () => ({ projectedTokens: Math.round(0.3 * WINDOW), contextWindow: WINDOW }),
        fire: () => {},
      },
      cacheTtl: "5m",
      knowledge: { compactionOff: false },
      log: (m: string) => logs.push(m),
    } as unknown as ContextPlaneDeps;

    // Native pressure backstop: production engine, real compaction-basic, real meter.
    const llm: DshSummarizeCall = async (inputChunk) => {
      backstopCalls += 1;
      const title = `CPK-${backstopCalls}`;
      // Real 42729564554 compaction 1: the mini-historian covered through the
      // last message with user-facing text (the subagent report, 322–323) and
      // left the tool round trips after it (324–327) as <unprocessed_from>.
      const view = transcriptRawMessageProvider(agentOf(), key).readMessages();
      let end = inputChunk.startIndex;
      for (const m of view) {
        if (m.ordinal < inputChunk.startIndex || m.ordinal > inputChunk.endIndex) continue;
        const texts = (m.parts as Array<{ type?: unknown; text?: unknown }>).filter((p) => p.type === "text" && typeof p.text === "string" && (opts.coverReading === true ? /(question|answer|reading) \d+/ : /(question|answer) \d+/).test(String(p.text)));
        if (texts.length > 0) end = m.ordinal;
      }
      if (opts.coverAll === true) end = inputChunk.endIndex;
      return `<output>
<compartments>
<compartment start="${inputChunk.startIndex}" end="${end}" title="${title}" episode_type="design" importance="50">
<p1>${title} content</p1>
<p2>${title} p2</p2>
<p3>${title} p3</p3>
<p4>${title}</p4>
</compartment>
</compartments>
<facts>
</facts>
<meta>
<messages_processed>${inputChunk.startIndex}-${end}</messages_processed>
<unprocessed_from>${end + 1}</unprocessed_from>
</meta>
</output>`;
    };
    const guard = createBackstopGuard({ db: () => db, canonicalKey: (id) => `dsh:${HOME}:${id}` });
    const engineHost = {
      nativePressurePercentage: () => 8,
      summarizeHook: () => (input: never, a: Agent, signal?: AbortSignal) =>
        createMagicSummarizeHook({ db, sessionId: key, ctx: {}, provider: historyContentProvider(a, key), summarize: llm, directory: dir, leaseHolderId: "ckpt-overlap" } as never)(input, a, signal),
      backstopGuard: () => guard,
    };
    const meterCtx = new Context();
    meterCtx.provide("sessionProjections", { register: () => () => {} } as never);
    const meter = new (TokenMeter as unknown as new (c: Context) => { measure(s: unknown): { totalTokens: number } })(meterCtx);
    const ctx = new Context();
    const policy = { ...POLICY, ...(opts.retainTokens !== undefined ? { retainTokens: opts.retainTokens } : {}) };
    const engine = new MagicCompactionEngine(ctx as never, { auto: false, modelPolicies: [policy] } as never);
    Object.defineProperty(engine, "ctx", {
      value: Object.assign(Object.create(ctx), {
        llm: { resolveModelInfo: async () => ({ context: { contextWindow: WINDOW }, defaultMaxTokens: 4096 }) },
        logger: { info: () => {}, warn: (m: string) => logs.push(`warn ${m}`) },
        tokenMeter: meter,
        get: (name: string) => (name === "magicContextHost" ? engineHost : undefined),
      }),
      configurable: true,
    });

    let kState = createKnowledgeGateState();
    let pState = createContextPlaneState();
    let compactions = 0;
    const published: Published[] = [];
    const agentOf = () => ({ id: r.session.id, session: r.session, options: ROUTE }) as unknown as Agent;

    /** Ordinal (history view) → turn, from the question / answer texts. */
    const turnsIn = (start: number, end: number): number[] => {
      const view = transcriptRawMessageProvider(agentOf(), key).readMessages();
      const out = new Set<number>();
      for (const m of view) {
        if (m.ordinal < start || m.ordinal > end) continue;
        for (const p of m.parts as Array<{ text?: unknown }>) {
          const match = typeof p.text === "string" ? /(?:^|§ )question (\d+)$/m.exec(p.text) : null;
          if (match) out.add(Number(match[1]));
        }
      }
      return [...out].sort((a, b) => a - b);
    };

    const snapshot = (label: string) => {
      const w = wire(r.session);
      const summaries: number[] = [];
      const visibleTitles = new Set<string>();
      w.forEach((m, i) => {
        if (m.role !== "user") return;
        if (m.sourceKind === "user") return; // the user's own words are never a summary
        const titles = m.content.match(TITLE) ?? [];
        if (titles.length === 0) return;
        summaries.push(i);
        for (const t of titles) visibleTitles.add(t);
      });
      const ordinals = new Set(transcriptRawMessageProvider(agentOf(), key).readMessages().map((m) => m.ordinal));
      requests.push({ label, wire: w, summaries, visibleTitles, ordinals });
    };

    const append = (type: string, data: unknown) => (r.session.append as unknown as (t: string, d: unknown) => unknown).call(r.session, type, data);
    /**
     * One DSH step: pre-step chain (gate → plane → backstop → terminal), the
     * batch lands, then `step/start` + one `request/header` = the provider
     * request (snapshot). `step === undefined` = a bare pre-step (no request
     * series events; idempotence checks).
     */
    const step = async (messages: unknown[], compact: boolean, label: string, at?: { turn: number; step: number }) => {
      // DSH order (42459290880 log): turn/start, step/start, pre-step (batch lands), request/header, response.
      if (at !== undefined) append("step/start", at);
      const agent = agentOf();
      const terminal = async () => ({ reject: false, messages }) as never;
      const backstop = async () => {
        if (compact) {
          const before = Number(r.session.seq);
          await engine.compactIfNeeded(agent, "pressure", new AbortController().signal).catch((e: unknown) => {
            logs.push(`backstop error ${e instanceof Error ? e.message : String(e)}`);
            return null;
          });
          for (let s = before; s < Number(r.session.seq); s += 1) {
            const ev = (r.session as unknown as { eventAt(x: number): { type: string } }).eventAt(s);
            if (ev.type === "compaction/end") compactions += 1;
          }
        }
        return terminal();
      };
      await runKnowledgeGateStep(kState, kDeps, { agent: agent as never, messages: messages as never }, () =>
        runContextPlaneStep(pState, pDeps, { agent: agent as never, messages: messages as never }, backstop),
      );
      for (const m of messages) r.session.append("user/message", m as never, { surfaceOp: "append" });
      if (at !== undefined) {
        // DSH writes one request/header per provider request (42459290880: 419 headers / 419 main requests).
        append("request/header", {
          header: { config: { ...ROUTE, maxTokens: 4096 }, adapterDefaults: { maxTokens: true } },
          reason: requests.length === 0 ? "initial" : "series",
        });
      }
      snapshot(label);
    };

    const r: Rig = {
      db,
      key,
      logs,
      requests,
      session: Session.create(SessionId(sid), undefined, header as never),
      turn: async (i, o) => {
        const size = o?.size ?? 260;
        const at = o?.compactAt;
        append("turn/start", { turn: i });
        await step(
          [createUserMessage({ content: [{ type: "text", text: o?.text ?? `question ${i}` }], source: { kind: "user" } })],
          at === "prompt" || at === "both",
          `t${i}:prompt`,
          { turn: i, step: 1 },
        );
        r.session.append(
          "assistant/message",
          {
            turn: i, step: 1, stream: [],
            message: createAssistantMessage({
              content: [
                { type: "reasoning", text: `thinking about step ${i}` },
                { type: "text", text: `reading ${i}` },
                { type: "tool-call", id: `call-${i}`, name: "read_file", arguments: JSON.stringify({ file_path: `f${i}.ts` }) },
              ],
              provider: ROUTE.provider, model: ROUTE.model, source: { ...SRC, replayState: replayOf(i) },
            } as never),
          } as never,
          { surfaceOp: "append" },
        );
        r.session.append(
          "tool/result",
          { turn: i, step: 1, message: createToolResultMessage({ callId: `call-${i}` as never, content: [{ type: "text", text: `BODY${i} `.repeat(size) }], isError: false }) } as never,
          { surfaceOp: "append" },
        );
        append("step/end", { turn: i, step: 1 });
        // Tool-only steps (reasoning + tool call, no assistant text): the shape
        // of 42729564554 messages 324–327 (two `read` round trips on files.py).
        const toolSteps = o?.toolSteps ?? 0;
        for (let k = 1; k <= toolSteps; k += 1) {
          const stepNo = 1 + k;
          await step([], o?.compactAtToolStep === k, `t${i}:tool${k}`, { turn: i, step: stepNo });
          r.session.append(
            "assistant/message",
            {
              turn: i, step: stepNo, stream: [],
              message: createAssistantMessage({
                content: [
                  { type: "reasoning", text: `need more of file ${i}.${k}` },
                  { type: "tool-call", id: `call-${i}-${k}`, name: "read_file", arguments: JSON.stringify({ file_path: `files-${i}-${k}.py`, offset: 218 }) },
                ],
                provider: ROUTE.provider, model: ROUTE.model, source: { ...SRC, replayState: replayOf(`${i}-${k}`) },
              } as never),
            } as never,
            { surfaceOp: "append" },
          );
          r.session.append(
            "tool/result",
            { turn: i, step: stepNo, message: createToolResultMessage({ callId: `call-${i}-${k}` as never, content: [{ type: "text", text: `SRC${i}-${k} `.repeat(size) }], isError: false }) } as never,
            { surfaceOp: "append" },
          );
          append("step/end", { turn: i, step: stepNo });
        }
        await step([], at === "reply" || at === "both", `t${i}:reply`, { turn: i, step: 2 + toolSteps });
        r.session.append(
          "assistant/message",
          {
            turn: i, step: 2, stream: [],
            message: createAssistantMessage({
              content: [
                { type: "reasoning", text: `wrapping up ${i}` },
                { type: "text", text: `answer ${i}` },
              ],
              provider: ROUTE.provider, model: ROUTE.model, source: { ...SRC, replayState: replayOf(`r${i}`) },
            } as never),
          } as never,
          { surfaceOp: "append" },
        );
        append("step/end", { turn: i, step: 2 + (o?.toolSteps ?? 0) });
        append("turn/end", { turn: i, reason: "completed" });
      },
      pass: async (o) => step([], o?.compact === true, o?.label ?? "pass"),
      publish: async (title, throughTurn) => {
        // Historian atomic publish (publishHistorianResult shape): compartments
        // + queued drops + staged marker, strictly later than the current baseline.
        await new Promise((res) => setTimeout(res, 5));
        const agent = agentOf();
        const provider = transcriptRawMessageProvider(agent, key);
        const view = provider.readMessages();
        const endIdx = view.findIndex((m) =>
          (m.parts as Array<{ text?: unknown }>).some((p) => p.text === `answer ${throughTurn}`),
        );
        if (endIdx < 0) throw new Error(`answer ${throughTurn} not in the history view`);
        const endOrdinal = endIdx + 1;
        const prior = getCompartments(db, key);
        const start = prior.length === 0 ? 1 : prior[prior.length - 1]!.endMessage + 1;
        if (start > endOrdinal) throw new Error(`publish ${title}: already covered through ${start - 1}`);
        appendCompartments(db, key, [{
          sequence: prior.length, startMessage: start, endMessage: endOrdinal,
          startMessageId: view[start - 1]!.id, endMessageId: view[endOrdinal - 1]!.id,
          title, content: `${title} content`, p1: `${title} p1`, p2: "p2", p3: "p3", p4: "p4", importance: 50, episodeType: "design",
        }] as never);
        const cleanup = setRawMessageProvider(key, provider);
        try {
          await queueDropsForCompartmentalizedMessages(db, key, endOrdinal);
        } finally {
          cleanup();
        }
        stageDshCompactionMarker(db, key, { ordinal: endOrdinal, endMessageId: String(view[endOrdinal - 1]!.id), tokensBefore: 1000, summary: title });
        await new Promise((res) => setTimeout(res, 5));
      },
      restart: () => {
        kState = createKnowledgeGateState();
        pState = createContextPlaneState();
        const persisted = sessionEvents(r.session).map((e) => JSON.parse(JSON.stringify(e)) as SessionEvent);
        r.session = Session.create(SessionId(sid), persisted as never, header as never);
      },
      compactions: () => compactions,
      published: () =>
        getCompartments(db, key).map((c) => ({ title: c.title, start: c.startMessage, end: c.endMessage, turns: turnsIn(c.startMessage, c.endMessage) })),
      checkpointLive: () =>
        wire(r.session).filter(
          (m) => m.role === "user" && m.sourceKind !== "user" && m.content.includes("automatically generated checkpoint") && (m.content.match(TITLE) ?? []).length > 0,
        ).length,
    };
    await fn(r);
  } finally {
    // Let the summarize hook's deferred drop queue settle before the DB closes
    // (a test that ends right at the compaction request leaves it in flight).
    await new Promise((res) => setTimeout(res, 50));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The per-request invariants. Returns the violations (empty = clean). */
function auditRequests(r: Rig, fromIndex = 0): string[] {
  const out: string[] = [];
  const comps = r.published();
  const titleTurns = new Map(comps.map((c) => [c.title, c.turns]));
  let prevVisible = new Set<string>();
  for (let k = fromIndex; k < r.requests.length; k += 1) {
    const req = r.requests[k]!;
    const at = `${k}:${req.label}`;
    // one live full-history summary at most
    if (req.summaries.length > 1) {
      out.push(`${at} ${req.summaries.length} live full-history summaries (${req.summaries.map((i) => req.wire[i]!.sourceKind + "/" + (req.wire[i]!.sourceId ?? "")).join(", ")})`);
    }
    // coverage never shrinks
    for (const t of prevVisible) if (!req.visibleTitles.has(t)) out.push(`${at} compartment ${t} no longer visible`);
    prevVisible = req.visibleTitles;
    // every turn visible raw or through a visible compartment
    const texts = req.wire.map((m) => m.content).join("\n");
    const maxTurn = Math.max(0, ...req.wire.flatMap((m) => [...m.content.matchAll(/question (\d+)/g)].map((x) => Number(x[1]))));
    for (let t = 1; t <= maxTurn; t += 1) {
      // raw, or carried verbatim (a checkpoint's unsummarized tail renders the raw text)
      const raw = new RegExp(`\\bquestion ${t}\\b`).test(texts);
      const viaSummary = [...req.visibleTitles].some((title) => (titleTurns.get(title) ?? []).includes(t));
      if (!raw && !viaSummary) out.push(`${at} turn ${t} invisible (no raw, no summary)`);
    }
    const pv = protocolViolations(req.wire);
    if (pv.length > 0) out.push(`${at} protocol ${pv.join("; ")}`);
    for (const a of req.wire.filter((m) => m.role === "assistant")) {
      if (a.reasoning !== 1 || a.replay !== true) {
        out.push(`${at} assistant lost reasoning/replay`);
        break;
      }
    }
  }
  return out;
}

/** Newest coverage: the live summary of the LAST request renders every published compartment. */
function newestCoverageGaps(r: Rig): string[] {
  const last = r.requests[r.requests.length - 1]!;
  const comps = r.published();
  if (comps.length === 0) return [];
  if (last.summaries.length === 0) return ["no live summary while compartments exist"];
  const live = last.wire[last.summaries[last.summaries.length - 1]!]!.content;
  return comps.filter((c) => !live.includes(c.title)).map((c) => `newest summary misses ${c.title}`);
}


interface ViewEntry {
  ordinal: number;
  callIds: string[];
  texts: string[];
}

/** The rig's own messages in the history view (questions / answers / tool calls), by ordinal. */
function historyEntries(r: Rig): ViewEntry[] {
  const view = transcriptRawMessageProvider({ id: r.session.id, session: r.session, options: ROUTE } as unknown as Agent, r.key).readMessages();
  const out: ViewEntry[] = [];
  for (const m of view) {
    const parts = m.parts as Array<{ type?: unknown; text?: unknown; callID?: unknown }>;
    const callIds = [...new Set(parts.filter((p) => p.type === "tool" && typeof p.callID === "string" && /^call-/.test(String(p.callID))).map((p) => String(p.callID)))];
    const texts = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => String(p.text).replace(/^§\d+§ /, ""))
      .filter((t) => /^(question|answer|reading) \d+$/.test(t));
    if (callIds.length > 0 || texts.length > 0) out.push({ ordinal: m.ordinal, callIds, texts });
  }
  return out;
}

/**
 * Acceptance 5 for one request: every rig message is visible raw, through a
 * visible compartment, or as a line of a live `<unsummarized_tail>`.
 */
function invisibleMessages(r: Rig, req: Snapshot): string[] {
  const comps = r.published();
  const visibleRanges = comps.filter((c) => req.visibleTitles.has(c.title)).map((c) => [c.start, c.end] as const);
  const rawCalls = new Set(req.wire.flatMap((m) => [...(m.calls ?? []), ...(m.toolCallId !== undefined ? [m.toolCallId] : [])]));
  const rawText = req.wire.filter((m) => !req.summaries.includes(req.wire.indexOf(m))).map((m) => m.content).join("\n");
  const tailLines = new Set<number>();
  for (const i of req.summaries) {
    for (const block of req.wire[i]!.content.matchAll(/<unsummarized_tail from="(\d+)" to="(\d+)">([\s\S]*?)<\/unsummarized_tail>/g)) {
      for (const line of block[3]!.matchAll(/^\[(\d+)\] /gm)) tailLines.add(Number(line[1]));
    }
  }
  const out: string[] = [];
  for (const e of historyEntries(r)) {
    if (!req.ordinals.has(e.ordinal)) continue; // appended after this request
    if (visibleRanges.some(([s, t]) => e.ordinal >= s && e.ordinal <= t)) continue;
    if (tailLines.has(e.ordinal)) continue;
    const raw = e.callIds.length > 0 ? e.callIds.every((id) => rawCalls.has(id)) : e.texts.every((t) => new RegExp(`(^|§ |\\n|\\|)${t}($|\\n|\\|)`).test(rawText));
    if (raw) continue;
    out.push(`${req.label}: ordinal ${e.ordinal} [${[...e.callIds, ...e.texts].join(",")}] neither summarized, raw nor in the unsummarized tail`);
  }
  return out;
}

function checkpointText(r: Rig, req: Snapshot): string {
  for (const i of req.summaries) {
    const m = req.wire[i]!;
    if (m.content.includes("automatically generated checkpoint")) return m.content;
  }
  return "";
}

describe("round 37 phase 2 segment 9: shadowed-but-unsummarized messages stay visible (limitation 36)", () => {
  it("G1 compaction inside a long turn whose uncovered end is tool-only round trips: every shadowed message is in the tail", async () => {
    await rig(async (r) => {
      for (let i = 1; i <= 8; i += 1) await r.turn(i);
      const firstAfter = () => r.requests.findIndex((q, k) => k > 0 && checkpointText(r, q).length > 0);
      await r.turn(9, { toolSteps: 6, compactAtToolStep: 6 });
      expect(r.compactions()).toBe(1);
      const k = firstAfter();
      expect(k).toBeGreaterThan(0);
      const comps = r.published();
      const coveredEnd = comps.at(-1)!.end;
      // the historian left the tool-only steps of turn 9 unprocessed
      const uncovered = historyEntries(r).filter((e) => e.ordinal > coveredEnd && e.callIds.some((id) => /^call-9-/.test(id)));
      expect(uncovered.length).toBeGreaterThan(0);
      const req = r.requests[k]!;
      // some of them are shadowed by the checkpoint (not raw any more)
      const rawCalls = new Set(req.wire.flatMap((m) => m.calls ?? []));
      expect(uncovered.some((e) => e.callIds.some((id) => !rawCalls.has(id)))).toBe(true);
      expect(invisibleMessages(r, req)).toEqual([]);
      // the tail names the call (tool + arguments) and the ctx_expand range
      const cp = checkpointText(r, req);
      expect(cp).toMatch(/<unsummarized_tail from="\d+" to="\d+">/);
      expect(cp).toContain("read_file");
      expect(cp).toContain("files-9-1.py");
      expect(cp).toMatch(/ctx_expand \d+-\d+/);
      for (let j = k; j < r.requests.length; j += 1) expect(invisibleMessages(r, r.requests[j]!)).toEqual([]);
    });
  });

  it("G1b the real 42729564554 shape: the uncovered end holds no assistant/user text at all — the tail block must still be carried", async () => {
    await rig(async (r) => {
      for (let i = 1; i <= 8; i += 1) await r.turn(i);
      await r.turn(9, { toolSteps: 6, compactAtToolStep: 6 });
      expect(r.compactions()).toBe(1);
      const k = r.requests.findIndex((q) => checkpointText(r, q).length > 0);
      const req = r.requests[k]!;
      const coveredEnd = r.published().at(-1)!.end;
      const uncovered = historyEntries(r).filter((e) => req.ordinals.has(e.ordinal) && e.ordinal > coveredEnd);
      // nothing after the covered end carries text the old renderer keeps
      expect(uncovered.filter((e) => e.texts.length > 0 && e.ordinal <= Math.max(...uncovered.filter((u) => !u.callIds.every((id) => (req.wire.flatMap((m) => m.calls ?? [])).includes(id))).map((u) => u.ordinal)))).toEqual([]);
      expect(invisibleMessages(r, req)).toEqual([]);
      expect(checkpointText(r, req)).toMatch(/<unsummarized_tail from="\d+" to="\d+">/);
    }, { coverReading: true });
  });

  it("G4 a tool-only tail over the cap stays a block under the cap and counts what it does not list", () => {
    const parts = (i: number) =>
      i % 2 === 0
        ? [{ type: "reasoning", text: "r" }, { type: "tool", tool: "bash", callID: `c${i}`, state: { input: { command: `sed -n '${i},+40p' x.py ${"y".repeat(300)}` } } }]
        : [{ type: "tool", tool: "bash", callID: `c${i - 1}`, state: { output: "o".repeat(5000) } }];
    const provider = { readMessages: () => Array.from({ length: 200 }, (_, k) => ({ ordinal: k + 1, id: `m${k + 1}`, role: k % 2 === 0 ? "assistant" : "user", parts: parts(k) })) } as never;
    const out = renderUnsummarizedTail(provider, 1, 200);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(UNSUMMARIZED_TAIL_MAX_CHARS);
    expect(out).toMatch(/\(\d+ of 200 messages in 1-200 not listed here for size; ctx_expand 1-200 returns every one\)/);
    expect(out).toContain("[200] tool result: bash (5000 chars, output omitted)"); // newest kept
    const small = renderUnsummarizedTail(provider, 199, 200);
    expect(small.split("\n").at(-2)).toBe("[200] tool result: bash (5000 chars, output omitted)");
    expect(small).toContain("[199] tool call: bash {\"command\":\"sed -n '198,+40p' x.py");
  });

  it("G2 the same session continues: every request stays visible, and the checkpoint (with its tail) still retires once a publication covers it", async () => {
    await rig(async (r) => {
      for (let i = 1; i <= 8; i += 1) await r.turn(i);
      await r.turn(9, { toolSteps: 6, compactAtToolStep: 6 });
      expect(r.compactions()).toBe(1);
      await r.turn(10);
      expect(r.checkpointLive()).toBe(1); // its tail reaches past the compartments: waits (O6 rule)
      await r.publish("ARC-ONE", 10);
      await r.turn(11);
      await r.turn(12);
      expect(r.checkpointLive()).toBe(0);
      for (const req of r.requests) expect(invisibleMessages(r, req)).toEqual([]);
      expect(auditRequests(r).filter((v) => !v.includes("live full-history summaries"))).toEqual([]);
      expect(newestCoverageGaps(r)).toEqual([]);
    });
  });

  it("G3 guard: a region the historian covers completely renders no tail block (unchanged)", async () => {
    await rig(async (r) => {
      for (let i = 1; i <= 8; i += 1) await r.turn(i);
      await r.turn(9, { toolSteps: 6, compactAtToolStep: 6 });
      expect(r.compactions()).toBe(1);
      const req = r.requests.find((q) => checkpointText(r, q).length > 0)!;
      expect(checkpointText(r, req)).not.toContain("unsummarized_tail");
      expect(invisibleMessages(r, req)).toEqual([]);
    }, { coverAll: true });
  });
});
