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
    | { restrict?: (filter: ToolRestriction) => () => void }
    | undefined;
  if (typeof tools?.restrict !== "function") return false;
  tools.restrict({ allow: [...allow] });
  return true;
}

/** Resolve the subagents service from a context (undefined-safe read). */
export function subagentsOf(ctx: Context): SubagentRuntime | undefined {
  return ctx.get("subagents") as SubagentRuntime | undefined;
}
