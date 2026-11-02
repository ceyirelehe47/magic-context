import { describe, expect, it } from "bun:test";
import { MAGIC_WORKER_READONLY_TOOLS, restrictChildTools } from "./subagent";

/** Mimics rc.5 `tools.restrict()`: throws on any unknown global name. */
function fakeChild(known: string[]) {
  const calls: string[][] = [];
  const tools = {
    get: (name: string) => (known.includes(name) ? { name } : undefined),
    restrict: (filter: { allow?: readonly string[] }) => {
      const unknown = (filter.allow ?? []).filter((n) => !known.includes(n));
      if (unknown.length > 0) throw new Error(`unknown global tool ${unknown.join(", ")}`);
      calls.push([...(filter.allow ?? [])]);
      return () => {};
    },
  };
  return { child: { ctx: { tools } } as never, calls };
}

describe("restrictChildTools on rc.5 tool catalogs", () => {
  it("drops allowlist names the registry lacks (rc.5 has no fs_search)", () => {
    const { child, calls } = fakeChild(["read", "write", "grep", "glob", "bash"]);
    expect(restrictChildTools(child, MAGIC_WORKER_READONLY_TOOLS)).toBe(true);
    expect(calls).toEqual([["read", "grep", "glob"]]);
  });

  it("fails closed when no allowlisted tool exists", () => {
    const { child, calls } = fakeChild(["bash"]);
    expect(restrictChildTools(child, MAGIC_WORKER_READONLY_TOOLS)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("never widens: unlisted known tools stay masked", () => {
    const { child, calls } = fakeChild(["read", "bash", "write"]);
    restrictChildTools(child, ["read", "fs_search"]);
    expect(calls).toEqual([["read"]]);
  });
});
