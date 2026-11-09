/**
 * Round 37 phase 2 (I4 follow-up) — a native compaction checkpoint and the
 * Magic knowledge baseline (m0) must not both stay live when one covers the
 * other.
 *
 * Evidence (evo bench 42459290880 @ 83c5388cd, 200k catalog-hist route, native
 * default): 182 of 419 main requests carry the DSH compact-checkpoint
 * (`compact-checkpoint` source, 15–40 KB, median 29.9 KB) AND the m0
 * `<session-history>`; the checkpoint's compartment range is a subset of the
 * m0's in all 182. Requests 389–429 keep the checkpoint at 1–537 while the m0
 * moved on to 1–589 … 1–713 (an old and a new full baseline live together).
 * Requests 178 / 318 / 431 (first request after each compaction) carry the
 * checkpoint alone (the m0 node was shadowed by the compaction), and the next
 * pre-step re-delivers the m0 at the tail next to it.
 *
 * Rig: the PRODUCTION pre-step chain in DSH order — knowledge gate (outermost)
 * → context plane → native pressure backstop (the production
 * MagicCompactionEngine over the REAL compaction-basic transaction, REAL DSH
 * TokenMeter, the real Magic summarize hook with a stubbed historian LLM) →
 * terminal — on a real DSH `Session` and a file DB; the pre-step batch lands on
 * the session like DSH appends it, and every "provider request" is
 * `session.deriveMessages()` right after a pre-step. Historian publications are
 * the atomic publish shape (compartments + queued drops + staged marker).
 *
 * Assertions on EVERY request (O1–O3 are three orders of the two events):
 *   - at most one live full history summary (m0 or checkpoint) carrying the
 *     compartments, and exactly one once any compartment exists;
 *   - the live summary renders every published compartment (newest coverage,
 *     no gap);
 *   - the set of visible compartments never shrinks from one request to the
 *     next (the first request after a compaction included);
 *   - every turn is visible either raw or through a visible compartment that
 *     covers it (never summary AND raw invisible);
 *   - roles, call ↔ result pairing, reasoning and replay metadata intact.
 * O4: repeated pre-steps and a cold restart write nothing / re-inject nothing;
 * O5: a user message quoting a checkpoint preamble / <session-history> is never
 * retired; O6: a checkpoint that still carries an UNSUMMARIZED tail (history
 * the compartments do not reach yet) stays live.
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
import { createMagicSummarizeHook, type DshSummarizeCall } from "./historian";
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
}

interface Rig {
  db: Database;
  key: string;
  session: Session;
  logs: string[];
  requests: Snapshot[];
  /** One user turn: prompt step (request) → call + result → reply step (request) → reply. */
  turn: (i: number, opts?: { text?: string; size?: number; compactAt?: "prompt" | "reply" | "both" }) => Promise<void>;
  /** A pre-step without new input (request). */
  pass: (opts?: { compact?: boolean; label?: string }) => Promise<void>;
  publish: (title: string, throughTurn: number) => Promise<void>;
  restart: () => void;
  compactions: () => number;
  published: () => Published[];
  checkpointLive: () => number;
}

let seq = 0;
async function rig(fn: (r: Rig) => Promise<void>, opts: { retainTokens?: number; tailLeft?: number; fold?: boolean } = {}) {
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
      let chunk = inputChunk;
      backstopCalls += 1;
      const title = `CPK-${backstopCalls}`;
      // tailLeft: the historian leaves the last N messages of the chunk unprocessed
      // (`<unprocessed_from>`), so the checkpoint carries them as an unsummarized tail.
      const end = chunk.endIndex - (opts.tailLeft ?? 0);
      chunk = { ...chunk, endIndex: end };
      return `<output>
<compartments>
<compartment start="${chunk.startIndex}" end="${chunk.endIndex}" title="${title}" episode_type="design" importance="50">
<p1>${title} content</p1>
<p2>${title} p2</p2>
<p3>${title} p3</p3>
<p4>${title}</p4>
</compartment>
</compartments>
<facts>
</facts>
<meta>
<messages_processed>${chunk.startIndex}-${chunk.endIndex}</messages_processed>
<unprocessed_from>${chunk.endIndex + 1}</unprocessed_from>
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
      requests.push({ label, wire: w, summaries, visibleTitles });
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
        await step([], at === "reply" || at === "both", `t${i}:reply`, { turn: i, step: 2 });
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
        append("step/end", { turn: i, step: 2 });
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

describe("round 37 phase 2: native compaction checkpoint vs knowledge baseline — one live full summary", () => {
  it("O1 backstop compaction first, then historian publications: the checkpoint retires once a baseline covers it", async () => {
    await rig(async (r) => {
      for (let i = 1; i <= 8; i += 1) await r.turn(i);
      await r.turn(9, { compactAt: "prompt" });
      expect(r.compactions()).toBe(1);
      await r.turn(10);
      await r.turn(11);
      await r.publish("ARC-ONE", 10);
      await r.turn(12);
      await r.turn(13);
      await r.publish("ARC-TWO", 12);
      await r.turn(14);
      expect(auditRequests(r)).toEqual([]);
      expect(newestCoverageGaps(r)).toEqual([]);
      expect(r.checkpointLive()).toBe(0);
    });
  });

  it("O2 historian publication first, then the backstop compaction (and a publication after it)", async () => {
    await rig(async (r) => {
      for (let i = 1; i <= 5; i += 1) await r.turn(i);
      await r.publish("ARC-ONE", 4);
      for (let i = 6; i <= 9; i += 1) await r.turn(i);
      await r.turn(10, { compactAt: "reply" });
      expect(r.compactions()).toBe(1);
      await r.turn(11);
      await r.turn(12);
      await r.publish("ARC-TWO", 11);
      await r.turn(13);
      expect(auditRequests(r)).toEqual([]);
      expect(newestCoverageGaps(r)).toEqual([]);
    });
  });

  it("O3 several alternations (publish / compact / publish / compact / publish)", async () => {
    await rig(async (r) => {
      for (let i = 1; i <= 5; i += 1) await r.turn(i);
      await r.publish("ARC-ONE", 4);
      for (let i = 6; i <= 9; i += 1) await r.turn(i);
      await r.turn(10, { compactAt: "prompt" });
      await r.turn(11);
      await r.publish("ARC-TWO", 10);
      for (let i = 12; i <= 17; i += 1) await r.turn(i);
      await r.turn(18, { compactAt: "prompt" });
      await r.turn(19);
      await r.publish("ARC-THREE", 18);
      await r.turn(20);
      await r.turn(21);
      expect(r.compactions()).toBe(2);
      expect(auditRequests(r)).toEqual([]);
      expect(newestCoverageGaps(r)).toEqual([]);
    });
  });

  it("O4 repeated pre-steps and a cold restart neither re-inject nor rewrite anything", async () => {
    await rig(async (r) => {
      for (let i = 1; i <= 8; i += 1) await r.turn(i);
      await r.turn(9, { compactAt: "prompt" });
      await r.turn(10);
      await r.publish("ARC-ONE", 9);
      await r.turn(11);
      await r.pass({ label: "settle" });
      const before = sessionEvents(r.session).length;
      const bytes = JSON.stringify(wire(r.session));
      await r.pass();
      await r.pass();
      expect(sessionEvents(r.session).length).toBe(before);
      r.restart();
      const restored = sessionEvents(r.session).length;
      await r.pass({ label: "cold-1" });
      await r.pass({ label: "cold-2" });
      expect(sessionEvents(r.session).length).toBe(restored);
      expect(JSON.stringify(wire(r.session))).toBe(bytes);
      expect(auditRequests(r)).toEqual([]);
      expect(r.checkpointLive()).toBe(0);
    });
  });

  it("O5 a user message quoting the checkpoint preamble and <session-history> is never retired", async () => {
    await rig(async (r) => {
      const quote =
        "This is an automatically generated checkpoint condensing an earlier span — what does it mean? <session-history>ARC-QUOTED-USER text</session-history>";
      for (let i = 1; i <= 8; i += 1) await r.turn(i);
      await r.turn(9, { compactAt: "prompt" });
      await r.turn(10);
      await r.publish("ARC-ONE", 10);
      await r.turn(11, { text: `question 11\n${quote}` });
      await r.turn(12);
      const w = wire(r.session);
      expect(w.filter((m) => m.role === "user" && m.sourceKind === "user" && m.content.includes("ARC-QUOTED-USER")).length).toBe(1);
      const quoteEvents = (sessionEvents(r.session) as Array<SessionEvent & { data?: { source?: { kind?: string } } }>).filter(
        (e) => e.type === "user/message" && JSON.stringify(e.data).includes("ARC-QUOTED-USER"),
      );
      expect(quoteEvents.length).toBe(1); // never replaced
      expect(auditRequests(r)).toEqual([]);
    });
  });

  it("O6 a checkpoint still carrying an unsummarized tail stays live until a publication covers it (never summary + raw both gone)", async () => {
    await rig(async (r) => {
      for (let i = 1; i <= 8; i += 1) await r.turn(i);
      await r.turn(9, { compactAt: "prompt" });
      expect(r.compactions()).toBe(1);
      await r.turn(10);
      // the compartments end before the checkpoint's range: the checkpoint is the
      // only place its tail is visible, so it must stay live next to the m0
      expect(r.checkpointLive()).toBe(1);
      expect(auditRequests(r).filter((v) => !v.includes("live full-history summaries"))).toEqual([]);
      await r.turn(11);
      await r.publish("ARC-ONE", 10);
      await r.turn(12);
      await r.turn(13);
      // once a publication covers the tail, one live summary again
      const last = r.requests.length - 1;
      expect(r.requests[last]!.summaries.length).toBe(1);
      expect(r.checkpointLive()).toBe(0);
      expect(auditRequests(r).filter((v) => !v.includes("live full-history summaries"))).toEqual([]);
      expect(newestCoverageGaps(r)).toEqual([]);
    }, { tailLeft: 3 });
  });

  it("O7 a legacy fold session keeps its pre-fix behaviour (the checkpoint is not retired by this path)", async () => {
    await rig(async (r) => {
      for (let i = 1; i <= 8; i += 1) await r.turn(i);
      await r.turn(9, { compactAt: "prompt" });
      expect(r.compactions()).toBe(1);
      await r.turn(10);
      await r.publish("ARC-ONE", 9);
      await r.turn(11);
      expect(r.logs.filter((l) => l.includes("checkpoint") && l.includes("superseded")).length).toBe(0);
      expect(auditRequests(r).filter((v) => !v.includes("live full-history summaries"))).toEqual([]);
    }, { fold: true });
  });
});
