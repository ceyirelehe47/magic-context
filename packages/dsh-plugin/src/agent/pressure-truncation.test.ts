import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createToolResultMessage, createUserMessage, deriveEventMessage, sessionEventAt } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";

/**
 * Round 11 item 1 — small-window deadlock (real rc.5, round 10): on a 24k
 * window two ~15 kB reads sit inside core's token-floor protection window
 * (the newest three tool tags are always protected), nothing under Magic calls
 * DSH's tool-result-pruner, and with maxTokens 4096 the request has no output
 * room: every step ends `max-tokens` after one token, so the model can never
 * call ctx_reduce. Magic must shrink protected large tool results itself once
 * input + output reserve crosses the force band — persistently (replayed
 * byte-identically on every later pass and after a restart), never twice.
 */

const SID = "sess-trunc";
const KEY = `dsh:a1b2c3d4:${SID}`;

function surface(session: Session): string[] {
  return session.surface.nodes
    .map((seq) => sessionEventAt(session, seq))
    .map((event) => (event ? deriveEventMessage(event) : undefined))
    .filter((m) => m !== undefined)
    .map((m) => (m as unknown as { content: Array<{ type: string; text?: string }> }).content.map((p) => p.text ?? `[${p.type}]`).join("|"));
}

/** A deterministic ~15 kB file body (numbered lines like the DSH read tool). */
function fileBody(name: string, lines = 300): string {
  const out: string[] = [];
  for (let i = 1; i <= lines; i += 1) out.push(`${i}: ${name} line ${i} ${"x".repeat(32)}`);
  return out.join("\n");
}

function addRead(session: Session, i: number, body: string, withHeader = true) {
  const u = createUserMessage({ content: [{ type: "text", text: `Turn ${i}: read file ${i}` }], source: { kind: "user" } });
  session.append("user/message", u as never, { surfaceOp: "append" });
  if (withHeader) {
    session.append("request/header", { header: { config: { provider: "d", model: "m", maxTokens: 4096 } } } as never);
  }
  const call = createAssistantMessage({
    content: [{ type: "tool-call", id: `call-${i}` as never, name: "read", arguments: JSON.stringify({ file_path: `f${i}.ts` }) }],
    provider: "d",
    model: "m",
    source: { kind: "model" } as never,
  } as never);
  session.append("assistant/message", { turn: i, step: 1, message: call } as never, { surfaceOp: "append" });
  const result = createToolResultMessage({ callId: `call-${i}` as never, content: [{ type: "text", text: body }], isError: false });
  session.append("tool/result", { turn: i, step: 1, message: result } as never, { surfaceOp: "append" });
  const reply = createAssistantMessage({ content: [{ type: "text", text: `answer ${i}` }], provider: "d", model: "m", source: { kind: "model" } as never } as never);
  session.append("assistant/message", { turn: i, step: 2, message: reply } as never, { surfaceOp: "append" });
}

interface Ctx {
  db: Database;
  session: Session;
  step: () => Promise<void>;
  applied: string[];
  pressure: { projectedTokens: number; contextWindow: number };
  rows: () => Array<{ tag_number: number; head_chars: number; tail_chars: number }>;
  newState: () => void;
}

async function scenario(fn: (ctx: Ctx) => Promise<void>, deps0: Partial<ContextPlaneDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-trunc-"));
  const db = await createTestDb(join(dir, "c.db"));
  try {
    const session = Session.create(SessionId(SID));
    const applied: string[] = [];
    const pressure = { projectedTokens: 1000, contextWindow: 24_000 };
    const deps: ContextPlaneDeps = {
      host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}` },
      config: {},
      historian: {
        config: { enabled: false, executeThresholdPercentage: 65 },
        readPressure: () => ({ ...pressure }),
        fire: () => {},
      },
      log: (m) => {
        if (m.includes("applied plan")) applied.push(m);
      },
      ...deps0,
    };
    let state = createContextPlaneState();
    const step = async () => {
      await runContextPlaneStep(state, deps, { agent: { id: session.id, session } as never, messages: [] as never }, async () => ({ reject: false, messages: [] } as never));
    };
    const rows = () => {
      try {
        return db
          .prepare("SELECT tag_number, head_chars, tail_chars FROM dsh_pressure_truncations WHERE session_id = ? ORDER BY tag_number")
          .all(KEY) as Array<{ tag_number: number; head_chars: number; tail_chars: number }>;
      } catch {
        return [];
      }
    };
    await fn({ db, session, step, applied, pressure, rows, newState: () => (state = createContextPlaneState()) });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const MARK = /truncated by Magic Context/;

describe("pressure truncation of protected large tool results (24k window deadlock)", () => {
  it("over the force band (input + output reserve), the older protected reads are middle-truncated; the newest stays whole", async () => {
    await scenario(async ({ session, step, pressure }) => {
      addRead(session, 1, fileBody("alpha"));
      pressure.projectedTokens = 9_000;
      await step();
      addRead(session, 2, fileBody("beta"));
      pressure.projectedTokens = 14_000;
      await step();
      addRead(session, 3, fileBody("gamma"));
      // 19.1k input + 4096 reserved output on a 24k window ≈ 97 % ≥ force 85 %.
      pressure.projectedTokens = 19_100;
      // A newer usage sample for the latch.
      session.append(
        "assistant/message",
        { turn: 4, step: 1, message: createAssistantMessage({ content: [{ type: "text", text: "" }], provider: "d", model: "m", source: { kind: "model" } as never } as never), usage: { inputTokens: 19_100, outputTokens: 1 } } as never,
        { surfaceOp: "append" },
      );
      await step();
      const texts = surface(session);
      const alpha = texts.find((t) => t.includes("alpha line 1 "))!;
      const gamma = texts.find((t) => t.includes("gamma line 1 "))!;
      expect(alpha).toMatch(MARK);
      // head and tail survive, the middle does not
      expect(alpha).toContain("1: alpha line 1 ");
      expect(alpha).toContain("300: alpha line 300 ");
      expect(alpha).not.toContain("150: alpha line 150 ");
      // the tag survives (head keeps the §N§ prefix of the output)
      expect(alpha).toMatch(/\u00a7\d+\u00a7 /);
      // newest read is what the model is answering about: untouched
      expect(gamma).not.toMatch(MARK);
      expect(gamma).toContain("150: gamma line 150 ");
    });
  });

  it("below the force band nothing is truncated", async () => {
    await scenario(async ({ session, step, pressure, rows }) => {
      addRead(session, 1, fileBody("alpha"));
      addRead(session, 2, fileBody("beta"));
      addRead(session, 3, fileBody("gamma"));
      pressure.projectedTokens = 12_000; // 12k + 4096 = 67 %
      await step();
      expect(rows()).toEqual([]);
      expect(surface(session).some((t) => MARK.test(t))).toBe(false);
    });
  });

  it("idempotent and cache-stable: later passes (and a restart) replay the same bytes and write nothing", async () => {
    await scenario(async ({ session, step, pressure, rows, applied, newState }) => {
      addRead(session, 1, fileBody("alpha"));
      addRead(session, 2, fileBody("beta"));
      addRead(session, 3, fileBody("gamma"));
      pressure.projectedTokens = 19_100;
      session.append(
        "assistant/message",
        { turn: 4, step: 1, message: createAssistantMessage({ content: [{ type: "text", text: "" }], provider: "d", model: "m", source: { kind: "model" } as never } as never), usage: { inputTokens: 19_100, outputTokens: 1 } } as never,
        { surfaceOp: "append" },
      );
      await step();
      const decided = rows();
      expect(decided.length).toBeGreaterThan(0);
      const surfaceAfter = surface(session);
      const appliedAfter = applied.length;
      // The meter has not re-sampled yet (same usage): no second batch.
      await step();
      await step();
      // Process restart: fresh in-process state, same DB + session log.
      newState();
      await step();
      expect(rows()).toEqual(decided);
      expect(applied.length).toBe(appliedAfter);
      expect(surface(session)).toEqual(surfaceAfter);
      const marks = surfaceAfter.join("\n").match(/truncated by Magic Context/g) ?? [];
      expect(marks.length).toBe(decided.length);
    });
  });

  it("a ctx_reduce drop of a truncated result lands once it leaves the protection window (drop wins over the replay)", async () => {
    const clock = { offset: 0 };
    await scenario(async ({ db, session, step, pressure, rows, newState }) => {
      addRead(session, 1, fileBody("alpha"));
      addRead(session, 2, fileBody("beta"));
      addRead(session, 3, fileBody("gamma"));
      pressure.projectedTokens = 19_100;
      session.append(
        "assistant/message",
        { turn: 4, step: 1, message: createAssistantMessage({ content: [{ type: "text", text: "" }], provider: "d", model: "m", source: { kind: "model" } as never } as never), usage: { inputTokens: 19_100, outputTokens: 1 } } as never,
        { surfaceOp: "append" },
      );
      await step();
      const first = rows()[0]!;
      queuePendingOp(db, KEY, first.tag_number, "drop", Date.now());
      pressure.projectedTokens = 9_000;
      await step();
      // Still inside core's protection window (newest three tool tags): the
      // drop stays queued (core parity) and the truncation keeps replaying.
      expect(surface(session).some((t) => t.includes("1: alpha line 1 ") && MARK.test(t))).toBe(true);
      // Three newer reads push it out of the window; the queued drop lands on
      // the next core reclaim ride (round 36 line C: here the cache-TTL idle
      // expiry), not on every pre-step.
      addRead(session, 4, fileBody("delta", 40));
      addRead(session, 5, fileBody("eps", 40));
      addRead(session, 6, fileBody("zeta", 40));
      clock.offset = 6 * 60_000;
      await step();
      clock.offset = 0;
      const texts = surface(session);
      expect(texts.some((t) => t.includes("1: alpha line 1 "))).toBe(false);
      const status = db.prepare("SELECT status FROM tags WHERE session_id = ? AND tag_number = ?").get(KEY, first.tag_number) as { status: string };
      expect(status.status).toBe("dropped");

      // Round 15 / S6: pruning the dropped tag's row (startup cleanup) changes
      // nothing the model sees — before or after a restart.
      const before = surface(session);
      const rowsBefore = rows();
      const { prunePressureTruncations } = await import("./pressure-truncation");
      prunePressureTruncations(db);
      const rowsAfter = rows();
      if (rowsBefore.length > 1) expect(rowsAfter.length).toBeLessThan(rowsBefore.length);
      expect(rowsAfter.some((r) => r.tag_number === first.tag_number) && rowsAfter.length > 1).toBe(false);
      await step();
      expect(surface(session)).toEqual(before);
      newState();
      await step();
      expect(surface(session)).toEqual(before);
    }, { cacheTtl: "5m", now: () => Date.now() + clock.offset });
  });
});

import { truncateOutput, keepBudgetChars } from "./pressure-truncation";

describe("truncateOutput (pure)", () => {
  it("is deterministic, keeps head/tail, never splits a surrogate pair, leaves short text alone", () => {
    const body = fileBody("p", 400);
    const a = truncateOutput(body, 1440, 480, 7);
    expect(truncateOutput(body, 1440, 480, 7)).toBe(a);
    expect(a.length).toBeLessThan(body.length);
    expect(a.startsWith("1: p line 1 ")).toBe(true);
    expect(a.endsWith("400: p line 400 " + "x".repeat(32))).toBe(true);
    expect(a).toContain("\u00a77\u00a7 truncated by Magic Context");
    // numbered listing: the marker names the omitted line numbers of the listing
    const m = /numbered lines (\d+)-(\d+)/.exec(a)!;
    expect(a).toContain(`\n${Number(m[1]) - 1}: p line ${Number(m[1]) - 1} `);
    expect(a).not.toContain(`\n${m[1]}: p line ${m[1]} `);
    expect(a).not.toContain(`\n${m[2]}: p line ${m[2]} `);
    expect(a).toContain(`\n${Number(m[2]) + 1}: p line ${Number(m[2]) + 1} `);
    expect(truncateOutput("short", 1440, 480, 7)).toBe("short");
    const emoji = "😀".repeat(3000);
    const e = truncateOutput(emoji, 1001, 501, 1);
    expect(e.includes("\ud83d\n")).toBe(false);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(e)).toBe(false);
  });
  it("keep budget scales with the window (1.2k..12k chars)", () => {
    expect(keepBudgetChars(24_000)).toEqual({ head: 1440, tail: 480 });
    expect(keepBudgetChars(1_000_000).head + keepBudgetChars(1_000_000).tail).toBe(12_000);
    expect(keepBudgetChars(1_000).head + keepBudgetChars(1_000).tail).toBe(1_200);
  });
});

describe("one batch per pressure sample", () => {
  it("a newer usage sample still over the force band may truncate the newest result too", async () => {
    await scenario(async ({ session, step, pressure, rows }) => {
      addRead(session, 1, fileBody("alpha"));
      addRead(session, 2, fileBody("beta"));
      pressure.projectedTokens = 21_000;
      const usage = (n: number) =>
        session.append(
          "assistant/message",
          { turn: 9, step: 1, message: createAssistantMessage({ content: [{ type: "text", text: "" }], provider: "d", model: "m", source: { kind: "model" } as never } as never), usage: { inputTokens: n, outputTokens: 1 } } as never,
          { surfaceOp: "append" },
        );
      usage(21_000);
      await step();
      const first = rows().map((r) => r.tag_number);
      expect(first.length).toBeGreaterThan(0);
      // same sample: no second batch
      await step();
      expect(rows().map((r) => r.tag_number)).toEqual(first);
      // new sample still far over the band: the rest is allowed
      usage(23_000);
      pressure.projectedTokens = 23_000;
      await step();
      expect(rows().length).toBe(2);
    });
  });
});
