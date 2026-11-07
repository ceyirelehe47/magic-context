/**
 * Round 37 phase 2 (I4) — a NEW knowledge baseline must REPLACE the previous
 * one in the active request, not pile up next to it.
 *
 * Evidence (evo bench L4 42348192506 @ 853606914, DSH 0.2.1-rc.5, native
 * default): main bodies 139 and 161 carry three Magic `<session-history>`
 * baselines at once — the first (empty) m0, the m0 rendered after the first
 * historian publication (compartments 1-3) and the m0 rendered after the
 * second (compartments 1-3 + 4-18). `knowledge-gate.ts` de-duplicates only on
 * an identical watermark (`isMagicWatermarkOnSurface`); every
 * re-materialization has a new revision, so it prepends a fresh m0 + m1 pair to
 * the current pre-step batch (DSH appends it at the tail) and the older full
 * baselines stay live surface nodes.
 *
 * These cases drive the PRODUCTION pre-step chain (knowledge gate outermost →
 * context plane → terminal), let the pre-step batch land on a real DSH
 * `Session` the way DSH does (`user/message`, surfaceOp append), publish
 * compartments + queued drops the way the historian's atomic publish does,
 * and assert on what the provider request is built from
 * (`session.deriveMessages()`):
 *   K1 two publications → exactly one live Magic m0 with the LATEST
 *      `<session-history>` (every compartment present), one m1, the covered raw
 *      messages gone, nothing lost;
 *   K2 repeating the pre-step and a cold restart (fresh gate / plane state,
 *      `Session.create` from the persisted events) write nothing;
 *   K3 a pass without a new materialization never rewrites the m0 / m1 nodes
 *      (stable prefix byte-identical), and m0 / m1 stay two separate messages;
 *   K4 identification is by controlled source + message identity: a user
 *      message that itself quotes `<session-history>` stays in the request;
 *   K5 publication committed but the baseline update not done (process died
 *      after the materialization was persisted, or the gate failed open while
 *      the plane ran): the covered raw messages stay visible until a baseline
 *      rendering that publication is on the surface; recovery converges on one
 *      live m0;
 *   K6 roles, call ↔ result pairing, reasoning and replay metadata survive;
 *      the event log keeps the superseded baselines (history), the surface does
 *      not.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import { appendCompartments, getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { queueDropsForCompartmentalizedMessages } from "@magic-context/core/hooks/magic-context/compartment-runner-drop-queue";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  sessionEvents,
} from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { createKnowledgeGateState, runKnowledgeGateStep, type KnowledgeGateDeps } from "./knowledge-gate";
import { transcriptRawMessageProvider } from "./historian-wiring";
import { stageDshCompactionMarker } from "./outbox";
import { NATIVE_ROLES_ENV } from "./tag-scheme";

const HOME = "a1b2c3d4";
const WINDOW = 100_000;

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

const isMagic = (m: Wire) => m.sourceKind === "magic-context";
/** Live Magic full baselines (m0) in the request: Magic source + mc-kb id without the :m1 suffix. */
const liveM0 = (w: Wire[]) => w.filter((m) => isMagic(m) && (m.sourceId ?? "").startsWith("mc-kb:") && !(m.sourceId ?? "").endsWith(":m1"));
const liveM1 = (w: Wire[]) => w.filter((m) => isMagic(m) && (m.sourceId ?? "").startsWith("mc-kb:") && (m.sourceId ?? "").endsWith(":m1"));
/** Any Magic-sourced message carrying a session-history block (the L4 symptom, counted by source). */
const magicHistories = (w: Wire[]) => w.filter((m) => isMagic(m) && m.content.includes("<session-history>"));

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

const SRC = { kind: "model", provider: "d", model: "m" };
const replayOf = (i: number | string) => ({
  response: { kind: "pi-ai", version: 2, responseId: `resp-${i}`, stopReason: "toolUse" },
  blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" }],
});

function appendUserEvent(session: Session, message: unknown) {
  session.append("user/message", message as never, { surfaceOp: "append" });
}
function addCalls(session: Session, i: number) {
  session.append(
    "assistant/message",
    {
      turn: i,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [
          { type: "reasoning", text: `thinking about step ${i}` },
          { type: "text", text: `reading ${i}` },
          { type: "tool-call", id: `call-${i}`, name: "read_file", arguments: JSON.stringify({ file_path: `f${i}.ts` }) },
        ],
        provider: "d",
        model: "m",
        source: { ...SRC, replayState: replayOf(i) },
      } as never),
    } as never,
    { surfaceOp: "append" },
  );
}
function addResult(session: Session, i: number, size: number) {
  session.append(
    "tool/result",
    { turn: i, step: 1, message: createToolResultMessage({ callId: `call-${i}` as never, content: [{ type: "text", text: `BODY${i} `.repeat(size) }], isError: false }) } as never,
    { surfaceOp: "append" },
  );
}
function addReply(session: Session, i: number) {
  session.append(
    "assistant/message",
    {
      turn: i,
      step: 2,
      stream: [],
      message: createAssistantMessage({
        content: [
          { type: "reasoning", text: `wrapping up ${i}` },
          { type: "text", text: `answer ${i}` },
        ],
        provider: "d",
        model: "m",
        source: { ...SRC, replayState: replayOf(`r${i}`) },
      } as never),
    } as never,
    { surfaceOp: "append" },
  );
}

interface H {
  db: Database;
  session: Session;
  key: string;
  dir: string;
  logs: string[];
  /** One production pre-step (gate → plane → terminal); the batch lands on the session like DSH appends it. */
  turn: (i: number, opts?: { text?: string; size?: number; noTools?: boolean }) => Promise<void>;
  /** Pre-step only (no new user prompt): gate → plane over an empty batch. */
  pass: (opts?: { planeOnly?: boolean }) => Promise<void>;
  /** Fresh in-process state (cold restart of gate + plane) over a session restored from its events. */
  restart: () => void;
  publish: (title: string, endOrdinal: number) => Promise<void>;
  ordinalOf: (pred: (text: string) => boolean) => number;
}

let seqId = 0;
async function scenario(fn: (h: H) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-kb-retire-"));
  const db = await createTestDb(join(dir, "c.db"));
  seqId += 1;
  const sid = `sess-kb-retire-${seqId}-${Date.now()}`;
  const key = `dsh:${HOME}:${sid}`;
  const header = { id: SessionId(sid), version: 4, createdAt: Date.now(), isSeeded: false, cwd: dir };
  try {
    const logs: string[] = [];
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
      config: { protectedTokens: 2000 },
      historian: {
        config: { enabled: false, executeThresholdPercentage: 65 },
        readPressure: () => ({ projectedTokens: Math.round(0.3 * WINDOW), contextWindow: WINDOW }),
        fire: () => {},
      },
      cacheTtl: "5m",
      // production wiring (agent/index.ts): the gate's switches
      knowledge: { compactionOff: false },
      log: (m: string) => logs.push(m),
    } as unknown as ContextPlaneDeps;
    let kState = createKnowledgeGateState();
    let pState = createContextPlaneState();
    const h: H = {
      db,
      dir,
      key,
      logs,
      session: Session.create(SessionId(sid), undefined, header as never),
      turn: async (i, opts) => {
        const messages: unknown[] = [createUserMessage({ content: [{ type: "text", text: opts?.text ?? `question ${i}` }], source: { kind: "user" } })];
        const agent = { id: h.session.id, session: h.session, options: { provider: "d", model: "m" } };
        await runKnowledgeGateStep(kState, kDeps, { agent: agent as never, messages: messages as never }, () =>
          runContextPlaneStep(pState, pDeps, { agent: agent as never, messages: messages as never }, async () => ({ reject: false, messages }) as never),
        );
        for (const m of messages) appendUserEvent(h.session, m);
        if (opts?.noTools === true) return;
        addCalls(h.session, i);
        addResult(h.session, i, opts?.size ?? 40);
        addReply(h.session, i);
      },
      pass: async (opts) => {
        const messages: unknown[] = [];
        const agent = { id: h.session.id, session: h.session, options: { provider: "d", model: "m" } };
        const terminal = async () => ({ reject: false, messages }) as never;
        const plane = () => runContextPlaneStep(pState, pDeps, { agent: agent as never, messages: messages as never }, terminal);
        if (opts?.planeOnly === true) await plane();
        else await runKnowledgeGateStep(kState, kDeps, { agent: agent as never, messages: messages as never }, plane);
        for (const m of messages) appendUserEvent(h.session, m);
      },
      restart: () => {
        kState = createKnowledgeGateState();
        pState = createContextPlaneState();
        const persisted = sessionEvents(h.session).map((e) => JSON.parse(JSON.stringify(e)) as SessionEvent);
        h.session = Session.create(SessionId(sid), persisted as never, header as never);
      },
      publish: async (title, endOrdinal) => {
        // Historian atomic publish, as publishHistorianResult does it:
        // compartments + queued drops + staged marker (strictly later than
        // the current baseline's materialization).
        await new Promise((r) => setTimeout(r, 5));
        const agent = { id: h.session.id, session: h.session, options: { provider: "d", model: "m" } } as unknown as Agent;
        const provider = transcriptRawMessageProvider(agent, key);
        const view = provider.readMessages();
        const prior = getCompartments(db, key);
        const start = prior.length === 0 ? 1 : prior[prior.length - 1]!.endMessage + 1;
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
        await new Promise((r) => setTimeout(r, 5));
      },
      ordinalOf: (pred) => {
        const agent = { id: h.session.id, session: h.session, options: { provider: "d", model: "m" } } as unknown as Agent;
        const view = transcriptRawMessageProvider(agent, key).readMessages();
        const idx = view.findIndex((m) =>
          m.parts.some((p) => p !== null && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" && pred((p as { text: string }).text)),
        );
        if (idx < 0) throw new Error("ordinal not found");
        return idx + 1;
      },
    };
    await fn(h);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Turns 1-3, publish A (through turn 2), turns 4-6, publish B (through turn 5), turn 7. */
async function twoPublications(h: H) {
  for (let i = 1; i <= 3; i += 1) await h.turn(i);
  await h.publish("ARC-ALPHA", h.ordinalOf((t) => t === "answer 2"));
  for (let i = 4; i <= 6; i += 1) await h.turn(i);
  await h.publish("ARC-BRAVO", h.ordinalOf((t) => t === "answer 5"));
  await h.turn(7);
}

describe("round 37 I4: a new knowledge baseline replaces the old one in the active request", () => {
  it("K1 two publications leave exactly one live m0 carrying every compartment; covered raw gone, nothing lost", async () => {
    await scenario(async (h) => {
      await twoPublications(h);
      const w = wire(h.session);
      expect(magicHistories(w).length).toBe(1);
      expect(liveM0(w).length).toBe(1);
      expect(liveM1(w).length).toBe(1);
      const m0 = liveM0(w)[0]!;
      expect(m0.content).toContain("ARC-ALPHA");
      expect(m0.content).toContain("ARC-BRAVO");
      // covered raw (turns 1-5) is out of the request, the live tail stays
      const texts = w.map((m) => m.content).join("\n");
      for (const i of [6, 7]) expect(texts).toContain(`question ${i}`);
      expect(texts).toContain("BODY7");
      expect(protocolViolations(w)).toEqual([]);
    });
  });

  it("K2 repeating the pre-step and a cold restart do not re-inject", async () => {
    await scenario(async (h) => {
      await twoPublications(h);
      const kb = () =>
        (sessionEvents(h.session) as Array<SessionEvent & { data?: { source?: { messageId?: string } } }>).filter((e) =>
          String(e.data?.source?.messageId ?? "").startsWith("mc-kb"),
        ).length;
      const kbBefore = kb();
      // settle: the first empty pass may still tag the last tool result (plane work, not knowledge)
      await h.pass();
      expect(kb()).toBe(kbBefore);
      const before = sessionEvents(h.session).length;
      const bytes = JSON.stringify(wire(h.session));
      await h.pass();
      await h.pass();
      expect(sessionEvents(h.session).length).toBe(before);
      h.restart();
      // Session.create(seed) closes the seed with one session/end-seed event (DSH, not Magic)
      const restored = sessionEvents(h.session).length;
      await h.pass();
      await h.pass();
      expect(sessionEvents(h.session).length).toBe(restored);
      expect(kb()).toBe(kbBefore);
      expect(JSON.stringify(wire(h.session))).toBe(bytes);
      expect(liveM0(wire(h.session)).length).toBe(1);
    });
  });

  it("K3 no new materialization → m0 / m1 nodes are not rewritten; m0 and m1 stay separate messages", async () => {
    await scenario(async (h) => {
      await twoPublications(h);
      const w1 = wire(h.session);
      const m0Index = w1.findIndex((m) => liveM0([m]).length === 1);
      expect(m0Index).toBeGreaterThanOrEqual(0);
      // m1 is its own message right after m0 (cache split contract)
      expect(liveM1([w1[m0Index + 1]!]).length).toBe(1);
      const prefix = JSON.stringify(w1.slice(0, m0Index + 2));
      const eventsBefore = sessionEvents(h.session).length;
      await h.turn(8);
      await h.turn(9);
      const w2 = wire(h.session);
      expect(JSON.stringify(w2.slice(0, m0Index + 2))).toBe(prefix);
      // no event after the snapshot touches a Magic baseline node
      const later = sessionEvents(h.session).slice(eventsBefore) as Array<SessionEvent & { data?: { source?: { messageId?: string } } }>;
      expect(later.filter((e) => String(e.data?.source?.messageId ?? "").startsWith("mc-kb:")).length).toBe(0);
    });
  });

  it("K4 a user message quoting <session-history> is not taken for a Magic baseline", async () => {
    await scenario(async (h) => {
      const quote = "Please explain this block: <session-history><compartment start=\"1\" end=\"2\" title=\"mine\">user text</compartment></session-history>";
      await h.turn(1);
      await h.turn(2);
      await h.turn(3, { text: quote, noTools: true });
      addReply(h.session, 3);
      await h.publish("ARC-ALPHA", h.ordinalOf((t) => t === "answer 2"));
      await h.turn(4);
      await h.turn(5);
      await h.publish("ARC-BRAVO", h.ordinalOf((t) => t === "answer 3"));
      await h.turn(6);
      const w = wire(h.session);
      expect(liveM0(w).length).toBe(1);
      expect(liveM0(w)[0]!.content).toContain("ARC-BRAVO");
      // the quote is covered by ARC-BRAVO (dropped as raw history like any
      // other user turn) — but never by the baseline retirement: the event
      // stays a user-sourced message and no Magic replace names it.
      const quoteEvents = (sessionEvents(h.session) as Array<SessionEvent & { data?: { source?: { kind?: string }; content?: Array<{ text?: string }> } }>)
        .filter((e) => e.type === "user/message" && JSON.stringify(e.data).includes("Please explain this block"));
      expect(quoteEvents.length).toBeGreaterThan(0);
      expect(quoteEvents.every((e) => e.data?.source?.kind === "user")).toBe(true);
      // before it is covered, a quote in the live tail stays in the request
      await h.turn(7, { text: quote, noTools: true });
      addReply(h.session, 7);
      await h.pass();
      const w2 = wire(h.session);
      expect(w2.filter((m) => m.role === "user" && !isMagic(m) && m.content.includes("<session-history>")).length).toBe(1);
      expect(liveM0(w2).length).toBe(1);
    });
  });

  it("K5 publication committed, baseline update not done: raw stays visible until a baseline rendering it is live; recovery converges", async () => {
    await scenario(async (h) => {
      for (let i = 1; i <= 3; i += 1) await h.turn(i);
      await h.publish("ARC-ALPHA", h.ordinalOf((t) => t === "answer 2"));
      // (a) the gate did not run / failed open; the plane alone must not land
      // the publication's drops while the live m0 still predates it.
      await h.pass({ planeOnly: true });
      let w = wire(h.session);
      let texts = w.map((m) => m.content).join("\n");
      expect(texts).toContain("question 1");
      expect(texts).toContain("question 2");
      expect(liveM0(w).length).toBe(1);
      expect(liveM0(w)[0]!.content).not.toContain("ARC-ALPHA");
      // (b) the process died right after the materialization was persisted
      // (cached m0 stamped newer than the publish) but before the surface
      // update: a cold process must still bring the new baseline live.
      const { materializeKnowledgeBlocks } = await import("./knowledge-gate");
      materializeKnowledgeBlocks(
        { host: { ready: Promise.resolve({}) as never, canonicalKey: (id: string) => id }, config: { injectDocs: false, compactionOff: false }, autoSearch: { enabled: false } } as never,
        h.db,
        h.key,
        undefined,
        h.dir,
        { id: h.session.id, options: { provider: "d", model: "m" }, session: h.session } as never,
        true,
      );
      h.restart();
      await h.turn(4);
      w = wire(h.session);
      texts = w.map((m) => m.content).join("\n");
      expect(liveM0(w).length).toBe(1);
      expect(magicHistories(w).length).toBe(1);
      expect(liveM0(w)[0]!.content).toContain("ARC-ALPHA");
      // summary live → covered raw may go now; at no point were both missing
      expect(texts).toContain("question 4");
      expect(protocolViolations(w)).toEqual([]);
    });
  });

  it("K6 roles, pairing, reasoning and replay metadata survive; the log keeps superseded baselines, the surface does not", async () => {
    await scenario(async (h) => {
      await twoPublications(h);
      const w = wire(h.session);
      expect(protocolViolations(w)).toEqual([]);
      const assistants = w.filter((m) => m.role === "assistant");
      expect(assistants.length).toBeGreaterThan(0);
      for (const a of assistants) {
        expect(a.reasoning).toBe(1);
        expect(a.replay).toBe(true);
      }
      expect(w.filter((m) => m.role === "tool").length).toBeGreaterThan(0);
      const baselineEvents = (sessionEvents(h.session) as Array<SessionEvent & { data?: { source?: { messageId?: string } } }>).filter(
        (e) => e.type === "user/message" && String(e.data?.source?.messageId ?? "").startsWith("mc-kb:") && !String(e.data?.source?.messageId).endsWith(":m1"),
      );
      // three materializations (first render, after A, after B) are all in the durable log
      expect(new Set(baselineEvents.map((e) => e.data?.source?.messageId)).size).toBe(3);
      expect(liveM0(w).length).toBe(1);
    });
  });

  it("K7 a session written before the fix (duplicate full baselines on the surface) is cleaned once on resume", async () => {
    await scenario(async (h) => {
      await h.turn(1);
      await h.turn(2);
      // pre-round-37 leftovers: an older full baseline pair still live at the tail
      for (const id of ["mc-kb:1000:legacy0000000000", "mc-kb:1000:legacy0000000000:m1"]) {
        appendUserEvent(
          h.session,
          createUserMessage({
            content: [{ type: "text", text: id.endsWith(":m1") ? "<session-history-since>old</session-history-since>" : "<session-history>OLD-LEGACY</session-history>" }],
            source: { kind: "magic-context", plugin: "magic-context", messageId: id, revision: "1000" } as never,
          }),
        );
      }
      expect(liveM0(wire(h.session)).length).toBe(2);
      h.restart();
      await h.turn(3);
      const w = wire(h.session);
      expect(liveM0(w).length).toBe(1);
      expect(liveM1(w).length).toBe(1);
      expect(w.map((m) => m.content).join("\n")).not.toContain("OLD-LEGACY");
      const before = sessionEvents(h.session).length;
      await h.pass();
      await h.pass();
      // at most the tag of the last tool result (its compaction/prune + tool/result replace), never a baseline write
      const after = sessionEvents(h.session).slice(before) as Array<SessionEvent & { data?: { source?: { messageId?: string } } }>;
      expect(after.filter((e) => e.type === "user/message").length).toBe(0);
      expect(after.length).toBeLessThanOrEqual(2);
      expect(liveM0(wire(h.session)).length).toBe(1);
    });
  });
});
