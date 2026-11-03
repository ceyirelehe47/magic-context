import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { createAssistantMessage, createUserMessage, magicSource, replaceSurfaceRange } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { initializeDshAdapterTables } from "./outbox";
import { readDshTranscript } from "./transcript";
import { registerMagicHistorianPlane, transcriptRawMessageProvider } from "./historian-wiring";

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
        source: { kind: "model" } as never,
      }),
    } as never,
    { surfaceOp: "append" },
  );
}

function agent(session: Session): Agent {
  return { id: DSH_ID, session, options: { provider: "p", model: "m" } } as unknown as Agent;
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

  // Round 20 (real rc.5 e2e 41593887664, pold-03/04): compaction-basic's
  // buildSummarizationInput PREPENDS the conversation's system prompt (the
  // system/message at surface node 0) to the region messages, and the region
  // can end on a surface message the transcript view does not carry by id
  // (a Magic op copy `mc-op:…`, a folded tool result). The hook resolved
  // messages[0] / messages[last] literally → "summarize range unresolvable"
  // → every native compaction of a main session (the 90 % backstop and
  // /compact) closed compaction/end with an error.
  it("skips the leading system prompt and unresolvable boundary ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-wiring-sys-"));
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
      const ids = view(session);
      appendCompartments(db, KEY, [compartment(0, 1, 6, ids)]);
      const messages = [
        { id: "system-prompt-node-0", role: "system" },
        ...ids.map((m) => ({ id: m.id })),
        { id: "mc-op:not-in-view", role: "user" },
      ];
      const result = await hook!({ messages }, agent);
      expect(result.summary[0]!.text).toContain("Narrative summary of 1-6.");
      // Nothing resolvable at all still fails closed.
      await expect(hook!({ messages: [{ id: "system-prompt-node-0", role: "system" }, { id: "ghost" }] }, agent)).rejects.toThrow(
        /summarize range unresolvable/,
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Round 20: the region's LAST message is often a Magic op copy (the tagged
  // re-render of the newest user prompt, `mc-op:<opId>` replace). The view
  // expands the copy back into its source event, so the copy's own surface
  // message id is unknown to the view; it must resolve to the ordinal of the
  // view message that copy covers, or the mini-historian stops short of the
  // region compaction-basic is about to drop.
  it("resolves a Magic op copy's surface id to the view message it covers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-wiring-copy-"));
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
      // Re-render the newest user prompt (surface node 4) as an op copy.
      const promptSeq = session.surface.nodes[4]!;
      const copySeq = replaceSurfaceRange(
        session,
        promptSeq,
        promptSeq,
        createUserMessage({ content: [{ type: "text", text: "§5§ question 3" }], source: magicSource({ messageId: "mc-op:copy-1" }) }) as never,
        [promptSeq],
      );
      const copy = session.snapshotEvents().find((e) => e.seq === copySeq)! as unknown as { data: { id: string } };
      const ids = view(session);
      expect(ids.length).toBe(6);
      appendCompartments(db, KEY, [compartment(0, 1, 5, ids)]);
      // Region = messages 1..4 + the copy (view ordinal 5); fully covered.
      const messages = [
        { id: "system-prompt-node-0", role: "system" },
        ...ids.slice(0, 4).map((m) => ({ id: m.id })),
        { id: copy.data.id, role: "user" },
      ];
      const result = await hook!({ messages }, agent(session));
      expect(result.summary[0]!.text).toContain("Narrative summary of 1-5.");
      // The copy's own surface id resolves to the covered view message.
      const provider = transcriptRawMessageProvider(agent(session), KEY);
      expect(provider.readMessageOrdinalById!(copy.data.id)).toBe(5);
      expect(provider.readMessageOrdinalById!(ids[4]!.id)).toBe(5);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
