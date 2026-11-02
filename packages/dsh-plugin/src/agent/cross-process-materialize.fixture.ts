/**
 * "Process A" of cross-process-materialize.test.ts (run with `bun run` in a
 * child process): one DSH headless turn = first knowledge-gate pass (empty
 * <session-history>), then a background historian pass that publishes
 * compartments and fires the in-memory deferred signal exactly like
 * agent/index.ts does — then the process exits and that signal is gone.
 *
 * argv: <dbPath> <outJson>
 */
import { writeFileSync } from "node:fs";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { canonicalSessionKey } from "dsh-magic-context-adapter";
import type { ProtectedTailBoundarySnapshot } from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import { createAssistantMessage, createUserMessage, type UserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { runDshHistorian, signalDshDeferredMaterialization } from "./historian";
import { createKnowledgeGateState, runKnowledgeGateStep, type KnowledgeAgentView } from "./knowledge-gate";
import { initializeDshAdapterTables } from "./outbox";
import { readDshTranscript } from "./transcript";

const XPROC_HOME_HASH = "a1b2c3d4";
const XPROC_DSH_SESSION = "sess-xproc";
const XPROC_CODEWORD = "PELICAN-4217";

const [dbPath, outJson] = process.argv.slice(2) as [string, string];
const sid = canonicalSessionKey(XPROC_HOME_HASH, XPROC_DSH_SESSION);
const db = await createTestDb(dbPath);
initializeDshAdapterTables(db);

// ── 1. first pre-step of the session: knowledge gate materializes m0 ──
const events: Array<Record<string, unknown>> = [];
const nodes: number[] = [];
const agent = {
  id: XPROC_DSH_SESSION,
  options: { provider: "deepseek", model: "deepseek-chat" },
  session: {
    surface: { nodes, replaceGeneration: 0 },
    events,
    header: { cwd: process.cwd() },
  },
  inject() {
    throw new Error("knowledge gate must not use agent.inject");
  },
} as unknown as KnowledgeAgentView;
const firstUser = createUserMessage({
  content: [{ type: "text", text: "first question" }],
  source: { kind: "user" },
}) as UserMessage;
const payload = { agent, messages: [firstUser] as unknown[] };
await runKnowledgeGateStep(
  createKnowledgeGateState(),
  {
    host: {
      ready: Promise.resolve({ kind: "ok" as const, db, storageDir: "", livenessPath: "" }),
      canonicalKey: (id: string) => canonicalSessionKey(XPROC_HOME_HASH, id),
    },
    config: { injectDocs: false, compactionOff: false },
    autoSearch: { enabled: false },
    log: () => {},
  } as never,
  payload as never,
  async () => ({ kind: "enter", messages: [] }) as never,
);
const injected = (payload.messages as Array<{ source?: { kind?: string } }>).filter(
  (m) => m.source?.kind === "magic-context",
);

// ── 2. the turn grows; the background historian publishes compartments ──
const session = Session.create(SessionId(XPROC_DSH_SESSION));
for (let turn = 1; turn <= 5; turn += 1) {
  session.append(
    "user/message",
    createUserMessage({
      content: [{ type: "text", text: turn === 2 ? `remember the codeword ${XPROC_CODEWORD}` : `question ${turn}` }],
      source: { kind: "user" },
    }),
    { surfaceOp: "append" },
  );
  session.append(
    "assistant/message",
    {
      turn,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [{ type: "text", text: `answer ${turn}` }],
        provider: "deepseek",
        model: "deepseek-chat",
        source: { kind: "model" },
      } as never),
    },
    { surfaceOp: "append" },
  );
}
const view = readDshTranscript({
  session: { events: session.snapshotEvents(), surface: session.surface, header: {} },
  canonicalSessionId: sid,
});
const messages = view.messages as unknown as Array<{ ordinal: number; id: string }>;
const count = messages.length;
const idAt = (o: number) => messages.find((m) => m.ordinal === o)?.id ?? null;
const boundary = {
  sessionId: sid,
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
  cacheNamespace: `test:${sid}`,
  createdAt: Date.now(),
  rawRangeFingerprint: "",
  trueRawEligibleTokens: 0,
  oversizeAtomicUnit: false,
  boundaryReason: "test",
} as unknown as ProtectedTailBoundarySnapshot;
const xml = `<output>
<compartments>
<compartment start="1" end="4" title="Codeword handoff" episode_type="design" importance="80">
<p1>The user asked the assistant to remember the codeword ${XPROC_CODEWORD}.</p1>
<p2>Codeword ${XPROC_CODEWORD} was given.</p2>
<p3>Codeword recorded.</p3>
<p4>Codeword.</p4>
</compartment>
</compartments>
<facts></facts>
<meta>
<messages_processed>1-4</messages_processed>
<unprocessed_from>5</unprocessed_from>
</meta>
</output>`;
let published = 0;
const ok = await runDshHistorian({
  db,
  sessionId: sid,
  provider: { readMessages: () => view.messages },
  summarize: async () => xml,
  boundarySnapshot: boundary,
  leaseHolderId: "xproc-a",
  onPublished: () => {
    published += 1;
    signalDshDeferredMaterialization(sid); // agent/index.ts onPublished — memory only
  },
} as never);

writeFileSync(outJson, JSON.stringify({ ok, published, injected }));
db.close();
process.exit(0);
