/**
 * Round 23: history ordinals across DSH native compactions (real rc.5 log).
 *
 * Fixture: the scenario-L session log of e2e run 41619627652 (round 22,
 * `lock-session.jsonl`, long strings trimmed, tool schemas stubbed). It holds
 * TWO native compactions of one session:
 *   - seq 104–108  `/compact` #1 shadows surface seqs 8..98 (20 view messages),
 *   - seq 145–150  `/compact` #2 shadows 114..139 — the checkpoint copy of #1,
 *     the turn-4 prompt and the p27–p29 reads.
 * Compartments 1..17 were published before #1 (db-lock-c.json).
 *
 * Real defect (reproduced in that run): after #1 the surface view restarts its
 * ordinals at 1 (checkpoint = 1 … "p29 read." = 10) while compartments keep the
 * old numbering (end 17), so `/compact` #2 judged the range "covered" and
 * replayed compartments 1–17 as the summary — shadowing p27–p29 and the user's
 * prompt without any summary of them (seq 147).
 *
 * The session is rebuilt by the REAL DSH `Session` from the logged events (the
 * surface fold is DSH's own), and read through the production
 * `transcriptRawMessageProvider` — the provider the historian, the summarize
 * hook and the drop queue use.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { appendCompartments, getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
  getRawSessionTagKeysThrough,
  withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createTestDb } from "../test-utils";
import { transcriptRawMessageProvider } from "./historian-wiring";
import { createMagicSummarizeHook, runDshHistorian, type DshSummarizeCall } from "./historian";
import { initializeDshAdapterTables } from "./outbox";

const FIXTURE = join(import.meta.dir, "fixtures", "rc5-two-native-compactions.session.jsonl");
const SID = "dsh:7114782d:session-5b23fe35-a0c3-448f-9217-e02fc2c4beec";

// Message ids taken from the logged events.
const ID_OK_ANSWER = "961474ff-5f8a"; // assistant "ok" (seq 100), kept by #1
const ID_TURN4_PROMPT = "d0d67495-06cb"; // user "Use the read tool … p27…" (seq 118)
const ID_P29_REPLY = "e29c670c-e11c"; // assistant "p29 read." (seq 142)

type Event = Record<string, unknown> & { seq: number; type: string };

function loadEvents(): { header: { id: string }; events: Event[] } {
  const lines = readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Event);
  return { header: lines[0] as unknown as { id: string }, events: lines.slice(1) };
}

/** Real DSH session replayed up to (and including) `uptoSeq`. */
function sessionUpTo(uptoSeq: number): Session {
  const { header, events } = loadEvents();
  return Session.create(SessionId(header.id), events.filter((e) => e.seq <= uptoSeq) as never);
}

function agentOf(session: Session): Agent {
  return {
    id: "session-5b23fe35-a0c3-448f-9217-e02fc2c4beec",
    options: { provider: "opencode-go-40k", model: "deepseek-v4.1-flash" },
    session,
  } as unknown as Agent;
}

function fullId(messages: readonly { id: string }[], prefix: string): string {
  const hit = messages.find((m) => m.id.startsWith(prefix));
  if (hit === undefined) throw new Error(`no message ${prefix}`);
  return hit.id;
}

/** Message id a surface event carries (user/message: data.id; others: data.message.id). */
function surfaceMessageId(event: Event): string {
  const data = event.data as { id?: string; message?: { id?: string } };
  return String(data.id ?? data.message?.id);
}

/** compaction-basic's region for `/compact` #2: the surface events seq 148 shadowed. */
function secondCompactionRegion(): Array<{ id: string; role: string; content: unknown[] }> {
  const { events } = loadEvents();
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const checkpoint = bySeq.get(148)!;
  const shadowed = (checkpoint.sourceEventSeqs as number[]).filter((seq) => {
    const type = bySeq.get(seq)?.type ?? "";
    return !type.startsWith("compaction/");
  });
  return shadowed.map((seq) => ({ id: surfaceMessageId(bySeq.get(seq)!), role: "user", content: [] }));
}

/** Compartments 1..17 exactly as the real run published them (db-lock-c.json). */
function stageRealCompartments(db: Database, preCompaction: readonly { id: string; ordinal: number }[]): void {
  const idAt = (o: number) => preCompaction.find((m) => m.ordinal === o)!.id;
  const rows: Array<[number, number, string]> = [
    [1, 1, "Session opened with codeword AMBER-FALCON-7319 injected via project memory"],
    [2, 5, "Readiness handshake for step-driven session"],
    [6, 11, "Ran e2e pressure-fixture read loop (p17–p24)"],
    [12, 17, "Finished the sequential file-read step sequence with DONE"],
  ];
  appendCompartments(
    db,
    SID,
    rows.map(([start, end, title], sequence) => ({
      sequence,
      startMessage: start,
      endMessage: end,
      startMessageId: idAt(start),
      endMessageId: idAt(end),
      title,
      content: `Narrative ${start}-${end}.`,
      p1: `Narrative ${start}-${end}.`,
      p2: `Condensed ${start}-${end}.`,
      p3: `Outcome ${start}-${end}.`,
      p4: `Anchor ${start}-${end}.`,
      importance: 50,
      episodeType: "design",
    })),
  );
}

async function withDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-native-ordinals-"));
  const db = await createTestDb(join(dir, "context.db"));
  initializeDshAdapterTables(db);
  try {
    return await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("history ordinals across DSH native compactions (real rc.5 log, run 41619627652)", () => {
  it("pre-compaction view (sanity): 21 messages, the kept 'ok' answer is ordinal 21", () => {
    const provider = transcriptRawMessageProvider(agentOf(sessionUpTo(102)), SID);
    const messages = provider.readMessages();
    expect(messages.length).toBe(21);
    expect(provider.readMessageOrdinalById(fullId(messages, ID_OK_ANSWER))).toBe(21);
  });

  it("after /compact #1 the history keeps its numbering: the kept answer stays 21, new turn-4 messages come after it", () => {
    const before = transcriptRawMessageProvider(agentOf(sessionUpTo(102)), SID).readMessages();
    const provider = transcriptRawMessageProvider(agentOf(sessionUpTo(144)), SID);
    const messages = provider.readMessages();
    // Every pre-compaction message keeps its id ↔ ordinal pair.
    for (const m of before) expect(provider.readMessageOrdinalById(m.id)).toBe(m.ordinal);
    expect(provider.readMessageOrdinalById(fullId(messages, ID_OK_ANSWER))).toBe(21);
    expect(provider.readMessageOrdinalById(fullId(messages, ID_TURN4_PROMPT))!).toBeGreaterThan(21);
    expect(provider.readMessageOrdinalById(fullId(messages, ID_P29_REPLY))!).toBeGreaterThan(21);
    // Ordinals are 1..N without gaps (core sizes ranges by count).
    expect(messages.map((m) => m.ordinal)).toEqual(messages.map((_, i) => i + 1));
    expect(provider.getMessageCount?.()).toBe(messages.length);
  });

  it("case 1 — /compact #2 over compartments 1..17 is NOT covered: the mini-historian reads p27–p29 and the turn-4 prompt", async () => {
    await withDb(async (db) => {
      const before = transcriptRawMessageProvider(agentOf(sessionUpTo(102)), SID).readMessages();
      stageRealCompartments(db, before);
      const agent = agentOf(sessionUpTo(144));
      const chunks: string[] = [];
      const summarize: DshSummarizeCall = async (chunk) => {
        chunks.push(chunk.text);
        throw new Error("stop after capture");
      };
      const hook = createMagicSummarizeHook({
        db,
        sessionId: SID,
        ctx: {},
        provider: transcriptRawMessageProvider(agent, SID),
        summarize,
        leaseHolderId: "r23-case1",
      });
      // Pre-fix: "covered" → compartments 1..17 returned, summarize never called.
      await expect(hook({ messages: secondCompactionRegion() as never }, agent)).rejects.toThrow(/mini-historian/);
      expect(chunks.length).toBeGreaterThan(0);
      const text = chunks.join("\n");
      expect(text).toContain("p27.txt");
      expect(text).toContain("p29.txt");
      expect(text).toContain("read each of these five files");
      expect(getCompartments(db, SID).at(-1)!.endMessage).toBe(17);
    });
  });

  it("case 2 — the background historian (production boundary) reads the post-compaction turn after compartment 17", async () => {
    await withDb(async (db) => {
      const before = transcriptRawMessageProvider(agentOf(sessionUpTo(102)), SID).readMessages();
      stageRealCompartments(db, before);
      const agent = agentOf(sessionUpTo(144));
      const chunks: Array<{ start: number; text: string }> = [];
      const ok = await runDshHistorian({
        db,
        sessionId: SID,
        provider: transcriptRawMessageProvider(agent, SID),
        summarize: async (chunk) => {
          chunks.push({ start: chunk.startIndex, text: chunk.text });
          return "";
        },
        leaseHolderId: "r23-case2",
        ignoreFailureBackoff: true,
      });
      expect(ok).toBe(false); // the stub returns no text → failure, nothing published
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.start).toBe(18);
      expect(chunks[0]!.text).toContain("Reply with the single word: ok."); // shadowed by #1 but never summarized
      expect(chunks[0]!.text).toContain("read each of these five files");
    });
  });

  it("case 3 — compartments through 17 make only messages 1..17 drop candidates, never the post-compaction turn", async () => {
    await withDb(async (db) => {
      const agent = agentOf(sessionUpTo(144));
      const provider = transcriptRawMessageProvider(agent, SID);
      const messages = provider.readMessages();
      const keys = await withRawMessageProvider(SID, provider, () => getRawSessionTagKeysThrough(SID, 17, { db }));
      const owners = new Set([...keys.messageFileKeys].map((key) => String(key).split(":")[0]));
      for (const prefix of [ID_TURN4_PROMPT, ID_P29_REPLY, ID_OK_ANSWER]) {
        expect(owners.has(fullId(messages, prefix))).toBe(false);
      }
    });
  });
});
