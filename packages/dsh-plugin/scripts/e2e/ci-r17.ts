// Round 17 e2e helper (dsh-ci.yml job `e2e`, scenarios C/S/U): read-only DB
// evidence for the compression / child-limit / daily-use scenarios.
//
//   bun scripts/e2e/ci-r17.ts snapshot <db>                 # row count of every table
//   bun scripts/e2e/ci-r17.ts session  <db> <dsh-session-id> [thresholdPct] [modelKey]
//
// `session` prints, for the canonical key that ends with the DSH id:
//   compartments (sequence / message range / title / content length / whether
//   the content mentions the e2e codeword), session_meta historian fields,
//   compartment leases (live or expired), compaction markers, tag status
//   counts, pending drop ops, outbox status counts, memories of the project,
//   and the two status readouts the user sees:
//     - `details`: readSessionContextDetails() — the source of the DSH settings
//       page / composer MC popover (`magicContext/context`), resolved through
//       the same wireSessionToCanonical() the Remote endpoint uses;
//     - `status`:  the `/ctx-status` command body (core executeStatus() passed
//       through the DSH command's stripOpenCodeDbStatusLine()).
// Prints JSON only; the DB holds no secrets.
import { Database } from "bun:sqlite";
import { readSessionContextDetails } from "../../src/host/context-details";
import { wireSessionToCanonical } from "../../src/host/remote";

const [cmd, dbPath, sid, thresholdArg, modelKey] = process.argv.slice(2);
if (!cmd || !dbPath || (cmd === "session" && !sid)) {
  console.error("usage: ci-r17.ts snapshot <db> | session <db> <sid> [thresholdPct] [modelKey]");
  process.exit(2);
}
const db = new Database(dbPath, { readonly: true });
const tables = (db.query("select name from sqlite_master where type='table' order by name").all() as { name: string }[]).map(
  (r) => r.name,
);
const safe = <T>(fn: () => T): T | { error: string } => {
  try {
    return fn();
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error).slice(0, 300) };
  }
};

if (cmd === "snapshot") {
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const n = safe(() => (db.query(`select count(*) n from "${t}"`).get() as { n: number }).n);
    if (typeof n === "number") counts[t] = n;
  }
  console.log(JSON.stringify({ at: Date.now(), counts }));
  process.exit(0);
}

const keyRow = db
  .query("select session_id from session_meta where session_id = ? or session_id like ? limit 1")
  .get(sid, `%:${sid}`) as { session_id: string } | null;
const key = keyRow?.session_id;
const now = Date.now();
const has = (t: string) => tables.includes(t);
const all = (sql: string, ...p: (string | number)[]) => safe(() => db.query(sql).all(...p));
const one = (sql: string, ...p: (string | number)[]) => safe(() => db.query(sql).get(...p));

const CODEWORD = process.env.MC_E2E_CODEWORD ?? "";
const out: Record<string, unknown> = { sid, key: key ?? null, now };
if (key !== undefined) {
  out.compartments = all(
    "select sequence, start_message, end_message, title, length(content) as content_len, content from compartments where session_id = ? order by sequence",
    key,
  );
  if (Array.isArray(out.compartments)) {
    out.compartments = (out.compartments as Record<string, unknown>[]).map(({ content, ...rest }) => ({
      ...rest,
      mentionsCodeword: CODEWORD.length > 0 && String(content).includes(CODEWORD),
    }));
  }
  out.compartmentHistoryVersions = has("compartment_history_versions")
    ? one("select count(*) n from compartment_history_versions where session_id = ?", key)
    : null;
  out.meta = one(
    `select compartment_in_progress, historian_failure_count, historian_last_error, last_context_percentage,
            memory_block_count, length(cached_m0_bytes) as m0_len, length(cached_m1_bytes) as m1_len,
            cached_m0_materialized_at, last_response_time, last_input_tokens, protected_tokens_effective
       from session_meta where session_id = ?`,
    key,
  );
  // Round 18: what the cached m0 baseline (the injected <session-history>)
  // actually carries — never the text itself, only shape facts.
  out.m0 = safe(() => {
    const row = db.query("select cached_m0_bytes b from session_meta where session_id = ?").get(key) as
      | { b: Uint8Array | null }
      | null;
    const text = row?.b ? new TextDecoder().decode(row.b) : "";
    const m = /<session-history>([\s\S]*?)<\/session-history>/.exec(text);
    const body = m?.[1] ?? "";
    return {
      len: text.length,
      hasSessionHistory: m !== null,
      sessionHistoryLen: body.trim().length,
      // DSH/Pi render: one "## <start>-<end> · <title>" heading per compartment.
      compartmentBlocks: (body.match(/^## \d+-\d+ · /gm) ?? []).length,
      mentionsCodeword: CODEWORD.length > 0 && body.includes(CODEWORD),
    };
  });
  out.leases = all("select holder_id, owner_pid, acquired_at, expires_at, expires_at > ? as live from compartment_state_lease where session_id = ?", now, key);
  out.markers = has("dsh_context_compaction_marker")
    ? all("select ordinal, status, published_at, tokens_before, length(summary) as summary_len from dsh_context_compaction_marker where session_id = ?", key)
    : null;
  out.tagStatus = all("select status, count(*) n from tags where session_id = ? group by status", key);
  out.pendingOps = all("select operation, count(*) n from pending_ops where session_id = ? group by operation", key);
  out.outbox = has("dsh_context_outbox")
    ? all("select kind, status, count(*) n from dsh_context_outbox where session_id = ? group by kind, status", key)
    : null;
  out.truncations = has("dsh_pressure_truncations")
    ? one("select count(*) n from dsh_pressure_truncations where session_id = ?", key)
    : null;
  out.memories = has("memories") ? one("select count(*) n from memories") : null;
  out.memoryCodeword = has("memories") && CODEWORD.length > 0
    ? one("select count(*) n from memories where content like ?", `%${CODEWORD}%`)
    : null;

  // Settings page / popover readout, through the Remote endpoint's own key resolution.
  const host = {
    canonicalKey: (id: string) => (id === sid ? key : undefined) as string,
    parseKey: (k: string) => (k === key ? { dshSessionId: sid } : undefined),
  };
  const canonical = safe(() => wireSessionToCanonical(host as never, sid));
  const threshold = Number(thresholdArg ?? 65);
  out.details = safe(() =>
    readSessionContextDetails({
      db: db as never,
      canonicalSessionId: typeof canonical === "string" ? canonical : undefined,
      sessionId: sid,
      effective: {
        enabled: { value: true },
        protectedTokens: { value: undefined },
        historianModel: { value: undefined },
      } as never,
      thresholds: { executeThresholdPercentage: threshold } as never,
    }),
  );
  out.status = await (async () => {
    try {
      const { executeStatus } = await import("@magic-context/core/hooks/magic-context/execute-status");
      const { stripOpenCodeDbStatusLine } = await import("../../src/agent/commands");
      return stripOpenCodeDbStatusLine(executeStatus(db as never, key, threshold, modelKey));
    } catch (error) {
      return { error: String(error instanceof Error ? error.message : error).slice(0, 300) };
    }
  })();
}
console.log(JSON.stringify(out));
