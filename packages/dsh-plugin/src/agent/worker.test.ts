import { describe, expect, it } from "bun:test";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { isMagicChildSession, runMagicWorker } from "./worker";

type CreatedListener = (payload: { agent: unknown }) => undefined;

/**
 * Fake DSH 0.2 subagents service: `startActivation(spec)` fires the host's
 * `agent/created` listeners for a child agent (as DSH does before the
 * activation resolves), then returns the activation.
 */
function fakeSubagents(
  host: { emitCreated: (agent: unknown) => void },
  opts: { output?: string; childParentSession?: string; childHasTools?: boolean } = {},
) {
  const specs: Array<Record<string, unknown>> = [];
  const restrictions: Array<{ allow?: readonly string[] }> = [];
  const service = {
    startActivation: async (spec: Record<string, unknown>) => {
      specs.push(spec);
      const child = {
        id: `child-${specs.length}`,
        session: Session.create(SessionId(`child-${specs.length}`)),
        ctx:
          opts.childHasTools === false
            ? {}
            : { tools: { restrict: (filter: { allow?: readonly string[] }) => { restrictions.push(filter); return () => {}; } } },
      };
      Object.defineProperty(child.session, "header", {
        value: { origin: "subagent", parentSession: opts.childParentSession ?? "parent-1" },
      });
      host.emitCreated(child);
      return {
        childId: child.id,
        result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: opts.output ?? "worker output" }] }),
        dispose: async () => {},
      };
    },
  };
  return { service, specs, restrictions };
}

function makeCtx(subagents: unknown) {
  const listeners: CreatedListener[] = [];
  return {
    get: (name: string) => (name === "subagents" ? subagents : undefined),
    on: (name: string, fn: CreatedListener) => {
      if (name === "agent/created") listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    emitCreated: (agent: unknown) => {
      for (const fn of [...listeners]) fn({ agent });
    },
    listenerCount: () => listeners.length,
  };
}

function makeParent() {
  const session = Session.create(SessionId("parent-1"));
  return { id: "parent-1", session, options: {}, ctx: { get: () => undefined } } as never;
}

describe("magic worker (PLAN §5.13 minimal worker)", () => {
  it("starts a caller-delivered activation with depth 0, restricts the child's tools and returns the text", async () => {
    let ctxRef: ReturnType<typeof makeCtx> | undefined;
    const sub = fakeSubagents({ emitCreated: (a) => ctxRef!.emitCreated(a) });
    const ctx = makeCtx(sub.service);
    ctxRef = ctx;
    const result = await runMagicWorker(ctx as never, {
      parent: makeParent(),
      label: "magic-worker-test",
      prompt: "do the thing",
      systemPrompt: "be terse",
      allow: ["read", "ctx_search"],
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(result?.text).toBe("worker output");
    expect(sub.specs).toHaveLength(1);
    const spec = sub.specs[0] as {
      provider: string;
      delivery: string;
      request: { maxDepth?: number; prompt: Array<{ text: string }> };
    };
    expect(spec.provider).toBe("spawn");
    expect(spec.delivery).toBe("caller");
    expect(spec.request.maxDepth).toBe(0);
    // persona removed in DSH 0.2: the system prompt rides in front of the task.
    expect(spec.request.prompt[0]?.text).toContain("be terse");
    expect(spec.request.prompt.at(-1)?.text).toBe("do the thing");
    // toolFilter removed in DSH 0.2: the allowlist is applied on the child scope.
    expect(sub.restrictions).toEqual([{ allow: ["read", "ctx_search"] }]);
    expect(ctx.listenerCount()).toBe(0); // one-shot listener released
  });

  it("fails closed when the child's tools cannot be restricted", async () => {
    let ctxRef: ReturnType<typeof makeCtx> | undefined;
    const sub = fakeSubagents({ emitCreated: (a) => ctxRef!.emitCreated(a) }, { childHasTools: false });
    const ctx = makeCtx(sub.service);
    ctxRef = ctx;
    const result = await runMagicWorker(ctx as never, {
      parent: makeParent(),
      label: "x",
      prompt: "x",
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(result).toBeNull();
  });

  it("returns null on failure / missing service (never throws)", async () => {
    // No subagents service.
    const noService = await runMagicWorker(makeCtx(undefined) as never, {
      parent: makeParent(),
      label: "x",
      prompt: "x",
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(noService).toBeNull();
    // Failed run (stopReason error).
    let ctxRef: ReturnType<typeof makeCtx> | undefined;
    const failing = fakeSubagents({ emitCreated: (a) => ctxRef!.emitCreated(a) });
    const original = failing.service.startActivation;
    failing.service.startActivation = async (spec) => {
      const activation = await original(spec);
      return { ...activation, result: Promise.resolve({ stopReason: "error", output: [] } as never) };
    };
    const failCtx = makeCtx(failing.service);
    ctxRef = failCtx;
    const failed = await runMagicWorker(failCtx as never, {
      parent: makeParent(),
      label: "x",
      prompt: "x",
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(failed).toBeNull();
  });
});

describe("recursion isolation (PLAN §9)", () => {
  it("identifies child sessions by origin or delegation depth", () => {
    const base = { session: { header: {} } };
    expect(isMagicChildSession(base as never)).toBe(false);
    expect(isMagicChildSession({ session: { header: { origin: "subagent" } } } as never)).toBe(
      true,
    );
    expect(isMagicChildSession({ session: { header: { delegationDepth: 1 } } } as never)).toBe(
      true,
    );
    expect(isMagicChildSession({ session: { header: { delegationDepth: 3 } } } as never)).toBe(
      true,
    );
    expect(isMagicChildSession({ session: { header: { delegationDepth: 0 } } } as never)).toBe(
      false,
    );
  });
});
