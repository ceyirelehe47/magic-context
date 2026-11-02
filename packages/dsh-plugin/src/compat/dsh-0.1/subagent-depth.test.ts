import { describe, expect, it } from "bun:test";
import { resolveChildDepth } from "@deepseek-ai/dsh-subagent";
import { workerMaxDepth } from "./subagent";

const agent = (header?: number, runtime?: number) =>
  ({ options: { subagentDepth: runtime }, session: { header: { delegationDepth: header } } }) as never;

describe("workerMaxDepth (rc.5 absolute depth cap)", () => {
  it("lets a top-level parent start exactly one child level", () => {
    const parent = agent();
    expect(workerMaxDepth(parent)).toBe(1);
    expect(() => resolveChildDepth(parent, workerMaxDepth(parent))).not.toThrow();
    expect(() => resolveChildDepth(parent, 0)).toThrow(/exceeds maxDepth 0/);
  });
  it("follows a nested parent's depth and still forbids grandchildren", () => {
    const parent = agent(2, 1);
    expect(workerMaxDepth(parent)).toBe(3);
    const child = agent(3);
    expect(() => resolveChildDepth(child, workerMaxDepth(parent))).toThrow();
  });
  it("tolerates a parent with no depth fields", () => {
    expect(workerMaxDepth({} as never)).toBe(1);
  });
});
