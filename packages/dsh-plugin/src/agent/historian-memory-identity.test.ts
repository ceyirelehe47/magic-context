/**
 * Round 25 (e2e 41682984222 U21, class=product): a corrected fact came back.
 *
 * Session A pinned four facts with ctx_memory (rows 13–16, project identity
 * `git:…`/`dir:…`). Two historian passes later rows 17–20 appeared — no
 * ctx_memory call in h-a2/h-a3 — three paraphrases and one BYTE-IDENTICAL copy
 * of the todo (20 == 16). The memories table is UNIQUE(project_path, category,
 * normalized_hash), so 20 can only exist under a DIFFERENT project_path: the DSH
 * historian promoted facts under the raw `directory` instead of the resolved
 * project identity (core `compartment-runner-incremental` uses
 * `resolveProjectIdentity(directory)`), so core's exact-hash dedup — which also
 * matches ARCHIVED rows, so a cancelled fact is never re-activated — never saw
 * the agent's row. The paraphrases come from the second gap: the DSH historian
 * prompt had an empty `<project-memory>` block (core passes the project's
 * active memories for the historian's "skip facts that overlap" dedup); before
 * a529b7846 the injected m0 `<project-memory>` reached the historian by accident.
 *
 * The correction in session B archived 16 only; 20 stayed active → U21.
 */
import { describe, expect, it } from "bun:test";
import type { Database as BunDatabase } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { insertMemory, updateMemoryStatus } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ProtectedTailBoundarySnapshot } from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createAssistantMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { initializeDshAdapterTables } from "./outbox";
import { readDshTranscript } from "./transcript";
import { runDshHistorian, type DshSummarizeCall } from "./historian";
import { createLlmSummarizeCall } from "./historian-wiring";

const SESSION_ID = "dsh:a1b2c3d4:sess-mem-identity";
const DSH_SESSION_ID = "sess-mem-identity";
const OLD_TODO = "Open todo: add a pruning job for stale historian leases (codeword TODO-BISON-9074).";
const LIVE_FACT = "Every write to the ledger goes through the outbox saga (codeword ARCH-KESTREL-4127).";

function buildSession(): Session {
  const session = Session.create(SessionId(DSH_SESSION_ID));
  for (let turn = 1; turn <= 5; turn += 1) {
    session.append(
      "user/message",
      createUserMessage({ content: [{ type: "text", text: `question ${turn}` }], source: { kind: "user" } }),
      { surfaceOp: "append" },
    );
    session.append(
      "assistant/message",
      {
        turn,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: "text", text: `answer ${turn}` }],
          provider: "deepseek",
          model: "deepseek-chat",
          source: { kind: "model" } as never,
        } as never),
      } as never,
      { surfaceOp: "append" },
    );
  }
  return session;
}

function providerOf(session: Session): RawMessageProvider {
  const view = readDshTranscript({
    session: { events: session.snapshotEvents(), surface: session.surface, header: {} },
    canonicalSessionId: SESSION_ID,
  });
  return { readMessages: () => view.messages as never };
}

function makeBoundary(messages: readonly { ordinal: number; id: string }[]): ProtectedTailBoundarySnapshot {
  const count = messages.length;
  const idAt = (ordinal: number): string | null => messages.find((m) => m.ordinal === ordinal)?.id ?? null;
  return {
    sessionId: SESSION_ID,
    mode: "incremental-runner",
    offset: 1,
    offsetMessageId: idAt(1),
    protectedTailStart: count + 1,
    protectedTailStartMessageId: null,
    eligibleEndOrdinal: count + 1,
    eligibleEndMessageId: idAt(count),
    rawMessageCountAtTrigger: count,
    rawLastMessageIdAtTrigger: idAt(count),
    N: 0,
    usagePercentage: 0,
    usageInputTokens: 0,
    usageSource: "provisional-zero",
    contextLimit: 128_000,
    executeThresholdPercentage: 65,
    triggerBudget: 10_000,
    priorBoundaryOrdinal: count + 1,
    migrationFloorActive: false,
    providerShapeVersion: "opencode-v1",
    cacheNamespace: `test:${SESSION_ID}`,
    createdAt: Date.now(),
    rawRangeFingerprint: "",
    trueRawEligibleTokens: 0,
    oversizeAtomicUnit: false,
    boundaryReason: "test",
  };
}

function historianXml(facts: string): string {
  return `<output>
<compartments>
<compartment start="1" end="7" title="work" episode_type="design" importance="50">
<p1>Narrative summary of 1-7.</p1>
<p2>Condensed 1-7.</p2>
<p3>Outcome 1-7.</p3>
<p4>Anchor 1-7.</p4>
</compartment>
</compartments>
<facts>
${facts}
</facts>
<meta>
<messages_processed>1-7</messages_processed>
<unprocessed_from>8</unprocessed_from>
</meta>
</output>`;
}

async function withEnv(fn: (db: Database, projectDir: string, identity: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "dsh-magic-mem-identity-"));
  const projectDir = join(root, "project");
  mkdirSync(projectDir);
  const db = await createTestDb(join(root, "context.db"));
  try {
    initializeDshAdapterTables(db);
    const identity = resolveProjectIdentityForSession(projectDir);
    expect(identity).toBeTruthy();
    expect(identity).not.toBe(projectDir);
    await fn(db, projectDir, identity as string);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function agentMemory(db: Database, identity: string, category: string, content: string): number {
  return insertMemory(db, {
    projectPath: identity,
    category: category as never,
    content,
    sourceSessionId: "dsh:a1b2c3d4:sess-other",
    sourceType: "agent",
  }).id;
}

describe("DSH historian memory promotion uses the project identity (U21)", () => {
  it("a re-extracted copy of an ARCHIVED (corrected) fact is not re-activated, and promoted rows carry the identity", async () => {
    await withEnv(async (db, projectDir, identity) => {
      const oldId = agentMemory(db, identity, "PROJECT_RULES", OLD_TODO);
      updateMemoryStatus(db, oldId, "archived");
      const session = buildSession();
      const provider = providerOf(session);
      const ok = await runDshHistorian({
        db,
        sessionId: SESSION_ID,
        directory: projectDir,
        provider,
        summarize: async () =>
          historianXml(`<PROJECT_RULES>\n* ${OLD_TODO}\n</PROJECT_RULES>\n<ARCHITECTURE>\n* ${LIVE_FACT}\n</ARCHITECTURE>`),
        boundarySnapshot: makeBoundary(provider.readMessages() as never),
        leaseHolderId: "lease-test",
      });
      expect(ok).toBe(true);
      const raw = db as unknown as BunDatabase;
      const todoRows = raw
        .query("SELECT id, status, project_path AS p FROM memories WHERE content = ? ORDER BY id")
        .all(OLD_TODO) as { id: number; status: string; p: string }[];
      // exactly the agent's row, still archived (seen-count bump only)
      expect(todoRows).toEqual([{ id: oldId, status: "archived", p: identity }]);
      const promoted = raw
        .query("SELECT project_path AS p FROM memories WHERE source_session_id = ?")
        .all(SESSION_ID) as { p: string }[];
      expect(promoted.length).toBe(1);
      expect(promoted.every((row) => row.p === identity)).toBe(true);
    });
  });

  it("the historian is given the project's ACTIVE memories as <project-memory> (dedup context), not archived ones", async () => {
    await withEnv(async (db, projectDir, identity) => {
      agentMemory(db, identity, "ARCHITECTURE", LIVE_FACT);
      const oldId = agentMemory(db, identity, "PROJECT_RULES", OLD_TODO);
      updateMemoryStatus(db, oldId, "archived");
      const session = buildSession();
      const provider = providerOf(session);
      const seen: unknown[] = [];
      const summarize: DshSummarizeCall = async (...args: unknown[]) => {
        seen.push(args[4]);
        return historianXml("");
      };
      const ok = await runDshHistorian({
        db,
        sessionId: SESSION_ID,
        directory: projectDir,
        provider,
        summarize,
        boundarySnapshot: makeBoundary(provider.readMessages() as never),
        leaseHolderId: "lease-test",
      });
      expect(ok).toBe(true);
      expect(seen.length).toBe(1);
      const memoryContext = seen[0] as { projectMemory?: string } | undefined;
      expect(memoryContext?.projectMemory).toContain("ARCH-KESTREL-4127");
      expect(memoryContext?.projectMemory).toContain("<project-memory>");
      expect(memoryContext?.projectMemory).not.toContain("TODO-BISON-9074");
    });
  });

  it("the production summarize call puts that block into the compartment prompt", async () => {
    const sent: string[] = [];
    const ctx = {
      get: (name: string) =>
        name === "llm"
          ? {
              stream: (request: { messages: { content: { type: string; text?: string }[] }[] }) => {
                sent.push(request.messages.map((m) => m.content.map((c) => c.text ?? "").join("")).join("\n"));
                return (async function* () {
                  yield { type: "text-delta", text: "<output></output>" };
                  yield { type: "finish", reason: { kind: "stop" } };
                })();
              },
            }
          : undefined,
    } as unknown as Context;
    const call = createLlmSummarizeCall(ctx, "p/m") as (...args: unknown[]) => Promise<string>;
    const block = "<project-memory>\n<ARCHITECTURE>\n- pinned fact PIN-OWL-1\n</ARCHITECTURE>\n</project-memory>";
    await call({ text: "[1] U: hello", startIndex: 1, endIndex: 1, messageCount: 1 }, [], undefined, undefined, { projectMemory: block });
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("PIN-OWL-1");
    // without a context the prompt has no memory block (unchanged behaviour)
    await call({ text: "[1] U: hello", startIndex: 1, endIndex: 1, messageCount: 1 }, [], undefined, undefined, undefined);
    expect(sent[1]).not.toContain("PIN-OWL-1");
  });
});
