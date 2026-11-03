import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  deriveEventMessage,
  sessionEventAt,
} from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import {
  type ContextPlaneDeps,
  createContextPlaneState,
  pressureTruncationInputFor,
  runContextPlaneStep,
} from "./context-plane";
import { PRESSURE_TRUNCATION_MARKER } from "./pressure-truncation";

/**
 * Round 23b P0-1 — dense tool output (Chinese text, digit listings) under
 * context pressure.
 *
 * Reproduced on real DSH rc.5 against a mock provider that enforces a 24k
 * window with a real BPE count (scripts/e2e/mock-llm.mjs, round 23b evidence):
 * one `read` of a 50 KB Chinese file put the request at 27 700 tokens while
 * DSH's token-meter projection — the last provider sample plus the surface
 * movement priced at 4 chars/token — said 63.5 %. The pressure-truncation
 * trigger reads that projection, so it never fired; the over-window request
 * went out (CONTEXT_WINDOW_EXCEEDED) and every later turn of the session sent
 * it again (session stuck). Common Chinese text is ≈ 0.94 tokens/char
 * (≈ 3.75× the meter's price), dense digit listings ≈ 2×.
 */

const SID = "sess-dense";
const KEY = `dsh:a1b2c3d4:${SID}`;
const WINDOW = 24_000;
const BASE_PROMPT = 9_556; // the real rc.5 base prompt of the mock run (system + tools + first user)
const ZH = "这是一个用于测试上下文压力的中文段落，包含常见的汉字和标点符号。";

function zh(chars: number): string {
  let s = "";
  let i = 0;
  while (s.length < chars) {
    s += `${String(i).padStart(3, "0")} ${ZH.repeat(40)}\n`;
    i += 1;
  }
  return s.slice(0, chars);
}

/** DSH token-meter price of a text block (CHARS_PER_TOKEN 4 + block overhead). */
const meterPrice = (text: string) => Math.ceil(text.length / 4) + 4 + 4;

function baseSession(): Session {
  const session = Session.create(SessionId(SID));
  session.append("request/context", { provider: "mock-24k", model: "m", contextWindow: WINDOW } as never);
  session.append(
    "request/header",
    { header: { provider: "mock-24k", model: "m", config: { maxTokens: 4096 } } } as never,
  );
  session.append(
    "user/message",
    createUserMessage({ content: [{ type: "text", text: "read the files" }], source: { kind: "user" } }) as never,
    { surfaceOp: "append" },
  );
  return session;
}

/** One model step: an assistant tool call carrying the provider usage of its request, then the tool result. */
function toolStep(session: Session, i: number, prompt: number, output: string) {
  const call = createAssistantMessage({
    content: [{ type: "tool-call", id: `call-${i}` as never, name: "read", arguments: `{"file_path":"f${i}.txt"}` }],
    provider: "mock-24k",
    model: "m",
    source: { kind: "model" } as never,
  } as never);
  session.append(
    "assistant/message",
    { turn: 1, step: i, message: call, usage: { inputTokens: prompt, outputTokens: 20, totalTokens: prompt + 20 } } as never,
    { surfaceOp: "append" },
  );
  const result = createToolResultMessage({ callId: `call-${i}` as never, content: [{ type: "text", text: output }], isError: false });
  session.append("tool/result", { turn: 1, step: i, message: result } as never, { surfaceOp: "append" });
}

/** What DSH's meter projects: last sample + meter-priced surface movement since. */
function meterProjection(prompt: number, outputsSinceSample: readonly string[]) {
  return prompt + outputsSinceSample.reduce((n, o) => n + meterPrice(o) + 30, 0);
}

function toolResultTexts(session: Session): string[] {
  const out: string[] = [];
  for (const seq of session.surface.nodes) {
    const ev = sessionEventAt(session, seq);
    if (ev?.type !== "tool/result" && !(ev?.type === "user/message")) continue;
    const m = ev ? deriveEventMessage(ev) : undefined;
    const parts = (m as unknown as { content?: Array<{ type: string; text?: string; content?: Array<{ text?: string }> }> } | undefined)?.content ?? [];
    for (const p of parts) {
      if (typeof p.text === "string") out.push(p.text);
      for (const c of p.content ?? []) if (typeof c.text === "string") out.push(c.text);
    }
  }
  return out;
}

async function withPlane(
  projection: () => number,
  fn: (ctx: { db: Database; session: Session; step: () => Promise<void> }) => Promise<void>,
  session: Session,
) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-dense-"));
  const db = await createTestDb(join(dir, "c.db"));
  try {
    const deps: ContextPlaneDeps = {
      host: {
        ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }),
        canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}`,
      } as never,
      config: {},
      historian: {
        config: { executeThresholdPercentage: 65 } as never,
        readPressure: () => ({ projectedTokens: projection(), contextWindow: WINDOW }),
        fire: () => {},
      },
    };
    const state = createContextPlaneState();
    const step = async () => {
      await runContextPlaneStep(
        state,
        deps,
        { agent: { id: session.id, session } as never, messages: [] as never },
        async () => ({ reject: false, messages: [] }) as never,
      );
    };
    await fn({ db, session, step });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pressure truncation input prices dense output like the provider (round 23b P0-1)", () => {
  it("projects the real size of a 16.6k-char Chinese read the meter prices at 4 chars/token", () => {
    const session = baseSession();
    const big = zh(16_600);
    toolStep(session, 1, BASE_PROMPT, big);
    const meter = meterProjection(BASE_PROMPT, [big]);
    const deps = {
      host: { canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}` },
      historian: { readPressure: () => ({ projectedTokens: meter, contextWindow: WINDOW }), fire: () => {} },
    } as unknown as ContextPlaneDeps;
    const input = pressureTruncationInputFor(deps, { id: SID, session } as never);
    expect(input).toBeDefined();
    const exact = BASE_PROMPT + estimateTokens(big);
    // The meter says ≈ 57 % input; the provider would count ≈ 109 %.
    expect(meter / WINDOW).toBeLessThan(0.65);
    expect(exact).toBeGreaterThan(WINDOW);
    expect(input!.projectedTokens).toBeGreaterThanOrEqual(exact - 200);
  });

  it("an ASCII listing is not re-priced upward beyond its real size (no change for meter-dense text)", () => {
    const session = baseSession();
    const lines: string[] = [];
    for (let i = 1; i <= 400; i += 1) lines.push(`${i}: plain english words in a source file line ${i}`);
    const text = lines.join("\n");
    toolStep(session, 1, BASE_PROMPT, text);
    const meter = meterProjection(BASE_PROMPT, [text]);
    const deps = {
      host: { canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}` },
      historian: { readPressure: () => ({ projectedTokens: meter, contextWindow: WINDOW }), fire: () => {} },
    } as unknown as ContextPlaneDeps;
    const input = pressureTruncationInputFor(deps, { id: SID, session } as never)!;
    expect(input.projectedTokens).toBeGreaterThanOrEqual(meter);
    // meter-dense text: at most a few tokens of tool-call arguments are re-priced
    expect(input.projectedTokens).toBeLessThanOrEqual(meter + 50);
  });
});

describe("context plane truncates dense output before the request overflows (round 23b P0-1)", () => {
  it("one Chinese read larger than the window is truncated on the pass right after it", async () => {
    const session = baseSession();
    const big = zh(16_600);
    toolStep(session, 1, BASE_PROMPT, big);
    await withPlane(
      () => meterProjection(BASE_PROMPT, [big]),
      async ({ db, step }) => {
        await step();
        const rows = db.prepare("SELECT tag_number FROM dsh_pressure_truncations WHERE session_id = ?").all(KEY);
        expect(rows.length).toBe(1);
        const texts = toolResultTexts(session).filter((t) => t.includes(ZH));
        expect(texts.length).toBe(1);
        expect(texts[0]).toContain(PRESSURE_TRUNCATION_MARKER);
        const projected = BASE_PROMPT + estimateTokens(texts[0]!) + 4096;
        expect(projected).toBeLessThan(WINDOW * 0.85);
        // Original kept: the event log still carries the untruncated output.
        const original = session
          .snapshotEvents()
          .filter((e) => e.type === "tool/result")
          .map((e) => JSON.stringify(e.data));
        expect(original.some((t) => t.includes(big.slice(-200)))).toBe(true);
      },
      session,
    );
  });

  it("three 5k-char Chinese reads (each under the old 3×keep CHAR floor) are truncated once they would overflow", async () => {
    const session = baseSession();
    const outs = [zh(5_000), zh(5_000).replace(/^000/, "a00"), zh(5_000).replace(/^000/, "b00")];
    let prompt = BASE_PROMPT;
    toolStep(session, 1, prompt, outs[0]!);
    prompt += estimateTokens(outs[0]!) + 30;
    toolStep(session, 2, prompt, outs[1]!);
    prompt += estimateTokens(outs[1]!) + 30;
    toolStep(session, 3, prompt, outs[2]!);
    // real next prompt ≈ 9.6k + 3 × 4.7k ≈ 23.7k (+ 4096 output) — far over the force band
    await withPlane(
      () => meterProjection(prompt, [outs[2]!]),
      async ({ db, step }) => {
        await step();
        const rows = db.prepare("SELECT tag_number FROM dsh_pressure_truncations WHERE session_id = ?").all(KEY) as unknown[];
        expect(rows.length).toBeGreaterThan(0);
        const texts = toolResultTexts(session).filter((t) => t.includes(ZH));
        const total = BASE_PROMPT + texts.reduce((n, t) => n + estimateTokens(t), 0) + 4096;
        expect(total).toBeLessThan(WINDOW * 0.85);
      },
      session,
    );
  });
});
