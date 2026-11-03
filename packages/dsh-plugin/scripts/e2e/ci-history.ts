// Round 23 e2e helper (dsh-ci.yml job `e2e`, scenario L, check R14): after the
// SECOND native compaction of the lock session, is the content that was not
// summarized before it still visible or recoverable?
//
//   bun scripts/e2e/ci-history.ts <session.jsonl> <db-session.json> <promptNeedle>
//
// The decoded DSH session log is replayed by the real DSH `Session` (its own
// surface fold). For the user prompt containing <promptNeedle> and for every
// file the model read after it (its `CHECKSUM: …` line from the read result),
// it reports:
//   - onSurface: the text is still in the model-visible surface view;
//   - historyOrdinal: its ordinal in the history view (= ctx_expand's source,
//     the numbering compartments use);
//   - coveredBy: the compartment (db snapshot) whose start..end holds it, i.e.
//     `ctx_expand(start, end)` of that compartment shows it.
// plus every compaction/summary event (shadowed seqs, whether its summary text
// carries a compartment whose range reaches the read turn).
// Prints JSON only; no secrets are read.
import { readFileSync } from "node:fs";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { readRawMessagesFromAgent } from "../../src/agent/tools";
import { readDshTranscript } from "../../src/agent/transcript";

const [sessionPath, dbJsonPath, needle] = process.argv.slice(2);
if (!sessionPath || !dbJsonPath || !needle) {
  console.error("usage: ci-history.ts <session.jsonl> <db-session.json> <promptNeedle>");
  process.exit(2);
}
type Ev = Record<string, unknown> & { type: string; seq: number };
const lines = readFileSync(sessionPath, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Ev);
const header = lines[0] as unknown as { id: string };
const events = lines.slice(1);
const session = Session.create(SessionId(header.id), events as never);
const agent = { session } as never;

const textOf = (m: { parts?: unknown[] }): string =>
  JSON.stringify((m.parts ?? []).map((p) => p as Record<string, unknown>));
const history = readRawMessagesFromAgent(agent);
const surface = readDshTranscript({
  session: { events: session.snapshotEvents(), surface: session.surface, header: {} } as never,
  canonicalSessionId: "",
}).messages;

const db = JSON.parse(readFileSync(dbJsonPath, "utf8")) as {
  compartments?: Array<{ start_message: number; end_message: number; title?: string }>;
};
const compartments = Array.isArray(db.compartments) ? db.compartments : [];
const lastCompartmentEnd = compartments.reduce((m, c) => Math.max(m, c.end_message), 0);
const coveredBy = (ordinal: number | null): string | null => {
  if (ordinal === null) return null;
  const c = compartments.find((x) => x.start_message <= ordinal && ordinal <= x.end_message);
  return c ? `${c.start_message}-${c.end_message}` : null;
};
const locate = (probe: string) => {
  const h = history.find((m) => textOf(m).includes(probe));
  const historyOrdinal = h ? h.ordinal : null;
  return {
    historyOrdinal,
    coveredBy: coveredBy(historyOrdinal),
    onSurface: surface.some((m) => textOf(m).includes(probe)),
  };
};

// The prompt (raw user text, without the §N§ tag prefix Magic adds on the surface).
const promptEvent = events.find(
  (e) =>
    e.type === "agent/inbox/spliced" &&
    JSON.stringify(e.data ?? {}).includes(needle),
);
const promptSeq = promptEvent?.seq ?? Number.POSITIVE_INFINITY;
const files: Array<Record<string, unknown>> = [];
for (const e of events) {
  if (e.seq <= promptSeq || e.type !== "tool/result") continue;
  const text = JSON.stringify((e.data as { message?: unknown })?.message ?? {});
  const path = /e2e-pressure-fixtures\/(p\d+\.txt)/.exec(text)?.[1];
  const checksum = /CHECKSUM: (P19-\d+-[0-9A-F]{6})/.exec(text)?.[1];
  if (!path || !checksum) continue;
  files.push({ file: path, checksum, resultSeq: e.seq, ...locate(checksum) });
}
const compactions = events
  .filter((e) => e.type === "compaction/summary")
  .map((e) => {
    const d = e.data as { shadowedSeqs?: number[]; summary?: Array<{ text?: string }> };
    const summary = (d.summary ?? []).map((p) => p.text ?? "").join("\n");
    const ranges = [...summary.matchAll(/<compartment start="(\d+)" end="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    return {
      seq: e.seq,
      shadowedSeqs: d.shadowedSeqs ?? [],
      summaryCompartmentRanges: ranges,
      summaryMaxEnd: ranges.reduce((m, r) => Math.max(m, r[1]!), 0),
    };
  });
console.log(
  JSON.stringify(
    {
      historyCount: history.length,
      surfaceCount: surface.length,
      lastCompartmentEnd,
      prompt: { found: promptEvent !== undefined, ...locate(needle) },
      files,
      compactions,
    },
    null,
    1,
  ),
);
