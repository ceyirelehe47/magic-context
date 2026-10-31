import { describe, expect, it } from "bun:test";
import {
  AWAIT_TURN_END_ENV,
  createHistorianDrain,
  resolveAwaitAtTurnEndMs,
} from "./historian-drain";
import { awaitHistorianAtTurnEnd, type ContextPlaneDeps } from "./context-plane";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("historian drain", () => {
  it("tracks in-flight passes per session and forgets settled ones", async () => {
    const drain = createHistorianDrain();
    let release!: () => void;
    drain.track("s1", new Promise<void>((resolve) => { release = resolve; }));
    drain.track("s2", Promise.reject(new Error("boom")));
    expect(drain.pending("s1")).toBe(1);
    await sleep(0);
    expect(drain.pending("s2")).toBe(0);
    release();
    await sleep(0);
    expect(drain.pending()).toBe(0);
  });

  it("waits until passes settle", async () => {
    const drain = createHistorianDrain();
    drain.track("s1", sleep(30));
    const result = await drain.drain(1_000, "s1");
    expect(result.settled).toBe(true);
    expect(result.pending).toBe(0);
  });

  it("stops waiting at the deadline without cancelling the pass", async () => {
    const drain = createHistorianDrain();
    let done = false;
    drain.track("s1", sleep(80).then(() => { done = true; }));
    const result = await drain.drain(10);
    expect(result.settled).toBe(false);
    expect(result.pending).toBe(1);
    await sleep(100);
    expect(done).toBe(true);
    expect(drain.pending()).toBe(0);
  });

  it("drain with nothing in flight returns immediately", async () => {
    const result = await createHistorianDrain().drain(5_000);
    expect(result).toEqual({ settled: true, pending: 0, waitedMs: 0 });
  });
});

describe("resolveAwaitAtTurnEndMs", () => {
  it("config wins over env; non-positive disables", () => {
    expect(resolveAwaitAtTurnEndMs(2500, { [AWAIT_TURN_END_ENV]: "9000" })).toBe(2500);
    expect(resolveAwaitAtTurnEndMs(0, { [AWAIT_TURN_END_ENV]: "9000" })).toBe(0);
    expect(resolveAwaitAtTurnEndMs(undefined, { [AWAIT_TURN_END_ENV]: "9000" })).toBe(9000);
    expect(resolveAwaitAtTurnEndMs(undefined, { [AWAIT_TURN_END_ENV]: "nope" })).toBe(0);
    expect(resolveAwaitAtTurnEndMs(undefined, {})).toBe(0);
  });
});

describe("awaitHistorianAtTurnEnd", () => {
  const agent = { id: "agent-1", session: { events: [], surface: [], header: {} } } as never;
  const host = (sessionId: string) => ({
    ready: Promise.resolve({ kind: "ok", db: {} }),
    canonicalKey: () => sessionId,
  }) as unknown as ContextPlaneDeps["host"];

  it("awaits the session's in-flight pass at the turn boundary", async () => {
    const drain = createHistorianDrain();
    let published = false;
    drain.track("canon-1", sleep(40).then(() => { published = true; }));
    const logs: string[] = [];
    await awaitHistorianAtTurnEnd(
      { host: host("canon-1"), historian: { fire: () => {}, drain }, log: (m) => logs.push(m) },
      agent,
      1_000,
    );
    expect(published).toBe(true);
    expect(logs.some((line) => line.includes("settled=true"))).toBe(true);
  });

  it("re-evaluates the trigger with the final pressure and awaits the new pass", async () => {
    const drain = createHistorianDrain();
    let published = false;
    const fired: string[] = [];
    await awaitHistorianAtTurnEnd(
      {
        host: host("canon-2"),
        historian: {
          config: { executeThresholdPercentage: 50 },
          readPressure: () => ({ projectedTokens: 900, contextWindow: 1000 }),
          fire: ({ sessionId }) => {
            fired.push(sessionId);
            drain.track(sessionId, sleep(30).then(() => { published = true; }));
          },
          drain,
        },
      },
      agent,
      1_000,
    );
    expect(fired).toEqual(["canon-2"]);
    expect(published).toBe(true);
  });

  it("is a no-op when disabled or the budget is 0", async () => {
    const drain = createHistorianDrain();
    let fired = 0;
    const deps: ContextPlaneDeps = {
      host: host("canon-3"),
      historian: {
        readPressure: () => ({ projectedTokens: 999, contextWindow: 1000 }),
        fire: () => { fired += 1; },
        drain,
      },
    };
    await awaitHistorianAtTurnEnd(deps, agent, 0);
    await awaitHistorianAtTurnEnd(
      { ...deps, historian: { ...deps.historian!, config: { enabled: false } } },
      agent,
      1_000,
    );
    expect(fired).toBe(0);
  });
});
