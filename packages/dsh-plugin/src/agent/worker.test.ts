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
      const childId = String(spec.childId ?? `child-${specs.length}`);
      const child = {
        id: childId,
        session: Session.create(SessionId(childId)),
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
    // DSH maxDepth is an absolute cap on the CHILD's depth: parent(0) + 1.
    // A literal 0 made every real rc.5 worker fail ("depth 1 exceeds maxDepth 0").
    expect(spec.request.maxDepth).toBe(1);
    // persona removed in DSH 0.2: the system prompt rides in front of the task.
    expect(spec.request.prompt[0]?.text).toContain("be terse");
    expect(spec.request.prompt.at(-1)?.text).toBe("do the thing");
    // toolFilter removed in DSH 0.2: the allowlist is applied on the child scope.
    expect(sub.restrictions).toEqual([{ allow: ["read", "ctx_search"] }]);
    expect(ctx.listenerCount()).toBe(0); // one-shot listener released
  });

  it("strips a leading §N§ tag the child wrote (worker text never carries a Magic tag into the parent)", async () => {
    let ctxRef: ReturnType<typeof makeCtx> | undefined;
    const sub = fakeSubagents(
      { emitCreated: (a) => ctxRef!.emitCreated(a) },
      { output: "§4§ TOOL: glob\nmid-text §2§ stays" },
    );
    const ctx = makeCtx(sub.service);
    ctxRef = ctx;
    const result = await runMagicWorker(ctx as never, {
      parent: makeParent(),
      label: "x",
      prompt: "x",
      signal: new AbortController().signal,
    });
    expect(result?.text).toBe("TOOL: glob\nmid-text §2§ stays");
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

  it("a finished worker leaves no timeout timer / abort listener behind (no late dispose, no 120 s exit hang)", async () => {
    let ctxRef: ReturnType<typeof makeCtx> | undefined;
    const sub = fakeSubagents({ emitCreated: (a) => ctxRef!.emitCreated(a) });
    let disposed = 0;
    const start = sub.service.startActivation;
    sub.service.startActivation = async (spec: Record<string, unknown>) => {
      const run = await start(spec);
      return { ...run, dispose: async () => void (disposed += 1) };
    };
    const ctx = makeCtx(sub.service);
    ctxRef = ctx;
    const controller = new AbortController();
    let listeners = 0;
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    (signal as { addEventListener: unknown }).addEventListener = (...args: Parameters<typeof add>) => {
      listeners += 1;
      return add(...args);
    };
    (signal as { removeEventListener: unknown }).removeEventListener = (...args: Parameters<typeof remove>) => {
      listeners -= 1;
      return remove(...args);
    };
    const result = await runMagicWorker(ctx as never, {
      parent: makeParent(),
      label: "magic-worker-timer",
      prompt: "p",
      allow: ["read"],
      signal,
      timeoutMs: 30,
      log: () => {},
    });
    expect(result?.text).toBe("worker output");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(disposed).toBe(0);
    expect(listeners).toBe(0);
    // A later abort of the parent's signal must not dispose the finished run.
    controller.abort();
    expect(disposed).toBe(0);
  });
  it("a timed-out worker disposes the child and logs WHY it returned null (round 13 run-32: report had no reason)", async () => {
    let ctxRef: ReturnType<typeof makeCtx> | undefined;
    const sub = fakeSubagents({ emitCreated: (a) => ctxRef!.emitCreated(a) });
    let disposed = 0;
    const start = sub.service.startActivation;
    sub.service.startActivation = async (spec: Record<string, unknown>) => {
      const run = await start(spec);
      return { ...run, result: new Promise<never>(() => {}), dispose: async () => void (disposed += 1) };
    };
    const ctx = makeCtx(sub.service);
    ctxRef = ctx;
    const logs: string[] = [];
    const result = await runMagicWorker(ctx as never, {
      parent: makeParent(),
      label: "magic-worker-timeout",
      prompt: "p",
      allow: ["read"],
      signal: new AbortController().signal,
      timeoutMs: 20,
      log: (m) => logs.push(m),
    });
    expect(result).toBeNull();
    expect(disposed).toBe(1);
    expect(logs.some((m) => m.includes("worker timed out after 20ms"))).toBe(true);
  });

  it("a parent-aborted worker disposes the child and logs the cancel", async () => {
    let ctxRef: ReturnType<typeof makeCtx> | undefined;
    const sub = fakeSubagents({ emitCreated: (a) => ctxRef!.emitCreated(a) });
    let disposed = 0;
    const start = sub.service.startActivation;
    sub.service.startActivation = async (spec: Record<string, unknown>) => {
      const run = await start(spec);
      return { ...run, result: new Promise<never>(() => {}), dispose: async () => void (disposed += 1) };
    };
    const ctx = makeCtx(sub.service);
    ctxRef = ctx;
    const logs: string[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await runMagicWorker(ctx as never, {
      parent: makeParent(),
      label: "magic-worker-abort",
      prompt: "p",
      allow: ["read"],
      signal: controller.signal,
      timeoutMs: 5_000,
      log: (m) => logs.push(m),
    });
    expect(result).toBeNull();
    expect(disposed).toBe(1);
    expect(logs.some((m) => m.includes("worker cancelled"))).toBe(true);
  });

  it("a child that stopped with error/aborted logs the stopReason", async () => {
    let ctxRef: ReturnType<typeof makeCtx> | undefined;
    const sub = fakeSubagents({ emitCreated: (a) => ctxRef!.emitCreated(a) });
    const start = sub.service.startActivation;
    sub.service.startActivation = async (spec: Record<string, unknown>) => {
      const run = await start(spec);
      return { ...run, result: Promise.resolve({ stopReason: "aborted", output: [] }) };
    };
    const ctx = makeCtx(sub.service);
    ctxRef = ctx;
    const logs: string[] = [];
    const result = await runMagicWorker(ctx as never, {
      parent: makeParent(),
      label: "magic-worker-stop",
      prompt: "p",
      allow: ["read"],
      signal: new AbortController().signal,
      log: (m) => logs.push(m),
    });
    expect(result).toBeNull();
    expect(logs.some((m) => m.includes("worker stopped: aborted"))).toBe(true);
  });
});

describe("concurrent workers under one parent (round 15)", () => {
  it("each worker's agent/created listener only touches ITS child (matched by the reserved childId, not just parentSession)", async () => {
    // Two workers of the same parent are in flight at once: both one-shot
    // listeners are registered when either child is created. Matching only on
    // `origin === 'subagent' && parentSession === parent` let worker A apply
    // its allowlist / policy overrides to worker B's child (and mark itself
    // restricted although its own child was never touched).
    const listeners: CreatedListener[] = [];
    const ctx = {
      get: (name: string) => (name === "subagents" ? service : undefined),
      on: (name: string, fn: CreatedListener) => {
        if (name === "agent/created") listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    };
    const restrictionsByChild = new Map<string, Array<readonly string[] | undefined>>();
    const pending: Array<{ spec: Record<string, unknown>; release: () => void }> = [];
    let n = 0;
    const makeChild = (id: string) => {
      const child = {
        id,
        session: Session.create(SessionId(id)),
        ctx: {
          tools: {
            restrict: (filter: { allow?: readonly string[] }) => {
              const list = restrictionsByChild.get(id) ?? [];
              list.push(filter.allow);
              restrictionsByChild.set(id, list);
              return () => {};
            },
          },
        },
      };
      Object.defineProperty(child.session, "header", {
        value: { id, origin: "subagent", parentSession: "parent-1" },
      });
      return child;
    };
    const service = {
      startActivation: (spec: Record<string, unknown>) =>
        new Promise((resolve) => {
          n += 1;
          const id = String(spec.childId ?? `child-${n}`);
          pending.push({
            spec,
            release: () => {
              const child = makeChild(id);
              for (const fn of [...listeners]) fn({ agent: child });
              resolve({
                childId: id,
                result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: `out ${id}` }] }),
                dispose: async () => {},
              });
            },
          });
        }),
    };
    const a = runMagicWorker(ctx as never, {
      parent: makeParent(),
      label: "a",
      prompt: "a",
      allow: ["read"],
      signal: new AbortController().signal,
    });
    const b = runMagicWorker(ctx as never, {
      parent: makeParent(),
      label: "b",
      prompt: "b",
      allow: ["grep"],
      signal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(pending).toHaveLength(2);
    expect(listeners).toHaveLength(2);
    const idA = String(pending[0]!.spec.childId ?? "child-1");
    const idB = String(pending[1]!.spec.childId ?? "child-2");
    // B's child is created first, while A's listener is still registered.
    pending[1]!.release();
    pending[0]!.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(restrictionsByChild.get(idA)).toEqual([["read"]]);
    expect(restrictionsByChild.get(idB)).toEqual([["grep"]]);
    expect(ra?.text).toBe(`out ${idA}`);
    expect(rb?.text).toBe(`out ${idB}`);
    expect(listeners).toHaveLength(0);
    // Reserved ids are distinct per worker.
    expect(pending[0]!.spec.childId).toBeDefined();
    expect(idA).not.toBe(idB);
  });
});
