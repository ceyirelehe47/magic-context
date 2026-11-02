import { describe, expect, it } from "bun:test";
import { childToolResolution, childVisibleToolNames } from "../compat/dsh-0.1/subagent";
import {
  WORKER_SELFTEST_TOOL,
  createWorkerSelftestTool,
  workerSelftestEnabled,
  workerSelftestTimeoutMs,
} from "./worker-selftest";

describe("worker self-test (env-gated diagnostics)", () => {
  it("is enabled only by MAGIC_CONTEXT_DSH_WORKER_SELFTEST=1", () => {
    expect(workerSelftestEnabled({})).toBe(false);
    expect(workerSelftestEnabled({ MAGIC_CONTEXT_DSH_WORKER_SELFTEST: "0" })).toBe(false);
    expect(workerSelftestEnabled({ MAGIC_CONTEXT_DSH_WORKER_SELFTEST: "1" })).toBe(true);
  });
  it("timeout is overridable only by a positive integer env value", () => {
    expect(workerSelftestTimeoutMs({})).toBe(180_000);
    expect(workerSelftestTimeoutMs({ MAGIC_CONTEXT_DSH_WORKER_SELFTEST_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(workerSelftestTimeoutMs({ MAGIC_CONTEXT_DSH_WORKER_SELFTEST_TIMEOUT_MS: "-5" })).toBe(180_000);
    expect(workerSelftestTimeoutMs({ MAGIC_CONTEXT_DSH_WORKER_SELFTEST_TIMEOUT_MS: "abc" })).toBe(180_000);
  });
  it("defines the ctx_worker_selftest tool", () => {
    const tool = createWorkerSelftestTool({} as never) as { name: string };
    expect(tool.name).toBe(WORKER_SELFTEST_TOOL);
  });
  it("childToolResolution compares the child's scoped lookup with the global one", () => {
    let child: unknown;
    const tools = {
      get: (name: string, scope?: unknown) =>
        scope === child ? (name === "read" ? {} : undefined) : name === "bash" || name === "read" ? {} : undefined,
    };
    child = { ctx: { tools } };
    expect(childToolResolution(child as never, ["bash", "read", "nope"])).toEqual({
      bash: { global: true, child: false },
      read: { global: true, child: true },
      nope: { global: false, child: false },
    });
    expect(childToolResolution({ ctx: {} } as never, ["bash"])).toBeUndefined();
  });
  it("childVisibleToolNames reads the child's scoped view", () => {
    let child: unknown;
    const tools = {
      view: (scope?: unknown) => ({ visible: new Map(scope === child ? [["read", 1], ["glob", 1], ["grep", 1]] : [["bash", 1]]) }),
    };
    child = { ctx: { tools } };
    expect(childVisibleToolNames(child as never)).toEqual(["glob", "grep", "read"]);
    expect(childVisibleToolNames({ ctx: {} } as never)).toBeUndefined();
  });
});
