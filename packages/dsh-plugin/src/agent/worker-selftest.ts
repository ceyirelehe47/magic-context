/**
 * agent/worker-selftest — an env-gated diagnostic tool that runs ONE Magic
 * worker (`runMagicWorker`) from inside a real DSH turn, so the worker path
 * (subagent activation, tool allowlist, approval pin) can be verified on a
 * real install. Nothing in production calls `runMagicWorker` yet; this tool
 * is the only real-host trigger.
 *
 * Registered ONLY when `MAGIC_CONTEXT_DSH_WORKER_SELFTEST=1` is set in the
 * DSH process environment. Never part of a normal install.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { textBlock } from "../compat/dsh-0.1/session";
import { runMagicWorker } from "./worker";
import { e2eWorkerPromptSuffix } from "./e2e-hooks";

export const WORKER_SELFTEST_ENV = "MAGIC_CONTEXT_DSH_WORKER_SELFTEST";
export const WORKER_SELFTEST_TOOL = "ctx_worker_selftest";

export function workerSelftestEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[WORKER_SELFTEST_ENV] === "1";
}

/** Optional override of the worker's hard timeout (ms), for the cancel/timeout probe. */
export const WORKER_SELFTEST_TIMEOUT_ENV = "MAGIC_CONTEXT_DSH_WORKER_SELFTEST_TIMEOUT_MS";

export function workerSelftestTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[WORKER_SELFTEST_TIMEOUT_ENV]);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 180_000;
}

const WORKER_PROMPT = [
  "You are a Magic Context maintenance worker self-test.",
  "1. List the exact names of every tool you can call, one per line, prefixed with 'TOOL: '.",
  "2. Call the glob tool with pattern '*' and report how many entries it returned as 'GLOB_COUNT: <n>'.",
  "3. Try to call a tool named bash with command 'echo hi' and a tool named write (path 'mc-worker-probe.txt', content 'x'),",
  "   even if they are not in your list. For each, report 'BASH: <what happened>' and 'WRITE: <what happened>'",
  "   (for example 'unavailable', the error text, or the output).",
  "Answer in plain text, nothing else.",
].join("\n");

export function createWorkerSelftestTool(ctx: Context, log?: (message: string) => void): ToolDefinition {
  return defineTool({
    name: WORKER_SELFTEST_TOOL,
    description:
      "Diagnostics only: run one read-only Magic Context worker sub-agent and report which tools it received and what it answered.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        properties: { text: { type: "string", required: true } },
        additionalProperties: false,
      } as const,
      render: (_args: unknown, value: { text: string }): ContentBlock[] => [textBlock(value.text)],
    },
    async execute(_args, exec) {
      const agent = exec.agent;
      if (!agent) throw new Error("ctx_worker_selftest requires an agent execution context.");
      let visible: readonly string[] | undefined;
      let childSessionId: string | undefined;
      let resolution: Record<string, { global: boolean; child: boolean }> | undefined;
      const logs: string[] = [];
      const controller = new AbortController();
      const timeoutMs = workerSelftestTimeoutMs();
      const result = await runMagicWorker(ctx, {
        parent: agent,
        label: "magic-worker-selftest",
        // Round 25 (P1-3): e2e-only mock-plan marker (inert without MAGIC_CONTEXT_DSH_E2E=1).
        prompt: ((suffix) => (suffix === undefined ? WORKER_PROMPT : `${WORKER_PROMPT}\n${suffix}`))(e2eWorkerPromptSuffix()),
        signal: controller.signal,
        timeoutMs,
        probeTools: ["bash", "write", "edit", "read", "glob", "grep", "ctx_search", "ctx_reduce", "spawn_agent"],
        onChildRestricted: (info) => {
          visible = info.visible;
          childSessionId = info.childSessionId;
          resolution = info.resolution;
        },
        log: (message) => {
          logs.push(message);
          log?.(message);
        },
      });
      const report = {
        ok: result !== null,
        childVisibleTools: visible ?? null,
        childSessionId: childSessionId ?? null,
        // tools.get(name, child) — the executor's lookup; child:false => UNKNOWN_TOOL.
        toolResolution: resolution ?? null,
        parentSessionId: String(agent.session?.id ?? agent.id),
        timeoutMs,
        workerText: result?.text ?? null,
        durationMs: result?.durationMs ?? null,
        workerLog: logs,
      };
      log?.(`[magic-context] worker self-test: ${JSON.stringify({ ok: report.ok, childVisibleTools: report.childVisibleTools })}`);
      return { text: `WORKER_SELFTEST ${JSON.stringify(report)}` };
    },
  });
}
