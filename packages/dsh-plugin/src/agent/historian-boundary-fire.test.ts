/**
 * Round 37 phase 2, segment 9 (known limitation 37) — the DSH historian fire
 * path must resolve a REAL protected-tail boundary, and a pass that ends as a
 * noop must say why.
 *
 * Evidence (evo bench 42729564554 @ d5158e995): `fires=true` on 92 trigger
 * lines but only 12 historian requests; every non-backstop historian request
 * starts 3–16 s after a new meaningful user message (110, 178, 183, 185, 190,
 * 193, 199, 301, 322) and turn 5 fires from main ≈141 to 177 without one
 * request. No log line said why. Cause (source): the context plane's fire
 * (`agent/index.ts`, now `createDshHistorianFire`) calls `runDshHistorian`
 * without `boundarySnapshot`, so `runHistorianPassCore` falls back to core's
 * `createDefaultBoundarySnapshotForTests` — eligible end = the 5th-last
 * meaningful user message (legacy `PROTECTED_TAIL_USER_TURNS = 5`). Inside one
 * long autonomous turn that end never moves; once the compartments reach it
 * every pass returns `noop` ("nothing to compact") and noop results are not
 * logged. Pi resolves the boundary with core `resolveProtectedTailBoundary`
 * (token-sized tail + live-prompt floor) at fire time.
 *
 * Rig: production context plane (`runContextPlaneStep`) with the production
 * fire factory (`createDshHistorianFire`) and the real `runDshHistorian`, a
 * stubbed historian LLM that covers its whole chunk, on a real DSH Session and
 * a file DB. Pressure is pinned at 70 % of a 40 k window (execute threshold 65).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createAssistantMessage, createToolResultMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import type { DshSummarizeCall } from "./historian";
import { createHistorianDrain } from "./historian-drain";
import { createDshHistorianFire } from "./historian-fire";
import { transcriptRawMessageProvider } from "./historian-wiring";
import { initializeDshAdapterTables } from "./outbox";
import { NATIVE_ROLES_ENV } from "./tag-scheme";

const HOME = "b0a7d001";
const ROUTE = { provider: "opencode-go-40k", model: "deepseek-v4.1-flash" };
const WINDOW = 40_000;

let savedEnv: string | undefined;
beforeAll(() => {
  savedEnv = process.env[NATIVE_ROLES_ENV];
  delete process.env[NATIVE_ROLES_ENV];
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env[NATIVE_ROLES_ENV];
  else process.env[NATIVE_ROLES_ENV] = savedEnv;
});

const SRC = { kind: "model", provider: ROUTE.provider, model: ROUTE.model };
const replayOf = (i: number | string) => ({
  response: { kind: "pi-ai", version: 2, responseId: `resp-${i}`, stopReason: "toolUse" },
  blocks: [{ type: "reasoning", thinkingSignature: "reasoning_content" }],
});

interface Rig {
  db: Database;
  key: string;
  session: Session;
  logs: string[];
  summarizeCalls: Array<{ start: number; end: number }>;
  /** One pre-step of the context plane (the trigger fires at the pinned pressure), then wait for the pass. */
  step: (newInput?: unknown[]) => Promise<void>;
  user: (text: string) => Promise<void>;
  toolStep: (id: string, size: number) => Promise<void>;
  answer: (text: string) => void;
  ordinalOf: (text: string) => number;
  coveredEnd: () => number;
}

let seq = 0;
async function rig(fn: (r: Rig) => Promise<void>, opts: { pct?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-hist-boundary-"));
  const db: Database = await createTestDb(join(dir, "context.db"));
  initializeDshAdapterTables(db);
  seq += 1;
  const sid = `sess-hist-boundary-${seq}-${Date.now()}`;
  const key = `dsh:${HOME}:${sid}`;
  const header = { id: SessionId(sid), version: 4, createdAt: Date.now(), isSeeded: false, cwd: dir };
  const logs: string[] = [];
  const summarizeCalls: Array<{ start: number; end: number }> = [];
  const drain = createHistorianDrain();
  const summarize: DshSummarizeCall = async (chunk) => {
    summarizeCalls.push({ start: chunk.startIndex, end: chunk.endIndex });
    const title = `HIST-${summarizeCalls.length}`;
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
</meta>
</output>`;
  };
  try {
    const host = {
      ready: Promise.resolve({ kind: "ok" as const, db, storageDir: dir, livenessPath: "" }),
      canonicalKey: (id: string) => `dsh:${HOME}:${id}`,
    };
    const pDeps = {
      host,
      config: { protectedTokens: 1500 },
      historian: {
        config: { executeThresholdPercentage: 65 },
        readPressure: () => ({ projectedTokens: Math.round(((opts.pct ?? 70) / 100) * WINDOW), contextWindow: WINDOW }),
        fire: createDshHistorianFire({ summarizeFor: () => summarize, model: () => `${ROUTE.provider}/${ROUTE.model}`, drain, log: (m) => logs.push(m) }),
        drain,
      },
      cacheTtl: "5m",
      log: (m: string) => logs.push(m),
    } as unknown as ContextPlaneDeps;
    let pState = createContextPlaneState();
    const session = Session.create(SessionId(sid), undefined, header as never);
    const agentOf = () => ({ id: session.id, session, options: ROUTE }) as unknown as Agent;
    let turn = 0;
    let stepNo = 0;
    const append = (type: string, data: unknown) => (session.append as unknown as (t: string, d: unknown) => unknown).call(session, type, data);
    const r: Rig = {
      db, key, session, logs, summarizeCalls,
      step: async (newInput = []) => {
        stepNo += 1;
        append("step/start", { turn, step: stepNo });
        await runContextPlaneStep(pState, pDeps, { agent: agentOf() as never, messages: newInput as never }, async () => ({ reject: false, messages: newInput }) as never);
        for (const m of newInput) session.append("user/message", m as never, { surfaceOp: "append" });
        append("request/header", { header: { config: { ...ROUTE, maxTokens: 4096 }, adapterDefaults: { maxTokens: true } }, reason: "series" });
        await drain.drain(10_000);
      },
      user: async (text) => {
        if (turn > 0) append("turn/end", { turn, reason: "completed" });
        turn += 1;
        stepNo = 0;
        append("turn/start", { turn });
        await r.step([createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })]);
      },
      toolStep: async (id, size) => {
        session.append(
          "assistant/message",
          {
            turn, step: stepNo, stream: [],
            message: createAssistantMessage({
              content: [
                { type: "reasoning", text: `need ${id}` },
                { type: "tool-call", id, name: "read_file", arguments: JSON.stringify({ file_path: `${id}.py` }) },
              ],
              provider: ROUTE.provider, model: ROUTE.model, source: { ...SRC, replayState: replayOf(id) },
            } as never),
          } as never,
          { surfaceOp: "append" },
        );
        session.append(
          "tool/result",
          { turn, step: stepNo, message: createToolResultMessage({ callId: id as never, content: [{ type: "text", text: `${id.toUpperCase()} `.repeat(size) }], isError: false }) } as never,
          { surfaceOp: "append" },
        );
        append("step/end", { turn, step: stepNo });
        await r.step();
      },
      answer: (text) => {
        session.append(
          "assistant/message",
          {
            turn, step: stepNo, stream: [],
            message: createAssistantMessage({
              content: [{ type: "reasoning", text: "done" }, { type: "text", text }],
              provider: ROUTE.provider, model: ROUTE.model, source: { ...SRC, replayState: replayOf(`a-${text}`) },
            } as never),
          } as never,
          { surfaceOp: "append" },
        );
        append("step/end", { turn, step: stepNo });
      },
      ordinalOf: (text) => {
        const view = transcriptRawMessageProvider(agentOf(), key).readMessages();
        const m = view.find((x) => (x.parts as Array<{ text?: unknown }>).some((p) => typeof p.text === "string" && String(p.text).replace(/^§\d+§ /, "") === text));
        if (m === undefined) throw new Error(`${text} not in the history view`);
        return m.ordinal;
      },
      coveredEnd: () => getCompartments(db, key).at(-1)?.endMessage ?? 0,
    };
    void pState;
    await fn(r);
    pState = createContextPlaneState();
  } finally {
    await drain.drain(10_000);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Six short requirement turns, then one long autonomous turn (no new user message). */
async function longSession(r: Rig, longSteps: number) {
  for (let t = 1; t <= 6; t += 1) {
    await r.user(`requirement ${t}`);
    await r.toolStep(`call-${t}`, 700);
    r.answer(`done ${t}`);
  }
  await r.user("requirement 7");
  for (let k = 1; k <= longSteps; k += 1) await r.toolStep(`call-7-${k}`, 700);
}

describe("round 37 phase 2 segment 9: historian fire resolves a real protected-tail boundary (limitation 37)", () => {
  it("H1 inside a long autonomous turn the pass summarizes past the 5th-last user message (up to the live prompt), not a silent noop", async () => {
    await rig(async (r) => {
      await longSession(r, 8);
      const fifthLastUser = r.ordinalOf("requirement 3");
      const liveprompt = r.ordinalOf("requirement 7");
      // legacy boundary: compartments stop before "requirement 3" and every later fire is a noop
      expect(r.coveredEnd()).toBeGreaterThanOrEqual(r.ordinalOf("done 6"));
      expect(r.coveredEnd()).toBeGreaterThan(fifthLastUser);
      // live-prompt floor (pressure 70 % < force band): the prompt being answered is never summarized
      expect(r.coveredEnd()).toBeLessThan(liveprompt);
    });
  });

  it("H2 a pass that ends as a noop logs one line with its reason", async () => {
    await rig(async (r) => {
      await longSession(r, 8);
      const before = r.summarizeCalls.length;
      await r.step();
      await r.step();
      expect(r.summarizeCalls.length).toBe(before); // nothing new is eligible
      const noop = r.logs.filter((l) => /historian noop/.test(l));
      expect(noop.length).toBeGreaterThan(0);
      expect(noop.at(-1)).toMatch(/nothing to compact|no eligible|eligibleEnd/);
    });
  });

  it("H3 guard: below the trigger nothing fires (no pass, no noop line)", async () => {
    await rig(async (r) => {
      await longSession(r, 3);
      expect(r.summarizeCalls.length).toBe(0);
      expect(r.logs.filter((l) => /historian noop/.test(l))).toEqual([]);
    }, { pct: 30 });
  });
});
