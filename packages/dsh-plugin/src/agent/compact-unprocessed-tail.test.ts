/**
 * Round 26 (P1-2, known limitation 17) — `/compact` when the mini-historian
 * leaves the end of the region unprocessed (`<unprocessed_from>`).
 *
 * Real case (e2e 41619627652 `/compact` #1): region through ordinal 20,
 * compartments end 17 — the summary rendered compartments 1..17 only, so DSH's
 * native checkpoint shadowed 18..20 WITHOUT any text standing for them. The
 * raw messages stay in the log (ctx_expand, next background pass), but until
 * that pass runs the model's context holds nothing of them. When the tail is a
 * user constraint, the next turn can ignore it.
 *
 * This test drives the PRODUCTION summarize hook over a real DSH Session whose
 * region ends with a user constraint carrying a unique codeword; the historian
 * (mock) covers only the first part and answers `<unprocessed_from>` for the
 * rest. The checkpoint summary is what the model sees after compaction, so it
 * must carry the uncovered tail (the constraint verbatim) — and only while it
 * is uncovered: a covered range renders as before.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createAssistantMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createMagicSummarizeHook } from "./historian";
import { historyContentProvider } from "./historian-wiring";
import { initializeDshAdapterTables } from "./outbox";

const DSH_ID = "sess-compact-tail";
const SID = `dsh:a1b2c3d4:${DSH_ID}`;
const CONSTRAINT = "From now on every reply must end with the line 'ack OTTER-LANTERN-6152' and never use bullet lists.";

function buildSession(turns: number, lastUser: string): Session {
  const session = Session.create(SessionId(DSH_ID));
  for (let turn = 1; turn <= turns; turn += 1) {
    const text = turn === turns ? lastUser : `question ${turn}: explain step ${turn} of the build`;
    session.append("user/message", createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }) as never, { surfaceOp: "append" });
    session.append(
      "assistant/message",
      {
        turn,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: "text", text: turn === turns ? "Understood." : `answer ${turn}: step ${turn} compiles the module` }],
          provider: "p",
          model: "m",
          source: { kind: "model" } as never,
        } as never),
      } as never,
      { surfaceOp: "append" },
    );
  }
  return session;
}

function agentOf(session: Session): Agent {
  return { id: DSH_ID, options: { provider: "p", model: "m" }, session } as unknown as Agent;
}

/** Historian mock: covers [start, start+cover-1], leaves the rest unprocessed. */
function partialHistorian(cover: number) {
  return async (chunk: { startIndex: number; endIndex: number }) => {
    const end = Math.min(chunk.endIndex, chunk.startIndex + cover - 1);
    return `<output>
<compartments>
<compartment start="${chunk.startIndex}" end="${end}" title="Build steps" episode_type="design" importance="50">
<p1>Walked through the build steps ${chunk.startIndex}-${end}.</p1>
<p2>Build steps.</p2>
<p3>Steps explained.</p3>
<p4>build</p4>
</compartment>
</compartments>
<facts>
</facts>
<meta>
<messages_processed>${chunk.startIndex}-${end}</messages_processed>
<unprocessed_from>${end + 1}</unprocessed_from>
</meta>
</output>`;
  };
}

async function withDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-compact-tail-"));
  const db = await createTestDb(join(dir, "context.db"));
  initializeDshAdapterTables(db);
  try {
    return await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function summaryText(result: { summary: unknown[] }): string {
  return (result.summary as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n");
}

describe("/compact with an unprocessed tail (round 26 P1-2, limitation 17)", () => {
  it("the checkpoint summary carries the uncovered tail (the user constraint verbatim) until the historian covers it", async () => {
    await withDb(async (db) => {
      const agent = agentOf(buildSession(8, CONSTRAINT));
      const provider = historyContentProvider(agent, SID);
      const messages = provider.readMessages();
      expect(messages).toHaveLength(16);
      const hook = createMagicSummarizeHook({ db, sessionId: SID, ctx: {}, provider, summarize: partialHistorian(12) as never, leaseHolderId: "r26-tail" });
      // Region = everything (as /compact with no protected tail on this route).
      const result = await hook({ messages: messages.map((m) => ({ id: m.id, role: m.role, content: [] })) as never }, agent);
      const compartments = getCompartments(db, SID);
      expect(compartments.at(-1)!.endMessage).toBe(12); // historian left 13..16
      const text = summaryText(result);
      expect(text).toContain("Walked through the build steps 1-12.");
      // Before round 26 the tail (13..16, the constraint at 15) had no text at all.
      expect(text).toContain("OTTER-LANTERN-6152");
      expect(text).toContain(CONSTRAINT);
      expect(text).toMatch(/ctx_expand[^\n]*13-16/);
      // Covered messages are not repeated verbatim.
      expect(text).not.toContain("question 2: explain step 2");
    });
  });

  it("the /compact mini-historian records one historian_runs row (unprocessed_from = first uncovered ordinal)", async () => {
    await withDb(async (db) => {
      const agent = agentOf(buildSession(8, CONSTRAINT));
      const provider = historyContentProvider(agent, SID);
      const messages = provider.readMessages();
      const hook = createMagicSummarizeHook({ db, sessionId: SID, ctx: {}, provider, summarize: partialHistorian(12) as never, leaseHolderId: "r26-tail-tel" });
      await hook({ messages: messages.map((m) => ({ id: m.id, role: m.role, content: [] })) as never }, agent);
      // Round 26 (e2e 41771964169 T2): the summarize path wrote no telemetry,
      // so the deferral was only visible through compartments.
      const runs = db
        .prepare("select status, chunk_start_ordinal, chunk_end_ordinal, unprocessed_from, compartments_produced from historian_runs where session_id = ?")
        .all(SID) as Array<Record<string, number | string>>;
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("success");
      expect(runs[0]!.unprocessed_from).toBe(13);
      expect(Number(runs[0]!.chunk_end_ordinal)).toBeGreaterThanOrEqual(13);
      expect(Number(runs[0]!.compartments_produced)).toBeGreaterThan(0);
    });
  });

  it("a fully covered region renders compartments only (no tail block)", async () => {
    await withDb(async (db) => {
      const agent = agentOf(buildSession(8, CONSTRAINT));
      const provider = historyContentProvider(agent, SID);
      const messages = provider.readMessages();
      const hook = createMagicSummarizeHook({ db, sessionId: SID, ctx: {}, provider, summarize: partialHistorian(100) as never, leaseHolderId: "r26-full" });
      const text = summaryText(await hook({ messages: messages.map((m) => ({ id: m.id, role: m.role, content: [] })) as never }, agent));
      expect(getCompartments(db, SID).at(-1)!.endMessage).toBe(16);
      expect(text).not.toContain("unsummarized");
      expect(text).not.toContain(CONSTRAINT);
    });
  });

  it("a long tail is bounded: user text kept first, the block stays under its cap", async () => {
    await withDb(async (db) => {
      const huge = `${"filler answer text ".repeat(800)}`;
      const session = Session.create(SessionId(DSH_ID));
      const user = (text: string) => session.append("user/message", createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }) as never, { surfaceOp: "append" });
      const assistant = (text: string, turn: number) =>
        session.append("assistant/message", { turn, step: 1, message: createAssistantMessage({ content: [{ type: "text", text }], provider: "p", model: "m", source: { kind: "model" } as never } as never) } as never, { surfaceOp: "append" });
      for (let t = 1; t <= 6; t += 1) {
        user(t === 5 ? CONSTRAINT : `question ${t}`);
        assistant(t >= 4 ? huge : `answer ${t}`, t);
      }
      const agent = agentOf(session);
      const provider = historyContentProvider(agent, SID);
      const messages = provider.readMessages();
      const hook = createMagicSummarizeHook({ db, sessionId: SID, ctx: {}, provider, summarize: partialHistorian(6) as never, leaseHolderId: "r26-cap" });
      const text = summaryText(await hook({ messages: messages.map((m) => ({ id: m.id, role: m.role, content: [] })) as never }, agent));
      expect(text).toContain(CONSTRAINT);
      const block = /<unsummarized_tail[\s\S]*<\/unsummarized_tail>/.exec(text)?.[0] ?? "";
      expect(block.length).toBeGreaterThan(0);
      expect(block.length).toBeLessThan(9_000);
    });
  });
});

describe("unsummarized tail vs compaction-basic's 'summary must be smaller' rule", () => {
  it("a region whose own text is too small for summary + tail gets no tail block (compaction stays valid)", async () => {
    await withDb(async (db) => {
      const agent = agentOf(buildSession(8, CONSTRAINT));
      const provider = historyContentProvider(agent, SID);
      const messages = provider.readMessages();
      const hook = createMagicSummarizeHook({ db, sessionId: SID, ctx: {}, provider, summarize: partialHistorian(12) as never, leaseHolderId: "r26-small" });
      // Region parts carry their text (as compaction-basic passes them): 320 chars, below compartments + tail.
      const region = messages.map((m) => ({ id: m.id, role: m.role, content: [{ type: "text", text: "x".repeat(20) }] }));
      const text = summaryText(await hook({ messages: region as never }, agent));
      expect(text).not.toContain("unsummarized_tail");
      // A large region (real text) keeps the tail.
      await withDb(async (db2) => {
        const hook2 = createMagicSummarizeHook({ db: db2, sessionId: SID, ctx: {}, provider, summarize: partialHistorian(12) as never, leaseHolderId: "r26-big" });
        const big = messages.map((m) => ({ id: m.id, role: m.role, content: [{ type: "text", text: "y".repeat(2_000) }] }));
        expect(summaryText(await hook2({ messages: big as never }, agent))).toContain(CONSTRAINT);
      });
    });
  });
});
