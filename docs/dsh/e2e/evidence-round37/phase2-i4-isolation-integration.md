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
- I4 in a real historian publication (two 429 stops, 0 publications).
- Backstop execute / deferred / failed in a real run.
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
