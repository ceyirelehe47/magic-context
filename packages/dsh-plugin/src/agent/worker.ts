/**
 * agent/worker — the minimal Magic worker (PLAN §5.13/D7) + recursion
 * isolation (PLAN §9 worker 递归隔离).
 *
 * A worker is a one-shot child agent with: depth pinned (maxDepth 0 — workers
 * can never spawn further), an explicit tool allowlist, delegated approval
 * pinned to 'never' (captureDelegatedPolicyOverrides), and no default shell /
 * network / credential inheritance beyond what the allowlist grants. It is
 * used for tool-requiring maintenance paths (none wired in production yet).
 *
 * RECURSION ISOLATION: the agent-plane Magic listeners (context plane,
 * knowledge gate, session tracking) must NOT process child sessions — a child
 * inherits the parent's preset composition, so without this gate every worker
 * turn would re-enter the full Magic pipeline. `isMagicChildSession` is the
 * single gate: header `origin === 'subagent'` or a persisted delegation
 * depth ≥ 1. This matches §5.10: Magic's per-session machinery applies to the
 * Magic-marked (top-level magic-standard) tree, while children run with
 * official semantics.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { textBlock } from "../compat/dsh-0.1/session";
import {
  appendDelegatedPolicyOverrides,
  captureDelegatedPolicyOverrides,
  MAGIC_WORKER_READONLY_TOOLS,
  magicWorkerActivation,
  restrictChildTools,
  subagentsOf,
} from "../compat/dsh-0.1/subagent";

/** Whether a session is a CHILD session (subagent origin or delegation depth). */
export function isMagicChildSession(agent: Agent): boolean {
  const header = agent.session?.header as
    | { origin?: string; delegationDepth?: number }
    | undefined;
  if (header?.origin === "subagent") return true;
  return typeof header?.delegationDepth === "number" && header.delegationDepth >= 1;
}

/** One worker run result. */
export interface MagicWorkerResult {
  readonly text: string;
  readonly durationMs: number;
  readonly toolCallCount: number;
}

export interface MagicWorkerDeps {
  /** The parent agent (owner of the worker). */
  readonly parent: Agent;
  /** Worker label (persistent provenance). */
  readonly label: string;
  /** The worker's task prompt (user turn). */
  readonly prompt: string;
  /** Tool allowlist (default: the read-only maintenance surface). */
  readonly allow?: readonly string[];
  /** Optional system prompt for the worker. */
  readonly systemPrompt?: string;
  readonly signal: AbortSignal;
  /** Hard timeout (default 120s). */
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

/**
 * Run one Magic worker. Returns null on failure/cancel/timeout (never throws
 * to the caller's pre-step chain). Delegated policy overrides (approval
 * 'never' + the parent's sandbox mode) are applied BEFORE the first await of
 * the run.
 */
export async function runMagicWorker(
  ctx: Context,
  deps: MagicWorkerDeps,
): Promise<MagicWorkerResult | null> {
  const log = deps.log ?? (() => {});
  try {
    const subagents = subagentsOf(ctx);
    if (subagents === undefined) {
      log("[magic-context] worker skipped: subagents service unavailable");
      return null;
    }
    const started = Date.now();
    const allow = deps.allow ?? MAGIC_WORKER_READONLY_TOOLS;
    const spec = magicWorkerActivation(deps.parent, {
      label: deps.label,
      prompt: [textBlock(deps.prompt)],
      maxDepth: 0, // workers can never spawn further (recursion cap)
      signal: deps.signal,
      systemPrompt: deps.systemPrompt,
    });

    // Tool allowlist + approval pinning + sandbox inheritance are applied to
    // the CHILD as it is created (`agent/created` is awaited before the
    // activation resolves, so this runs before its first step). Fail closed:
    // a child whose tools could not be restricted is disposed unused.
    let restricted = false;
    const parentSessionId = String(deps.parent.session?.id ?? deps.parent.id);
    const off = (ctx as unknown as {
      on?: (name: string, fn: (payload: { agent: Agent }) => undefined) => () => void;
    }).on?.("agent/created", ({ agent: child }) => {
      const header = child.session?.header as
        | { origin?: string; parentSession?: string }
        | undefined;
      if (header?.origin !== "subagent" || String(header.parentSession ?? "") !== parentSessionId) {
        return undefined;
      }
      restricted = restrictChildTools(child, allow);
      appendDelegatedPolicyOverrides(child.session as never, captureDelegatedPolicyOverrides(deps.parent));
      return undefined;
    });
    let run: Awaited<ReturnType<typeof subagents.startActivation>>;
    try {
      run = await subagents.startActivation(spec);
    } finally {
      off?.();
    }
    if (!restricted) {
      log("[magic-context] worker aborted: could not restrict child tools (fail-closed)");
      await run.dispose().catch(() => {});
      return null;
    }

    const timeout = deps.timeoutMs ?? 120_000;
    const result = await Promise.race([
      run.result,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => {
          void run.dispose().catch(() => {});
          resolve(null);
        }, timeout);
        deps.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            void run.dispose().catch(() => {});
            resolve(null);
          },
          { once: true },
        );
      }),
    ]);
    if (result === null) return null;
    const stopReason = (result as { stopReason?: string }).stopReason;
    if (stopReason === "error" || stopReason === "aborted" || stopReason === "refusal") {
      return null;
    }
    const text = result.output
      .map((block: { type: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : ""))
      .join("\n")
      .trim();
    if (text.length === 0) return null;
    return {
      text,
      durationMs: Date.now() - started,
      toolCallCount: result.structured !== undefined ? 1 : 0,
    };
  } catch (error) {
    log(`[magic-context] worker failed (returns null): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
