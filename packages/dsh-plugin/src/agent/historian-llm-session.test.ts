/**
 * Round 36 line I — I1: the Magic Context historian request carries no session
 * identity.
 *
 * Verification run 42274076026 (1M evo bench, native, commit dc916285b): both
 * historian requests were rejected by the OpenCode Go gateway with HTTP 400
 * `{"type":"MissingSessionID","message":"Request is missing x-opencode-session
 * and cannot be routed efficiently"}` (resp/365.json, resp/377.json; the same 2 ×
 * 400 in 42262946905 native run 2). Main-loop requests on the same catalog route
 * pass: the loop stamps `GenerateOptions.sessionId`, which the pi-ai adapter maps
 * to the header. DSH's own summarizer (compaction-basic) passes
 * `sessionId: agent.session.id, purpose: "compaction"`; the plugin's historian
 * call (`createLlmSummarizeCall` → `ctx.llm.stream`) passed no `sessionId`, so on
 * this route the historian could never run (silent in headless: ctx.logger is not
 * printed). Parity fix: the historian request carries the DSH session id.
 */
import { describe, expect, it } from "bun:test";
import type { Context } from "@deepseek-ai/cordis";
import { createLlmSummarizeCall } from "./historian-wiring";

function stubCtx(seen: Array<Record<string, unknown>>): Context {
  return {
    get: (name: string) =>
      name === "llm"
        ? {
            stream: (request: Record<string, unknown>) => {
              seen.push(request);
              return (async function* () {
                yield { type: "text-delta", text: "<output></output>" };
                yield { type: "finish", reason: { kind: "stop" } };
              })();
            },
          }
        : undefined,
  } as unknown as Context;
}

const chunk = { text: "[1] U: hello", startIndex: 1, endIndex: 1, messageCount: 1 };

describe("historian LLM request session identity (I1)", () => {
  it("passes the DSH session id to ctx.llm.stream (compaction-basic parity), purpose compaction", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const call = (createLlmSummarizeCall as (...a: unknown[]) => unknown)(stubCtx(seen), "p/m", "dsh-session-42") as (
      ...args: unknown[]
    ) => Promise<string>;
    await call(chunk, [], undefined, undefined, undefined);
    expect(seen.length).toBe(1);
    expect(seen[0].sessionId).toBe("dsh-session-42");
    expect(seen[0].purpose).toBe("compaction");
  });

  it("control: without a session id the request is unchanged (no sessionId key)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const call = createLlmSummarizeCall(stubCtx(seen), "p/m") as (...args: unknown[]) => Promise<string>;
    await call(chunk, [], undefined, undefined, undefined);
    expect(seen.length).toBe(1);
    expect("sessionId" in seen[0]).toBe(false);
  });
});
