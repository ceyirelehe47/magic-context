import { describe, expect, it } from "bun:test";
import { fireAndForget } from "./fire-and-forget";

/**
 * Round 12 static scan: three detached promises had no rejection handler
 * (agent/index.ts dreamer/recomp seam fill on host.ready, entries/meter.ts
 * token-meter definition capture, host/remote.ts typert disposer). A throw in
 * any of them is an unhandled rejection, which Node ≥15 treats as fatal.
 */
describe("fireAndForget", () => {
  it("logs a rejection instead of leaving it unhandled", async () => {
    const logs: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      fireAndForget(Promise.reject(new Error("seam factory threw")), (m) => logs.push(m), "dreamer seams");
      fireAndForget(
        Promise.resolve().then(() => {
          throw new Error("late");
        }),
        (m) => logs.push(m),
        "meter",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(logs).toEqual([
      "[magic-context] dreamer seams failed (ignored): seam factory threw",
      "[magic-context] meter failed (ignored): late",
    ]);
  });
  it("accepts non-promises and a throwing logger", async () => {
    expect(() => fireAndForget(undefined, undefined, "x")).not.toThrow();
    fireAndForget(Promise.reject("str"), () => {
      throw new Error("logger broke");
    }, "y");
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
