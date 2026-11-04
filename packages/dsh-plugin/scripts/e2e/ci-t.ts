// Round 26 e2e helper (dsh-ci.yml job `e2e`, scenario T, checks T1–T4):
// after `/compact` with a historian `<unprocessed_from>` inside the region,
// where is the user constraint (codeword) the historian did not cover?
//
//   bun scripts/e2e/ci-t.ts <session.jsonl> <context.db> <dsh-session-id> <codeword>
//
// The decoded DSH session log is replayed by the real DSH `Session` (as
// ci-history.ts). Reports:
//   - constraint: its history ordinal (ctx_expand numbering), whether the
//     ORIGINAL user message is still on the model-visible surface (a summary
//     carrying the codeword does not count), and the other surface messages
//     carrying the codeword (anything that could leak it besides the summary);
//   - compactions: every compaction/summary event — compartment ranges, the
//     <unsummarized_tail from to> block, whether that block carries the codeword;
//   - historianRuns: the session's historian_runs (chunk, unprocessed_from);
//   - compartments: start/end per compartment (DB, read-only).
// Prints JSON only; no secrets are read.
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { decodeSeqRanges, Session, SessionId } from "@deepseek-ai/dsh-session";
import { readRawMessagesFromAgent } from "../../src/agent/tools";
import { readDshTranscript } from "../../src/agent/transcript";

const [sessionPath, dbPath, sid, codeword] = process.argv.slice(2);
if (!sessionPath || !dbPath || !sid || !codeword) {
  console.error("usage: ci-t.ts <session.jsonl> <context.db> <dsh-session-id> <codeword>");
  process.exit(2);
}
type Ev = Record<string, unknown> & { type: string; seq: number };
const lines = readFileSync(sessionPath, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Ev);
const header = lines[0] as unknown as { id: string };
const events = lines.slice(1).map((e) =>
  Array.isArray(e.sourceEventSeqs) ? { ...e, sourceEventSeqs: decodeSeqRanges(e.sourceEventSeqs) } : e,
);
const session = Session.create(SessionId(header.id), events as never);
const textOf = (m: { parts?: unknown[] }): string => JSON.stringify(m.parts ?? []);
const history = readRawMessagesFromAgent({ session } as never);
const surface = readDshTranscript({
  session: { events: session.snapshotEvents(), surface: session.surface, header: {} } as never,
  canonicalSessionId: "",
}).messages;

const isSummary = (t: string) => t.includes("<unsummarized_tail") || t.includes("<session-history") || t.includes("<compartment ");
const hist = history.find((m) => (m as { role?: string }).role === "user" && textOf(m).includes(codeword));
const surfaceHits = surface
  .filter((m) => textOf(m).includes(codeword))
  .map((m) => ({ role: (m as { role?: string }).role, summary: isSummary(textOf(m)), text: textOf(m).slice(0, 160) }));
const originalOnSurface = surface.some((m) => {
  const t = textOf(m);
  return (m as { role?: string }).role === "user" && t.includes(codeword) && !isSummary(t);
});

const compactions = events
  .filter((e) => e.type === "compaction/summary")
  .map((e) => {
    const d = e.data as { shadowedSeqs?: number[]; summary?: Array<{ text?: string }> };
    const summary = (d.summary ?? []).map((p) => p.text ?? "").join("\n");
    const ranges = [...summary.matchAll(/<compartment start="(\d+)" end="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const tail = /<unsummarized_tail from="(\d+)" to="(\d+)">([\s\S]*?)<\/unsummarized_tail>/.exec(summary);
    return {
      seq: e.seq,
      shadowed: (d.shadowedSeqs ?? []).length,
      summaryChars: summary.length,
      compartmentRanges: ranges,
      tail: tail
        ? { from: Number(tail[1]), to: Number(tail[2]), chars: tail[3]!.length, carriesCodeword: tail[3]!.includes(codeword),
            constraintLine: (tail[3]!.split("\n").find((l) => l.includes(codeword)) ?? "").slice(0, 300) }
        : null,
      summaryCarriesCodeword: summary.includes(codeword),
    };
  });

const db = new Database(dbPath, { readonly: true });
const keyRow = db
  .query("select session_id from session_meta where session_id = ? or session_id like ? limit 1")
  .get(sid, `%:${sid}`) as { session_id: string } | null;
const key = keyRow?.session_id ?? sid;
const safe = <T>(fn: () => T): T | { error: string } => {
  try {
    return fn();
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error).slice(0, 200) };
  }
};
const compartments = safe(() =>
  db.query("select sequence, start_message, end_message from compartments where session_id = ? order by sequence").all(key),
);
const historianRuns = safe(() =>
  db
    .query("select run_kind, status, chunk_start_ordinal, chunk_end_ordinal, unprocessed_from, compartments_produced from historian_runs where session_id = ? order by id")
    .all(key),
);
console.log(
  JSON.stringify(
    {
      key,
      historyCount: history.length,
      surfaceCount: surface.length,
      constraint: { found: hist !== undefined, historyOrdinal: hist ? (hist as { ordinal: number }).ordinal : null, originalOnSurface },
      surfaceHits,
      compactions,
      historianRuns,
      compartments,
    },
    null,
    1,
  ),
);
