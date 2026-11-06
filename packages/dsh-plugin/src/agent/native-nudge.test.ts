/**
 * Round 36 line H — ctx_reduce nudge measurement in the plan-N native-role
 * view (limitation 31) on a REAL @deepseek-ai/dsh-session Session, driven
 * through the real pre-step body (`runContextPlaneStep` → `maybeNudgeChannels`).
 *
 * Native view: the assistant node keeps its tool-call part (input only) and the
 * output lives on a separate tool-result (synthetic user) message. The tag row
 * is owned by the call (`toolOwnerMessageId` = assistant). Pi pairs a
 * `toolResult` with the call that owns it (tail-hygiene-walk-pi arcs); the
 * nudge measurement must do the same, so U (undropped reclaimable tokens)
 * counts the output and channel 1 / 2 fire as in the fold view.
 *
 * Fold view (switch off): U/T per turn and the nudge log are pinned to the
 * values measured before the fix (no behaviour change).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createToolResultMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { observedProtectionWindow } from "./protection";
import { nudgeMeasurementMessages } from "./nudge";
import { refreshTailHygieneBaseline } from "@magic-context/core/hooks/magic-context/tail-hygiene-walk";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import { evaluateChannel2 } from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";

const WINDOW = 100_000;

type TagRow = { tag_number: number; type: string; status: string; message_id: string };
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

// Pinned from the pre-fix tree (aa4c00b93), switch off.
const FOLD_U = [18042, 45106, 72170, 99234, 126298];
const FOLD_T = [27062, 54126, 81190, 108254, 135318];
const FOLD_C2 = ["quiet", "quiet", "trigger", "trigger", "trigger"];
const FOLD_LOGS = [
  "[magic-context] channel1 nudge fired: level=urgent U=54130 T=63150 reason=band-crossing",
  "[magic-context] channel2 nudge delivered: reclaimable~54k",
];

const READS_PER_TURN = 6;
const TURNS = 5;
const BODY_REPEAT = 1500; // "BODYk " x 1500 = ~9000 B, ~4.5k tokens per read

interface Measured {
  u: number[];
  t: number[];
  c2: string[];
  logs: string[];
}

async function runReads(native: boolean): Promise<Measured> {
  const out: Measured = { u: [], t: [], c2: [], logs: [] };
  await scenario(
    async (h) => {
      let k = 0;
      for (let turn = 1; turn <= TURNS; turn += 1) {
        addUser(h.session, `question ${turn}`);
        await h.step();
        for (let c = 0; c < READS_PER_TURN; c += 1) {
          k += 1;
          addCall(h.session, k);
          await h.step();
          addResult(h.session, k, `BODY${k} `.repeat(BODY_REPEAT));
          await h.step();
        }
        addReply(h.session, k);
        const msgs = nudgeMeasurementMessages({ id: h.session.id, session: h.session } as never, h.key);
        const prot = observedProtectionWindow(h.db, h.key, { protectedTokens: 4000, contextWindow: WINDOW });
        const b = refreshTailHygieneBaseline({
          messages: msgs,
          tags: getTagsBySession(h.db, h.key),
          protectedTagNumbers: prot.protectedTagNumbers,
          pendingDropTagNumbers: new Set(),
          cacheBusting: true,
          previous: undefined,
          calibration: { toolsRatio: 1, proseRatio: 1 },
          now: Date.now(),
        } as never);
        out.u.push(b.baselineU);
        out.t.push(b.baselineT);
        const c2 = evaluateChannel2(b) as unknown as { shouldTrigger: boolean; reason?: string };
        out.c2.push(c2.shouldTrigger ? "trigger" : "quiet");
      }
      out.logs = h.logs.filter((l) => /nudge/.test(l));
    },
    { native },
  );
  return out;
}

describe("round 36 line H — ctx_reduce nudge measurement, native roles", () => {
  it("H1 native: U counts tool-result output (same order as fold) and channel 1 / 2 fire", async () => {
    const fold = await runReads(false);
    const native = await runReads(true);
    console.log(`H1 fold   U=${fold.u.join(",")} T=${fold.t.join(",")} c2=${fold.c2.join(",")} logs=${fold.logs.join(" || ")}`);
    console.log(`H1 native U=${native.u.join(",")} T=${native.t.join(",")} c2=${native.c2.join(",")} logs=${native.logs.join(" || ")}`);
    // T (live tail) already agreed before the fix; U must now too.
    for (let i = 0; i < TURNS; i += 1) {
      expect(native.u[i]).toBeGreaterThan(fold.u[i] * 0.5);
      expect(native.u[i]).toBeLessThan(fold.u[i] * 2);
    }
    expect(native.u[0]).toBeGreaterThan(10_000);
    expect(native.logs.some((l) => l.includes("channel1 nudge fired"))).toBe(true);
    expect(native.logs.some((l) => l.includes("channel2 nudge delivered"))).toBe(true);
    // Channel 2 by the same turn as fold (ceiling threshold).
    expect(native.c2.indexOf("trigger")).toBeGreaterThanOrEqual(0);
    expect(native.c2.indexOf("trigger")).toBeLessThanOrEqual(fold.c2.indexOf("trigger"));
  });

  it("H2 fold (switch off): measurement and nudge log unchanged (pinned pre-fix values)", async () => {
    const fold = await runReads(false);
    expect(fold.u).toEqual(FOLD_U);
    expect(fold.t).toEqual(FOLD_T);
    expect(fold.c2).toEqual(FOLD_C2);
    expect(fold.logs).toEqual(FOLD_LOGS);
  });
});
