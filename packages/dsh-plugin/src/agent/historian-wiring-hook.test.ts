import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { createAssistantMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { initializeDshAdapterTables } from "./outbox";
import { readDshTranscript } from "./transcript";
import { registerMagicHistorianPlane } from "./historian-wiring";

// Round 14 scan: registerMagicHistorianPlane cached ONE summarize hook per
// session for the process lifetime, and that hook carried a transcript
// SNAPSHOT (transcriptRawMessageProvider reads the log once) taken at the
// first compaction. A second compaction of the same session in the same
// process (long-running web/tui session, /compact twice) asked for message ids
// the snapshot never saw → "summarize range unresolvable" → the DSH
// compaction failed.
const DSH_ID = "sess-wiring";
const KEY = `dsh:abc:${DSH_ID}`;

function appendTurn(session: Session, turn: number): void {
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
        source: { kind: "model" },
      }),
    },
    { surfaceOp: "append" },
  );
}

function view(session: Session) {
  return readDshTranscript({
    session: { events: session.snapshotEvents(), surface: session.surface, header: {} },
    canonicalSessionId: KEY,
  }).messages;
}

function compartment(seq: number, start: number, end: number, ids: readonly { id: string }[]) {
  return {
    sequence: seq,
    startMessage: start,
    endMessage: end,
    startMessageId: ids[start - 1]!.id,
    endMessageId: ids[end - 1]!.id,
    title: `c${seq}`,
    content: `Narrative summary of ${start}-${end}.`,
    p1: `Narrative summary of ${start}-${end}.`,
    p2: "p2",
    p3: "p3",
    p4: "p4",
    importance: 50,
    episodeType: "design",
  };
}

describe("registerMagicHistorianPlane summarize hook", () => {
  it("reads the CURRENT transcript on every compaction of the same session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-wiring-"));
    const db = await createTestDb(join(dir, "context.db"));
    try {
      initializeDshAdapterTables(db);
      let hook: ((input: unknown, agent: unknown, signal?: AbortSignal) => Promise<{ summary: { text: string }[] }>) | undefined;
      const ctx = { get: (name: string) => (name === "llm" ? { stream: () => { throw new Error("no LLM expected"); } } : undefined) } as unknown as Context;
      registerMagicHistorianPlane(ctx, {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: join(dir, "l") }),
          canonicalKey: (id: string) => `dsh:abc:${id}`,
          registerSummarizeHook: (fn: typeof hook) => {
            hook = fn;
          },
        } as never,
      });
      const session = Session.create(SessionId(DSH_ID));
      for (let t = 1; t <= 3; t += 1) appendTurn(session, t);
      const agent = { id: DSH_ID, session, options: { provider: "p", model: "m" } } as unknown as Agent;

      // First compaction: messages 1..6, fully covered → no LLM call.
      let ids = view(session);
      appendCompartments(db, KEY, [compartment(0, 1, 6, ids)]);
      const first = await hook!({ messages: ids.map((m) => ({ id: m.id })) }, agent);
      expect(first.summary[0]!.text).toContain("Narrative summary of 1-6.");

      // The session grows in the same process; a second compaction covers 1..10.
      for (let t = 4; t <= 5; t += 1) appendTurn(session, t);
      ids = view(session);
      appendCompartments(db, KEY, [compartment(1, 7, 10, ids)]);
      const second = await hook!({ messages: ids.map((m) => ({ id: m.id })) }, agent);
      expect(second.summary[0]!.text).toContain("Narrative summary of 7-10.");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
