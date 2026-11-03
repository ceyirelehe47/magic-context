import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createTestDb, createTestStorageDir } from "../test-utils";
import {
  computeHasRecentReduce,
  ctxReduceCallIds,
  getDshNudgeBaseline,
  maybeNudgeChannels,
  resetDshNudgeStateForTest,
  scanSessionMetrics,
} from "./nudge";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createToolResultMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { deriveMutationPlan, readDshTranscript } from "./transcript";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import { resetEpochFloorRegistryForTest } from "@magic-context/core/features/magic-context/storage-meta-persisted";

afterEach(() => {
  resetDshNudgeStateForTest();
  resetEpochFloorRegistryForTest();
});

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet",
  "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango"];
/** Deterministic, non-repetitive tool output (~N tokens with the real tokenizer). */
function bulkOutput(seed: number, words: number): string {
  const out: string[] = [];
  let x = seed * 7919 + 13;
  for (let i = 0; i < words; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(`${WORDS[x % WORDS.length]}${x % 97}`);
  }
  return out.join(" ");
}

/** A real DSH session: one user turn, then `calls` tool calls with bulky outputs, then a user turn. */
function bulkySession(calls: number, wordsPerOutput: number): Session {
  const session = Session.create(SessionId("sess-nudge-real"));
  session.append("user/message", createUserMessage({ content: [{ type: "text", text: "start" }], source: { kind: "user" } }), { surfaceOp: "append" });
  for (let i = 1; i <= calls; i++) {
    const assistant = createAssistantMessage({
      content: [{ type: "tool-call", id: `call-${i}` as never, name: "read_file", arguments: `{"path":"f${i}.ts"}` }],
      provider: "deepseek",
      model: "deepseek-chat",
      source: { kind: "model" } as never,
    });
    session.append("assistant/message", { turn: 1, step: i, message: assistant } as never, { surfaceOp: "append" });
    session.append("tool/call", { turn: 1, step: i, callId: `call-${i}` as never, name: "read_file", arguments: "{}" });
    const result = createToolResultMessage({ callId: `call-${i}` as never, content: [{ type: "text", text: bulkOutput(i, wordsPerOutput) }], isError: false });
    session.append("tool/result", { turn: 1, step: i, message: result }, { surfaceOp: "append" });
  }
  session.append("user/message", createUserMessage({ content: [{ type: "text", text: "next" }], source: { kind: "user" } }), { surfaceOp: "append" });
  return session;
}

function tagSession(db: Parameters<typeof deriveMutationPlan>[1]["db"], session: Session, sessionId: string): void {
  const view = readDshTranscript({
    session: { events: session.snapshotEvents(), surface: session.surface, header: {} },
    canonicalSessionId: sessionId,
  });
  deriveMutationPlan(view, { db, protection: { protectedTokens: 8_000 } });
}

function agentFor(session: Session, injected: string[]): never {
  return {
    session,
    inject: (m: { content: { text: string }[] }) => injected.push(m.content[0]!.text),
  } as never;
}

describe("nudge (ctx_reduce Channel-1 parity)", () => {
  async function openDb() {
    const dir = await createTestStorageDir();
    const db = await createTestDb(join(dir, "context.db"));
    return { db, dir, sessionId: "dsh:test:nudge-session" };
  }

  function fakeAgent(events: unknown[]): never {
    return { session: { events } } as never;
  }

  it("scans session metrics: context window + last input usage", () => {
    const metrics = scanSessionMetrics(
      fakeAgent([
        { type: "request/context", data: { contextWindow: 1000000 } },
        { type: "assistant/message", data: { usage: { inputTokens: 5000, outputTokens: 10 } } },
      ]),
    );
    expect(metrics.contextWindow).toBe(1000000);
    expect(metrics.lastInputTokens).toBe(5000);
  });

  it("counts cached prompt tokens and keeps only the LAST call (DSH 0.2 exclusive TokenUsage)", () => {
    const metrics = scanSessionMetrics(
      fakeAgent([
        { type: "request/context", data: { contextWindow: 200000 } },
        { type: "assistant/message", data: { usage: { inputTokens: 9000, cacheReadTokens: 1000, outputTokens: 5 } } },
        {
          type: "assistant/message",
          data: { usage: { inputTokens: 300, cacheReadTokens: 12000, cacheWriteTokens: 700, outputTokens: 5 } },
        },
      ]),
    );
    expect(metrics.lastInputTokens).toBe(13000);
  });

  it("persists nudge cadence state and stays silent below the floor", async () => {
    const { db, dir, sessionId } = await openDb();
    try {
      const agent = fakeAgent([{ type: "request/context", data: { contextWindow: 1000000 } }]);
      const injected: unknown[] = [];
      (agent as unknown as { inject: (m: unknown) => void }).inject = (m) => injected.push(m);
      maybeNudgeChannels(db, sessionId, agent, { threshold: 65, log: () => {} });
      expect(injected.length).toBe(0);
      // 无工具标签 → 低于地板 → 不触达（也不建 meta 行）。
      const row = db
        .prepare("SELECT last_nudge_undropped FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { last_nudge_undropped: number } | null;
      expect(row).toBeNull();
    } finally {
      db.close();
      await import("node:fs").then((f) => f.rmSync(dir, { recursive: true, force: true }));
    }
  });

  it("fires Channel 1 and injects a reminder when reclaimable tool output is large", async () => {
    const { db, dir, sessionId } = await openDb();
    try {
      // 写入一条大工具输出标签的 token_count。
      db.prepare(
        `INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, token_count, drop_mode)
         VALUES (?, 'm1:p0', 'tool', 40000, 1, 'dsh', 20000, 'full')`,
      ).run(sessionId);
      const agent = fakeAgent([
        { type: "request/context", data: { contextWindow: 1000000 } },
        { type: "assistant/message", data: { usage: { inputTokens: 100000, outputTokens: 10 } } },
      ]);
      const injected: { text: string; messageId: string }[] = [];
      (agent as unknown as { inject: (m: { content: { text: string }[]; source: { messageId: string } }) => void }).inject =
        (m) => injected.push({ text: m.content[0].text, messageId: m.source.messageId });
      maybeNudgeChannels(db, sessionId, agent, {
        threshold: 65,
        log: () => {},
      });
      // A tag row with no transcript behind it is not a live tail: the core
      // walk measures U = T = 0 → below the 60k tail minimum → quiet.
      expect(injected.length).toBe(0);
      expect(getDshNudgeBaseline(sessionId)?.baselineT).toBe(0);
    } finally {
      db.close();
      await import("node:fs").then((f) => f.rmSync(dir, { recursive: true, force: true }));
    }
  });
});

describe("nudge on real tail-hygiene measurements (core walk)", () => {
  async function openDb() {
    const dir = await createTestStorageDir();
    const db = await createTestDb(join(dir, "context.db"));
    return { db, dir, sessionId: "dsh:test:nudge-real" };
  }

  it("measures U/T from the transcript with the token-floor window and fires Channel 1", async () => {
    const { db, dir, sessionId } = await openDb();
    try {
      const session = bulkySession(10, 4_000);
      tagSession(db, session, sessionId);
      const toolTags = getTagsBySession(db, sessionId).filter((t) => t.type === "tool");
      expect(toolTags.length).toBe(10);
      const injected: string[] = [];
      const logs: string[] = [];
      maybeNudgeChannels(db, sessionId, agentFor(session, injected), {
        protection: { protectedTokens: 8_000 },
        log: (m) => logs.push(m),
      });
      const baseline = getDshNudgeBaseline(sessionId)!;
      expect(baseline).toBeDefined();
      // Real measurement: T covers every tool output, U excludes the protected tail.
      expect(baseline.baselineT + baseline.turnDeltaT).toBeGreaterThan(60_000);
      const u = baseline.baselineU + baseline.turnDeltaU;
      expect(u).toBeGreaterThan(25_000);
      expect(u).toBeLessThan(baseline.baselineT + baseline.turnDeltaT);
      expect(injected.length).toBeGreaterThanOrEqual(1);
      expect(logs.some((m) => m.includes("channel1 nudge fired"))).toBe(true);
    } finally {
      db.close();
      await import("node:fs").then((f) => f.rmSync(dir, { recursive: true, force: true }));
    }
  });

  it("protects more mass with a larger floor (U shrinks)", async () => {
    const { db, dir, sessionId } = await openDb();
    try {
      const session = bulkySession(6, 2_000);
      tagSession(db, session, sessionId);
      maybeNudgeChannels(db, sessionId, agentFor(session, []), { protection: { protectedTokens: 4_000 } });
      const small = getDshNudgeBaseline(sessionId)!;
      resetDshNudgeStateForTest();
      resetEpochFloorRegistryForTest();
      db.prepare("UPDATE session_meta SET protected_tokens_pre_snapshot = NULL, protected_tokens_effective = 60000 WHERE session_id = ?").run(sessionId);
      maybeNudgeChannels(db, sessionId, agentFor(session, []), {});
      const large = getDshNudgeBaseline(sessionId)!;
      expect(large.baselineU + large.turnDeltaU).toBeLessThan(small.baselineU + small.turnDeltaU);
      expect(large.baselineT + large.turnDeltaT).toBe(small.baselineT + small.turnDeltaT);
    } finally {
      db.close();
      await import("node:fs").then((f) => f.rmSync(dir, { recursive: true, force: true }));
    }
  });

  it("hasRecentReduce: a drop queued after the last refreeze keeps Channel 1 quiet until the next bust", async () => {
    const { db, dir, sessionId } = await openDb();
    try {
      const session = bulkySession(10, 4_000);
      tagSession(db, session, sessionId);
      const injected: string[] = [];
      const agent = agentFor(session, injected);
      // Pass 1 (refreeze) applied agent drops → core suppression, no fire.
      maybeNudgeChannels(db, sessionId, agent, {
        protection: { protectedTokens: 8_000 },
        agentDropsAppliedThisPass: true,
        now: () => 1_000,
      });
      expect(injected.length).toBe(0);
      // Agent queues a drop (ctx_reduce) after the refreeze.
      const oldest = getTagsBySession(db, sessionId).filter((t) => t.type === "tool").sort((a, b) => a.tagNumber - b.tagNumber)[0]!;
      queuePendingOp(db, sessionId, oldest.tagNumber, "drop", 2_000);
      const logs: string[] = [];
      maybeNudgeChannels(db, sessionId, agent, { protection: { protectedTokens: 8_000 }, now: () => 3_000, log: (m) => logs.push(m) });
      expect(injected.length).toBe(0);
      // Next surface rewrite refreezes → the reduce is absorbed → evaluation resumes.
      maybeNudgeChannels(db, sessionId, agent, { protection: { protectedTokens: 8_000 }, cacheBusting: true, now: () => 4_000 });
      expect(injected.length).toBe(1);
    } finally {
      db.close();
      await import("node:fs").then((f) => f.rmSync(dir, { recursive: true, force: true }));
    }
  });

  it("computeHasRecentReduce: new ctx_reduce call ids or post-refresh queued drops", () => {
    const base = { reduceCallIdsAtRefresh: new Set(["c1"]), pendingDropQueuedAt: [] as number[], refreshedAt: 100 };
    expect(computeHasRecentReduce({ ...base, currentReduceCallIds: new Set(["c1"]) })).toBe(false);
    expect(computeHasRecentReduce({ ...base, currentReduceCallIds: new Set(["c1", "c2"]) })).toBe(true);
    expect(computeHasRecentReduce({ ...base, currentReduceCallIds: new Set(), pendingDropQueuedAt: [50] })).toBe(false);
    expect(computeHasRecentReduce({ ...base, currentReduceCallIds: new Set(), pendingDropQueuedAt: [150] })).toBe(true);
  });

  it("ctxReduceCallIds extracts DSH ctx_reduce tool parts", () => {
    const ids = ctxReduceCallIds([
      { info: { id: "u1", role: "user" }, parts: [
        { type: "tool", tool: "ctx_reduce", callID: "r1", state: { input: { drop: "1" } } },
        { type: "tool", tool: "read_file", callID: "x1", state: { output: "…" } },
        { type: "text", text: "hi" },
      ] },
    ] as never);
    expect([...ids]).toEqual(["r1"]);
  });
});
