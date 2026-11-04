/**
 * Round 28 (task 2, adapter scan: swallowed exceptions). The context plane is
 * fail-open by design — nothing may break DSH's pre-step chain — but two of its
 * catches were also SILENT:
 *   - `maybeFireHistorian` wraps the whole pressure trigger in `catch {}`: a
 *     throwing `fire` / pressure read / DB write meant the historian simply never
 *     ran again, with no log line and nothing in /ctx-status (Magic's main
 *     compaction path disabled without a trace);
 *   - the `session_meta` persistence of percentage / input tokens / response
 *     time (what /ctx-status and ctx_reduce read) failed the same way.
 * They stay fail-open; they now log once per distinct message per process.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";

function buildSession(id: string): Session {
  const session = Session.create(SessionId(id));
  session.append("user/message", createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } }), { surfaceOp: "append" });
  session.append(
    "assistant/message",
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: "text", text: "hi" }], provider: "deepseek", model: "deepseek-chat", source: { kind: "model" } as never } as never),
    } as never,
    { surfaceOp: "append" },
  );
  return session;
}

async function step(deps: ContextPlaneDeps, session: Session): Promise<void> {
  await runContextPlaneStep(createContextPlaneState(), deps, { agent: { id: session.id, session } as never } as never, async () => ({ reject: false, messages: [] }) as never);
}

describe("context plane: fail-open catches are no longer silent (round 28)", () => {
  it("a throwing historian fire is logged (once per message), and the step still completes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-plane-silent-"));
    const db = await createTestDb(join(dir, "context.db"));
    try {
      const logs: string[] = [];
      const session = buildSession("sess-silent-fire");
      const deps: ContextPlaneDeps = {
        host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}` },
        config: { enabled: false },
        directory: dir,
        historian: {
          config: { enabled: true, executeThresholdPercentage: 65, triggerBudgetTokens: 1000 },
          readPressure: () => ({ projectedTokens: 90_000, contextWindow: 128_000 }),
          fire: () => {
            throw new Error("boom-fire-28");
          },
        },
        log: (m) => logs.push(m),
      };
      await step(deps, session);
      await step(deps, session);
      const hits = logs.filter((l) => l.includes("historian trigger failed") && l.includes("boom-fire-28"));
      expect(hits).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failing session_meta persistence is logged, and the trigger still runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-plane-silent-"));
    const db = await createTestDb(join(dir, "context.db"));
    try {
      const logs: string[] = [];
      let fired = 0;
      const session = buildSession("sess-silent-meta");
      // Make every session_meta UPDATE fail (a trigger that aborts), reads still work.
      db.exec("CREATE TRIGGER r28_fail_meta BEFORE UPDATE ON session_meta BEGIN SELECT RAISE(ABORT, 'meta-write-blocked-28'); END;");
      const deps: ContextPlaneDeps = {
        host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}` },
        config: { enabled: false },
        directory: dir,
        historian: {
          config: { enabled: true, executeThresholdPercentage: 65, triggerBudgetTokens: 1000 },
          readPressure: () => ({ projectedTokens: 90_000, contextWindow: 128_000 }),
          fire: () => {
            fired += 1;
          },
        },
        log: (m) => logs.push(m),
      };
      await step(deps, session);
      expect(logs.some((l) => l.includes("session_meta") && l.includes("meta-write-blocked-28"))).toBe(true);
      expect(fired).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
