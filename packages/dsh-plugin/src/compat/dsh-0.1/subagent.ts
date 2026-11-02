/**
 * compat/dsh-0.1/subagent — the minimal worker seam (PLAN §5.13 / D7).
 *
 * Validated in Phase 0 spike-5 (DSH 0.1): capability validation is fail-loud,
 * depth is capped, delegated approval is pinned to 'never'. Ported to DSH 0.2:
 * `startActivation({ provider: "spawn", delivery: "caller" })`, tool scoping
 * via the child scope's `tools.restrict` (request-level `toolFilter` removed). The adapter does NOT depend on any undeclared `AgentOptions.role`
 * field.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  resolveChildDepth,
  SubagentDepthError,
  type SubagentActivation,
  type SubagentActivationSpec,
  type SubagentRuntime,
  type SubagentStartRequest,
} from "@deepseek-ai/dsh-subagent";
import type { ToolRestriction } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";

export {
  SubagentDepthError,
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  resolveChildDepth,
};
export type {
  SubagentActivation,
  SubagentActivationSpec,
  SubagentRuntime,
  SubagentStartRequest,
  ToolRestriction,
};

/** Tool allowlist for a Magic worker (read-only maintenance surface). */
export const MAGIC_WORKER_READONLY_TOOLS: readonly string[] = [
  "read",
  "grep",
  "glob",
  "fs_search",
];

/**
 * DSH `request.maxDepth` is an ABSOLUTE cap on the child's delegation depth
 * (`resolveChildDepth`: child = parent + 1, must be <= maxDepth). Pinning a
 * worker to "no further spawning" therefore means maxDepth = parent + 1; a
 * literal 0 rejects every worker ("subagent depth 1 exceeds maxDepth 0",
 * observed on real rc.5).
 */
export function workerMaxDepth(parent: Agent): number {
  // Mirrors rc.5 `delegationDepthOf` (max of the session header's persisted
  // depth and the runtime option) but tolerates a parent without either.
  const p = parent as unknown as {
    options?: { subagentDepth?: unknown };
    session?: { header?: { delegationDepth?: unknown } };
  };
  const num = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  return Math.max(num(p.session?.header?.delegationDepth), num(p.options?.subagentDepth)) + 1;
}

/** Default local provider registered by DSH's subagent tooling. */
export const MAGIC_WORKER_PROVIDER = "spawn";

/**
 * Build the one-shot activation spec for a Magic worker (DSH 0.2
 * `SubagentRuntime.startActivation`): depth pinned, parent-bound cancellation,
 * `delivery: "caller"` (the result returns to Magic only — the parent model
 * is never notified).
 *
 * DSH 0.2 removed `SubagentRuntime.start()`, the request-level `toolFilter`
 * and `persona`. The worker's system prompt is therefore prepended to the
 * task prompt, and the tool allowlist is enforced separately on the child
 * agent's scope (see {@link restrictChildTools}).
 */
export function magicWorkerActivation(
  parent: Agent,
  opts: {
    label: string;
    prompt: ContentBlock[];
    maxDepth?: number;
    signal: AbortSignal;
    systemPrompt?: string;
    provider?: string;
    /**
     * Reserved child session id (local backends only; rc.5 `startLocal`
     * honours `spec.childId`). Lets the caller recognise ITS child in an
     * `agent/created` listener when several workers of one parent overlap.
     */
    childId?: string;
  },
): SubagentActivationSpec {
  const prompt: ContentBlock[] =
    opts.systemPrompt === undefined || opts.systemPrompt.length === 0
      ? opts.prompt
      : [{ type: "text", text: `<system>\n${opts.systemPrompt}\n</system>` }, ...opts.prompt];
  return {
    provider: opts.provider ?? MAGIC_WORKER_PROVIDER,
    label: opts.label,
    signal: opts.signal,
    delivery: "caller",
    ...(opts.childId !== undefined ? { childId: opts.childId as SubagentActivationSpec["childId"] } : {}),
    request: {
      prompt,
      parent,
      maxDepth: opts.maxDepth ?? 1,
    },
  };
}

/**
 * Apply a global-tool allowlist to a child agent's own scope
 * (`ctx.tools.restrict` on the child's context). Returns false when the child
 * exposes no tools registry (caller must fail closed).
 */
export function restrictChildTools(child: Agent, allow: readonly string[]): boolean {
  const scoped = (child as unknown as { ctx?: { get?: (name: string) => unknown; tools?: unknown } }).ctx;
  const tools = (scoped?.tools ?? scoped?.get?.("tools")) as
    | {
        restrict?: (filter: ToolRestriction) => () => void;
        get?: (name: string, scope?: unknown) => unknown;
        view?: (scope?: unknown) => { restrictableNames?: ReadonlySet<string> } | undefined;
      }
    | undefined;
  if (typeof tools?.restrict !== "function") return false;
  // rc.5 `tools.restrict()` throws on ANY name outside the child scope's
  // `view(scope).restrictableNames` (the global layer + every ANCESTOR layer,
  // e.g. tools a preset mounted on the agent plane; never the child's own
  // layer). A default allowlist naming a tool this install lacks (e.g.
  // `fs_search`, which rc.5 splits into `grep`/`glob`) would fail the worker
  // closed forever, so keep only names restrict() will accept. Check the
  // CHILD's scoped view: `get(name)` without a scope reads the global layer
  // only and misses ancestor contributions. An empty result still fails closed.
  const known = knownRestrictableNames(tools, child, allow);
  if (known.length === 0) return false;
  tools.restrict({ allow: known });
  return true;
}

/**
 * The tool names a child agent can call after its restriction (rc.5
 * `tools.view(child).visible`, sorted). Diagnostics only (worker self-test);
 * undefined when the registry exposes no view.
 */
export function childVisibleToolNames(child: Agent): string[] | undefined {
  const scoped = (child as unknown as { ctx?: { get?: (name: string) => unknown; tools?: unknown } }).ctx;
  const tools = (scoped?.tools ?? scoped?.get?.("tools")) as
    | { view?: (scope?: unknown) => { visible?: ReadonlyMap<string, unknown> } | undefined }
    | undefined;
  if (typeof tools?.view !== "function") return undefined;
  try {
    const visible = tools.view(child)?.visible;
    return visible === undefined ? undefined : [...visible.keys()].sort();
  } catch {
    return undefined;
  }
}

/**
 * How a tool name resolves for the restricted child vs the global layer —
 * the same `tools.get(name, scope)` lookup rc.5's executor uses
 * (`resolveExecution`), so `child: false` means a call by that name fails
 * with UNKNOWN_TOOL. Diagnostics only (worker self-test); undefined when the
 * registry exposes no `get`.
 */
export function childToolResolution(
  child: Agent,
  names: readonly string[],
): Record<string, { global: boolean; child: boolean }> | undefined {
  const scoped = (child as unknown as { ctx?: { get?: (name: string) => unknown; tools?: unknown } }).ctx;
  const tools = (scoped?.tools ?? scoped?.get?.("tools")) as
    | { get?: (name: string, scope?: unknown) => unknown }
    | undefined;
  if (typeof tools?.get !== "function") return undefined;
  const out: Record<string, { global: boolean; child: boolean }> = {};
  for (const name of names) {
    const probe = (scope?: unknown): boolean => {
      try {
        return tools.get?.(name, scope) !== undefined;
      } catch {
        return false;
      }
    };
    out[name] = { global: probe(), child: probe(child) };
  }
  return out;
}

function knownRestrictableNames(
  tools: {
    get?: (name: string, scope?: unknown) => unknown;
    view?: (scope?: unknown) => { restrictableNames?: ReadonlySet<string> } | undefined;
  },
  child: Agent,
  allow: readonly string[],
): string[] {
  if (typeof tools.view === "function") {
    try {
      const names = tools.view(child)?.restrictableNames;
      if (names !== undefined && typeof names.has === "function") return allow.filter((name) => names.has(name));
    } catch {
      // fall through to the per-name lookup
    }
  }
  if (typeof tools.get === "function") {
    return allow.filter((name) => {
      try {
        return tools.get?.(name, child) !== undefined || tools.get?.(name) !== undefined;
      } catch {
        return false;
      }
    });
  }
  return [...allow];
}

/** Resolve the subagents service from a context (undefined-safe read). */
export function subagentsOf(ctx: Context): SubagentRuntime | undefined {
  return ctx.get("subagents") as SubagentRuntime | undefined;
}
