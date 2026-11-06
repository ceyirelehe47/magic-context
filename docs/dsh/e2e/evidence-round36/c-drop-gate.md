# Round 36 line C — queued drops land only on a core reclaim ride

User-approved 2026-11-06 12:07 CST (product code change). Core untouched; adapter only
(`packages/dsh-plugin`). Follows line B's finding 3 (`cache-bench.md`): the adapter applied
`pending_ops` on every pre-step, so one ctx_reduce became one prefix-cache break per step
(run 42142782133: 45 + 30 breaks, all newly materialized `[dropped §N§]`).

| commit | what |
|---|---|
| `d8c571377` | RED — `src/agent/drop-gate-context-plane.test.ts`, 7 tests through the real pre-step body (`runContextPlaneStep`) on a real DSH `Session`; **7 / 7 FAIL** on `22558298c` |
| `8cc2c4220` | FIX — `src/agent/drop-gate.ts` (new), `transcript.ts` gate around `applyPendingOperations`, `context-plane.ts` ride input, `index.ts` wiring (`cacheTtl`, `now`); unit tests `drop-gate.test.ts` (4); 5 old tests given a ride (below) |
| (this commit) | docs — this file, `c-drop-gate-red.txt`, `c-drop-gate-bench-steps.jsonl`, `c-drop-gate-post.py`; `DSH-MAINTENANCE.md` known limitation 30; `RELEASE-NOTES.md` dsh.8 |

## What core does (read, not changed)

* OpenCode `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts`:
  `rideSignals = { servedShapeRepair, executeReclaim, subagentExecute, hardFold (signed-prefix rewrite /
  m[0] fold busting the served prefix / first render / idle-expiry rebuild), force (≥ force band, and
  < 95 % only on a provider reading with no latched emergency sample), explicitFlush (pending
  materialization of origin user_flush), publishedHistory (m[1] refreshed / legacy published head
  changed) }`; `executeReclaim = originateExecuteReclaim(…)` (primary execute below the force band, no
  other ride, no summary expected, reclaimable ≥ 2 % of the usable window or held 3 passes);
  `publishedWorkDrainAllowed = reclaimRidePermitted(rideSignals, {signedThinkingHold, firstRender,
  idleExpiry, emergency})`; `shouldApplyPendingOps = !compactionOff && publishedWorkDrainAllowed`;
  `applyPendingOperations(…, new Set([...(pct ≥ 95 ? [] : protectedTagIds), ...protectedToolTags]))`.
* Pi `packages/pi-plugin/src/context-handler.ts`: the same shape (`hardFold` also covers a system-prompt
  change), `shouldApplyPendingOps = publishedWorkDrainAllowed`, same ≥ 95 % rule.
* `cache-busting-signals.ts`: `hasReclaimRide`, `prefixMutationPermitted`, `reclaimRidePermitted`,
  `reclaimRideLabel`; `execute-reclaim.ts`: `originateExecuteReclaim`, `estimateExecuteReclaimTokens`,
  `readExecuteReclaimState`.

## How the DSH adapter now decides (reuses those core functions)

`agent/drop-gate.ts` only gathers DSH observations into core's shapes; the decision is
`reclaimRidePermitted(signals, gate)`; executeReclaim is `originateExecuteReclaim` +
`estimateExecuteReclaimTokens`; the log label is `reclaimRideLabel`.

| core signal | DSH observation | note |
|---|---|---|
| hardFold | (a) a served surface node replaced since the last served request — durable session log: boundary = latest `request/header` (every surface node with a lower seq was in that prompt), a replace event after it whose `surfaceOp.startSeq` is below it; Magic's own `mc-op:` plan copies excluded; (b) nothing served yet (first render); (c) cache-TTL idle expiry (`now − last completed assistant/message > resolveCacheTtl(cache_ttl)`, core default 5m; core folds idle expiry into hardFold too) | (a) covers DSH compaction checkpoints (MC summarize hook / 90 % backstop / `/compact`), a system-prompt rewrite and any non-Magic replace. Without request headers (test doubles) the boundary falls back to the latest appended assistant/message |
| publishedHistory | a historian publication (`compartments.created_at` / `dsh_context_compaction_marker.published_at`) at or after the last served request | the historian queues its compartment drops as pending ops (`queueDropsForCompartmentalizedMessages`); core lands them on the m[1]-refresh ride |
| force | context % ≥ force band (`escalationBands`, 85 % at execute 65 %), with core's guard: below 95 % only on a provider-anchored reading (token-meter projection or provider usage) and `getEmergencyInputSample == 0` | context % = the historian trigger's reading (token-meter projection / window) |
| executeReclaim | core `originateExecuteReclaim` on [execute, force), `summaryCanCome` = `compartmentInProgress` / unapplied DSH compaction marker / core floor mark; `reclaimableTokens` = core `estimateExecuteReclaimTokens` over the recording targets | only originated when drops are queued (it writes core's held-pass counter) |
| explicitFlush | **not needed as a ride**: DSH `/ctx-flush` runs core `executeFlush`, which flips the tags to `dropped` directly; `applyFlushedStatuses` replays them on the next pass with no gate | same effect, immediate |
| subagentExecute | **no counterpart** — child sessions never enter the Magic context plane (`isMagicChildSession`) | always false |
| servedShapeRepair | **no counterpart** (OpenCode served-shape replay) | always false |
| gate.signedThinkingHold | **no counterpart** — DeepSeek reasoning is not signature-bound; `prefixMutationPermitted` is therefore true | false |

* ≥ 95 %: no protected tags are passed to `applyPendingOperations` (core parity); below it the
  token-floor window still protects the tail. DSH has no `protected_tools` set (core's
  `protectedToolTags`).
* Unknown → defer: a ride input that cannot be built (any read error) means "no ride"; queued drops wait
  for the next ride, landed drops keep replaying (`applyFlushedStatuses` runs on every pass, unchanged).
* Logs: `pending ops WILL APPLY — reason=ride=<core label>, pendingOps=N, context=…` on a ride;
  `pending ops deferred — ride=none, …` once per queue depth per process.
* When do drops now land in practice: historian publication (≈ 63 % proactive trigger → next pass),
  a DSH compaction / `/compact`, a > cache_ttl idle gap, the force band (85 %), executeReclaim
  (≥ 65 % with no summary coming), `/ctx-flush`. None of these is "never": the force band is always
  reached before DSH's 90 % native backstop, so the "may be deferred, never permanently" requirement holds.

## Tests

RED (`d8c571377`, file `drop-gate-context-plane.test.ts`, output in `c-drop-gate-red.txt`): 7 / 7 FAIL on
`22558298c` —
1. no ride: queued drops stay queued and every node of the previous request is byte-identical over 3
   pre-steps with new turns arriving;
2. a. historian publication lands all eligible drops in one pass (protected ones stay queued below 95 %);
   b. force band lands them together, the next pass without a ride lands nothing new;
   c. cache-TTL idle expiry and a rewritten served prefix are rides; `/ctx-flush` lands without one;
3. ≥ 95 % lifts tail protection, 90 % (force, < 95) keeps it;
4. replay invariant: landed drops replay on later passes and in a fresh process, never revert, a newly
   queued drop still waits;
5. execute band: executeReclaim rides only when no historian summary can come.

In the FIX commit the RED file changed in one scenario only (2c): 8 turns instead of 7 (it needs 5
unprotected tags; with 7 the fifth was `undefined`) and one served request added after the
rewritten-prefix ride (that ride lasts until the next request is served). The adjusted file was re-run
against the old code: still **7 / 7 FAIL** (`c-drop-gate-red.txt`, second block). No assertion removed or
loosened.

Old tests that relied on "every pre-step applies" (assertions unchanged; each drop step now gets a core
ride — the cache-TTL idle expiry via the injectable clock / an explicit ride input):
* `transcript.test.ts` "derives a drop op from a queued pending operation" (direct `deriveMutationPlan`,
  now with a `dropRide` input);
* `drop-after-tag.test.ts` "a queued drop … replaces the surface copy" and "round 17: two dropped tool
  arcs …";
* `identity-regression.test.ts` "drop targets the exact number";
* `pressure-truncation.test.ts` "a ctx_reduce drop of a truncated result lands once it leaves the
  protection window" (the first half — the drop stays queued while protected — passes unchanged; the
  landing step gets the idle ride).

Counts (push CI 42163961834 @ `8cc2c4220`, green): `dsh-plugin` **673** (660 + 7 RED + 4 unit + 2
generated core-import-surface contract cases for the two newly imported core modules
`cache-busting-signals` / `execute-reclaim`), `adapter-api` **15**, `contracts:dsh` **107** on rc.5 /
alpha.3 / rc.1 (105 + those 2), ci-check unit **33**, typecheck 0.


## Real-model evidence (rc.5)

### cache-bench (`dsh-cache-bench.yml`, DeepSeek `deepseek-v4.1-flash` via OpenCode Go, same task as line B)

| run | ref | what |
|---|---|---|
| [42142782133](https://github.com/ceyirelehe47/magic-context/actions/runs/42142782133) | `5fced3818` (before the fix) | line B, 3 + 3 (`cache-bench.md`) |
| [42164389768](https://github.com/ceyirelehe47/magic-context/actions/runs/42164389768) | `8cc2c4220` (fix) | 3 + 3, slot `cache-2` |
| [42166613496](https://github.com/ceyirelehe47/magic-context/actions/runs/42166613496) | `46370ac0f` (fix + line A docs only; same product code) | plugin × 3, slot `cache-2` — rerun because 42164389768 had no ctx_reduce before the cutoff |

Hit rate = Σhit / Σ(hit + miss) of the main-agent steps before the cutoff (first historian request or first
`compaction/start`), cost at DeepSeek peak prices (analyze.py). Per-run numbers from `analyze.py` run_stats;
"drop divergence" = a step whose first differing message gained `[dropped §N§]` placeholders.

| | plugin runs with ctx_reduce before the cutoff | hit rate | steps to cutoff | drop divergences | cost / run | cost / step |
|---|---|---|---|---|---|---|
| before fix, 42142782133 run1 | 11 calls | 87.1 % | 143 | 45 | $0.236 | $0.00165 |
| before fix, 42142782133 run2 | 7 calls | 88.2 % | 113 | 30 | $0.196 | $0.00173 |
| before fix, 42142782133 run3 | none | 94.7 % | 36 | 0 | $0.042 | $0.00118 |
| **fix, 42166613496 run2** | **2 calls** (steps 22 and 32; 17 + 8 tags) | **94.7 %** | 36 | **0** | **$0.041** | $0.00113 |
| fix, 42166613496 run1 / run3 | none (1 / 2 calls after the cutoff) | 93.7 % / 93.9 % | 41 / 34 | 0 | $0.041 / $0.038 | — |
| fix, 42164389768 run1–3 | none (2 / 2 / 1 calls after the cutoff) | 94.5 / 94.3 / 94.3 % | 33 / 38 / 32 | 0 | $0.042 / $0.039 / $0.042 | — |

Group means with the fix: 42164389768 plugin **94.4 % (94.3–94.5)**, $0.041 / run; 42166613496 plugin
**94.1 % (93.7–94.7)**, $0.040 / run; 0 divergences of any kind in 6 runs (108 + 100 append-only steps).
Before the fix the group was 90.0 % (87.1–94.7), $0.158 / run, 75 drop divergences. Baseline (no plugin)
in 42164389768: 85.9 % (83.3–87.5), 0 divergences — unchanged in kind from line B (87.6 %). The cost / run
before the fix is not like-for-like (landed drops shrank the prompt, so run1 / run2 took 143 / 113 steps to
reach the historian); per step it was $0.00165–0.00173 vs $0.00113 with the fix, and line B's
excess-miss estimate for the drop divergences was $0.111 + $0.080 per run, now $0.

**Pre-cutoff drop sample (42166613496 run2).** After each of the two ctx_reduce calls every later step up to
the cutoff and beyond is append-only: 19 and 9 waiting steps, hit rate on those steps 96.8 % / 96.9 %
(cached = the whole previous prompt rounded to DeepSeek's 128-token block), placeholder count 0. No ride
happened before the bench stopped (step 41, 71 % of the 100k route): the historian had started at step 37
(`compartmentInProgress`, so no executeReclaim on [65 %, 85 %)), its publication came after the stop, and
the force band (85 %) was not reached. So this run shows the "wait without breaking the prefix" half; the
"land in one pass on the ride" half is shown after the cutoff:

| run | ctx_reduce (step) | waiting steps (all append-only) | landed in one step | that step | later steps |
|---|---|---|---|---|---|
| 42164389768 run1 | step 35, 29 tags | 3 (hit 97.0 %) | **33** placeholders at step 39 | historian publication pass (prompt 69.3k → 20.1k, msg[3] changed; hit 9 984 / miss 10 087) | 5 steps append-only, no new placeholder |
| 42164389768 run2 | step 40, 29 tags | 0 | **25** at step 41 | historian publication pass (63.5k → 19.7k, msg[7]) | 3 append-only, none new |
| 42166613496 run1 | between step 42 and 43, 23 tags | 0 | **23** at step 43 (same pass) | historian publication pass (62.7k → 19.3k, msg[7]) | 4 append-only, none new |
| 42166613496 run3 | steps 36 and 41 | 5 + 0 (hit 97.9 %) | not reached before the bench stopped (historian request after step 41) | — | — |

The landing pass is the historian's own m[1] rewrite (`publishedHistory` ride), which breaks the prefix
from the session-history message on anyway, so the drops add no extra miss of their own there; that is
core's design (drops ride on a reset that is happening regardless). Placeholder counts differ from
the stamped tag counts because tags still inside the protection window stay queued (below 95 %) and one
tool arc can carry more than one placeholder. Step-level data:
`c-drop-gate-bench-steps.jsonl` (both runs, every main request and historian request), produced by
`c-drop-gate-post.py <artifact-root>`. The plugin's adapter debug log is not in the bench artifact, so the
ride label (`ride=published-history`) is inferred from the timing and the prompt shrink, not read from a log line.

### e2e [42164393979](https://github.com/ceyirelehe47/magic-context/actions/runs/42164393979) (rc.5, slot `r36c`, `8cc2c4220`)

**132 PASS / 2 FAIL / 1 WARN** (checks + contracts alpha.3 / rc.1 success). Against line A's
42141100109 @ `2e96be4c1` (132 / 2 / 1: R9 / R15 FAIL = scenario L lock-a 400 s timeout, E2 WARN):

* **R9 / R15 PASS** this time (lock-a finished; 7 historian holds, 1 deferral at 37.2 % ≥ 36 %, 7
  compactions, no error). Scenario L's time budget stays known limitation 29 — one clean run does not close it.
* **E2 WARN** — core ranking with real embeddings, as in every run.
* **New FAIL R0** (scenario P `pold-01` rc=1 after 31 s): the very first model request got
  `429 server_error "Upstream request failed: [overloaded] the server is overloaded"` from the provider
  (`turn_end` reason RATE_LIMIT, pressure 0 %, no Magic action had happened yet).
* **New FAIL R7** (scenario P, `pold-03` / `pold-04`): two native compactions failed inside the MC summarize
  hook with the same provider `429 … overloaded` on the mini-historian LLM call (pressure 43.7 % / 43.8 %).
* Both are the provider overload, not the gate: the gate only decides when `applyPendingOperations` runs;
  the summarize hook, the historian LLM client and the first request do not go through it, and neither
  failing check involves a drop. Drop / flush / fold checks all PASS: C9 (no repeated `[dropped §N§]`),
  U4 (DB tags active 25 / dropped 11, nothing pending), R10, X5, I1 (no fold imitation, limitation 21), I2.
  Analysed only, nothing changed. Rows: run log (`dsh-e2e` artifact), `summary.md` there.

## Evidence level

* Gate logic: RED → GREEN unit / integration tests on a real DSH `Session` (strong).
* Real model, wait-without-breaking: 1 pre-cutoff run with 2 ctx_reduce calls + 5 post-cutoff episodes,
  every waiting step append-only, 0 drop divergences in 6 runs vs 75 in 2 runs before (medium: n is small,
  the model calls ctx_reduce on its own and rarely before the historian).
* Real model, one-shot landing: 3 post-cutoff episodes, all on a historian publication; the force band,
  executeReclaim and cache-TTL rides are covered by tests only (not observed on a real model).
