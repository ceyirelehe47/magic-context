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

export const WORKER_SELFTEST_ENV = "MAGIC_CONTEXT_DSH_WORKER_SELFTEST";
export const WORKER_SELFTEST_TOOL = "ctx_worker_selftest";

export function workerSelftestEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[WORKER_SELFTEST_ENV] === "1";
}

const WORKER_PROMPT = [
  "You are a Magic Context maintenance worker self-test.",
  "1. List the exact names of every tool you can call, one per line, prefixed with 'TOOL: '.",
  "2. Call the glob tool with pattern '*' and report how many entries it returned as 'GLOB_COUNT: <n>'.",
  "3. If (and only if) a tool named bash is in your list, call it with 'echo hi'; otherwise write 'BASH_UNAVAILABLE'.",
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
      const logs: string[] = [];
      const controller = new AbortController();
      const result = await runMagicWorker(ctx, {
        parent: agent,
        label: "magic-worker-selftest",
        prompt: WORKER_PROMPT,
        signal: controller.signal,
        timeoutMs: 180_000,
        onChildRestricted: (info) => {
          visible = info.visible;
        },
        log: (message) => {
          logs.push(message);
          log?.(message);
        },
      });
      const report = {
        ok: result !== null,
        childVisibleTools: visible ?? null,
        workerText: result?.text ?? null,
        durationMs: result?.durationMs ?? null,
        workerLog: logs,
      };
      log?.(`[magic-context] worker self-test: ${JSON.stringify({ ok: report.ok, childVisibleTools: report.childVisibleTools })}`);
      return { text: `WORKER_SELFTEST ${JSON.stringify(report)}` };
    },
  });
}
