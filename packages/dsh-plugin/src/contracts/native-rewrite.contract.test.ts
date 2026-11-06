/**
 * Plan N rewrite primitives contract (round 36 line G; runtime, every declared
 * DSH version — CI `contracts-dsh` runs this against alpha.3 / rc.1 too).
 *
 * The native-role view (`agent/tag-scheme.ts`) relies on three DSH session
 * rules the official `dsh-compaction-tool-result-pruner` relies on as well:
 *   1. a single-node `tool/result` replace may change ONLY `message.content`
 *      (callId / isError / turn / step deep-equal; `assertToolResultRewrite`);
 *   2. an `assistant/message` can never be a replace product;
 *   3. token-meter consumes a `compaction/prune` claim on the very next replace
 *      and prices appends with the `estimateMessage` heuristic the adapter
 *      uses for the shadow price (`meterEstimateMessage`).
 * A DSH that loosens or renames any of these fails here first.
 */
import { describe, expect, it } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import {
  meterEstimateMessage,
  replaceToolResultContent,
  sessionEventAt,
  sessionEvents,
} from "../compat/dsh-0.1/session";
import { toolTurn } from "../agent/crash-recovery.helpers";

describe("DSH plan-N rewrite primitives (installed DSH version)", () => {
  it("content-only tool/result replace keeps role and pairing; anything else is refused", () => {
    const s = Session.create(SessionId("contract-native-1"));
    toolTurn(s, 1, 20);
    const toolSeq = s.surface.nodes[2]!;
    const newSeq = replaceToolResultContent(s, toolSeq, "\u00a71\u00a7 BODY1");
    const msgs = s.deriveMessages() as unknown as Array<{ role: string; toolCallId?: string; content: Array<{ text?: string }> }>;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(msgs[2]!.toolCallId).toBe("call-1");
    expect(msgs[2]!.content[0]!.text).toBe("\u00a71\u00a7 BODY1");
    expect(s.surface.nodes[2]).toBe(newSeq as never);
    const prev = sessionEventAt(s, newSeq - 1) as unknown as { type: string };
    expect(prev.type).toBe("compaction/prune");

    const live = sessionEventAt(s, newSeq) as unknown as { data: { message: Record<string, unknown> } & Record<string, unknown> };
    const replace = { surfaceOp: { op: "replace", startSeq: SessionSeq(newSeq), endSeq: SessionSeq(newSeq) }, sourceEventSeqs: [SessionSeq(newSeq)] };
    expect(() =>
      s.append("tool/result", { ...live.data, message: { ...live.data.message, isError: true } } as never, replace as never),
    ).toThrow();
    const assistantSeq = s.surface.nodes[1]!;
    const assistant = sessionEventAt(s, assistantSeq) as unknown as { data: unknown };
    expect(() =>
      s.append("assistant/message", assistant.data as never, {
        surfaceOp: { op: "replace", startSeq: SessionSeq(assistantSeq), endSeq: SessionSeq(assistantSeq) },
        sourceEventSeqs: [SessionSeq(assistantSeq)],
      } as never),
    ).toThrow();
  });

  it("token-meter prices the replaced node out with the adapter's shadow price (no drift)", async () => {
    const defs = new Map<string, { key: string; init: () => unknown; apply: (st: unknown, e: unknown) => unknown; wire: { view: (st: unknown) => { messageTokens: number } } }>();
    const ctx = new Context();
    ctx.provide("sessionProjections", {
      register(d: never) {
        defs.set((d as { key: string }).key, d);
        return () => defs.delete((d as { key: string }).key);
      },
    } as never);
    (ctx as unknown as { plugin(p: unknown): void }).plugin(TokenMeter);
    for (let i = 0; i < 40 && !defs.has("contextBreakdown"); i += 1) await new Promise((r) => setTimeout(r, 5));
    const def = defs.get("contextBreakdown")!;
    const s = Session.create(SessionId("contract-native-2"));
    toolTurn(s, 1, 2000);
    replaceToolResultContent(s, s.surface.nodes[2]!, "[dropped \u00a71\u00a7]");
    const folded = def.wire.view((sessionEvents(s) as unknown[]).reduce((st, e) => def.apply(st, e), def.init())).messageTokens;
    const live = (s.deriveMessages() as unknown[]).reduce((n: number, m) => n + meterEstimateMessage(m), 0);
    expect(folded).toBe(live);
    expect(folded).toBeLessThan(200);
  });
});
