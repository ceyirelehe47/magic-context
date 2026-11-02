# Round 13 — Magic worker on real DSH 0.2.1-rc.5 (A1–A5)

Real host: `@deepseek-ai/dsh` 0.2.1-rc.5, headless, opencode-go `deepseek-v4.1-flash`, contextWindow 24000.
Trigger: env-gated `ctx_worker_selftest` (`MAGIC_CONTEXT_DSH_WORKER_SELFTEST=1`), the only real-host caller of
`runMagicWorker`. Each run is a fresh `dsh` process.

| run | build | worker timeout | parent session | child session | result |
|---|---|---|---|---|---|
| run-29 | 151ab09da | 180 s | (round 13 log) | — | ok, but child replied with `§4§` (MC guidance leaked into child system prompt) → fixed in 1cacaa607 |
| run-30 | 1cacaa607 | 180 s | `session-32e863a3…` | `554f0b41…` | ok, 5.5 s |
| run-31 | 4ba6fb163 | 180 s | `session-72fad26c…` | `1b7d7567…` | ok, 7.1 s, + executor tool resolution |
| run-32 | 4ba6fb163 | 1500 ms | `session-c7e4552b…` | `91060f17…` | ok:false (timeout), child aborted |

Files: `run-30/31/32.turn-log.jsonl` (headless event stream; glob listings trimmed, paths redacted),
`child-sessions.txt` (decoded child `session.v4.jsonl.zstd` summaries), `db.txt` (context.db rows).

## A1 — worker starts, ends, returns text, no §N§ — **measured: pass**
- run-30 / run-31: `ok:true`, `workerText` = `TOOL: glob / TOOL: grep / TOOL: read / GLOB_COUNT: … / BASH: unavailable / WRITE: unavailable`;
  child `turn/end` `completed`. No `§` anywhere in `workerText`.
- Child `system/message` (all three children): 1941 chars, contains neither `## Magic Context` nor `§`
  (run-29 child had the ~7.6k-char MC section and wrote `§4§`).
- Caveat: the defensive leading-`§N§` strip in `runMagicWorker` (1cacaa607) means a clean `workerText` alone does not
  prove the child did not write a tag; the child's own assistant text in `child-sessions.txt` (no `§`) does.

## A2 — child sees only read/grep/glob — **measured: pass**
- Child `request/header.tools` = `["glob","grep","read"]` in all three children (what the model was actually sent).
- `childVisibleTools` = `["glob","grep","read"]` (`tools.view(child).visible`).

## A3 — executor rejects bash/write etc. — **measured resolution + static executor path; no forced call**
- Measured on the real host (run-31, run-32 `toolResolution`, `tools.get(name, child)` vs global):
  `bash/write/edit/ctx_search/ctx_reduce` → `global:true, child:false`; `read/glob/grep` → `child:true`;
  `spawn_agent` absent globally.
- Static (rc.5 `@deepseek-ai/dsh-tools/lib/index.js`): `Tools.get(name, scope)` = `view(scope).visible.get(name)`;
  `resolveExecution(name, scope, nested)` calls `get(name, scope)`; the dispatch path does
  `const tool = this.resolveExecution(exec.name, exec.agent, …); if (!tool) throw new ToolNotFoundError(exec.name)`
  (`UNKNOWN_TOOL`). So `child:false` ⇒ a child call by that name fails with `UNKNOWN_TOOL`.
- Not measured: an actual `bash` tool call reaching the executor from the child. The model is never sent the
  schema, so it does not emit the call (both runs: "unavailable — no tool named bash …"); no `tool/call bash` exists in
  any child log, and no `mc-worker-probe.txt` was created.
- Child also runs with `approval/policy never` (source delegation) and inherits the parent's `sandbox/mode workspace-write`.

## A4 — timeout / cancel cleanup — **measured: pass; diagnosability gap fixed**
- run-32 (1500 ms): parent got `ok:false, workerText:null` after ~1.6 s; child session `turn/end` =
  `aborted {kind: parent}` 1.6 s after its `createdAt` → the child was disposed, not left running.
- The headless turn ended normally (`rc=0`, 23.9 s); leftover `dsh` processes after the run: 0 (round13-log).
- Child has 0 rows in every Magic table (see A5).
- Gap: the report had `workerLog: []` — nothing said *why* it returned null. Fixed in 502d74b94
  (`worker timed out after Nms; child disposed` / `worker cancelled by parent signal` / `worker stopped: <reason>` /
  `worker returned no text`), unit tests red before. Not re-run on the real host after the fix.

## A5 — no double processing; child writes nothing; parent §N§ contiguous — **measured: pass**
- Child session ids (all three) have 0 rows in every `session_id` table of `context.db` (tags, source_contents,
  compartments, historian_runs, session_meta, dsh_context_outbox, dsh_context_compaction_marker, dsh_pressure_truncations, …).
- Parent tags: run-30 §1–§4, run-31 §1–§5, run-32 §1–§2; each `tag_number` once, each `message_id` once
  (`${id}:p0` for messages, callId for tools). The model's own reply prefixes (§2§/§5§, §4§/§6§, §3§) are the next
  numbers, no collision with an existing tag.
- historian_runs: 2 per parent — one per agent step (incremental), not a re-run of the same range: noop/noop
  (run-30, run-32); run-31 noop then success producing exactly one compartment (ordinals 1–1). outbox: one
  `tags` op per tagging generation (generation 0, 1), all `committed` with distinct ack seqs.
- Observation (not a worker bug): run-31's one compartment summarises only the empty session-history marker
  ("Empty session-history marker at session start"); its compaction marker row is still `pending` at process exit.
