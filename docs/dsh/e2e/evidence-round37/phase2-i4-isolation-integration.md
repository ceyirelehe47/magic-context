# Round 37 phase 2 — I4, bench isolation, real integration paths, report correction (2026-11-07)

User request 16:53 CST (phase 2 of round 37, base `c6208045c`). Decisions: 17:40 CST isolation permission
change accepted (workspace-write + approval never for all groups under isolation; not comparable with
pre-isolation results); 18:30 CST environment-allowlist boundary accepted (host path NAMES in allowed
`DSH_*` / `XDG_*` values are visible, the directories are hidden); legacy fold sessions' unfinished tool
call (known limitation 1) is **not** fixed — fold compatibility unchanged, documented only.

Nothing here touches core, pi-plugin, upstream DSH, node_modules or the upstream workflows; no e2e / soak,
no tag, no release. S9 (`738e3312a`) stays `it.failing`.

## 1. Product fixes (adapter only)

| item | RED | fix | verification |
|---|---|---|---|
| I4 — a new knowledge baseline supersedes the live one | `edb79efbf` `knowledge-baseline-retire.test.ts` K1–K6, 5 / 6 fail on `c6208045c` (3 live m0) | `6713a5394` (in-place m0 / m1 replace by controlled source + watermark id; resume writes nothing; old duplicates retired; drops held while the live baseline is older than the latest publication) | CI 42358893700: dsh-plugin 717 / 0, K1–K7 ran and passed (log `checks.txt`); real run §3 |
| real `ctx_expand` after a real drop / compaction | `e82c566e2` `ctx-expand-real.test.ts` X1 (real DSH ToolRuntime registry; expand returned `[dropped §6§]`: `readRawMessagesFromAgent` used canonical session id `""`, native scheme never found) | `a07673702` (canonical key passed; native walk follows the in-place rewrite back to the original `tool/result`) | X1 passes; tools 14 / 14 and neighbours green; CI 42364879914 |
| unfinished tool call, cold process | — (acceptance) `bd9835061` `cold-resume.test.ts`: process A (real child process) leaves an open call and exits; process B (other pid) reopens DB + session, appends the result, continues | no code change needed | R1 native: scheme, call id, roles, reasoning / replay intact, same view as one process. R2 legacy fold: frozen fold, open call already folded into a "no result recorded" note — known limitation 1, kept by decision |
| native backstop: what it did | `ea7a861f9` `backstop-outcome.test.ts` B1–B4, 4 / 4 fail (no record; the L4 shape "pct above threshold, outcome=none" reproduced as `pct=51.1 thresholdPct=42 outcome=none`) | `5b19f5212` (`lastPressureCheck` = outcome + predicted {pct, thresholdPct} + measured {tokensBefore, tokensAfter, thresholdTokens, reservedTokens, window}; null outcomes classified `skipped:below-threshold` / `skipped:pruned-below-threshold` / `no-compactable-range` / `no-routed-request` / `unmeasured`, guards `skipped:would-not-shrink` / `deferred:historian-busy`, errors `failed:<msg>`; read-only) | 4 / 4; CI 42364879914; real run §3 |

CI note: push CI 42363839709 (`5b19f5212`) **failed** on the test-file typecheck only (3 type errors in
the two new test files; every test step passed: dsh-plugin 724 / 0, adapter-api 15 / 0, contracts 109 / 0,
ci-check 42 / 0). Fixed by `ab88e100b` (types only, no assertion changed); CI 42364879914 at `ab88e100b`
**success**: dsh-plugin 724 / 0, adapter-api 15 / 0, contracts:dsh 109 / 0, test-file typecheck 0,
ci-check unit 42 / 0, wf-lint 0 FAIL, both contracts jobs (DSH 0.2.2-alpha.3 / rc.1) success. CI 42364665079
(`b498ada3a`) failed on the same typecheck (pre-`ab88e100b`); 42364650596 (`f7d74d31d`, RED) was cancelled
by the next push (its RED evidence is local, below).

## 2. Bench isolation (bench only)

| step | commit | evidence |
|---|---|---|
| RED probe: agent reaches controller, logs, raw session store | `4fc70d8ae` | local probe, plain launch: 9 / 9 locations leak (task, ctrlout, benchout, scratch, sessions, dshhome, magicdata, repo, githist) via bash / read / grep |
| isolation (bwrap namespace for the whole DSH process; DSH workspace-write executor with a runner that hides `E2E_ROOT`; ripgrep + in-process file tools fenced; key held by the proxy) | `1911f8a00` | local probe 0 / 9 |
| RED + fix: probe on its own DSH_HOME / Magic DB | `bf2d6f94b` / `0df97f353` | `test_evo_probe_storage.py` 3 / 3 fail → pass; paid store byte-identical |
| runner: nested bwrap (AppArmor `bwrap-userns-restrict`), permission preset activation | `22606ea31` | smoke 1 42361138232 failed the positives (0 leaks); smoke 2 42362017411 passed: 0 leaks, docker, write, ctx tool, host entries, $0.16 |
| **RED: controller environment reaches the agent** | `f7d74d31d` | smoke 2's agent `env` showed `BENCH_OUT` and run metadata. Local probe at `5b19f5212` with a controller-only canary `EVO_PROBE_CONTROLLER_ENV`: canary in mock requests 45–49 (turn 1 and turn 2). `test_evo_isolation_env.py` (environment computed the way bwrap applies `--clearenv` / `--setenv` / `--unsetenv`): 2 / 4 fail (no `--clearenv`; `BENCH_OUT` reaches DSH) |
| **fix: environment allowlist** | `b498ada3a` (+ `3c71286c8` test hygiene: closed files so the CI "... ok" count sees the 4 tests) | 4 / 4; local probe 0 / 10 leaks incl. env, positives pass; the agent's `env` now lists only DSH / XDG / locale / proxy / mock names |
| runner smoke after the fix | 42364900456 (`ab88e100b`, native, 2 items, cap $1, slot evo-15) | see below |

Allowlist: `PATH`, `LANG`, `LANGUAGE`, `LC_*`, `TERM`, `USER`, `LOGNAME`, `SHELL`, `TZ`, `NO_COLOR`, `DSH_*`,
`XDG_*`, `OPENCODE_SESSION`, `OPENCODE_DB`, `MAGIC_CONTEXT_*`, `MC_*`, `MOCK_LLM_PORT`, `MOCK_LLM_KEY` (probe's
fake key), `DOCKER_HOST`, `NODE_OPTIONS`, `HTTP(S)_PROXY` / `NO_PROXY` (both cases); then `HOME` = a private
dir and `OPENCODE_API_KEY` = a placeholder (the proxy injects the real key). Everything else — `BENCH_*`,
`EVO_*`, `GITHUB_*`, `RUNNER_*`, `ACTIONS_*`, the upstream key, anything exported later — is gone.
**Residual boundary (accepted 18:30 CST):** `DSH_HOME` / `XDG_*` values name host paths; those directories
are not readable by the agent (mount namespace + runner tmpfs + fences, probe-verified).

### Runner probes (one per bench job, before any paid call)

| run | commit | locations | leaks | positives |
|---|---|---|---|---|
| smoke 1 42361138232 | `0df97f353` | 9 | 0 | **fail** (nested bwrap, preset inactive) → `22606ea31`; no paid call |
| smoke 2 42362017411 | `22606ea31` | 9 | 0 | pass |
| smoke 3 42364900456 | `ab88e100b` | 10 (+ env) | 0 | pass |
| pair 42365193718 (4 jobs) | `ab88e100b` | 10 | 0 / 0 / 0 / 0 | pass |
| catalog-hist 42365197639, 42365663370 | `ab88e100b` | 10 | 0, 0 | pass |
| smoke 4 42368007721 | `b36e0d104` | 11 (+ isopatches) | 0 (probe step passed; it stops the job on any leak) | pass (same gate) |

`evo_pytest_ok` is false in the probe's own mock plan on the runner (smoke 2 onwards) while the real bench
runs use `evo-pytest` successfully (8 calls in smoke 3); recorded, not a leak and not a boundary.

### Second gap: the bench patch files (`iso/patches`)

In catalog-hist 42365663370 the agent `cat` the bench's own DSH patch files under the controller scratch
`$SCR/iso/patches` (they are bind-mounted for the DSH host to load, so the fence over `$SCR` did not cover
that sub-path). RED `05bf8205d`: probe canary `isopatches`; local probe leaks through bash, grep and read.
Fix `b36e0d104`: `launch.sh` puts a tmpfs over `iso/patches` in the agent runner and the ripgrep fence and
adds it to the in-process fs fence's hidden roots (the DSH host still loads the patches before the fence is
applied). Local probe at `b36e0d104`: 0 / 11 leaks, positives pass. CI 42367999555
(`b36e0d104`) success: dsh-plugin 724 / 0, adapter-api 15 / 0, contracts:dsh 109 / 0, test-file typecheck 0,
ci-check unit 46 / 0 (now counts the 4 isolation-env tests after `3c71286c8`), wf-lint 0 FAIL, both
contracts jobs success. Runner check: smoke 4 above. Runs before `b36e0d104` (smoke 2–3, pair, catalog-hist)
had this path readable; nothing in their traces shows it read except catalog-hist 42365663370 (bench
config only: DSH patches, no task, score or other group's data).

### Isolation design, four layers

1. **Mount namespace** (bwrap, whole DSH process): task dir, bench output, controller scratch (except what
   the host must load), repo checkout, runner home are not mounted; on the runner the outer bwrap runs with
   the AppArmor-compatible flags of `22606ea31`.
2. **Agent command runner**: agent bash runs through DSH's workspace-write executor (approval never) whose
   runner overlays tmpfs on `E2E_ROOT` (DSH runtime, session store, Magic DB) and, from `b36e0d104`, on
   `iso/patches`.
3. **Tool fences**: ripgrep (grep / glob) and DSH's in-process file tools (read / write / edit) refuse the
   same hidden roots.
4. **Secrets and environment**: the upstream key stays in the proxy (DSH gets a placeholder); the DSH
   process starts from `--clearenv` and receives the allowlist above.

Residual boundary (accepted 18:30 CST): host path **names** in the allowed `DSH_*` / `XDG_*` values are
visible to the agent; the contents are not.

## 3. Real runs (route opencode-go deepseek-v4.1-flash, generation config unchanged, isolated, workspace-write)

Unit of comparison: the **paired run** (one fold job and one native job on the same item, same model,
same config). Requests inside a run are not independent samples. Reasoning tokens are a part of output
tokens and are billed once.

### Paired run 42365193718 (1M route, 2 items planned, turn timeout 1200 s, cap $1)

Two pairs, one item (item 1 of the changelog), only turn 1 reached in every job: all four jobs hit the
1200 s turn-1 timeout. Same observation window (turn 1, 1200 s) for all four.

| pair | group | turns ok / started / planned | stop | files changed | main req (with / w/o usage) | historian / subagent req | 429 | reasoning med / p90 / max (main) | req ms med / p90 | TTFT med s | prompt tok med / max | cache hit (main) | cost USD (all kinds) | F2P / P2P |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | fold | 0 / 1 / 2 | turn-timeout-turn-1 | 0 | 20 (19 / 1) | 0 / 0 | 0 | 4 151 / 7 594 / 37 649 | 41 450 / 73 184 | 1.4 | 32 399 / 42 591 | 92.5 % | 0.1562 | 0/8, 309/317 |
| A | native | 0 / 1 / 2 | turn-timeout-turn-1 | 6 | 91 (90 / 1) | 0 / 0 | 0 | 353 / 2 130 / 4 334 | 6 278 / 25 784 | 1.7 | 76 424 / 140 925 | 97.9 % | 0.1897 | 0/8, 309/317 |
| B | fold | 0 / 1 / 2 | turn-timeout-turn-1 | 0 | 19 (18 / 1) | 0 / 0 | 0 | 3 734 / 13 095 / 15 992 | 41 481 / 125 120 | 1.6 | 31 055 / 41 162 | 92.1 % | 0.1341 | 0/8, 309/317 |
| B | native ⚠ | 0 / 1 / 2 | turn-timeout-turn-1 | 0 | 23 (21 / 2) | 0 / 0 | 2 (overloaded) | 136 / 714 / 1 943 | 50 777 / 73 090 | **38.3** | 31 329 / 50 095 | 91.3 % | 0.0321 | 0/8, 309/317 |

Title requests (1 per job, ≤ $0.0005) are in the cost column. The first main request after normalisation
(nonce, session header, group-run path, container name) is identical in all four jobs (`218bcaffdf313cd6`).
Structure: native bodies carry historical assistant / tool / tool_calls / reasoning_content (A 90 / 90 / 90 / 88
of 90, B 21 / 21 / 21 / 21 of 22); fold 0 of all. Tool-call pairing violations 0, reasoning lost vs the
response 0, active m0 ≤ 1 in every body (no publication happened in these runs).

**Pair B is confounded by the upstream:** its native job got two HTTP 429 "overloaded" at the start and
then a median time-to-first-token of 38 s (the other three jobs ≈ 1.5 s), so it made only 23 requests in
the window. It says nothing about native vs fold. Pair A repeats the pre-isolation direction (native
moves: 91 requests, 6 files; fold stalls: 20 requests, 0 files) under isolation, but it is **one pair on one
item, turn 1 only**; no item was solved (F2P 0 / 8 everywhere; P2P 309 / 317 is the unchanged baseline).

Single native smoke 4 42368007721 (`b36e0d104`, isolation check after the iso/patches fix, not part of the
comparison): probe 0 / 11 leaks, positives pass (docker, write, ctx tool, session resume); bench 0 / 1 / 2
turns, turn-1 timeout (1200 s), 17 main requests, 0 files, TTFT median 41.8 s (slow upstream, as pair B),
backstop 18 lines all skipped, $0.0342, F2P 0 / 8, P2P 309 / 317.

Single native smoke 3 42364900456 (`ab88e100b`, same route, 2 items, no fold partner, not part of the
comparison): 2 / 2 turns done (651 s, 112 s), 4 files, 76 main requests, cache hit 97.6 %, $0.1185,
F2P 0 / 8.

Tables and per-request scans: `phase2-tables/pair-42365193718.md` and `phase2-tables/i4scan-*.md` (generated
by `i3-scripts/pair.py` / `i3-scripts/i4scan.py` from the Actions artifacts `dsh-e2e-evobench-*-<run id>`).

### §I4-real — catalog-hist route (200k window, historian on): I4 **not** verified in a real publication

The 200k catalog-hist route is the one where the historian publishes inside a short run (L4 baseline at
`c6208045c`: max 3 active m0, publications at requests 124 / 138).

| run | result | stop | cost |
|---|---|---|---|
| 42365197639 (attempt 1, evo-17, 6 items, cap $3) | 0 turns | turn 1: 7 / 7 requests HTTP 429 "[overloaded] the server is overloaded" | $0 |
| 42365663370 (attempt 2, evo-18) | turns 3 ok / 4 started / 6 planned | turn 4: 6 × HTTP 429 `prefill_cap_refused`; DSH retried within ≈ 1 s each time, ignoring the "retry after 30 s" hint | $0.149 |

In attempt 2 the peak prompt was 129 232 tokens, below the 130k execute threshold; the historian was
triggered 4 times (predicted pct 63–65) but sent no request, so there were **0 publications**: max active
m0 = 1, no supersession happened. After two 429 stops the round's stop rule applied and no third attempt
was made. **I4 is verified offline only** (K1–K7, CI 42358893700); the real-publication check remains open.

### Native backstop in real runs: only the skipped classes were exercised

From `5b19f5212` every main step logs `native pressure check: … outcome=<class> backstop=<before>-><after>/<threshold>`.
Real coverage: catalog-hist 42365663370 — 84 lines, `skipped:below-threshold` 83, `skipped:no-routed-request` 1
(the first step); the plugin's predicted pct maxed at 64.5 % (threshold 83.6 %) while the measured value
the backstop uses was 129 081 against a threshold of 167 232 tokens. Pair 42365193718 native A — 91 lines,
all skipped (1M window, threshold 900 000). No real run executed, deferred or failed a backstop; those
classes are covered by `backstop-outcome.test.ts` B1–B4 only.

## 4. What is verified and what is not

Verified: I4 supersession, resume and crash window offline (K1–K7, CI); real `ctx_expand` after a real
native drop through the real tool registry (X1); cold-process resume of an unfinished call, native (R1) and
the legacy fold behaviour as documented (R2); backstop outcome classification offline (B1–B4) and the
skipped classes in real runs; isolation by access probe (local RED → fix, then 0 leaks on every runner job;
env and iso/patches gaps found and closed); the same-window wording of the round-37 progress paragraph.

Not verified / limits:
- I4 in a real historian publication (two 429 stops, 0 publications) — **closed by the 2026-11-08 rerun, §6**
  (with a new checkpoint + m0 overlap finding).
- Backstop execute / deferred / failed in a real run — **all three seen in the 2026-11-08 rerun, §6**.
- Sample: **2 pairs, 1 item, turn 1 only**; pair B confounded upstream. No quality claim, no item solved;
  this is not a long-session quality acceptance (green CI, faster calls or finished turns do not replace it).
- e2e / soak not run.
- **Pre-isolation results** (round 36, round 37 phase 1 incl. 42345522531 / 42348194793 / 42348192506) keep
  the contamination caveat of known limitation 32 and ran with `danger-full-access`; isolated results ran
  with workspace-write + approval never. The two sets are **not directly comparable**.

## 5. Commits (all on `dsh-integration`)

`edb79efbf` RED I4 · `6713a5394` I4 fix · `4fc70d8ae` RED probe · `1911f8a00` isolation · `bf2d6f94b` RED probe
storage · `0df97f353` fix · `22606ea31` runner bwrap / preset · `e82c566e2` RED ctx_expand · `a07673702` fix ·
`bd9835061` cold resume · `ea7a861f9` RED backstop · `5b19f5212` backstop outcome · `f7d74d31d` RED env ·
`b498ada3a` env allowlist · `ab88e100b` test types · `3c71286c8` test hygiene · `05bf8205d` RED iso/patches ·
`b36e0d104` iso/patches hidden.

## 6. I4 real-publication rerun (2026-11-08, run 42459290880)

One dispatch, approved by the user and not retried: `dsh-evo-bench.yml` @ `83c5388cd`, native only, runs 1,
**max_items 10**, cost cap $3, `evo-model-200k-catalog-hist.yml` (200k window, historian on), isolate 1,
validate off, on-timeout stop, turn timeout 1200 s, slot evo-19. Model, thinking, effort and maxTokens
unchanged. Scan extracts: [`phase2-tables/i4-rerun-42459290880.md`](phase2-tables/i4-rerun-42459290880.md);
raw bodies, requests and turn logs are in the run artifact `dsh-e2e-evobench-native-run1-42459290880`.

**Run.** Stop class `completed` (`done`): 10 / 10 / 10 turns, 0 turn timeouts, **0 HTTP 429**
(467 / 467 requests HTTP 200), wall time for turns 3318 s. F2P **0/8**, P2P **310/317** (pass rate 95.4 %),
26 files touched. Turn 9 ended `max-tokens`: main request 426 (prompt 179 522) went out with
`max_completion_tokens: 1` and finished `length`; turn 10 ran normally.

| kind | requests | input tok | cache hit | miss | output (reasoning ⊂ output) | USD |
|---|---|---|---|---|---|---|
| main | 419 | 47 662 228 | 45 139 456 | 2 522 772 | 234 306 (163 928) | 1.3088 |
| subagent | 28 (+2 without usage) | 464 741 | 302 976 | 161 765 | 199 678 (180 959) | 0.2900 |
| historian | 17 | 280 425 | 231 552 | 48 873 | 70 983 (47 408) | 0.1012 |
| title | 1 | 382 | 0 | 382 | 12 | 0.0001 |
| **total** | 467 | 48 407 776 | 45 673 984 | 2 733 792 | 504 979 (392 295) | **1.7002** |

Main requests without usage 0; the 2 without usage are subagent streams (requests 37, 151, HTTP 200,
no usage chunk), so their tokens are missing from the totals. Access probe before the paid run:
0 / 11 leak classes, positive controls pass.

**Publications.** 17 historian requests, **all HTTP 200** (`finish=stop`). They reached the main surface as
**14 m0 rewrites** (main requests 93, 114, 138, 152, 179, 241, 271, 298, 319, 389, 396, 411, 429, 432);
historian 174+177, 313+317 and 427+430 each completed before the same next main request.

**I4 — verified in a real run, with one new finding.**
- Active `<session-history>` (m0) per main request: **1 in 416, 0 in 3, never 2** (L4 baseline at
  `c6208045c`: up to 3). `<session-history-since>` (m1) ≤ 1 in every request.
- Around each publication (before / at / after; e.g. 113 → 114 → 115: body 513 → 529 → 529 KB, newest m0
  1–16 → 1–115) the old m0 is replaced in place, not appended. The m0 text changes **only** at the 14
  publications, never with unchanged coverage. Prompt-cache drops that are not publications (175, 305, 413)
  start at an earlier tool message (native drops), not at m0.
- Coverage: the newest m0 never has a gap and its upper bound never decreases (final m0: 18 ranges, 1–761).
- The 3 requests without m0 (178, 318, 431) are the first main request after each native backstop
  compaction. There the DSH `compact-checkpoint` carries the compartments (1–262 / 1–537 / 1–761, at least
  the previous request's coverage, 147 / 428 / 713), and the next request has the m0 again. No history was
  lost, but "exactly one m0" does not hold for these 3 requests.
- **New finding (fixed 2026-11-09 in `e67beb9a0`, see §7):** after a native compaction the checkpoint stays
  on the surface **next to** the m0 in **182 of 419** main requests (178–240 until a native drop replaced it
  at 241; 318–429; 431–467). In all 182 the checkpoint's compartment range is a subset of the m0's, so the
  same summaries are sent twice: 15–40 KB per request, median 29.9 KB. From 389 to 429 the checkpoint
  (1–537) is older than the m0 (1–589 up to 1–713). That is the same "old and new full baseline" shape as I4, through
  the checkpoint instead of a second m0. The offline K1–K7 cases do not cover a compaction checkpoint.
- Request structure: pairing violations **0**; reasoning lost **0** (`i4scan` reports 1, which is a key
  collision on `list_agents {}`: the copy in body 45 is the call from response 44, which had no reasoning).

**Native backstop: execute, defer and fail seen for real.** 449 `native pressure check` lines:
`skipped:below-threshold` 383, `skipped:pruned-below-threshold` 44, `skipped:no-routed-request` 14,
`deferred:historian-busy` 4, **`compacted` 3**, **`failed` 1** (summarize: mini-historian lease busy after
45 s). Predicted pct and measured tokens (threshold 83.6 % = 167 232):

| line | outcome | predicted pct | measured before → after |
|---|---|---|---|
| turn-05:41 | compacted | 93.0 | 186 056 → 56 317 |
| turn-07:44 | compacted | 93.3 | 186 649 → 51 471 |
| turn-09:306 | failed (lease busy 45 s) | 90.0 | 180 068 → 167 579 (still above) |
| turn-09:317 | compacted | 91.2 | 182 468 → 48 977 |
| 4 × deferred (turn-04:41, 05:16, 07:16, 09:295) | deferred:historian-busy | 83.6–89.8 | not measured (`?`) |

The three compactions match the main-prompt drops 176 → 178, 316 → 318 and 429 → 431.

**Limits.** This is one run (n = 1), one SWE-EVO transition, and the first 10 items; there is no fold
counterpart. 0/8 F2P is not a quality claim, so this is not the long-session quality acceptance. These
results ran with isolation and are not comparable with pre-isolation runs.

## 7. Checkpoint + m0 overlap fix and the `max_completion_tokens: 1` investigation (2026-11-09)

User approval 2026-11-09 19:37 CST ("修吧"): fix the native compaction checkpoint / m0 overlap found in §6,
investigate (not fix) `max_completion_tokens: 1`, and one small real check afterwards.

### 7.1 Failing regression first — `f7f3fb4c3`

`packages/dsh-plugin/src/agent/checkpoint-baseline-overlap.test.ts` drives the production pre-step chain in
DSH order — knowledge gate (outermost) → context plane → native pressure backstop (production
`MagicCompactionEngine` over the real compaction-basic transaction, real DSH TokenMeter, real Magic summarize
hook with a stubbed historian LLM) → terminal — on a real DSH `Session` and a file DB, with one
`step/start` + `request/header` per provider request (the 42459290880 log has one header per main request).
Every provider request (`session.deriveMessages()` after each pre-step) is audited: at most one live full
history summary (m0 or checkpoint), the newest one renders every published compartment, the set of visible
compartments never shrinks (first request after a compaction included), every turn visible raw or through a
visible compartment, pairing / reasoning / replay intact.

| case | what | on `e5d8222cd` |
|---|---|---|
| O1 | backstop compaction, then two historian publications | FAIL — 2 live summaries from the first request after the m0 came back |
| O2 | publication, then compaction, then publication | FAIL — same |
| O3 | publish / compact / publish / compact / publish | FAIL — same, both checkpoints |
| O4 | repeated pre-steps + cold restart: no write, no re-injection | FAIL (overlap only) |
| O5 | a user message quoting the checkpoint preamble and `<session-history>` is never retired | FAIL (overlap only) |
| O6 | a checkpoint that still carries an unsummarized tail stays live until a publication covers it | FAIL at the end (still 2 after the covering publication) |
| O7 | legacy fold session keeps its pre-fix behaviour (guard) | pass |

The rig reproduces the real shape: the checkpoint at the head, the m0 re-delivered at the tail by the next
pre-step. No visibility, pairing or reasoning violation appeared in any case — only the duplicate summary.
CI 42612450331 @ `f7f3fb4c3`: 725 pass / **6 fail = O1–O6**.

### 7.2 Fix — `e67beb9a0` (adapter only; core, pi-plugin, upstream DSH untouched)

Why nothing retired the checkpoint: after a compaction the m0 node is shadowed, the next pre-step
re-delivers the m0 at the tail, and the checkpoint is just tagged history to Magic. The publication drop
queue never reaches it — the summarize mini-historian publishes the region *before* compaction-basic writes
the checkpoint (no tag yet), and later chunks start after its range. The one checkpoint retired in §6 (at
241) went only because it carried an unsummarized tail that a later chunk covered.

- `context-plane.ts` `checkpointsSupersededByBaseline()` (native-roles sessions only): live surface nodes that
  are checkpoint stand-ins in the history view (`readDshHistory`: `compact-checkpoint` source + shadowed seqs,
  or a Magic op copy expanding to one — structural, never text), whose history range ends at or before the
  last stored compartment, **and** a live or just-delivered m0 renders the latest publication
  (`knowledge-gate.ts` `knowledgeBaselineRendersLatestPublication`, by source + watermark revision).
- `transcript.ts` `deriveMutationPlan` → `retireSupersededCheckpoints()`: right after tagging, a core pending
  drop is queued on exactly those message tags (`queuePendingDropForUnchangedTag`) and only that batch is
  applied (`applyPendingOperations` with that subset); other queued drops keep waiting for their ride. The
  coordinator writes the usual `mc-op` `[dropped §N§]` copy: the history view still expands it into everything
  the checkpoint shadowed (compartment ordinals unchanged), the durable log keeps the checkpoint, and a later
  compaction re-summarizes through it as before.
- Not changed: when / what the backstop compacts; m0 / m1 injection, in-place supersession and cache split;
  resume / repeated pre-steps (O4: 0 events); legacy fold sessions (O7); persistence of old versions.
- Cache: the retirement lands in the pass that re-delivers or re-materializes the m0, which already rewrites
  the prefix (the checkpoint itself gets its `§N§` tag in that pass anyway).

Verification: O1–O7 green; all 68 `src/agent/*.test.ts` files green one by one (K1–K7 included,
S9 stays `it.failing`); tsc src 0, test files 0. CI 42613187077 @ `e67beb9a0`: **732 / 0**, adapter 15 / 0,
contracts 110 / 0 ×3, test-file typecheck 0.

### 7.3 `max_completion_tokens: 1` at 42459290880 #426 — where it comes from

| step | finding | evidence |
|---|---|---|
| 1 | The value is set by **pi-ai 1.4.0** `clampMaxTokensToContext` (DSH dependency via `@deepseek-ai/dsh-llm-pi-ai` 0.2.1-rc.5): `min(maxTokens, max(1, contextWindow − estimateContextTokens − 4096))`. Route maxTokens 32 768, window 200 000 (`evo-model-200k-catalog-hist.yml`). | source (`dist/api/simple-options.js`); arithmetic matches all 55 main requests sent below 32 768 — strong |
| 2 | **Withdrawn in §7.8** (rc.5 replays assistants without usage, so there is never an anchor; the estimate is always the chars/3.5 count). Original reading: `estimateContextTokens` uses the last assistant's usage only while no earlier message is newer than that response; otherwise it counts the whole request at 3.5 chars/token. #426 needed an estimate ≥ 195 903 for a 179 522-token prompt (×1.09). | source (`dist/utils/estimate.js`) — strong |
| 3 | Between the headers of #424 and #426 (log seq 6216 → 6243) the only surface writes are `compaction/prune` + `tool/result` replaces of nodes **before** the last assistant message, all newer than it (6224–6240). | session log — strong |
| 4 | Those replaces are a **ping-pong**: DSH `compaction-tool-result-pruner` cuts a > 8192-char result (head 4096 + `[... tool result middle pruned ...]` + tail 1024; 603 shrinking replaces in the run) and the **Magic native tool rewrite** writes the tagged original back on the next pre-step (943 growing replaces; the node behind 6240 alternates 10 096 / 5 159 chars every step since seq 4805). | session log + pruner source — strong; the plugin half reproduced offline (P1 below) |

Classification: the clamp itself is pi-ai (DSH dependency, not changed); the trigger that made it bite is a
**plugin defect** — Magic undoing DSH's tool-result pruning (also undoes the pruner's savings and rewrites old
tool nodes every step). Not the bench (the route sets only window / maxTokens) and not DSH core.
RED only, by instruction: `pruner-restore-churn.test.ts` P1 (`06c802d28`) — after the DSH pruner shortened a
tagged result, the next plain pre-step writes it back to full length (as `it`: one restore, 11 183 chars).
Committed as `it.failing` so CI stays green; fixing it flips it. CI 42613963531 @ `06c802d28`: 733 / 0.

### 7.4 Real run 42613997607 — the fixed path was **not reached**

One dispatch only (2026-11-09 20:04 CST, no retry): `dsh-evo-bench.yml` @ `06c802d28` (contains `e67beb9a0`),
groups native, runs 1, max_items 10, cost_cap 3, `evo-model-200k-catalog-hist.yml`, isolate 1, validate false,
on_timeout stop, turn_timeout 1200, slot evo-20. Same task / image / route as 42459290880 (§6). Job
129149272272 green; extracts `phase2-tables/ckpt-fix-42613997607.md`.

| item | 42613997607 (fix) | 42459290880 (§6, before fix) |
|---|---|---|
| turns completed / started / planned | **0 / 1 / 10** — turn 1 hit the 1200 s timeout (rc 124), stop `turn-timeout-turn-1` (on_timeout stop) | 10 / 10 / 10, stop done / completed |
| requests (HTTP) | 98 (97 main + 1 title), all 200; 0 × 429; finish tool_calls 97 / stop 1 | 467, all 200 |
| main requests without usage | 0 | 0 |
| historian requests / publications | **0 / 0** (trigger `fires=true` once, at pct 64 before main #77; no historian request followed — cause not established; it coincided with the model's own `ctx_reduce` drop at step 71, after which pct fell to 54) | 17 / 14 |
| native compactions (backstop) | **0** — 96 × skipped:below-threshold, 1 × skipped:no-routed-request; peak prompt 128 240, max pct 64.1 vs threshold 83.6 % | 3 |
| live full summaries per main request (m0 + checkpoint) | 0 with compartments: the one m0 in each of the 97 requests is the empty baseline (no compartment); checkpoints 0; never 2 | 1 × 237, **2 × 182**; m0-less 3 |
| coverage monotonic | trivially (nothing covered) | yes |
| body bytes (main) | median 376 386, total 32.76 MB (97 req) | same window (first 97): median 337 624, total 30.50 MB; whole run median 459 309, total 190.6 MB |
| prompt tokens (main) | median 95 743, total 8 324 327 | first 97: median 94 258, total 8 384 810; whole run median 113 460 |
| pairing violations / reasoning lost | 0 / 0 | 0 / 0 |
| `max_completion_tokens` < 32 768 | **0** (all 97 main at 32 768) — limitation 35 not triggered: the clamp only bites above ~163k estimated tokens and the prompt peaked at 128k | 55, min 1 (#426) |
| cost | **$0.2290**: main 97 $0.2287, title 1 $0.0003, historian 0, subagent 0 | $1.7002 (main $1.3088 / subagent $0.2900 / historian $0.1012 / title $0.0001) |
| tokens | input 8 324 707 (hit 96.5 %), output 78 438 (reasoning 60 059) | — |
| F2P / P2P | 0 / 8, 309 / 317 (final patch 5 files) | 0 / 8, 310 / 317 |
| isolation probe | 0 / 11 leak classes, positives pass (docker, workspace write, ctx tool, resume; `evo_pytest_ok` false as in every earlier smoke) | 0 / 11 |

The size rows compare the same request window only; this run's bodies are 7–12 % larger at equal index because
the agent took a different path (no publication in the window; 42459290880 published at #93), not because of the
fix — no checkpoint existed, so `retireSupersededCheckpoints` had nothing to select. One cache collapse without a
prompt drop (#66, hit 0.999 → 0) and one reduction boundary (#77 → #78, 128 240 → 106 822, the model's
`ctx_reduce`) are not related to the fix.

**Verdict:** the run shows the fix does no harm on a session without checkpoints (no extra drop, no pairing /
reasoning violation, I4 ≤ 1 m0), but the overlap scenario (native compaction followed by a publication) did not
occur, so the fix is **verified offline only** (O1–O6, CI 42613187077). A real check needs a run that reaches
both a backstop compaction and a later publication; not dispatched (one run authorised). Limitation 35 likewise
not exercised.

### 7.5 Real rerun 42729564554 (turn timeout 2400 s) — the fixed path **was reached**

One dispatch only (user approval 2026-11-10 08:32 CST, no retry): `dsh-evo-bench.yml` @ `d5158e995` (contains
`e67beb9a0`), groups native, runs 1, max_items 10, cost_cap 3, `evo-model-200k-catalog-hist.yml`, isolate 1, validate
false, on_timeout stop, **turn_timeout 2400** (the workflow input has no upper bound; the only cap is the job's
`timeout-minutes: 355`), slot evo-21. Everything else as 42613997607; model, thinking, effort and maxTokens unchanged.
Job 129543892204 green; extracts `phase2-tables/ckpt-fix-42729564554.md`. The longer timeout was not needed in the end:
the longest turn took 712 s (TTFT median 1.3 s, against 41.8 s in the slow-upstream smokes).

| item | 42729564554 (fix) | 42459290880 (§6, before fix) |
|---|---|---|
| turns completed / started / planned | 10 / 10 / 10, stop done / completed; 0 timeouts | 10 / 10 / 10 |
| requests (HTTP) | 346, all 200; 0 × 429 | 467, all 200 |
| main requests without usage | 0 (one subagent request, #169, without usage: client-aborted stream) | 0 |
| native compactions (backstop) | **2** — main 215 (turn 6, pct 86.8, 173 647 → 48 886) and 339 (turn 10, pct 85.8, 171 558 → 48 040) | 3 |
| historian requests / publications | 12 (all 200) / 12 m0 changes (113, 184, 186, 191, 194, 196, 204, 216, **310**, 311, 332, 340) | 17 / 14 |
| compaction → later publication | **yes**: compaction 215 → publications 216 (322–323, mini-historian chunk) and **310** (1–427, covers the checkpoint range) | yes (179, 319, 389, 396, 411 …) |
| checkpoint retired after the m0 covers it | **yes, at 310** — the checkpoint message becomes `[dropped §244§] [dropped §245§] [dropped §246§]` (49 chars; the three tagged parts of that one message) in the same request whose m0 gains 324–427; messages after it unchanged; never live again | no: 318–429 stayed live through 4 publications (only native drop at 241 retired one) |
| live full summaries (m0 + checkpoint) per main request | 0: **0** · 1: **211** · 2: **95** (216–308 = 88, 340–346 = 7) | 1: 237 · 2: 182 |
| duplicate checkpoint bytes in the "2" requests | 1.62 MB (16.2 KB × 88, 28.3 KB × 7) | 5.07 MB (median 29.9 KB) |
| m0 per main request | 1 × 304, 0 × 2 (215, 339 = first request after each compaction; the checkpoint carries the coverage); never 2; m1 ≤ 1 | 1 × 416, 0 × 3 |
| coverage | max never decreases, no gap in the newest m0; first request after compaction 1 covers 1–323 (previous m0 1–321), after compaction 2 covers 1–543 plus `<unsummarized_tail 544–560>` (previous m0 1–447) | same |
| body bytes (main, same window = first 306) | median 433 934, mean 415 329, p90 664 479 | median 477 768, mean 448 804, p90 632 284 |
| prompt tokens (main) | median 107 610, mean 101 529, p90 159 288; peak 168 857 | median 113 460 (419 req) |
| pairing violations / reasoning lost | 0 / 0 | 0 / 0 |
| `max_completion_tokens` < 32 768 (main) | 46, **min 13 241** (no tiny value; limitation 35 not hit this time) | 55, min 1 |
| cost | **$1.2620**: main 306 $1.0494, subagent 26 (+1 no usage) $0.1490, historian 12 $0.0634, title 1 $0.0003 | $1.7002 |
| F2P / P2P | 0 / 8, 310 / 317 | 0 / 8, 310 / 317 |
| isolation probe | 0 / 11 leak classes, positives pass (`evo_pytest_ok` false as before) | 0 / 11 |

**Why 216–308 still carried two summaries (88 requests).** The retirement rule needs the checkpoint's history range to
end at or before the last stored compartment. Checkpoint 1 renders compartments 1–323 only, but compaction 1 also
shadowed the next four messages: the m0 compartment 324–344 published at 310 says "In [324-331] I read `files.py`
imports and edited the download path …", and the raw history kept after the checkpoint at 215 starts with that edit
call (the `sed`/`read` of `files.py` before it is gone from the request). So the range ended at about 327 > 323 and the
checkpoint waited, as designed (O6), for the first publication past it — 310, where it was retired. Ordinal 327 is
inferred from the compartment text and the message order of request 213 (offset 42 between body index and ordinal,
checked on compartment 322–323 = the two subagent messages), not read from the DB. The checkpoint shows no
`<unsummarized_tail>` for those four messages (two tool round trips without user text), so for 89 main requests (215–308) they were
neither in a summary nor raw; they stayed recoverable through the history view. Checkpoint 2 does carry its tail
(544–560, the requirement 9 message); no historian request followed it before the run ended (346), so the second
checkpoint was never retired — expected, not a failure.

**Historian trigger without a request (seen again).** `fires=true` appears on 92 trigger lines but only 12 historian
requests were sent; e.g. turn 5 fires from about main 141 to 177 with no request. Every non-backstop historian request
starts 3–16 s after a new meaningful user message (requirement or subagent inbox message: 110, 178, 183, 185, 190, 193,
199, 301, 322; 214 / 338 are the summarize mini-historian right before each compaction, 309 a second chunk), and no
`lease busy` / `backing off` / `historian failure` line exists. Likely cause (source + timing, no log line states it):
the DSH fire path passes no boundary snapshot, so `runHistorianPassCore` uses `createDefaultBoundarySnapshotForTests`
(boundaryReason `test-legacy`), whose eligible end is the 5th-last meaningful user message
(`PROTECTED_TAIL_USER_TURNS = 5`). Inside a long autonomous turn that end does not move, the pass returns `noop`
("nothing to compact"), and noop results are not logged. Not fixed (not authorised); recorded for the limitation list.

**Verdict.** The fixed path ran for real: a native compaction followed by a publication that covers the checkpoint's
range retired the checkpoint in that same request, with no pairing / reasoning violation, no coverage loss and no extra
drop of other messages. Overlap fell from 182 / 419 to 95 / 306 main requests and from 5.07 to 1.62 MB of duplicate
bytes. The remaining overlap is the designed wait for a checkpoint whose range runs past the last compartment (88
requests here; length depends on when the next publication lands) plus the unretired tail of the run. Not covered: a
second retirement in the same session, legacy fold sessions, a checkpoint retired by a publication that does not
arrive until a later turn, cache effect of the retirement step (310 hit 8 192 / 142 370, but 310 is also a publication
request, so the split is not separable). One run, one task.

### 7.6 Segment 9 (2026-11-10) — coverage gap after compaction (limitation 36) and the silent historian noop (limitation 37)

User instruction 2026-11-10 10:35 CST ("有问题就修"). Adapter only (`packages/dsh-plugin`); core, pi-plugin, upstream DSH,
workflows untouched. **No bench / e2e / soak was dispatched**; everything below is offline (unit rig + the artifacts of
42729564554). S9 (`738e3312a`) and limitation 35 (`06c802d28`) stay `it.failing`, untouched.

| commit | what | CI |
|---|---|---|
| `3e9271ab1` | RED: `compaction-tail-coverage.test.ts` G1 / G1b / G2 fail, G3 passes; `historian-boundary-fire.test.ts` H1 / H2 fail, H3 passes; no-op extraction of the inline historian fire of `agent/index.ts` into `agent/historian-fire.ts` (`createDshHistorianFire`) so the test drives the production wiring | 42746008776 failure as intended: dsh-plugin 735 pass / **5 fail = G1, G1b, G2, H1, H2**; adapter 15 / 0; contracts 110 / 0 ×2; test tsc 0 |
| `f73973a2a` | fix both (below); adds G4; 50 ms settle before the rig closes its DB (a test ending at the compaction request left the deferred drop queue running into the next test) | 42746978609 success: dsh-plugin **741 / 0** (733 + 8 new), adapter 15 / 0, contracts 110 / 0 ×2, test tsc 0, ci-check 46 / 0, wf-lint 0 |

**Gap range — exact, read from the run's own log (the "about 327" of §7.5 was an inference).** `turn-06.log:118`:
`[magic-context] summarize: unsummarized tail 324-327 not carried (budget 300377 chars of region 395183)`. So the
compaction region ended at ordinal **327**, the summarize mini-historian covered **322–323** (its raw output:
`<messages_processed>322-323</messages_processed><unprocessed_from>324</unprocessed_from>`), and **324–327** were
shadowed with no text. They are (body 213, ordinal = index − 42, offset checked on 322–323):

| ordinal | message |
|---|---|
| 324 | assistant, reasoning + `bash` `sed -n '1,30p' conan/tools/files/files.py` ("Read files.py imports"), no text |
| 325 | its result (1 064 chars) |
| 326 | assistant, reasoning + `read` `conan/tools/files/files.py` offset 218 limit 70, no text |
| 327 | its result (4 058 chars) |

328 (the `edit` of files.py) is the first raw message after the checkpoint in request 215. The budget was **not** the
cause (300 377 chars available). Affected: main requests 215–308 (until publication 310 covered 324–427).

**Limitation 36 — cause and fix.** `renderUnsummarizedTail` kept user / assistant TEXT only
(`getIndexableContent`); a tool-only step (reasoning + tool call) and a tool result have none, so they got no line, and a
range made only of them rendered `""` — the hook then carried no block and only printed the debug line above. Fix
(`agent/historian.ts`): every message of the uncovered range gets a line — text as before (an assistant line also names
its tool call), a tool-only step `[n] tool call: <tool> <clipped arguments, 240 chars>`, a result `[n] tool result:
<tool> (<N> chars, output omitted)`, anything else `(no text)`. Over the 8 000-char cap the non-user lines go first, then
user lines are clipped and the oldest dropped, and one note line says `(k of m messages in a-b not listed here for size;
ctx_expand a-b returns every one)`. Plain text tails render byte-identically (round 27b golden unchanged). Request 215
would now carry (shape, constructed from body 213):

```
<unsummarized_tail from="324" to="327">
Messages 324-327 were compacted before the historian summarized them. …
[324] tool call: bash {"command":"cd ~/work/_temp/evo/native-run1/conan && sed -n '1,30p' conan/tools/files/files.py","description":"Read files.py imports"}
[325] tool result: bash (1064 chars, output omitted)
[326] tool call: read {"file_path":"~/work/_temp/evo/native-run1/conan/conan/tools/files/files.py","limit":70,"offset":218}
[327] tool result: read (4058 chars, output omitted)
</unsummarized_tail>
```

Tests (production pre-step chain: knowledge gate → context plane → native backstop = production
`MagicCompactionEngine` over the real compaction-basic transaction, real TokenMeter, real summarize hook; historian stub
that covers through the last message with user-facing text, as the real one did; real DSH Session, file DB — the O1–O7
rig plus tool-only steps in one long turn). Every request is audited: each rig message visible raw, through a visible
compartment, or as a line of a live `<unsummarized_tail>`.
- G1: compaction at the 6th tool step of turn 9 → tail 36–41 had one line (`[36] assistant: reading 9`) and 37–41 (tool
  result + two tool-only round trips) were invisible; now all six have lines, names `read_file` + `files-9-1.py`.
- G1b: the real shape — nothing in the uncovered range has text → before: **no block at all**; now the block is carried.
- G2: same session continued; the checkpoint with its tail waits (O6 rule) and retires at the first covering
  publication; every request audited clean; O1–O7 checks (`auditRequests`, `newestCoverageGaps`) clean.
- G3 (guard, green before and after): a fully covered region renders no tail. G4: a 200-message tool-only tail stays
  ≤ 8 000 chars, keeps the newest lines and counts the rest.
- Unchanged and green: `checkpoint-baseline-overlap.test.ts` O1–O7 (retirement `e67beb9a0`, fold O7),
  `compact-unprocessed-tail.test.ts`, `unsummarized-tail-edge.test.ts`.
- **Residual (not changed):** a region whose own text cannot hold compartments + tail (budget < 300 chars:
  compaction-basic rejects a summary that is not smaller than the region) still carries no tail; that case is pinned by
  an existing test ("compaction stays valid") and now also logged through `ctx.logger`. Not seen in real runs so far.

**Limitation 37 — the silent historian noop: cause confirmed, fixed.**
- Source: the context plane's fire (`agent/index.ts`, now `createDshHistorianFire`) called `runDshHistorian` without a
  `boundarySnapshot`; `runHistorianPassCore` then used core `createDefaultBoundarySnapshotForTests` →
  `getLegacyProtectedTailStartOrdinal`: eligible end = protected-tail start = the 5th-last meaningful user message.
  `runDshHistorian` logged failures only; a `noop` result went to `historian_runs` and nowhere else. Pi resolves the
  boundary with core `resolveProtectedTailBoundary(resolveBoundaryContext(…))` at trigger time
  (`pi-plugin/src/context-handler.ts`, `resolvePiBoundarySnapshot`). The cause sits in the adapter's choice of the core
  test default, not in core, so the fix stays in the adapter.
- Offline reproduction on the production wiring (H1, RED on `3e9271ab1`): six requirement turns, then one long turn
  with 8 tool steps at 70 % of a 40 k window → compartments stop at ordinal 8 (just before `requirement 3`, the 5th-last
  user message) and every later fire summarizes nothing; H2: no log line says so.
- Run data (static correlation only): a replay of `session.jsonl` (`phase2-tables/noop-replay-42729564554.txt`; one line per main pre-step with `fires=true`: 5th-last meaningful user message in the replayed view, rendered coverage end, historian request after it) shows the
  historian requests following steps where a new meaningful user message entered (the 5th-last moves); the replay's
  ordinals do not match Magic's ordinal space, so this is an order check, not a proof.
- Fix: `createDshHistorianFire` gets the trigger's usage (percentage + projected tokens), execute threshold and context
  limit (new optional fields on `ContextPlaneDeps.historian.fire`), and `runDshHistorian` resolves
  `resolveDshProtectedTailBoundary` **inside the pass, after the lease, under the pass's raw-message provider**: core
  `resolveProtectedTailBoundary(resolveBoundaryContext({ mode: "trigger", usage, usageSource: "live",
  providerShapeVersion: "opencode-v1", cacheNamespace: "dsh:<sid>" }))`, re-resolved with the emergency tail scale
  (0.5, 0.25 at ≥ 95 %) when no head is runnable at or above the force band (Pi parity). The snapshot is validated
  against its own context limit; a resolver error falls back to the legacy default with a log line. A noop pass logs
  `[magic-context] historian noop: nothing to compact (eligibleEnd=25 <= offset=25; boundary=size-walk
  protectedTailStart=25 messages=41)` through `ctx.logger` every time and to stderr (`MAGIC_CONTEXT_DEBUG_HISTORIAN=1`)
  once per changed reason per session (a fire repeats every step).
- H1 (fixed): the pass summarizes through `done 6` (ordinal 24) and stops before the live prompt `requirement 7` (25)
  — core's live-prompt floor below the force band; H2: the noop line names the resolved boundary (not the legacy
  default); H3 (guard): below the trigger nothing fires and nothing is logged.
- **Behaviour change to expect:** inside long autonomous turns below the force band the historian now summarizes up to
  (not including) the newest meaningful user message instead of stopping five user messages back. In a run shaped like
  42729564554 that means publications during the long turns (more m0 rewrites → more prefix-cache breaks, earlier
  drops, earlier checkpoint retirement) — **static inference, not measured**. The summarize mini-historian path
  (`eligibleEndOrdinal` override) and the backstop policy are unchanged.

**Not covered.** No real run with either fix (both are offline only); e2e / soak scenarios written around the
5-user-turn protection (e.g. `scripts/e2e/ci-x.sh` ST5 warm-up) were not run against the new boundary; legacy fold
sessions (the boundary fix applies to them too, the tail fix applies to every summarize); the budget < 300 residual
above. Suggested real check (needs separate approval, slot evo-22, cap $3): one `dsh-evo-bench` native run, 10 items,
catalog-hist, isolate 1, turn_timeout 2400, @ `f73973a2a` — look for historian requests inside long turns, the noop
lines, `unsummarized_tail` blocks after each compaction (none dropped), cache-hit change around publications.

### 7.7 Real check evo-22 — run 42805322951 (segment 9 fixes in a real run)

One dispatch only (user approval 2026-11-10 19:08 CST, no retry): `dsh-evo-bench.yml` @ `bf190fd08` (contains
`f73973a2a`), groups native, runs 1, max_items 10, cost_cap 3, `evo-model-200k-catalog-hist.yml`, isolate 1, validate
false, on_timeout stop, turn_timeout 2400, slot evo-22 — the inputs of 42729564554 apart from the slot. Job
129792909501 green; extracts `phase2-tables/evo22-42805322951.md` (script `i3-scripts/evo22scan.py`). Label per row:
**R** = reproduced in this run's artifacts, **S** = static inference, **N** = not covered by this run.

| item | 42805322951 (seg 9) | 42729564554 (§7.5) | 42459290880 (§6) | |
|---|---|---|---|---|
| turns completed / started / planned; stop | 10 / 10 / 10, completed; 0 timeouts (longest turn 1 521 s, turn 5) | 10 / 10 / 10 (longest 712 s) | 10 / 10 / 10 | R |
| requests; 429; main without usage | 555, all 200; 0; 0 (5 subagent requests client-aborted, 1 subagent `length`) | 346; 0; 0 | 467; 0; 0 | R |
| historian requests / `fires=true` lines | **24 / 138** | 12 / 92 | 17 / 194 | R |
| fires without a request and without a reason in the log ("other") | **2** (both on the compaction step, the summarize hook holds the lease) | **53** | **92** | R (classification of the 117 "in-flight" fires as lease-busy: S) |
| `historian noop` lines | 18 (turn 5 ×17, turn 6 ×1), all `eligibleEnd=569 <= offset=569; boundary=size-walk protectedTailStart=569` | none (not logged before the fix) | none | R |
| historian requests inside long turns | turn 5 (1 521 s): 12 requests at 29 … 1 268 s; turn 8: 4; turn 9: 4 | turn 5 (712 s): 110 @ 17 s, then none until 508 s | — | R |
| publications (= m0 rewrites) | **22**: 108, 149, 177, 196, 202, 215, 225, 228, 236, 340, 350, 353, 355, 381, 462, 470, 476, 484, 493, 497, 503, 510 | 12 | 14 | R |
| native compactions | 3: main 235 (turn 5, 89.1 %), 380 (turn 6, 88.3 %), 504 (turn 9, 90.2 %) | 2 | 3 | R |
| order | pubs … 228 → **compaction 235 → 236 retire** → 340–355 → **compaction 380 → 381 retire** → 462–503 → **compaction 504 → 505 retire** → 510 | 215 → wait → 310 retire; 339 never retired | — | R |
| live full summaries per main request (m0 + checkpoint) | **1 × 487** (never 0, never 2); m0 1 × 484, 0 × 3 (235, 380, 504: checkpoint only) | 1 × 211, 2 × 95 | 1 × 237, 2 × 182 | R |
| checkpoint retirements | **3 in one session** (2nd and 3rd included), each in the request right after its compaction | 1 | 1 (by native drop) | R |
| coverage | max never decreases, no gap in the newest m0 (`coverage_gaps_in_latest` {}); m1 ≤ 1 | same | same | R |
| gap after compaction ("neither summary nor raw") | **none** at all three boundaries (content match: 235 and 380 contiguous, 504 overlaps by ≥ 6 messages that are both raw and summarized) | 324–327 for main 215–308 | — | R (ordinal-exact: N — content match, no DB) |
| `<unsummarized_tail>` blocks | **0** in all bodies; no `not carried` log line: every compaction region was already fully covered by compartments | 1 (544–560) | — | the limitation-36 renderer is **N** in a real run |
| cache hit, main (weighted) | 93.6 % | 92.9 % | 94.7 % | R |
| cache hit at publication requests (mean; before → at → after, typical) | 23.0 % (≈ 98–99 % → 7–33 % → 97–99 %) | 11.4 % | 20.1 % | R |
| main miss tokens at publication requests | 2 241 038 of 3 272 727 (68.5 %) | 1 425 808 of 2 210 258 (64.5 %) | 1 359 577 of 2 522 772 (53.9 %) | R |
| body bytes (main) | median 434 879, total 208.27 MB (first 306: 127.98 MB) | median 433 934, 127.09 MB | median 459 309, 190.59 MB (first 306: 137.33) | R |
| prompt tokens (main) | median 105 974, p90 152 592, peak 171 289 | median 107 610, peak 168 857 | median 113 460, peak 179 522 | R |
| pairing violations / reasoning lost vs response | 0 / 0 | 0 / 0 | 0 / 0 | R |
| `max_completion_tokens` < 32 768 (main) | 59, **min 4 041** (main 374, prompt 171 289: pi-ai estimate ≈ 191 863 = window − 4 041 − 4 096, i.e. the chars/3.5 fallback of limitation 35, S); no value < 1 000 | 46, min 13 241 | 55, min 1 | R (cause: S) |
| backstop outcomes | below-threshold 497, pruned-below 15, no-routed 12, deferred:historian-busy 3, compacted 3 | — | — | R |
| cost | **$1.9718**: main 487 $1.6062, subagent 38 $0.1592, historian 24 $0.2060, title $0.0003 | $1.2620 (historian $0.0634) | $1.7002 (historian $0.1012) | R |
| F2P / P2P | 0 / 8, 310 / 317 | same | same | R |
| isolation probe | pass, 0 / 11 leak classes, positives pass (`evo_pytest_ok` false as before) | 0 / 11 | 0 / 11 | R |

**Limitation 37 (historian boundary) — verified in a real run.** The pass now runs inside long autonomous turns
(turn 5: 12 historian requests spread over 1 268 s, against none between 17 s and 508 s in 42729564554), and every
`fires=true` line is accounted for: a request starts, a pass is already running (117, the `lease busy` line goes to
`ctx.logger` only — inferred from the request windows), a `historian noop` line names the reason (18), or the step is
a compaction (2). The 18 noop lines are the expected live-prompt floor: compartments reach 568, the newest
meaningful user message is 569 and everything after it belongs to the live turn below the force band. One side
effect: the stderr noop line was meant to print once per changed reason, but the reason text carries
`messages=N`, so it prints on every fire (18 lines here; harmless, noted). Expected consequences measured: 22
publications against 12 (more m0 rewrites, each a cache break: publication requests average 23 % hit, 68.5 % of main
miss tokens), historian cost $0.2060 against $0.0634, and the checkpoint retired in the very next request after
each compaction because the background pass had already covered the region (the "designed wait" of §7.5 — 88
requests with two summaries — did not occur).

**Limitation 36 (tail coverage) — no gap, renderer not exercised.** All three compactions found the region already
summarized (235: summarize took the lease after 2 s; 380: "range covered by the background pass"), so no
compaction had an uncovered range and no `<unsummarized_tail>` was rendered. The boundaries were checked by content
(the request before vs the first request after): no message is missing from both the summary and the raw view at
any of them. The new tail lines for tool-only steps remain verified offline only (G1–G4).

**What the comparison can and cannot say.** One run per configuration; the trajectories differ before the fix can
matter (turn 1, where no historian fires: 804 s / 75 main requests here vs 418 s / 40 in 42729564554), so the total
cost (+$0.71) and request count (+181 main) are mostly trajectory variance; per main request the cost is
$0.00330 vs $0.00343. The historian's share is attributable to the fix (twice the requests, 3.2× the cost) — an
inference from the mechanism, not a controlled comparison. Not covered: a compaction with an uncovered range
(limitation-36 renderer), legacy fold sessions, the budget < 300 residual, e2e / soak scenarios written around the
5-user-turn protection (`ci-x.sh` ST5 warm-up), the limitation-35 clamp to 1 (it.failing kept; min here 4 041;
root cause corrected and the plugin half fixed in §7.8).

### 7.8 Segment 11 (2026-11-10) — limitation 35: root cause corrected, prune/restore ping-pong fixed (offline)

User instruction 2026-11-10 20:37 CST ("得修"); adapter only (core, pi-plugin, upstream DSH, `node_modules`
untouched); no bench / e2e / soak dispatched. Labels: **R** = reproduced (artifacts or offline test), **S** = static
inference from source, **V** = needs a real run.

**Root cause, corrected.** §7.3 step 2 is withdrawn. `@deepseek-ai/dsh-llm-pi-ai` 0.2.1-rc.5 converts every
replayed assistant with `usage: emptyPiUsage()` and `timestamp: 0`, so pi-ai's `getLastAssistantUsageInfo` never
finds a usage anchor: the estimate is **always** `Σ ceil(chars / 3.5)` over all messages plus the tool schemas, in
every request, with or without replaces (S). Recomputing that from the request bodies reproduces the estimate implied
by `max_completion_tokens` for every clamped main request of both runs within 0.1–0.3 %, and all 865 unclamped ones
are consistent with it (R; `phase2-tables/lim35-estimate-42459290880-42805322951.md`, scripts
`i3-scripts/estscan.py`, `prunesim.py`). On these runs the estimate is 1.07× the real prompt (median; up to 1.17×).
What turned that overshoot into `1` at #426 is the ping-pong: #424 went out with 8 results pruned (prompt 165 020,
clamp 12 988), #426 with the same 8 restored by Magic (prompt 179 522, +14.5k real tokens, estimate 200 015 → 1) (R).
The pruner only runs when DSH's compaction check sees pressure ≥ its threshold, i.e. exactly near the window, and
Magic undid it: 358 / 449 and 492 / 530 main bodies carried an unpruned > 8192-char result, only 47 / 18 a pruned one.

| layer | owner | status |
|---|---|---|
| pruned results restored by the Magic native tool rewrite (trigger; also undoes the pruner's savings and rewrites old tool nodes = prefix churn) | adapter | **fixed** `51d0e90bb` (R offline, V real) |
| no usage anchor in rc.5 replay → chars/3.5 estimate, ~7 % (up to 17 %) above the real prompt near the window | DSH `dsh-llm-pi-ai` + pi-ai | not changed (out of scope); residual below |

**Options compared.**

| | (a) Magic respects the pruner's cut (chosen) | (b) make the prefix prune "stable / cacheable" to keep the usage anchor | (c1) disable / bypass the DSH pruner in native sessions | (c2) Magic pressure model mirrors pi's chars/3.5 estimate |
|---|---|---|---|---|
| fixes the restore / churn | yes | no (there is no anchor to keep in rc.5) | yes, by removing the pruner | no |
| cache prefix | one write per pruned node (the pruner's), then stable | — | stable | earlier compactions / truncations = more breaks |
| ctx_expand / history | history view keeps the original (P3) | — | unchanged | unchanged |
| pairing / reasoning | content-only tool/result replace as before; assistants untouched | — | — | — |
| fold sessions | unchanged (native branch only) | — | profile-wide change | — |
| scope | `transcript.ts` view only | needs DSH change | changes DSH composition (preset) and loses the native relief | behaviour change of thresholds, touches backstop / G / H baselines |

(a) is the smallest correct one: the defect is Magic re-deriving a node from its root and writing over a rewrite
that was not Magic's. (b) rests on the withdrawn anchor theory. (c1) would hide the symptom by removing a DSH
mechanism the user did not ask to remove. (c2) targets the residual, is not a minimal fix and needs its own decision.

**Fix `51d0e90bb` (adapter).** In the native (plan-N) surface view a rewritten `tool/result` node used to be read
back as its root (original) result, so core re-rendered `§N§ original` and `planNativeNodeOps` wrote it over the
pruner's output. Now `prunedToolBase` walks the node's single-source rewrite chain and, when a step is exactly the
pruner's output for its source (`isDshPrunerRewrite`: `head + PRUNE_MARKER + tail` with head a prefix and tail a
suffix of the cited source, non-overlapping — never the marker alone), core sees that text (tag prefix stripped); core
re-tags it with the same `§N§`, the render equals the live node and no op is planned. Later Magic decisions (drop
sentinel, a new tag) still apply on top of it. A Magic pressure truncation that the pruner cut again stays cut (its
replay row no longer matches the base sha and is skipped; the pruned text is below the truncation floor). The history
view (`readDshHistory`: historian, compartments, `ctx_expand`, drop queue numbering) passes `toolRewriteBase: "root"`
and keeps the full original. Fold sessions do not take the native branch and are unchanged. Also in this commit: the
stderr `historian noop` line dedupes on the reason without `messages=N` (`historianNoopDedupeKey`) — evo-22 printed
all 18 identical noops.

**Tests.** RED `a1f1f55e4` (`pruner-restore-churn.test.ts` P2: six 30 000-char results pruned in a session whose
pruned surface estimates 169k tokens; the next pre-step restored them, estimate +42 594 → clamp 1; P3 history keeps
the original, P4 a result that merely contains the marker text is tagged once — guards, pass before and after). CI
RED **42819590979** @ `a1f1f55e4`: dsh-plugin 743 pass / 1 fail = P2 only, adapter 15 / 0, contracts 110 / 0 (rc.5,
alpha.3, rc.1). FIX `51d0e90bb`: P1 `it.failing` → `it` (assertions unchanged), P2 passes (request-point estimate
within 1 % of the pruned surface, clamp > 16 384 at every step), new `seg11-dedupe-prune-id.test.ts` N1–N3 (dedupe)
and I1–I3 (identification: tagged / untagged prunes; tag prefix, sentinel, re-tag are not; marker literal and a cut of
another text are not). Local per-file run 746 / 0 (115 files without `scripts/e2e/cache-bench/proxy.test.ts`), test
tsc 0. CI FIX **42820480391** @ `51d0e90bb` SUCCESS: dsh-plugin 750 / 0 (116 files), adapter 15 / 0, contracts
110 / 0 (rc.5, alpha.3, rc.1), test-file typecheck 0. S9 `it.failing`, O1–O7, G, H, I4 and backstop tests
unchanged and green.

**Residual (not fixed).** With the restore gone, the clamp is set by the rc.5 estimate overshoot alone: a static
what-if on the same bodies (every > 8192-char result pruned) leaves 29 / 55 and 37 / 59 clamped requests below
32 768, lowest 8 343 / 9 742 — far from 1 but still below the route's 32 768 when the real prompt is above ≈ 155k
(S; trajectories after the fix will differ: fewer tokens near the window can also mean fewer native compactions,
V). Closing it needs either DSH to replay assistant usage (or pi's estimator to anchor otherwise; pi 1.5.1's 15 %
margin still falls back to 4096 when the window is nearly full) or a Magic decision to keep `estimate + 4096 +
maxTokens` under the window (option c2) — not done, needs a decision. Not covered offline: the real ordering of
DSH's compaction check vs the Magic pre-step in one step (the tests run prune → pre-step and assert both points),
multi-text-block tool results (identification runs on the joined text; a mismatch falls back to the old behaviour),
the pressure-truncation interplay (S), and DSH 0.2.2 (the pruner's `PRUNE_MARKER` is identical in alpha.3 / rc.1
package sources — S; whether 0.2.2's pi-ai adapter keeps assistant usage was not checked).
