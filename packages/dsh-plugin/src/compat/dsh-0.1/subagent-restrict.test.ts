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

  it("sees tools an ANCESTOR (preset-plane) layer registered: checks the child's scoped view, not the global one", () => {
    // rc.5 tools.get(name) without a scope reads the GLOBAL layer only, while
    // restrict() validates against view(scope).restrictableNames (global +
    // every ancestor layer). Tools contributed on the agent plane are absent
    // from the global view.
    const calls: string[][] = [];
    const global = new Set(["bash"]);
    const inherited = new Set(["bash", "read", "grep", "glob"]);
    let child: unknown;
    const tools = {
      get: (name: string, scope?: unknown) => ((scope === child ? inherited : global).has(name) ? { name } : undefined),
      view: (scope?: unknown) => ({ restrictableNames: scope === child ? inherited : global }),
      restrict: (filter: { allow?: readonly string[] }) => {
        const unknown = (filter.allow ?? []).filter((n) => !inherited.has(n));
        if (unknown.length > 0) throw new Error(`unknown global tool ${unknown.join(", ")}`);
        calls.push([...(filter.allow ?? [])]);
        return () => {};
      },
    };
    child = { ctx: { tools } };
    expect(restrictChildTools(child as never, MAGIC_WORKER_READONLY_TOOLS)).toBe(true);
    expect(calls).toEqual([["read", "grep", "glob"]]);
  });

  it("a scope-local name (not restrictable) is never passed to restrict()", () => {
    const calls: string[][] = [];
    let child: unknown;
    const restrictable = new Set(["read", "grep"]);
    const visible = new Set(["read", "grep", "glob"]); // glob registered in the child's OWN layer
    const tools = {
      get: (name: string, scope?: unknown) => (scope === child && visible.has(name) ? { name } : undefined),
      view: (scope?: unknown) => ({ restrictableNames: scope === child ? restrictable : new Set<string>() }),
      restrict: (filter: { allow?: readonly string[] }) => {
        const unknown = (filter.allow ?? []).filter((n) => !restrictable.has(n));
        if (unknown.length > 0) throw new Error(`unknown global tool ${unknown.join(", ")}`);
        calls.push([...(filter.allow ?? [])]);
        return () => {};
      },
    };
    child = { ctx: { tools } };
    expect(restrictChildTools(child as never, MAGIC_WORKER_READONLY_TOOLS)).toBe(true);
    expect(calls).toEqual([["read", "grep"]]);
  });
});
