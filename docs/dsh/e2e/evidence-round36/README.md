# Round 36 evidence (2026-11-06) — line A: rc.5 e2e re-test + rc.5 soak

User approval 2026-11-06 09:00 CST: one rc.5 e2e and one rc.5 soak (`segments=2 segment_minutes=120`, the
"soak freshness" recommendation of round 30). No code, assertion, scenario, time budget or workflow was
changed. No tag (dsh.8 stays untagged), no release, no npm, no PR / issue / comment. Both runs are on
`2e96be4c1` (round 35 docs HEAD; last code change `7f3e6d451`). A parallel line B (cache bench, slots
`cache*`) pushed its own commits to the branch during this round; they do not touch the runs below.

## Runs

| run id | kind | ref / SHA | DSH / node | result |
|---|---|---|---|---|
| 42141100109 | dsh-ci dispatch, `e2e=true`, slot `r36` | `2e96be4c1` | 0.2.1-rc.5 (installed = requested) / node 22 | **132 PASS / 2 FAIL / 1 WARN** — R9, R15 FAIL (scenario L, below); E2 WARN (core ranking, as always); checks + contracts alpha.3 / rc.1 success |
| 42141109254 | dsh-soak, `segments=2 segment_minutes=120` (real every 30, default) | `2e96be4c1` | 0.2.1-rc.5 / node 22 | **K1–K9 PASS** (check job success), 4.01 h, 5247 mock + 8 real runs; segment 1 alone K9 FAIL 3/4 (one provider 429), whole soak K9 7/8 PASS |

## e2e 42141100109 — scenario L (lock-a) timed out a third time; K passed

`e2e-rc5-42141100109.txt` has every check row. Everything outside scenario L passed, including scenario K
(U7–U10, the round-35 rerun's edit-window misses: the jsonc edit landed mid-turn this time) and
BS1 / R11–R14.

- **R9** FAIL: lock-a `rc=124 elapsed=400.1s` (the scenario's 400 s run timeout).
- **R15** FAIL: the 6th backstop compaction of lock-a (pressure 49.5 % ≥ 36 %) had waited out the
  15 s e2e lease hold and was inside its summarize call when the timeout killed the process; that
  pressure check's outcome is `error:magic-context: summarize mini-historian failed: llm call failed …
  (aborted; finish=aborted)`. It is the same cut-off as round 35 run 1 (where it was counted by BS1 / R15).

This is the **third** occurrence (42070363765, 42077125011, 42141100109), so by the round rule it is
analysed only. Timelines from `lock-session.jsonl` (`l-lock-a-timelines.txt`, script
`r36-lock-cmp.py`), against the last clean rc.5 run 42050071694:

| | 42050071694 (clean) | 42070363765 (r35) | 42077125011 (r35b) | **42141100109 (r36)** |
|---|---|---|---|---|
| lock-a | rc 0, 185.0 s | rc 124, 404.1 s | rc 124, 400.1 s | rc 124, 400.1 s |
| reads (p17…) | 8, in order | 11 (p17–p19 re-read) | 5, in order | **8, in order, no re-read** |
| model steps (s) | 9 steps, median 4.0, sum 37 | 11, median 9.2, sum 127 | 6, median 14.9, sum 121 | **8, median 15.0, sum 127** |
| backstop compactions, start → end (s) | 6: 14 31 24 21 21 20 (sum 131) | 9: 27–42, last cut (sum 271) | 3: 116 53 73 (sum 242) | **6: 75 34 39 43 54 + 6th cut (sum 245)** |
| lease waits (s) | 5, then 15 ×5 | 15 ×8 | 42, 15, 15 | 22, then 15 ×5 |
| deferrals (37 % ≥ 36 %) | 1 | 1 | 1 | 1 |

The adapter did the same work as in the clean run — one deferral, then one compaction per pressure
check after the 15 s hold (lease wait 15.0 s each, first 22 s while the historian's own pass finished),
the same eight files once each. Only the model got slower: model steps ≈ 3.4× the clean run's sum
(127 s vs 37 s) and the summarize calls inside the compactions ≈ 1.9× (245 s vs 131 s, of which 6 × 15 s
is the fixed e2e hold). 127 + 245 + boot already reaches the 400 s budget before the final step. So:
**model latency against the scenario's fixed time budget, not adapter behaviour** — the round-35 code
(open lock, setup write, migrate-legacy) is not on this path, the open-lock line does not appear, and no
compaction failed for any other reason. Other model-bound steps in the same run were also slow (lock-a
"ready" turn 20.1 s vs 3.9 s in the clean run; `/compact` 43.4 s and 54.3 s).

Not changed (rule): scenario, assertion and the 400 s budget are untouched. Scenario L stays **待验证**:
three consecutive rc.5 runs failed only on its time budget, with three different model behaviours
(re-reads; slow steps; slow steps + slow summarize). A user decision is needed on whether the budget
should scale with the observed model latency or the run be retried at a quieter time.

## soak 42141109254 — 2 × 120 min on rc.5, no leak, no error of the adapter

Inputs confirmed from the job logs of both segments: `installed @deepseek-ai/dsh@0.2.1-rc.5` (the
round-34 check "installed = requested" passed), `node v22.23.4`, checkout `2e96be4c1`. Segment 1
09:02–11:03 CST, segment 2 11:03–13:04 CST, `check` job success. Files: `soak-42141109254-summary.md`
(K1–K9), `soak-42141109254-trend.md` (per-segment / per-hour table and the old run's first 240 min,
script `r36-soak-an.py`), `soak-42141109254-fail-1-2065-real.txt` (the one failed real sample).

| | **42141109254** (r36, 4 h, rc.5 / node 22, round-35 code) | 41775904921 first 240 min (round-26 code, same harness) |
|---|---|---|
| mock runs / rc≠0 | 5247 / **0** | 4418 / 0 |
| real-model samples ok | 7 / 8 (iter 2065: provider `429 RATE_LIMIT … overloaded`, 17 s, no Magic line involved) | 8 / 8 |
| max RSS, median first → last 10 % | 303004 → 320762 KB (**1.06×**), slope +3.9 MB / 1k runs | 303004 → 318528 KB (1.05×), slope +3.7 MB / 1k runs |
| per segment | seg 1 1.05× (+4.2 MB / 1k), seg 2 1.03× (+3.0 MB / 1k) | — |
| wall time median first → last 10 % | 2.52 → 2.69 s (1.07×; the step is between segments, 2.48→2.50 in seg 1, 2.68→2.69 in seg 2; each segment is a fresh runner, so likely runner speed, not drift) | 3.06 → 3.05 s |
| DB size / growth per run | 1.1 → 75.3 MB, 14178 B/run (1st half 14097, 2nd 14177: not accelerating) | 1.1 → 63.5 MB, 14171 B/run |
| WAL max | 0 | 0 |
| leftover dsh processes (K2) | max 0 | max 0 |
| residue rows: live lease / in-progress / outbox / open lock (K3) | **0** of 5255 (open_lock max 0, live_leases max 0) | 0 |
| lock timeouts | 0 (no `rc=124`, no open-lock wait line in either segment log) | 0 |
| compactions (compartments Δ) / historian runs / failed | 2916 / 26936 / **0** | 2334 / 22671 / 0 |
| over-window mock requests (K8) | 0 | 0 |
| sessions | 133 | 112 |

File handles: the soak harness records no fd / handle count (CSV columns are rc, elapsed, RSS, DB / WAL,
lock / lease / outbox residue, leftover processes, counters); every mock run is a fresh `dsh` process,
so a handle leak inside one process cannot accumulate across runs. The proxies — leftover processes,
open-lock residue, live leases — are all 0. Not measured directly (待验证 if wanted).

Observation, not a defect: `pending_ops` (Magic ops queued but not yet applied) is > 0 in 267 of 5255
rows (max 20, typical 4–9) and 0 at the end; it does not trend upward. The old soak (round-26 code)
always read 0. Inferred (not traced): this is the deferred-drop queue that line B describes (`cache-bench.md`: drops land one
per pre-step); the soak shows it drains. Not investigated further here.

Conclusion: **no leak and no adapter error** over 4 h on rc.5 — RSS ratio, RSS slope and DB growth per
run match the 12 h soak of round 26 to within noise (RSS grows with the DB each process opens, 14 KB of
new Magic rows per run, at the same rate as before), 0 historian failures, 0 residue, 0 lock timeouts.
The single failed real sample is an upstream provider overload (429), which K9's 80 % threshold
absorbs (7 / 8).

## Line B (cache bench) — see its own documents

`cache-bench.md`, `cache-bench-results.md` and `cache-bench-requests.jsonl` in this directory are line B's
(run 42142782133, analysis only, no product code changed); line A did not change them.

## Evidence level

- e2e 42141100109 and soak 42141109254: **real CI runs** (real DSH 0.2.1-rc.5 host, node 22, real model
  for e2e and for the soak's real samples; installed versions and SHA read back from the job logs).
- Scenario L cause ("model latency against the fixed budget, not adapter behaviour"): **inferred from
  log timelines** of four runs (`lock-session.jsonl`); not reproduced with controlled model latency.
- Soak "no leak": **measured trend** over 4 h / 5247 runs, compared with the old 12 h soak's first
  240 min; file-handle counts are not measured (proxies only).

## dsh.8 condition (e2e all PASS + soak without leak or error)

**Not met.** The soak half is met (K1–K9 PASS, no leak, no adapter error). The e2e half is not:
42141100109 is 132 / 2 / 1 with R9 and R15 FAIL (scenario L, lock-a 400 s timeout, third consecutive
rc.5 occurrence). The analysis points to model latency against a fixed time budget rather than an
adapter defect, but no rc.5 e2e has passed scenario L since 42050071694, and no assertion or budget was
changed to make it pass. dsh.8 stays untagged; tagging needs a user decision on scenario L
(see DSH-MAINTENANCE known limitation 29).

## Line D — why the plugin group's output tokens are ~6× the baseline (analysis only)

[d-output-tokens.md](d-output-tokens.md): per-step output / reasoning data (9 plugin + 6 baseline existing runs),
request-body diff, and proxy-level ablations (diagnosis-only `BENCH_ABLATE` switches in the bench proxy;
runs 42172021344, 42172024788, 42172028320, 42173981151, 42173985186). Cause reproduced: the adapter's
surface fold (known limitation 1) turns the live turn's tool arcs into `user` text, and the model
re-derives its progress every step (~295 vs ~7 reasoning tokens/step). Static injections (MC system
section, ctx_* tools, §N§ tags) show no measurable effect. Per-step numbers:
[d-output-tokens-steps.jsonl](d-output-tokens-steps.jsonl); scripts in [d-scripts/](d-scripts/).
No product code changed; fix options A / A′ await a user decision.

## Line G — native roles (plan N) behind an experimental switch, default off

[g-native-roles.md](g-native-roles.md): commits (RED `16e6fe2e8` → `8e095e315`, N11 `73cf540e6` → `5d19db4aa`),
the env-on preview-tags observation (expected: tool results are tagged on the surface, the preview only
rewrites user input; N12 pin), and the two native cache-bench rounds 42214443375 / 42215740858 (94.3 %, 0
divergences, $0.0274 / run vs $0.041 fold; reasoning 9–18 vs 290–325 tokens / step). Open: the ctx_reduce
nudge never fires in native sessions ([g-nudge-diag.txt](g-nudge-diag.txt); fixed in line H). Round-2 summary
[g-bench-42215740858-summary.md](g-bench-42215740858-summary.md), counts [g-bench-stats.txt](g-bench-stats.txt),
scripts in [g-scripts/](g-scripts/).

## Line H — ctx_reduce nudge in native sessions (limitation 31, fixed)

[h-native-nudge.md](h-native-nudge.md): root cause (core's walk keys a `{type:"tool"}` part to the message it
sits in; native output sat on the tool-result message, the tag on the call), fix in `agent/nudge.ts`
(`pairedNativeToolPart`: native call / output → `tool_use` / `tool_result`, Pi arc pairing), commits
`efa9c4aab` / `3f1d66f68` / `b65acb3f9`, RED → GREEN [h-red-green.txt](h-red-green.txt), diagnostic re-run
[h-nudge-diag-after.txt](h-nudge-diag-after.txt), push CI 42221751881 (692 / 15 / 109 ×3 / 33), cache-bench
42221195453 (94.5 %, 0 divergences, reminder at body 33–34, ctx_reduce 1 / 5 / 1;
[h-bench-42221195453-summary.md](h-bench-42221195453-summary.md), [h-bench-stats.txt](h-bench-stats.txt),
[h-scripts/](h-scripts/)).
