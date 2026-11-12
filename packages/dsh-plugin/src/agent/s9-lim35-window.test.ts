/**
 * Round 37 seg 12 — S9 fix A (MC prices pressure against the available window,
 * window − the route's maxTokens; pressure truncation's min(32 000, reserve)
 * cap removed) and limitation 35 option B (a SEPARATE near-window trigger:
 * pi-ai estimate + 4096 + 16 384 > window, or a reply cut on max tokens below
 * the route's maxTokens, lifts the next pass's MC pressure to the force band;
 * not folded into the persisted pressure percentage).
 *
 * User decisions: S9 "A+C" (2026-11-07, test rewrite confirmed 2026-11-12
 * 20:29 CST), limitation 35 option B (2026-11-12).
 *
 * Only pre-existing public APIs are imported, so the file runs (and fails) on
 * the pre-fix tree. The pi-ai estimate is mirrored locally (pi-ai 1.3.0
 * utils/estimate.ts, no usage anchor as replayed by dsh-llm-pi-ai rc.5) so the
 * assertion on max_completion_tokens is independent of the plugin's mirror.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createAssistantMessage, createToolResultMessage, createUserMessage, deriveEventMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { applyPressureTruncation, PRESSURE_TRUNCATION_MARKER, type PressureTruncationInput } from "./pressure-truncation";
import { NATIVE_ROLES_ENV } from "./tag-scheme";

let savedEnv: string | undefined;
beforeAll(() => {
  savedEnv = process.env[NATIVE_ROLES_ENV];
  delete process.env[NATIVE_ROLES_ENV];
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env[NATIVE_ROLES_ENV];
  else process.env[NATIVE_ROLES_ENV] = savedEnv;
});

/* ───────── local pi-ai 1.3.0 mirror (estimate + clamp), independent of src ───────── */
const est35 = (chars: number) => Math.ceil(chars / 3.5);
type Block = { type?: string; text?: string; name?: string; arguments?: string; content?: Block[] };
function piEstimate(session: Session, tools: unknown[]): number {
  let tokens = tools.length > 0 ? est35(JSON.stringify(tools).length) : 0;
  for (const seq of [...session.surface.nodes]) {
    const event = (session as unknown as { eventAt(s: number): unknown }).eventAt(Number(seq));
    const m = deriveEventMessage(event as never) as unknown as { role?: string; content?: Block[] };
    let chars = 0;
    for (const b of m.content ?? []) {
      if (m.role === "assistant") {
        if (b.type === "text" || b.type === "reasoning") chars += (b.text ?? "").length;
        else if (b.type === "tool-call") chars += (b.name ?? "").length + JSON.stringify(JSON.parse(b.arguments || "{}")).length;
      } else if (b.type === "text") chars += (b.text ?? "").length;
    }
    tokens += est35(chars);
  }
  return tokens;
}
const piClamp = (window: number, maxTokens: number, estimate: number) => Math.min(maxTokens, Math.max(1, window - estimate - 4096));

/* ───────── rig ───────── */
interface Rig {
  session: Session;
  db: Database;
  sessionKey: string;
  preStep: (batch: unknown[]) => Promise<void>;
  fires: Array<{ usage?: { percentage: number } }>;
  pressure: { projectedTokens: number; contextWindow: number };
}

async function rig(dir: string, opts: { window: number; projected: number; historian?: boolean }): Promise<Rig> {
  const db: Database = await createTestDb(join(dir, "c.db"));
  const sid = `sess-s9-${Math.random().toString(36).slice(2)}`;
  const header = { id: SessionId(sid), version: 4, createdAt: Date.now(), isSeeded: false, cwd: dir };
  const session = Session.create(SessionId(sid), undefined, header as never);
  const host = {
    ready: Promise.resolve({ kind: "ok" as const, db, storageDir: dir, livenessPath: "" }),
    canonicalKey: (id: string) => `dsh:s9lim35:${id}`,
  };
  const fires: Rig["fires"] = [];
  const pressure = { projectedTokens: opts.projected, contextWindow: opts.window };
  const deps = {
    host,
    config: { protectedTokens: 500 },
    historian: {
      config: { enabled: opts.historian === true, executeThresholdPercentage: 65 },
      readPressure: () => ({ ...pressure }),
      fire: (args: { usage?: { percentage: number } }) => {
        fires.push(args);
      },
    },
    cacheTtl: "5m",
    log: () => {},
  } as unknown as ContextPlaneDeps;
  const state = createContextPlaneState();
  const agent = { id: session.id, session, options: { provider: "d", model: "m" } };
  const preStep = async (batch: unknown[]) => {
    await runContextPlaneStep(state, deps, { agent: agent as never, messages: batch as never }, async () => ({ reject: false, messages: batch }) as never);
    for (const m of batch) session.append("user/message", m as never, { surfaceOp: "append" });
  };
  return { session, db, sessionKey: `dsh:s9lim35:${sid}`, preStep, fires, pressure };
}

const piSource = (stopReason: string) => ({
  kind: "model",
  provider: "d",
  model: "m",
  replayState: { response: { kind: "pi-ai", version: 2, api: "openai-completions", provider: "d", model: "m", stopReason }, blocks: [] },
});

/** The evo catalog's tool schemas weigh ≈ 9 037 pi tokens; one padded schema of the same size. */
const TOOLS = [{ name: "bash", description: "d".repeat(31_560), parameters: { type: "object" } }];

function appendHeader(session: Session, maxTokens: number, tools: unknown[] = TOOLS, contextWindow = 200_000): void {
  session.append("request/header", { header: { config: { provider: "d", model: "m", maxTokens }, ...(tools.length > 0 ? { tools } : {}) } } as never);
  session.append("request/context", { provider: "d", model: "m", contextWindow } as never);
}

async function turn(r: Rig, n: number, opts: { prose: string; result: string; stopReason?: string; usage?: Record<string, number> }): Promise<void> {
  await r.preStep([createUserMessage({ content: [{ type: "text", text: `question ${n}\n${opts.prose}` }], source: { kind: "user" } })]);
  r.session.append(
    "assistant/message",
    { turn: n, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: "reasoning", text: `r${n}` }, { type: "tool-call", id: `call-${n}`, name: "grep", arguments: "{}" }], provider: "d", model: "m", source: piSource("toolUse") } as never) } as never,
    { surfaceOp: "append" },
  );
  r.session.append("tool/result", { turn: n, step: 1, message: createToolResultMessage({ callId: `call-${n}` as never, content: [{ type: "text", text: opts.result }], isError: false }) } as never, { surfaceOp: "append" });
  await r.preStep([]); // Magic tags the new result
  r.session.append(
    "assistant/message",
    {
      turn: n,
      step: 2,
      stream: [],
      ...(opts.usage ? { usage: opts.usage } : {}),
      message: createAssistantMessage({ content: [{ type: "reasoning", text: `w${n}` }, { type: "text", text: `answer ${n}` }], provider: "d", model: "m", source: piSource(opts.stopReason ?? "stop") } as never),
    } as never,
    { surfaceOp: "append" },
  );
}

const prose = (n: number, lines: number) => Array.from({ length: lines }, (_, i) => `turn ${n} note ${i}: context the user pasted, kept verbatim`).join("\n");
const bigResult = (n: number, chars: number) =>
  Array.from({ length: Math.ceil(chars / 44) }, (_, i) => `src/mod${n}/file${i % 37}.py:${i}: match ${i} of grep`).join("\n").slice(0, chars);

const truncatedCount = (session: Session) =>
  [...session.surface.nodes].filter((seq) => {
    const m = deriveEventMessage((session as unknown as { eventAt(s: number): unknown }).eventAt(Number(seq)) as never) as unknown as { content?: Block[] };
    return (m.content ?? []).some((b) => (b.text ?? "").includes(PRESSURE_TRUNCATION_MARKER));
  }).length;

function lastPct(db: Database, key: string): number | undefined {
  const row = db.prepare("SELECT last_context_percentage AS p FROM session_meta WHERE session_id = ?").get(key) as { p: number } | null;
  return row?.p ?? undefined;
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-s9-lim35-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ───────── S9 fix A: runtime pricing against the available window ───────── */
describe("S9 fix A: MC prices pressure against window − maxTokens (round 37 seg 12)", () => {
  const body = (s: string) => Array.from({ length: 1200 }, (_, i) => `${s} line ${i}: some tool output text`).join("\n");
  const part = (text: string) => {
    const p = { text, getText: () => p.text, setToolOutput: (t: string) => ((p.text = t), true) };
    return p;
  };
  const input = (over: Partial<PressureTruncationInput>): PressureTruncationInput => ({
    projectedTokens: 0,
    contextWindow: 1_000_000,
    outputReserveTokens: 384_000,
    executePercentage: 65,
    forcePercentage: 85,
    usageSeq: 10,
    ...over,
  });

  it("A1 pressure truncation on 1M / 384k decides at MC's force band of the available window (523 600), not of the whole window", async () => {
    await withDir(async (dir) => {
      const db = await createTestDb(join(dir, "t.db"));
      try {
        const below = [part(body("a")), part(body("b"))];
        const r0 = applyPressureTruncation(db, "S0", below.map((p, i) => ({ tagNumber: i + 1, part: p })), input({ projectedTokens: 523_000 }));
        expect(r0.decided).toEqual([]);
        const at = [part(body("a")), part(body("b"))];
        // 530 000 = 86 % of 616 000 (MC force band) — pre-fix: 530 000 + min(32 000, 384 000) = 562 000 < 850 000
        const r1 = applyPressureTruncation(db, "S1", at.map((p, i) => ({ tagNumber: i + 1, part: p })), input({ projectedTokens: 530_000 }));
        expect(r1.decided.length).toBeGreaterThan(0);
        expect(at[0]!.text).toContain(PRESSURE_TRUNCATION_MARKER);
      } finally {
        db.close();
      }
    });
  });

  it("A2 no cap on the reserve: 100k window / 64k maxTokens truncates once input reaches 85 % of the 36k usable window", async () => {
    await withDir(async (dir) => {
      const db = await createTestDb(join(dir, "t.db"));
      try {
        const p = [part(body("a")), part(body("b"))];
        // 31 000 ≥ 0.85 × 36 000 = 30 600 — pre-fix: 31 000 + 32 000 = 63 000 < 85 000
        const r = applyPressureTruncation(db, "S", p.map((x, i) => ({ tagNumber: i + 1, part: x })), input({ contextWindow: 100_000, outputReserveTokens: 64_000, projectedTokens: 31_000 }));
        expect(r.decided.length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });
  });

  it("A3 historian trigger + persisted context % on 1M / 384k: 410k input is 66.6 % of the usable window (fires; pre-fix 41 %, silent)", async () => {
    await withDir(async (dir) => {
      const r = await rig(dir, { window: 1_000_000, projected: 410_000, historian: true });
      try {
        appendHeader(r.session, 384_000, [], 1_000_000);
        await turn(r, 1, { prose: "short", result: "small" });
        await r.preStep([createUserMessage({ content: [{ type: "text", text: "next" }], source: { kind: "user" } })]);
        expect(lastPct(r.db, r.sessionKey)).toBe(67);
        expect(r.fires.length).toBeGreaterThan(0);
      } finally {
        r.db.close();
      }
    });
  }, 60_000);
});

/* ───────── limitation 35 option B: the near-window trigger ───────── */
describe("limitation 35 option B: near-window trigger (round 37 seg 12)", () => {
  it("B1 200k window: pi estimate near the window while MC's measured pressure is below its force band → the next request keeps max_completion_tokens ≥ 16 384", async () => {
    await withDir(async (dir) => {
      // measured: last usage 90k + the movement since (≈ 31k) ≈ 72 % of the
      // 167 232 usable window (< force 85 %)
      const r = await rig(dir, { window: 200_000, projected: 90_000 });
      try {
        appendHeader(r.session, 32_768);
        // every reply carries provider usage (the batch latch needs a newer sample)
        const usage = { inputTokens: 90_000, outputTokens: 900 };
        for (let n = 1; n <= 6; n += 1) await turn(r, n, { prose: prose(n, 1050), result: bigResult(n, 40_000), usage });
        const surface = piEstimate(r.session, TOOLS);
        expect(surface).toBeLessThan(200_000 - 4096 - 16_384); // not near yet: nothing cut so far
        expect(truncatedCount(r.session)).toBe(0);
        // the next user message (pasted context) brings the request near the window
        const next = createUserMessage({ content: [{ type: "text", text: `next question\n${prose(7, 750)}` }], source: { kind: "user" } });
        const nextTokens = est35(`next question\n${prose(7, 750)}`.length);
        const request = surface + nextTokens;
        expect(request).toBeGreaterThan(200_000 - 4096 - 16_384);
        expect(request).toBeLessThan(200_000 - 4096 - 1000);
        expect(piClamp(200_000, 32_768, request)).toBeLessThan(16_384); // what pi would send without the trigger
        await r.preStep([next]);
        const after = piEstimate(r.session, TOOLS); // the surface as sent (the user message appended)
        const maxCompletionTokens = piClamp(200_000, 32_768, after);
        expect(maxCompletionTokens).toBeGreaterThanOrEqual(16_384);
        expect(truncatedCount(r.session)).toBeGreaterThan(0);
      } finally {
        r.db.close();
      }
    });
  }, 90_000);

  it("B2 a reply cut on max tokens below the route's maxTokens lifts the next pass to the force band (pressure truncation runs)", async () => {
    await withDir(async (dir) => {
      const r = await rig(dir, { window: 200_000, projected: 60_000 });
      try {
        appendHeader(r.session, 32_768);
        for (let n = 1; n <= 2; n += 1) {
          await turn(r, n, { prose: "p", result: bigResult(n, 40_000), ...(n === 2 ? { stopReason: "length", usage: { inputTokens: 60_000, outputTokens: 9_000 } } : {}) });
        }
        await r.preStep([createUserMessage({ content: [{ type: "text", text: "continue" }], source: { kind: "user" } })]);
        expect(truncatedCount(r.session)).toBeGreaterThan(0);
      } finally {
        r.db.close();
      }
    });
  }, 60_000);

  it("B3 guard: same session, the reply stopped normally (or at the full maxTokens) → no truncation at 36 % measured pressure", async () => {
    for (const variant of [{ stopReason: "stop", out: 9_000 }, { stopReason: "length", out: 32_768 }]) {
      await withDir(async (dir) => {
        const r = await rig(dir, { window: 200_000, projected: 60_000 });
        try {
          appendHeader(r.session, 32_768);
          for (let n = 1; n <= 2; n += 1) {
            await turn(r, n, { prose: "p", result: bigResult(n, 40_000), ...(n === 2 ? { stopReason: variant.stopReason, usage: { inputTokens: 60_000, outputTokens: variant.out } } : {}) });
          }
          await r.preStep([createUserMessage({ content: [{ type: "text", text: "continue" }], source: { kind: "user" } })]);
          expect(truncatedCount(r.session)).toBe(0);
        } finally {
          r.db.close();
        }
      });
    }
  }, 60_000);

  it("B4 guard: a 24k window / 4096 maxTokens route is held to its own maxTokens (est + 4096 + 4096 ≤ window → no trigger)", async () => {
    await withDir(async (dir) => {
      const r = await rig(dir, { window: 24_000, projected: 6_000 });
      try {
        appendHeader(r.session, 4096, [], 24_000);
        // ≈ 13.5k pi tokens: above window − 4096 − 16 384 (3 520), below window − 4096 − 4096 (15 808)
        await turn(r, 1, { prose: prose(1, 600), result: bigResult(1, 20_000) });
        expect(piEstimate(r.session, [])).toBeGreaterThan(24_000 - 4096 - 16_384);
        expect(piEstimate(r.session, [])).toBeLessThan(24_000 - 4096 - 4096);
        await r.preStep([createUserMessage({ content: [{ type: "text", text: "next" }], source: { kind: "user" } })]);
        expect(truncatedCount(r.session)).toBe(0);
      } finally {
        r.db.close();
      }
    });
  }, 60_000);

  it("B5 the trigger is not folded into the pressure percentage: persisted context % stays the measured one while the historian is fired at the force band", async () => {
    await withDir(async (dir) => {
      const r = await rig(dir, { window: 200_000, projected: 60_000, historian: true });
      try {
        appendHeader(r.session, 32_768);
        await turn(r, 1, { prose: "p", result: "small", stopReason: "length", usage: { inputTokens: 60_000, outputTokens: 9_000 } });
        await r.preStep([createUserMessage({ content: [{ type: "text", text: "continue" }], source: { kind: "user" } })]);
        // 60 000 / 167 232 = 35.9 %
        expect(lastPct(r.db, r.sessionKey)).toBe(36);
        expect(r.fires.length).toBeGreaterThan(0);
        expect(r.fires.at(-1)?.usage?.percentage).toBeGreaterThanOrEqual(85);
      } finally {
        r.db.close();
      }
    });
  }, 60_000);
});
