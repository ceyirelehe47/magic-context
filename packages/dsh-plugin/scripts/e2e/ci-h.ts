// Round 24b scenario H helper (dsh-ci.yml job `e2e`, checks U13…): read-only
// DB evidence for the multi-session memory-correctness scenario.
//
//   bun scripts/e2e/ci-h.ts <db> <codes,comma,separated> <dsh-sid>[,<dsh-sid>…]
//
// Prints JSON: for every session (by DSH id) its canonical key, compartments
// (range + which scenario codewords each one's text mentions), compartment
// chunk-embedding rows, historian runs, and what its cached m0 injection
// carries: whether a <project-memory> block exists and which codewords it /
// <session-history> mention. Plus every memory row that mentions a codeword
// (id, status, category, superseded_by, content — scenario test data only).
// The DB holds no secrets.
import { Database } from "bun:sqlite";

const [dbPath, codesArg, sidsArg] = process.argv.slice(2);
if (!dbPath || !codesArg || !sidsArg) {
  console.error("usage: ci-h.ts <db> <codes> <sid,sid,…>");
  process.exit(2);
}
const codes = codesArg.split(",").filter(Boolean);
const db = new Database(dbPath, { readonly: true });
const tables = new Set((db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name));
const safe = <T>(fn: () => T): T | { error: string } => {
  try {
    return fn();
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error).slice(0, 300) };
  }
};
const mentions = (text: string) => codes.filter((c) => text.includes(c));

const sessions: Record<string, unknown> = {};
for (const sid of sidsArg.split(",").filter(Boolean)) {
  const key = (db.query("select session_id from session_meta where session_id = ? or session_id like ? limit 1").get(sid, `%:${sid}`) as
    | { session_id: string }
    | null)?.session_id;
  if (!key) {
    sessions[sid] = { key: null };
    continue;
  }
  const comps = safe(() =>
    (db.query("select id, sequence, start_message, end_message, title, content from compartments where session_id = ? order by sequence").all(key) as {
      id: number; sequence: number; start_message: number; end_message: number; title: string; content: string;
    }[]).map((c) => ({ id: c.id, sequence: c.sequence, range: [c.start_message, c.end_message], title: c.title, codes: mentions(`${c.title}\n${c.content}`) })),
  );
  const chunks = tables.has("compartment_chunk_embeddings")
    ? safe(() => db.query("select count(*) n, count(distinct compartment_id) compartments from compartment_chunk_embeddings where session_id = ?").get(key))
    : null;
  const historianRuns = tables.has("historian_runs")
    ? safe(() => db.query("select count(*) n from historian_runs where session_id = ?").get(key))
    : null;
  const m0 = safe(() => {
    const row = db.query("select cached_m0_bytes b from session_meta where session_id = ?").get(key) as { b: Uint8Array | null } | null;
    const text = row?.b ? new TextDecoder().decode(row.b) : "";
    const pm = /<project-memory>([\s\S]*?)<\/project-memory>/.exec(text);
    const sh = /<session-history>([\s\S]*?)<\/session-history>/.exec(text);
    return {
      len: text.length,
      hasProjectMemory: pm !== null,
      projectMemoryCodes: mentions(pm?.[1] ?? ""),
      sessionHistoryCodes: mentions(sh?.[1] ?? ""),
      anyCodes: mentions(text),
    };
  });
  sessions[sid] = { key, compartments: comps, chunks, historianRuns, m0 };
}

const memories = tables.has("memories")
  ? safe(() =>
      (db.query("select id, status, category, superseded_by_memory_id sup, source_session_id src, content from memories order by id").all() as {
        id: number; status: string; category: string; sup: number | null; src: string | null; content: string;
      }[])
        .filter((m) => mentions(m.content).length > 0)
        .map((m) => ({ ...m, codes: mentions(m.content) })),
    )
  : null;
console.log(JSON.stringify({ at: Date.now(), codes, sessions, memories }));
