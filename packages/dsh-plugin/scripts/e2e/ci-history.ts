// Round 23 e2e helper (dsh-ci.yml job `e2e`, scenario L, check R14): after the
// SECOND native compaction of the lock session, is the content that was not
// summarized before it still visible or recoverable?
//
//   bun scripts/e2e/ci-history.ts <session.jsonl> <db-session.json> <promptNeedle>
//
// The decoded DSH session log (storage-form seq ranges expanded with DSH's own
// `decodeSeqRanges`) is replayed by the real DSH `Session` (its own surface fold). For the user prompt containing <promptNeedle> and for every
// file the model read after it (its `CHECKSUM: …` line from the read result),
// it reports:
//   - onSurface: the text is still in the model-visible surface view;
//   - historyOrdinal: its ordinal in the history view (= ctx_expand's source,
//     the numbering compartments use);
//   - coveredBy: the compartment (db snapshot) whose start..end holds it, i.e.
//     `ctx_expand(start, end)` of that compartment shows it.
// plus every compaction/summary event (shadowed seqs, whether its summary text
// carries a compartment whose range reaches the read turn).
//
// Round 33 (R14 structural basis): per item also
//   - originSeqs: the raw event(s) that carry it (the read's tool/result; for
//     the prompt every un-derived user/message holding the needle);
//   - shadowedBy: every compaction/summary whose `shadowedSeqs` contains one of
//     originSeqs or a node derived from them through `sourceEventSeqs` (a Magic
//     surface-replace copy of the read, the checkpoint that folded that copy, …)
//     — i.e. the native compaction structurally folded the original message;
//   - onRawSurface: the text is on the surface OUTSIDE every summary node's own
//     text (a summary node = a user/message whose sourceEventSeqs name a
//     compaction/summary, or a copy whose sources are all summary nodes). The
//     summary texts are cut out of each surface message before probing, so a
//     checkpoint that restates a checksum no longer counts as "still visible",
//     while any raw message (or Magic injection) that still carries it does;
//   - inSummaryText: the text occurs in a summary node's own text (diagnostic).
// Prints JSON only; no secrets are read.
import { readFileSync } from "node:fs";
import { decodeSeqRanges, Session, SessionId } from "@deepseek-ai/dsh-session";
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
// Round 24c: DSH's JSONL storage form range-encodes `sourceEventSeqs` runs of
// >= 3 consecutive seqs (`encodeSeqRanges`, e.g. [53, [57, 59]]); the in-memory
// seed `Session.create` validates wants them expanded (e2e 41679402115 R14:
// "invalid seed event at index 61 … sourceEventSeqs must densely contain …"
// on a Magic op copy that shadowed three parallel read results).
const events = lines.slice(1).map((e) =>
  Array.isArray(e.sourceEventSeqs) ? { ...e, sourceEventSeqs: decodeSeqRanges(e.sourceEventSeqs) } : e,
);
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
// Round 33: structural fold evidence (see header).
const summaryEventSeqs = new Set(events.filter((e) => e.type === "compaction/summary").map((e) => e.seq));
const sourcesOf = (e: Ev): number[] => (Array.isArray(e.sourceEventSeqs) ? (e.sourceEventSeqs as number[]) : []);
const summaryNodeSeqs = new Set<number>();
for (const e of events) {
  // events are in seq order, so a copy's sources are classified before it
  const src = sourcesOf(e);
  if (e.type !== "user/message" || src.length === 0) continue;
  if (src.some((s) => summaryEventSeqs.has(s))) summaryNodeSeqs.add(e.seq);
  else if (src.every((s) => summaryNodeSeqs.has(s))) summaryNodeSeqs.add(e.seq);
}
const contentTexts = (e: Ev): string[] => {
  const d = e.data as { content?: Array<{ text?: unknown }> } | undefined;
  return (d?.content ?? []).map((p) => (typeof p.text === "string" ? p.text : "")).filter((t) => t.length > 0);
};
// Each summary node's text without a leading Magic "§N§ " tag; cut out of the
// JSON form of every surface message before the raw-surface probe.
const summaryTexts = [...summaryNodeSeqs]
  .flatMap((seq) => contentTexts(events.find((e) => e.seq === seq)!))
  .map((t) => t.replace(/^\s*\u00a7\d+\u00a7\s*/, ""))
  .filter((t) => t.length > 0)
  .sort((a, b) => b.length - a.length);
const cut = (json: string): string =>
  summaryTexts.reduce((acc, t) => acc.split(JSON.stringify(t).slice(1, -1)).join("\u0000"), json);
const derivedFrom = new Map<number, number[]>();
for (const e of events) for (const s of sourcesOf(e)) derivedFrom.set(s, [...(derivedFrom.get(s) ?? []), e.seq]);
const closure = (roots: number[]): Set<number> => {
  const seen = new Set<number>(roots);
  const todo = [...roots];
  while (todo.length > 0) for (const n of derivedFrom.get(todo.pop()!) ?? []) if (!seen.has(n)) (seen.add(n), todo.push(n));
  return seen;
};
const summaryEvents = events.filter((e) => e.type === "compaction/summary");
const structural = (probe: string, originSeqs: number[]) => {
  const reach = closure(originSeqs);
  return {
    originSeqs,
    shadowedBy: summaryEvents
      .filter((e) => ((e.data as { shadowedSeqs?: number[] })?.shadowedSeqs ?? []).some((s) => reach.has(s)))
      .map((e) => e.seq),
    onRawSurface: surface.some((m) => cut(textOf(m)).includes(probe)),
    inSummaryText: summaryTexts.some((t) => t.includes(probe)),
  };
};
const locate = (probe: string, originSeqs: number[]) => {
  const h = history.find((m) => textOf(m).includes(probe));
  const historyOrdinal = h ? h.ordinal : null;
  return {
    historyOrdinal,
    coveredBy: coveredBy(historyOrdinal),
    onSurface: surface.some((m) => textOf(m).includes(probe)),
    ...structural(probe, originSeqs),
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
  files.push({ file: path, checksum, resultSeq: e.seq, ...locate(checksum, [e.seq]) });
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
      prompt: {
        found: promptEvent !== undefined,
        ...locate(
          needle,
          events
            .filter((e) => e.type === "user/message" && sourcesOf(e).length === 0 && JSON.stringify(e.data ?? {}).includes(needle))
            .map((e) => e.seq),
        ),
      },
      files,
      compactions,
    },
    null,
    1,
  ),
);
