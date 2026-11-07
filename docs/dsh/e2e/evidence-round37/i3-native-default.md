# Round 37 — I3: fold-mode reasoning blow-up fixed by making native roles the default for new sessions

User request 2026-11-07 13:44 CST (round 37): fix the reasoning blow-up of the DSH adapter in the fold
view (I3, `evidence-round36/i-evo-bench.md` §6), may change the **default history presentation of new
sessions** (reuse native roles / `dsh_session_tag_scheme`), old fold sessions must not be migrated
silently; small real evo-bench / cache-bench runs allowed (evo slots from evo-10). Not approved: e2e / soak,
dsh.8 tag, `v*`, release / npm, PR / issue / comments, core / pi-plugin / upstream DSH / node_modules /
existing upstream workflows, the S9 fix.

Scope of the change: `packages/dsh-plugin` only (`agent/tag-scheme.ts`, one comment in
`agent/context-plane.ts`, tests), bench scripts and `dsh-*` workflows. Core, pi-plugin, DSH untouched.

## 1. Root cause — what is proven and what is inferred

Trace "persisted events → internal view → write-back → provider request" (fold view, code at `a2c58a49a`):

| stage | fold view (legacy) | native view (plan N) |
|---|---|---|
| persisted events | DSH appends `assistant/message` (reasoning + text + `tool-call` blocks, `source.replayState`), `tool/result` (callId) | same |
| internal view (`transcript.ts` `walkDshLog`) | a tool-call assistant node stays *pending*; when its results arrive the assistant + results are folded into one synthetic user message (`flushSynthetic` → `role: "user"`, id `synth-user-*`) | every surface node is its own message with its own role (no pending fold), parts remember their source node |
| write-back plan (`deriveMutationPlan` / `RecordingMessage.render`) | the folded message is rendered as text — tool calls become the prose note "Magic Context note: these tool calls already ran …", `RecordingPart.render()` returns `null` for `thinking` / `reasoning` parts — and written as **one `user/message` replace over [assistant … tool results]** | per source node: content-only `tool/result` replace or single-node `user/message` replace, each after a priced `compaction/prune`; assistant parts are read-only (never written), reasoning replay skipped |
| provider request (DSH `deriveMessages` → pi-ai) | the replace shadows the assistant and tool nodes: no historical `assistant`, `tool`, `tool_calls`, `reasoning_content` | DSH serves the original nodes: assistant `tool_calls` + `reasoning_content`, paired `tool` messages |
| when | on the first pre-step after the tool results arrive — i.e. the **just-finished, still active** tool chain of the current turn is demoted to user text at every step | — |

**Proven (code + real request bodies):**
- The fold write-back removes roles, call ↔ result pairing and reasoning from every finished tool step,
  including the active one. Request bodies of 42274076026 (`dc916285b`, DSH 0.2.1-rc.5, opencode-go
  `deepseek-v4.1-flash`, 1M): fold 0 / 176 main requests after the first carry a historical `assistant`,
  `tool`, `tool_calls` or `reasoning_content`; native 356 / 356 carry all four (`r37/cmp.py`, table §5).
- DeepSeek thinking mode with `tools` expects the `reasoning_content` of all previous turns to be passed
  back ("If your code does not correctly pass back reasoning_content, the API will return a 400 error",
  https://api-docs.deepseek.com/guides/thinking_mode/). The fold view never sends a 400-triggering message
  because it removes the assistant messages altogether — the model just loses its own reasoning and
  calls.
- Default new sessions got the fold view: `nativeRolesRequested()` returned `false` unless
  `context.nativeRoles` / `MAGIC_CONTEXT_DSH_NATIVE_ROLES` was set; RED `81a441e96` reproduces it on a
  real `@deepseek-ai/dsh-session` Session (6 / 7 fail on `a2c58a49a`).
- Strong, repeated association: fold vs native on the same task, model, route and first request
  (byte-identical after nonce / workdir normalisation): reasoning median 10 704 vs 120 tokens per main
  request, 15 / 15 vs 0 / 22 turns timed out (42274076026); the three earlier fold runs 4.9–8.8 k vs
  34–141 (42262147533 / 42262946905); round 36 D ablation on cache-bench: baseline + fold 553 reasoning /
  step, baseline + "fold only closed history" 17, baseline 7.

**Not isolated / inferred:**
- How much each of (a) roles flattened to user, (b) reasoning not passed back, (c) the note text / tags,
  (d) the write-back path contributes is not separated by a single-variable experiment on this task.
  Round 36 D found "foldplain" (roles flattened, no note) ≈ fold and "noreason" (reasoning not passed
  back, roles kept) without effect on cache-bench — evidence that role / pairing loss dominates there, but
  on a different, shorter task. Sending native roles without reasoning is not a legal request with tools
  (400), so that arm cannot be run cleanly on the real route.
- Why the model re-derives state (it repeatedly writes "Previous turns are compacted", "turn-01 made no
  changes" in its reasoning) is a mechanism explanation, not proven.

## 2. Implementation

The native-role view already existed (round 36 G, behind a default-off switch) and keeps exactly what the
protocol needs, so the fix reuses it instead of building a second mapping:

- `agent/tag-scheme.ts` `nativeRolesRequested()`: default **on**. Explicit `context.nativeRoles: false` or
  `MAGIC_CONTEXT_DSH_NATIVE_ROLES=0|false|off|no` opts out; `1|true|on|yes` / unset = default.
- The per-session freeze is unchanged and now always active: on its first pass a session with no Magic tag
  rows and no Magic surface copy is frozen `native`; a session Magic already processed is frozen `fold`
  (`dsh_session_tag_scheme`, table created on first use).
- What the native view guarantees (tested in §4): assistant nodes are never written, so their tool calls,
  reasoning blocks and replay metadata (`source.replayState`, e.g. `thinkingSignature:
  "reasoning_content"`) reach the provider exactly as DSH recorded them; tool results stay `tool` messages
  paired by call id and are tagged / dropped / truncated in place (content-only replace); closed history
  is still summarised by the historian through DSH's own compaction transaction (one balanced
  `user/message` replace over a region compaction-basic selects with `toolPairingBalanced*`), so the
  request stays legal after a region is replaced.
- Not done (deliberately): no change to the fold view itself (old sessions keep their rules, see §3), no
  thinking / effort / maxTokens / model change.

Bench / e2e consequences (same commit): evo `fold` group pins `MAGIC_CONTEXT_DSH_NATIVE_ROLES=0`, `native`
group now runs the default (env unset); cache-bench input `native_roles` = `default | off | on`; e2e
scenario F (crash in the tail-fold window, which only exists in the fold view) pins `=0` for f-1 / f-2.

## 3. Compatibility

- **New sessions** (no Magic tag rows, no `mc-op:` surface copy): native by default, no setting needed.
- **Sessions already processed in the fold view** (every session Magic touched before this change — no
  scheme row was written while the switch was off): on their next pass they are frozen `fold` and keep its
  tag keys (`${viewMessageId}:pN`), tool-tag owners (`synth-user-*`), write rules (one user replace per
  folded range) and recovery behaviour. **They are not migrated and do not get the fix**: the fold view's
  loss of roles / reasoning (known limitation 1, I3) still applies to them. No mixing: a frozen session
  never switches view, whatever the setting later says (C1, S1, S2).
- Reading, recovery and history search of old sessions are unchanged (same code path).
- How to continue: an old fold session keeps working as before; to get native roles, start a new DSH
  session (project memories, compartments of the old session via `ctx_search`, and the repo state carry
  over; the old session's raw transcript stays searchable). There is no in-place migration in this round.
- Opt-out for new sessions: `context.nativeRoles: false` or `MAGIC_CONTEXT_DSH_NATIVE_ROLES=0`.

## 4. Tests (layer 1, offline, real `@deepseek-ai/dsh-session` Session, assertions on `deriveMessages()`)

`src/agent/default-native-roles.test.ts` — no switch set (env cleared for the file):

| case | what it checks |
|---|---|
| D1 | single + two consecutive tool steps: role sequence, `call-N` ↔ `tool` pairing, protocol checker clean, every assistant keeps its reasoning block + replay metadata, tool results tagged in place, no Magic note, no assistant replace, scheme `native` |
| D2 | one assistant with reasoning + text + two parallel calls, one result `isError`: both results paired in call order, both tagged, error kept |
| D3 | unfinished call across a pass and a process restart (session restored from events, fresh plugin state): served prefix byte-identical, result paired after restart |
| D4 | drop on a ride → historian region compaction (real `MagicCompactionEngine.compactRegion`) → expand-style call → parallel calls: protocol clean at every stage, region replaced by the summary, reasoning of the remaining assistants kept |
| D5 | the same pass repeated (same process and a fresh one) writes nothing, bytes unchanged |
| C1 | a session processed in the fold view before the change (no scheme row) stays fold under the new default: frozen `fold`, fold note present, no `tool/result` replace, no `compaction/prune` |
| C2 | explicit opt-out (setting `false`, env `0`) keeps fold for a new session |

The protocol checker (`protocolViolations`): every `tool` message answers a call of the assistant that
opened its run, each call answered at most once, all calls answered before the next non-tool message.

RED `81a441e96`: 6 / 7 fail on `a2c58a49a` (C2 passes — the opt-out was already the behaviour). FIX
`b3310120c`: 7 / 7.

Existing fold suites now pin `nativeRoles: false` (their setup only; no assertion changed):
`context-plane-preview-tags` 3, `fold-format` 1, `identity-regression` 1, `legacy-tag-cleanup` 1,
`new-input-fold-tags` 2 (4 tests), `runtime-context-tags` 1, `crash-recovery.helpers` (9 tests).
`native-roles.test.ts`: S1 starts from the explicit opt-out (the pre-change history), S3 renamed "switch
explicitly off" (same assertions). These are exactly the 8 files / tests round 36 G listed as fold-view
expectations when the switch was forced on.

Bench defect (also RED → FIX): the evo loop appended the next item after every `rc=124`, so one stuck
turn contaminated every later turn (42274076026 fold: 15 / 15 timeouts, ended on the workflow deadline
with a green job). RED `b876646df` (`test_evo_turn_policy.py`, 11 / 11 fail / error), FIX `6d8e115c4`:
`evo-bench/turn_policy.py` — default `EVO_ON_TIMEOUT=stop` keeps the session / workspace and stops;
`continue` must be chosen explicitly and flags each such turn `continued_after_timeout`; other failed turns
and a missing session stop (`turn-failed-*`, `infra-no-session-*`). `analyze.py` reports the stop class
(completed / turn-timeout / turn-failed / cost-cap / deadline / infra), turns completed / started / planned,
the policy (runs before round 37 = continue) and the main requests without usage (missing from all token /
cost totals); scoring and cost are unchanged.

CI: push CI 42345305410 @ `6d8e115c4` green — `dsh-plugin` **710 / 0** (703 at `a2c58a49a` + 7),
`adapter-api` 15, `contracts:dsh` 109 ×3 (rc.5 / alpha.3 / rc.1), python unit tests 33 + 11 = 44 ran, 0
FAIL / ERROR (the summary's `... ok` grep shows 40: ResourceWarnings printed by analyze.py split 4 of the
new lines), wf-lint 0, typecheck 0, test-file typecheck 0; 42345513122 @ `853606914` green.

## 5. Layer 2 — small real paired comparison (fold vs native default, same commit, 1M route)

Setup (all six runs): commit `853606914` (code = `b3310120c` + bench / route commits, no product change
after it), DSH `0.2.1-rc.5`, OpenCode Go `deepseek-v4.1-flash`, shipped opencode-go catalog route
`evo-model.yml` (1M window, catalog maxTokens 384 000, historian default = main model, no turn-end await),
SWE-EVO `conan-io__conan_2.0.2_2.0.3` first 3 items, turn timeout 1200 s, `on_timeout=stop`, web tools
off, network blocked. fold = `MAGIC_CONTEXT_DSH_NATIVE_ROLES=0` (explicit), native = env unset (the new
default). Runs: 42345522531 (slot evo-10, cost cap $1.5, × 1) and 42348194793 (slot evo-13, cost cap $3
per run, × 2) — three fold / native pairs. **First main request identical in all six runs** after
normalising nonce, session header, group-run path and container name (sha256 prefix `b82ef680b833eead`:
model, tools, generation parameters, system and user text). Analysis: `r37/pair.py`, `r37/cmp.py`
(local), same pricing as `analyze.py`. Reasoning is a subset of output tokens and is not added to cost.

Per run:

| run | group | turns completed / started / planned | stop | turn s | cum. files changed (end of each turn) | main requests | main bodies with hist. assistant / tool / tool_calls / reasoning_content | cost USD (all kinds) | F2P / P2P |
|---|---|---|---|---|---|---|---|---|---|
| 42345522531 | fold | 0 / 1 / 3 | turn-timeout-turn-1 | 1200 | 0 | 18 | 0 / 0 / 0 / 0 of 17 | 0.1311 | 0/8, 309/317 |
| 42345522531 | native | **3 / 3 / 3** | completed | 1061, 157, 295 | 4, 7, 9 | 129 | 128 / 128 / 128 / 128 of 128 | 0.2434 | 0/8, 309/317 |
| 42348194793 run1 | fold | 0 / 1 / 3 | turn-timeout-turn-1 | 1201 | 0 | 17 | 0 / 0 / 0 / 0 of 16 | 0.1358 | 0/8, 309/317 |
| 42348194793 run2 | fold | 0 / 1 / 3 | turn-timeout-turn-1 | 1200 | 0 | 25 | 0 / 0 / 0 / 0 of 24 | 0.1193 | 0/8, 309/317 |
| 42348194793 run1 | native | 0 / 1 / 3 | turn-timeout-turn-1 | 1200 | 2 | 80 | 79 / 79 / 79 / 79 of 79 | 0.2470 | 0/8, 309/317 |
| 42348194793 run2 | native | 0 / 1 / 3 | turn-timeout-turn-1 | 1200 | 3 | 94 | 93 / 93 / 93 / 93 of 93 | 0.2481 | 0/8, 309/317 |

Pooled over the three pairs, by request kind (no historian / summarizer request in any 1M run — the
window never got near a threshold):

| group | kind | n | with usage | without usage | reasoning / request median / p90 / max | reasoning sum | request ms median / p90 | output tok | cost USD | HTTP 429 | other HTTP errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fold | main | 60 | 58 | 2 | **3 047 / 9 875 / 25 552** | 267 502 | **36 225 / 122 168** | 280 911 | 0.3856 | 0 | 0 |
| fold | title | 3 | 3 | 0 | 55 / 64 / 64 | 119 | 1 955 / 7 394 | 156 | 0.0005 | 0 | 0 |
| native | main | 303 | 301 | 2 | **133 / 1 509 / 5 587** | 152 614 | **5 743 / 22 535** | 206 589 | 0.5863 | 0 | 0 |
| native | subagent | 83 | 72 | 11 | 92 / 1 406 / 26 046 | 52 730 | 7 230 / 21 691 | 67 962 | 0.1514 | 6 | 0 |
| native | title | 3 | 3 | 0 | 99 / 126 / 126 | 225 | 2 346 / 3 215 | 265 | 0.0007 | 0 | 0 |

Per-run main medians: fold 2 782 / 3 505 / 2 983, native 92 / 295 / 114 reasoning tokens; fold 34.7 /
39.3 / 33.6 s, native 5.4 / 7.4 / 5.5 s per request. The six requests without usage are streams cut by
the turn timeout (one per timed-out run) plus subagent requests rejected with 429
`prefill_cap_refused` (42345522531 native, retried by DSH); they are missing from the token / cost totals.

Reading:
- **Structure**: every native main request after the first keeps historical assistant messages with
  native `tool_calls` and `reasoning_content` and paired `tool` messages (300 / 300); fold keeps none
  (0 / 57). The protocol check (`r37/pairing.py`: every `tool` answers a call of the assistant that opened
  its run, no orphan, no duplicate, no unanswered call) is clean on all 386 native main + subagent bodies of the three native runs (and on the 86 of L3).
- **Reasoning and latency**: per request an order of magnitude lower with native (median 133 vs 3 047,
  p90 1 509 vs 9 875), requests ~6× faster — same direction and size as the 22-item runs of round 36.
- **Progress**: in the same 1200 s, fold made 17–25 main requests and changed 0 files in all three runs;
  native made 80–129 main requests and changed 2–4 files in turn 1, and one native run finished all three
  items. Item 1 is hard: two of three native runs also hit the 1200 s timeout on it, so this is "native
  moves, fold stalls", not "native solves the item". F2P is 0 / 8 for every run.
- **Cost**: native costs more per run (≈ $0.24 vs $0.13) because it makes 4–5× more requests in the same
  wall time (input / cache-hit tokens); per main request native is cheaper ($0.0019 vs $0.0064), and fold's
  output is 95 % reasoning.
- **Repeated calls**: identical tool calls in main responses fold 1 / 0, native 12 / 4 — almost all
  `list_agents` polling of running subagents and re-running the same test command after an edit; no
  repeated edit-plan loop was seen.
- Sample: three pairs, one task, mostly turn 1 — enough to confirm the direction, not a distribution.

## 6. Layer 3 — real context-management path (200k stress main route, historian on the shipped catalog provider)

Route `evo-model-200k-catalog-hist.yml` (`853606914`): main route 200k window / maxTokens 32 768 (MC
execute threshold 65 % = 130 000 is reached inside a few turns), historian on the **shipped opencode-go
catalog provider** (proxy path `/r/hist`, no static `x-opencode-session` header), so a historian request
without the DSH session id fails with HTTP 400 `MissingSessionID` as in 42274076026 (I1) instead of being
masked. Native group only (= new default), historian awaited 60 s at turn end.

Code state of I1: **fixed in code** since `f5bf2f84a` (RED `a889abf10`): the historian's `ctx.llm.stream`
gets `sessionId = agent.session.id`. Whether the real route accepts it is what L3 / L4 check.

### L3 — 42345528229 (slot evo-11, 8 items, turn timeout 1200 s, `on_timeout=stop`, cap $2)

| turns completed / started / planned | stop | main requests (with usage) | reasoning / main request median / p90 / max | request ms median / p90 | cost | HTTP | F2P |
|---|---|---|---|---|---|---|---|
| 0 / 1 / 8 | turn-timeout-turn-1 | 86 (83) | 434 / 3 023 / 4 795 | 6 678 / 27 601 | $0.208 | 83 × 200, 4 × 429 `overloaded` (req 1–4) | 0/8 |

- **Historian: fired, sent nothing.** `turn-01.log:457–…`: 19 `historian trigger … fires=true` lines from
  63 % to 73 % of the window; **0 historian requests** reached the proxy (`analyze.py`: "fired but no
  successful historian request"). The pass outcome is not visible: it goes to `ctx.logger`, which the
  bench does not capture (§7). Most likely cause (**inferred** from code and message counts, not from a
  log line): the eligible range ends at the protected tail, the last **5 meaningful user messages** (core
  `PROTECTED_TAIL_USER_TURNS = 5`, `read-session-chunk.ts:1266`; Magic's own injected messages excluded);
  turn 1 had fewer, so the range was empty and the pass returned `noop` before any LLM call. L4 fits the
  same rule: its first historian request came at the turn 3 → 4 boundary, when the session had enough user
  messages. So L3 does **not** test I1 on the real route; L4 does.
- **Drop path landed in native roles, protocol kept.** Req 85 → 86: prompt 146 274 → 112 928 tokens,
  `[dropped …]` placeholders 2 → 58 (queued `ctx_reduce` drops landing on a ride), cache hit 99.9 % →
  9.1 % for that one request (the expected re-prefill after a rewrite). Body 86: roles intact (81
  assistant / 94 tool / 5 user), every assistant still has its `tool_calls`, 73 / 81 have
  `reasoning_content` — the 8 without had no reasoning block in the session events either (DSH recorded
  them so); protocol check clean on all 86 main bodies; the model kept making normal tool calls after it
  (no 400, no repeated edits). No `compaction/start` event (native backstop 83.6 % not reached).
- Structure: 82 / 85 main bodies after the first carry historical assistant / tool / `tool_calls`, 80 / 85
  `reasoning_content` (the first requests of the turn have no reasoning yet).

### L4 — 42348192506 (slot evo-12, 10 items, turn timeout 2400 s, `on_timeout=continue`, cap $2.5)

Dispatched 14:42 CST, commit `853606914`, native = default (env unset), route
`evo-model-200k-catalog-hist.yml`, historian awaited 60 s at turn end, `on_timeout=continue` as requested.
**No turn timed out**, so the `continue` policy never applied and no turn is flagged
`continued_after_timeout`; the run is still reported under that policy.

| turns completed / started / planned | stop | turn s | cum. files | main requests (with usage) | reasoning / main request median / p90 / max | request ms median | cost | HTTP | F2P / P2P |
|---|---|---|---|---|---|---|---|---|---|
| 4 / 5 / 10 | `turn-failed-rc1-turn-5` — the turn ended on a provider 429 (`RATE_LIMIT`, `prefill_cap_refused`, `turn-05.log:175`) | 1480, 136, 230, 382, 898 | 0, 3, 6, 9, 9 | 164 (151) | 220 / 1 513 / 5 154 | 7 763 | $0.4429 | 154 × 200, 13 × 429 (all main, capacity) | 0/8, 309/317 |

- **Historian on the real catalog route: requests accepted and published (I1 verified on the route).**
  46 `fires=true` lines (turn 1: 2, turn 3: 6, turn 4: 15, turn 5: 23). Two historian requests, both
  **HTTP 200**: n 118 at the turn 3 → 4 boundary (35.7 s, prompt 14 467, output 2 773 of which reasoning
  1 831) and n 134 at the turn 4 → 5 boundary (18.0 s, prompt 14 731 with 14 080 cached, output 1 367).
  The route has no static `x-opencode-session` header and the same upstream answered 400
  `MissingSessionID` in 42274076026; the proxy does not log request headers, so "the header was sent" is
  inferred from the 200, not read. Outputs: one compartment each, `1–3` ("Set up conan 2.0.2→2.0.3
  incremental implementation session") and `4–18` ("Explored Conan download/auth internals …").
- **Publication reached the model.** First main request after publication 1 (n 125): `[dropped …]`
  placeholders 60 → 67 — the covered raw messages, including the first task message `§1§`, whose content
  is in compartment 1–3 — and a `<session-history>` user message with compartment 1–3; prompt 133 296 →
  126 143 (−5 %), cache hit 0 on that request (prefix rewrite). Publication 2 (n 139): placeholders
  67 → 78, a second `<session-history>` with compartments 1–3 and 4–18; prompt 137 856 → 133 563, hit
  74.6 %. Both chunks were small (~14 k tokens of input), so the reduction is small; the only ≥ 15 % prompt
  drop of the run is a drop ride in turn 1 (n 63 → 64, 129 892 → 87 026).
- **After compaction, protocol and execution chain intact.** All 163 main bodies after the first keep
  historical assistant / tool / `tool_calls` / `reasoning_content`; pairing check clean on all 166 main +
  historian bodies; no fold note in any body; the model kept working (turn 4 and 5 edits, files 6 → 9); no
  repeated edit or test plan (the only identical repeated call is one `job_output` poll); one session id
  over five turns (one process per turn), no resume mismatch.
- **Reasoning around the publications** (main requests with usage): before n 118 median 180 / p90 1 407 /
  max 5 109 (116 requests); between the publications 69 / 304 / 520 (14); after n 134 549 / 3 689 / 5 154
  (21, turn 5 at 75–88 % of the window). No fold-like blow-up (max unchanged); the higher median late in
  turn 5 rests on 21 requests and a much fuller context — not attributed.
- **Not reached:** native backstop compaction. In turn 5 the debug line reported pct 84.2–87.9 % above
  `thresholdPct=83.6` on 6 checks with `outcome=none`; the last served prompt was 164 223 tokens (82.1 %).
  Inferred: compaction-basic's own measure was still below its line (the debug pct is the plugin's
  projection) — not verified. The turn then ended on the 429.
- Leak: this run also read the bench output dir, `evo-task/requests.json` and the bench scripts (§7.4).

## 7. Remaining issues

1. **Old fold sessions keep I3.** Sessions Magic processed before this change are frozen `fold` and still
   lose roles / call pairing / reasoning at every step; there is no in-place migration (§3). Workaround: a
   new session.
2. **Historian is (most likely) a no-op until the session has enough user messages (core semantics,
   recorded only; inferred, see §6 L3).** The protected tail is the last 5 meaningful user messages (`PROTECTED_TAIL_USER_TURNS = 5`,
   `packages/plugin/src/hooks/magic-context/read-session-chunk.ts:1266`); with fewer user turns the
   eligible range is empty and the pass returns `noop` ("nothing to compact") without a request. L3
   (42345528229): 19 `fires=true` lines from 63 % to 73 % of the 200k window in turn 1, 0 historian
   requests; the only relief before the turn timeout was a drop ride (§6). In L4 the first request came at
   the turn 3 → 4 boundary. Same rule as OpenCode / Pi — not changed here (core).
3. **The historian's outcome is invisible in the bench.** Pass results (`noop` reasons, failures, publish)
   go to `ctx.logger.info` only; the bench captures stderr (`MAGIC_CONTEXT_DEBUG_HISTORIAN=1` prints the
   trigger line, not the outcome). Judged here from proxy requests (`kind=historian`), prompt boundaries
   and session events instead. Pipeline gap, not fixed.
4. **Bench isolation leak (new, recorded; not fixed).** The agent runs as the runner user with
   `danger-full-access` and reads, by itself, files that are not part of the task:
   - `~/work/_temp/evo-task/requests.json` — **every later changelog item** (the turn-by-turn task order is
     visible from turn 1) — and `instance.json` (upstream `end_version_commit`);
   - the bench output dir `~/work/_temp/bench/<group>-<run>/`: `meta.json` (group, native_roles, plan),
     the proxy's `requests.jsonl`, `resp/*.json`, `bodies/` — i.e. its **own full, uncompacted history**,
     which bypasses whatever context management the group applies, and `turn-NN.log`;
   - the repo checkout `~/work/magic-context/magic-context` (workflows, `evo-bench/prepare.py`,
     `score.py`, `run.sh`).
   - its own DSH session storage `~/work/_temp/e2e/home/sessions/…/session.v4.jsonl.zstd` and
     `storages/session_projcache` (42348194793 native run2 seq 893–925);
   - the repo's committed evidence docs and git history: 42348194793 native run2 spent seq 578–1189
     (≈ 150 tool calls, a large part of its 1200 s turn) grepping `docs/`, `git log --all -p` and
     `git grep $(git rev-list --all)` for F2P test names. **One F2P test id was in a committed doc**
     (`evidence-round36/i-evo-bench.md` lines 114 / 163) — redacted in this round's doc commit, but it stays
     in git history, which the agent can read.
   Seen in 42274076026 fold (`session.jsonl` tool calls seq 254, 276–293, 563–607, 957, 1448) and native
   (seq 338–563, 692, 734, 1597), 42345522531 fold (seq 237), 42345528229 native (seq 284–308, 416, 426
   reads `requests.jsonl`, 472–482, 571–631), 42348194793 native run1 (seq 406–476, 823) and run2 (above), 42348192506 (seq 199–409, 616–684, 1686). Scoring files did not leak from the task dir: the workflow deletes
   `gold.patch`, `test.patch`, `tests.json`, `items.json` before the run (the agent's `find` for them at
   42345528229 seq 631 returned nothing) and re-fetches them only for `score.py` after the run. Impact:
   trajectories can be steered by future items, a run can burn its turn on leak-hunting (native run2 above
   — this biases the §5 progress numbers against that run), and context-management comparisons are biased toward
   groups whose agent happens to re-read the proxy log. Not a simple pipeline fix: the agent, the proxy
   and DSH run as the same user and DSH must read the checkout (plugin), so hiding these paths needs a
   separate unix user or a mount namespace (`bwrap` / `unshare -m` over `_temp/bench`, `_temp/evo-task`,
   the checkout's `.github` / `scripts`), plus feeding items from memory — a bench redesign to be approved
   and validated with its own runs. Until then every evo-bench result carries this caveat.
5. **Task quality not established.** F2P stayed 0–1 / 8 for every group; native completing its turns does
   not mean the task or compaction quality is good.
6. **S9** unchanged (RED `738e3312a` stays `it.failing`; fix option awaits the user).
7. **Provider capacity:** HTTP 429 (`prefill_cap_refused`, `overloaded`) on subagent / first requests in
   several runs; retried by DSH, counted separately, not a plugin error.
8. **Not covered by e2e / soak yet** with the new default (needs user approval).

9. **New (I4, recorded): every re-materialization appends a full `<session-history>` baseline and the
   earlier ones stay.** On DSH the m0 baseline is a durable `magic-context` user message appended to the
   surface (`agent/knowledge-gate.ts`), not a per-call transform as on OpenCode / Pi. In 42348192506 every
   request after publication 2 carries three baselines: the empty one at index 1, one with compartment
   1–3 (index 265, 2 245 chars) and one with 1–3 + 4–18 (index 294, 3 691 chars) — compartment 1–3 twice
   (bodies 139, 161). Small here, but it grows with every publication (each copy repeats all earlier
   compartments). Not fixed this round (product change, not in this segment's brief); whether the fold view
   behaves the same was not checked.
10. **Native backstop not exercised on the real route** (L4 turn 5: debug pct above the 83.6 % line with
    `outcome=none`; inferred measurement difference, §6 L4).
11. **Provider capacity ended L4 early** (turn 5, HTTP 429 → `rc 1`), so the planned 10 items and a third
    publication were not reached; a re-run is needed for a longer post-compaction trajectory.

## 8. Commits

| commit | what | CI |
|---|---|---|
| `81a441e96` | RED I3: default new session must keep roles / pairing / reasoning (6 / 7 fail on `a2c58a49a`) | — |
| `b3310120c` | FIX I3: native roles default for new sessions; fold suites pin the opt-out | 42345305410 ✓ |
| `b876646df` | RED bench: loop appends after timeouts, stop not classified | — |
| `6d8e115c4` | FIX bench: stop after timeout by default, stop classes, turns completed / started / planned | 42345305410 ✓ |
| `853606914` | bench route `evo-model-200k-catalog-hist.yml` (historian on the shipped catalog provider) | 42345513122 ✓ |
| `65321c44d` | docs: round-37 evidence (layer 2, L3), DSH-MAINTENANCE baseline + limitation 32, RELEASE-NOTES, i-evo-bench | 42350864804 ✓ |
| (this commit) | docs: L4 historian real-route result, I4 (limitation 33), I1 row verified | see push CI |
