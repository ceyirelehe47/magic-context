import { describe, expect, it } from "bun:test";
import { childVisibleToolNames } from "../compat/dsh-0.1/subagent";
import { WORKER_SELFTEST_TOOL, createWorkerSelftestTool, workerSelftestEnabled } from "./worker-selftest";

describe("worker self-test (env-gated diagnostics)", () => {
  it("is enabled only by MAGIC_CONTEXT_DSH_WORKER_SELFTEST=1", () => {
    expect(workerSelftestEnabled({})).toBe(false);
    expect(workerSelftestEnabled({ MAGIC_CONTEXT_DSH_WORKER_SELFTEST: "0" })).toBe(false);
    expect(workerSelftestEnabled({ MAGIC_CONTEXT_DSH_WORKER_SELFTEST: "1" })).toBe(true);
  });
  it("defines the ctx_worker_selftest tool", () => {
    const tool = createWorkerSelftestTool({} as never) as { name: string };
    expect(tool.name).toBe(WORKER_SELFTEST_TOOL);
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
