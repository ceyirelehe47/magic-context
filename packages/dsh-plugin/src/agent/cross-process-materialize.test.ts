/**
 * Round 18 (real rc.5 round 17 e2e): headless DSH runs every turn in a NEW
 * process. The historian's post-publish "materialize next pre-step" signal
 * lived only in process memory (historian.ts deferredSignalsBySession), so the
 * next process saw a cache-valid m0 and kept replaying the old EMPTY
 * <session-history> while the compartmentalized raw messages were dropped —
 * the history was lost. This test runs "process A" (first gate pass +
 * historian publish + in-memory signal) in a real child process, then plays
 * "process B" here against the same DB with fresh in-memory state.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSessionKey } from "dsh-magic-context-adapter";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { createUserMessage, type UserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createKnowledgeGateState, runKnowledgeGateStep, type KnowledgeAgentView } from "./knowledge-gate";

const HOME_HASH = "a1b2c3d4";
const DSH_SESSION = "sess-xproc";
const CODEWORD = "PELICAN-4217";

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

describe("cross-process historian publish → next process materializes compartments", () => {
  it("process B injects an m0 whose <session-history> carries the compartments process A published", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-xproc-"));
    const dbPath = join(dir, "context.db");
    const out = join(dir, "a.json");
    try {
      // ── process A (real child process) ──
      const a = Bun.spawnSync({
        cmd: [process.execPath, "run", join(import.meta.dir, "cross-process-materialize.fixture.ts"), dbPath, out],
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (a.exitCode !== 0) throw new Error(`process A failed: ${a.stderr.toString()}`);
      const resultA = JSON.parse(readFileSync(out, "utf8")) as {
        ok: boolean;
        published: number;
        injected: Array<{ source: { messageId: string } }>;
      };
      expect(resultA.ok).toBe(true);
      expect(resultA.published).toBe(1);
      expect(resultA.injected.length).toBeGreaterThan(0);
      const oldM0 = resultA.injected[0]!;
      expect(textOf(oldM0)).toContain("<session-history></session-history>");

      // ── process B: same DB, fresh module state, surface already carries A's m0 ──
      const db = await createTestDb(dbPath);
      const sid = canonicalSessionKey(HOME_HASH, DSH_SESSION);
      expect(getCompartments(db, sid).length).toBe(1);
      const events: Array<Record<string, unknown>> = [];
      const nodes: number[] = [];
      for (const m of resultA.injected) {
        events.push({ type: "user/message", seq: events.length, time: Date.now(), data: m, surfaceOp: "append" });
        nodes.push(events.length - 1);
      }
      const agent = {
        id: DSH_SESSION,
        options: { provider: "deepseek", model: "deepseek-chat" },
        session: { surface: { nodes, replaceGeneration: 0 }, events, header: { cwd: dir } },
        inject() {
          throw new Error("no agent.inject");
        },
      } as unknown as KnowledgeAgentView;
      const deps = {
        host: {
          ready: Promise.resolve({ kind: "ok" as const, db, storageDir: dir, livenessPath: "" }),
          canonicalKey: (id: string) => canonicalSessionKey(HOME_HASH, id),
        },
        config: { injectDocs: false, compactionOff: false },
        autoSearch: { enabled: false },
        log: () => {},
      };
      const user = createUserMessage({
        content: [{ type: "text", text: "what was the codeword?" }],
        source: { kind: "user" },
      }) as UserMessage;
      const payload = { agent, messages: [user] as unknown[] };
      await runKnowledgeGateStep(createKnowledgeGateState(), deps as never, payload as never, async () => ({
        kind: "enter",
        messages: [],
      }) as never);

      const magic = payload.messages.filter(
        (m) => (m as { source?: { kind?: string } }).source?.kind === "magic-context",
      );
      expect(magic.length).toBeGreaterThan(0); // a NEW baseline was delivered this turn
      const m0 = textOf(magic[0]);
      expect(m0).toContain("<session-history>");
      expect(m0).not.toContain("<session-history></session-history>");
      expect(m0).toContain("Codeword handoff");
      expect(m0).toContain(CODEWORD); // the dropped raw message is readable from session-history
      expect((magic[0] as { source: { messageId: string } }).source.messageId).not.toBe(oldM0.source.messageId);

      // Self-consuming: the following process replays the new baseline (no re-fold).
      const again = { agent, messages: [user] as unknown[] };
      for (const m of magic) {
        events.push({ type: "user/message", seq: events.length, time: Date.now(), data: m, surfaceOp: "append" });
        nodes.push(events.length - 1);
      }
      await runKnowledgeGateStep(createKnowledgeGateState(), deps as never, again as never, async () => ({
        kind: "enter",
        messages: [],
      }) as never);
      expect(
        again.messages.filter((m) => (m as { source?: { kind?: string } }).source?.kind === "magic-context").length,
      ).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
