# Round 36 line I — CompactionBench-style same-task bench (evo bench)

User approval: 2026-11-06 21:45 CST ("试试吧"). Bench-only: new files
`.github/workflows/dsh-evo-bench.yml` and `packages/dsh-plugin/scripts/e2e/evo-bench/`
(`prepare.py`, `run.sh`, `score.py`, `analyze.py`, `evo-model.yml`, `evo-model-200k-stress.yml`,
`bench-evo.yml`). Core, pi-plugin, product defaults, peer ranges and upstream workflows untouched. The
cache-bench recording proxy `proxy.mjs` is reused (record only, `BENCH_ABLATE` empty); after the user's
02:18 CST authorisation (non-core fixes, RED first, CI green) it aborts the upstream request when its
client goes away and keeps non-2xx bodies (§8). Plugin code changed only for S6 (log text); S9 is a RED
test awaiting the user's choice of fix (§7).

## 1. Method

Reference: Microsoft CompactionBench preprint (Liu et al., 2026-10,
<https://www.microsoft.com/en-us/research/wp-content/uploads/2026/10/CompactionBench_preprint.pdf>), §3.2
and appendix A. Task source: SWE-EVO (arXiv 2512.18470), dataset `Fsoft-AIC/SWE-EVO`
(HF datasets-server rows API).

| step | CompactionBench (appendix A) | this bench |
|---|---|---|
| task | 8 release transitions, 315 items | 1 transition: `conan-io__conan_2.0.2_2.0.3` (22 items, paper's first row) |
| requests | changelog split into bullet-level items (multi-line kept); items with a PR number in ascending PR order, the rest after; request 1 states repository + release goal | same (`prepare.py`); request 1 also names the test command `evo-pytest`; **PR / docs links removed** from the item text |
| session | one persistent OpenClaude session per task, adapter feeds the next item, source checkpoint after every request | one DSH session per run, every item a new `dsh --session-id` headless turn (fresh process per turn, as in cache-bench / ci-e2e); cumulative source diff saved after every turn (`patches/turn-NN.patch`, snapshot git dir outside the workspace) |
| anti-shortcut | images rebuilt with git history and release refs stripped | `.git` removed from the agent's copy of `/testbed` (history, tags and packed future objects); **plus** DSH web tools off (`bench-evo.yml`), code hosts / package indexes blocked in `/etc/hosts` for the run, the agent's test container `--network none` |
| scoring | final cumulative source patch, agent test changes excluded, repository tests, test-weighted accuracy | same: `score.py` applies the final source patch minus test files (`tests?/`, `test_*.py`, `*_test.py`, `conftest.py`) and the release `test_patch` in a fresh container of the instance image at `base_commit`, runs the instance test command (`pytest -rA`) on the files holding the FAIL_TO_PASS + PASS_TO_PASS ids; pass rate = passed listed tests / listed tests |
| harness / model | OpenClaude, GPT-5.6 Sol, 400k window, trigger (400k-128k)·ρ | DSH 0.2.1-rc.5 headless, deepseek-v4.1-flash via OpenCode Go. **Default route since `6c624362f` (user 2026-11-07 01:18–01:20 CST): the shipped `opencode-go` catalog route, only the baseURL pointed at the proxy** (`evo-model.yml`: 1M window, catalog maxTokens 384 000, historian on its default model, no turn-end await). Measured on that route (§5, §7): the catalog maxTokens is applied per request by the adapter and is **not** a reservation for compaction — DSH compaction-basic fires at min(0.8 × 1M, 1M − 0 − 65 536) = 800 000, the plugin's native backstop at 90 % = 900 000, Magic Context executes at 65 % = 650 000. The earlier 200k route (maxTokens 32 768: compaction-basic at 101 696, MC at 130 000) is kept as `evo-model-200k-stress.yml` (§4). Not the paper's equal-ρ trigger |
| trials | 5 per task | 200k stress smoke 1 per group, first 10 items (§4); 1M real-use route: smoke + repeats, all **22** items, 3 runs per group (§5) |

Groups (same profile shape as cache-bench): **baseline** = shipped DSH headless template, no plugin
(native compaction-basic); **fold** = dsh-magic-context from this checkout + `setup`, defaults;
**native** = fold + `MAGIC_CONTEXT_DSH_NATIVE_ROLES=1` (line G plan N). All groups:
`DSH_PERMISSION_MODE=danger-full-access` (the agent needs docker for `evo-pytest`; the paper's agent runs
inside its container), on the 200k stress route `MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS=60000` (each
turn is its own process, as in cache-bench; the 1M default route keeps the shipped default: no await), per-turn timeout 1200 s (`timeout -k 30`), cost cap: no new turn starts
above $3 (peak list price).

`evo-pytest` = `docker exec` into a container of the instance image with the agent's tree mounted at
`/testbed` (the editable-install path), conda env `testbed`, `PYTHONDONTWRITEBYTECODE=1`,
`-p no:cacheprovider`.

Recorded per run (`analyze.py`; every proxied request counts — main agent, historian, DSH's
compaction summarizer, titles): pass rate (raw and gold-valid), F2P / P2P, cost (cache-aware, DeepSeek
flash peak list price, the cache-bench table), input / cache-hit / miss / output / reasoning tokens, hit
rate Σhit / Σ(hit+miss), compactions (historian requests, compaction-basic summarizer requests,
session `compaction/start` events), reduction boundaries (consecutive main calls whose prompt shrinks
≥ 15 %) with the hit rate (hit / prompt) of the call before and after (paper Fig. 5a), turn time, failed
turns, network attempts in the agent's tool calls. DSH's compaction summarizer reuses the main request
shape (same tools / system), so the proxy tags it `main`; `analyze.py` splits it out by its prompt
("You are now acting as a compaction engine…").

## 2. Harness validation (no model)

validate job of 42229338110 (scores the gold patch and an empty patch in the same environment):

| patch | F2P | P2P | raw pass rate | time |
|---|---|---|---|---|
| gold (`patch`) | 8 / 8 | 311 / 317 | 98.2 % | 121 s |
| empty | 0 / 8 | 309 / 317 | 95.1 % | 84 s |

376 results parsed. 6 P2P tests fail even with the gold patch here (environment) → the **gold-valid**
rate counts only the 319 tests that pass with gold. Consequence: the raw test-weighted rate only spans
95.1 % (do nothing) … 98.2 % (gold) on this task, because 317 of the 325 listed tests are
pass-to-pass; F2P (0–8) is the discriminating part and is reported separately.

## 3. Pipeline run and the fixes it forced (42229338110, baseline only, 2 items)

- Turn 1: 535 s, rc 0, 5 source files changed, $0.16. Turn 2 outlived its 1800 s timeout (last proxied
  request at 1692 s; SIGTERM did not end the process) → cancelled at ~62 min; now `timeout -k 30`.
- **Shortcut observed**: the agent `curl`ed `api.github.com/repos/conan-io/conan/pulls/13450`
  (+ commits, issue 13424 and its comments) and `web_fetch`ed the 2.0.3 changelog — the target code is
  one hop away. Stripping git alone (the paper's rule) is not enough with a networked agent → web tools
  off + host block + `--network none` test container; `analyze.py` counts residual attempts.
- **100k window thrash**: with cache-bench's 100k route, native compaction fires at 30.4k; the
  baseline ran 59 summarizer calls in ~110 main calls, and the main prompt right after each compaction was
  back at ~30k (one conan read / test burst is 10–15k). → 200k window for all groups (§1).

## 4. 200k stress smoke (route `evo-model-200k-stress.yml`, the default before 01:20 CST)

Smoke-1 `42235538885` (cancelled): fold ended all 10 turns with `turn_end` max-tokens after 4096-token
reasoning steps (rc 1, no edits) → main maxTokens 32768 (`1a69c2188`).

Smoke-2 `42238241963` (slot evo-3, `1a69c2188`, max_items 10, cost cap $3, turn timeout 1200 s; validate
again gold 8/8 + 311/317, empty 0/8 + 309/317). Per-run artifacts
`dsh-e2e-evobench-{baseline,fold,native}-run1-42238241963`, compare `dsh-e2e-evobench-compare-42238241963`.

| group | turns (rc ≠ 0) | `turn_end` | pass rate (raw / gold-valid) | F2P | P2P (gold-valid) | cost USD | input tok | hit tok | output tok (reasoning) | hit rate | compactions | reduction boundaries, hit before → after | peak prompt | turn time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 10 (0) | completed 10 | 95.4 % / 97.2 % | 0/8 | 310/311 | 0.669 | 21.71 M | 20.79 M | 224 k (154 k) | 95.8 % | 5 summarizer (5 `compaction/start`) | 7, 97.9 % → 19.6 % | 101.6 k | 65.7 min |
| native | 10 (0) | completed 10 | 95.4 % / 97.2 % | 0/8 | 310/311 | 0.668 | 26.56 M | 25.51 M | 166 k (105 k) | 96.0 % | 6 historian (1 `compaction/start`) | 3, 93.1 % → 13.7 % | 167.9 k | 41.1 min |
| fold | 10 (5: rc 124,124,1,1,124) | completed 5, max-tokens 2, none 3 | ~~97.5 % / 99.4 %~~ | ~~7/8~~ | 310/311 | 1.047 | 8.40 M | 8.16 M | 772 k (736 k) | 97.1 % | 1 historian | 1, 98.3 % → 23.9 % | 118.1 k | 99.0 min |

**Fold is invalid (shortcut).** The instance image's `/testbed` ships the full upstream git history
(release tags after 2.0.2 included). The agent has docker (it needs it for `evo-pytest`), so in turns
1–4 the fold agent hunted for the answer (two 1200 s timeouts, two rc 1 after 32 768-token reasoning
steps, no edits) and in turn 5 ran `docker run --entrypoint bash <image> -lc 'cd /testbed && git log
2.0.2..2.0.3'`, `git show`ed the upstream commits into `~/work/_temp/evo-patches` and applied them:
33 files / 113 KB in one turn, F2P 7/8. Baseline and native also searched the file system for
2.0.3 material (history probes 2 / 3: `git log` on the bench's own snapshot dir, `docker image inspect`),
but only `docker exec`ed into the test container, whose `/testbed` is the agent's mounted tree — their
numbers stand. The repeat run 42254245892 (same hole) was cancelled before any turn finished.

Fix `786eca88a` (harness only): the run uses a flattened copy of the image without `/testbed` and
without any `.git` (`docker export | docker import`, image ENV kept; checked: 0 `.git` left), the
pristine image is `docker rmi`'d for the run and re-pulled for the Score step, Docker registries
(`registry-1.docker.io`, `auth.docker.io`, `mirror.gcr.io`, `ghcr.io`, `quay.io`, …) and `huggingface.co`
are blocked with the code hosts, a `docker pull` of the instance image is checked to fail before turn 1,
`evo-pytest` must run in the sanitized image or the run aborts, and `analyze.py` counts history probes
(`docker run|pull|create|save|export|cp|history`, `git log|show|tag|rev-list|cat-file|reflog`) per run.
`dac2a66bb`: `prepare.py` retries the datasets-server fetch (IncompleteRead killed one job of 42255053410).

What the smoke does show (single run, not a result): F2P 0/8 for both valid groups — 7 of the 8 F2P
tests belong to items 1 and 5 (`tools.files.download` auth, server-side source backups), which both
agents implemented with their own conf names / messages, so the release tests fail; the 8th
(`test_cache_integrity`) belongs to an item after the 10-item cut. Both fixed the
`options_test` P2P regression item (13467). Native finished the same items in 63 % of baseline's time
with 81 % of its main calls, ran its prompt up to 168 k (Magic Context's 65 % execute threshold is
130 k; the historian publication lands later), and paid the same total: more input tokens (26.6 M vs
21.7 M) at a slightly higher hit rate, fewer output tokens.

## 5. Real-use route: 1M window, catalog defaults (all 22 items)

User instruction 2026-11-07 01:18–01:20 CST: all groups on the shipped `opencode-go` catalog route,
1M window and the catalog's default maxTokens, nothing else overridden; the purpose is to find what goes
wrong in real use. Commit `6c624362f` (sanitized harness of `786eca88a`, retry `dac2a66bb`). Runs:
smoke **42262147533** (slot evo-7, 1 run per group, validate) and repeats **42262946905** (slot evo-8,
2 runs per group). Validate (42262147533): gold 8/8 F2P + 311/317 P2P, the same 6 environment failures as
before → gold-valid = 319 tests. Per-run artifacts `dsh-e2e-evobench-<group>-run<k>-<run id>`; analysis
regenerated with the fixed `analyze.py` (`dc916285b`, subagent calls split out of "main").

| group | run (run id) | turns (rc ≠ 0) | `turn_end` | pass raw / gold-valid | F2P | P2P (gold-valid) | cost USD | input tok | output tok (reasoning) | hit rate | compactions | peak prompt | turn time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 1 (42262147533) | 22 (0) | completed 22 | 96.0 % / 97.8 % | 1/8 | 311/311 | 1.338 | 147.8 M | 223 k (140 k) | 99.6 % | 0 | 592 597 | 61.5 min |
| baseline | 1 (42262946905) | 22 (0) | completed 22 | 95.7 % / 97.5 % | 1/8 | 310/311 | 1.437 | 129.6 M | 321 k (214 k) | 99.3 % | 0 | 539 388 | 59.9 min |
| baseline | 2 (42262946905) | 22 (0) | completed 22 | 95.7 % / 97.5 % | 1/8 | 310/311 | 0.872 | 77.6 M | 194 k (124 k) | 99.2 % | 0 | 573 549 | 35.1 min |
| native | 1 (42262147533) | 22 (0) | completed 22 | 95.7 % / 97.5 % | 1/8 | 310/311 | 1.399 | 144.8 M | 287 k (195 k) | 99.6 % | 0 | 562 773 | 63.9 min |
| native | 1 (42262946905) | 22 (1: rc 124) | completed 21 | 95.7 % / 97.5 % | 1/8 | 310/311 | 0.946 | 92.1 M | 203 k (137 k) | 99.4 % | 0 | 489 905 | 52.5 min |
| native | 2 (42262946905) | 22 (0) | completed 22 | 95.7 % / 97.5 % | 1/8 | 310/311 | 1.686 | 178.1 M | 300 k (192 k) | 99.5 % | 0 (historian 2 × HTTP 400) | 647 176 | 48.0 min |
| fold | 1 (42262147533) | 13 of 22, stopped by cost cap $3 before turn 14 (12: rc 124 on all but turn 4) | completed 1 | 95.7 % / 97.5 % | 1/8 | 310/311 | 3.247 | 59.4 M | 2 312 k (2 240 k) | 99.3 % | 0 | 371 395 | 259.1 min |
| fold | 1 (42262946905) | 11 of 22, cost cap before turn 12 (10: rc 124 turns 1–10) | completed 1 | 95.4 % / 97.2 % | 0/8 | 310/311 | 3.037 | 39.3 M | 2 258 k (2 191 k) | 99.2 % | 0 | 295 037 | 207.1 min |
| fold | 2 (42262946905) | 11 of 22, cost cap before turn 12 (11: rc 124 turns 1–11) | none | 95.4 % / 97.2 % | 0/8 | 310/311 | 3.093 | 46.8 M | 2 259 k (2 191 k) | 99.3 % | 0 | 321 332 | 220.0 min |

Per group, mean (min–max):

| group | runs | pass raw % | gold-valid % | F2P | cost USD | hit rate % | input tok | output tok | compactions | turn time min | failed turns |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 3 | 95.8 (95.7–96.0) | 97.6 (97.5–97.8) | 1/8 all | 1.215 (0.872–1.437) | 99.4 (99.2–99.6) | 118.4 M (77.6–147.8) | 246 k (194–321) | 0 | 52.2 (35.1–61.5) | 0 |
| native | 3 | 95.7 (95.7–95.7) | 97.5 | 1/8 all | 1.344 (0.946–1.686) | 99.5 (99.4–99.6) | 138.3 M (92.1–178.1) | 264 k (203–300) | 0 | 54.8 (48.0–63.9) | 1 |
| fold | 3 (all stopped by the $3 cost cap after 11–13 of 22 turns) | 95.5 (95.4–95.7) | 97.3 (97.2–97.5) | 0/8, 0/8, 1/8 | 3.125 (3.037–3.247) | 99.3 (99.2–99.3) | 48.5 M (39.3–59.4) | 2 276 k (2 258–2 312) | 0 | 228.7 (207.1–259.1) | 33 of 35 turns rc 124 (1200 s timeout) |

Fold on the 1M route (I3): median reasoning per main request 4 897 / 8 765 / 6 028 tokens (baseline 34–141, native 44–121), median request time 35–50 s (others 3–5 s), so a 1200 s turn holds only ~20 steps and 33 of 35 turns hit the timeout; 97 % of the output is reasoning. In the fold view every earlier assistant step and tool result is a user message ("Magic Context note: these tool calls already ran …"), and the reasoning keeps re-deriving the state ("Previous turns are compacted", "turn-01 made no changes") and tries to recall the upstream 2.0.3 code (16 517 matches for 2.0.3 / upstream / recall in run 1 of 42262946905, native 933). Same direction as round 36 G (fold 290–325 reasoning tokens per step vs native 9–18), much larger on this task. Attribution: plugin fold presentation × model; not fixable without changing the fold semantics (record only; native roles avoids it). Evidence: `dsh-e2e-evobench-fold-run*-4226*/requests.jsonl`, `resp/37.json`, `turns.jsonl`.

What the 1M route shows:

- **No context management ran at all in any baseline / native run.** 22 items fill 0.49–0.65 M tokens.
  DSH reserves 0 output tokens on this route (the catalog's 384 000 is applied by the adapter per request,
  clamped to window − prompt: `max_tokens` 383 946 … 306 038 on the main calls above 616k), so
  compaction-basic would fire at 800 000 and the plugin's backstop at 900 000; Magic Context's historian
  is the only mechanism inside the observed range, and it fired in one run only (native run 2 of
  42262946905, from 63 % projected pressure at the end of turn 20) — **both historian requests were
  rejected with HTTP 400 in 23 / 45 ms** and nothing else happened (issue I1, §6). The groups therefore
  differ only by the plugin's per-request surface (Magic Context system section, ctx_* tools, tags), not
  by a compaction policy: this is **not** a compaction comparison.
- Quality is flat: every run passes `test_cache_integrity` (the one F2P item the agents implement with
  upstream's API names) and fails the 7 F2P tests of items 1 and 5 (download auth, server-side source
  backups — own conf names / messages); gold-valid 97.5–97.8 %. One baseline run also kept the last P2P
  test green (311/311).
- Cost differences are run-to-run noise at n = 3: the cheapest and the most expensive run of the six are
  baseline 2 ($0.872) and native 2 ($1.686); input tokens track how much the agent re-reads (77.6–178.1 M),
  the hit rate is 99.2–99.6 % everywhere (append-only prefix, nothing rewritten).
- Subagents: agents delegated in 3 of 6 runs (8 / 128 / 56 requests, $0.09 / $0.28 / $0.14). Before
  `dc916285b`, `analyze.py` counted every switch between the main conversation and a subagent as a
  "reduction boundary" (7 / 50 / 27 with "hit before → after" means) although nothing was compacted.

- **Fold (plugin default) is the outlier, and not because of compaction** (I3): it never got near any
  threshold (peak prompt 0.30–0.37 M) but every main request carried 4.9–8.8 k reasoning tokens (median;
  baseline / native 34–141), so a 1200 s turn held ~20 steps, 33 of 35 turns timed out, and all three runs
  hit the $3 cap after 11–13 of 22 turns at $3.04–3.25 — about 2.6× the baseline group mean ($1.215) for
  half the turns. Quality is no better (F2P 0/8, 0/8, 1/8; gold-valid 97.2–97.5 %). Native roles on the same
  plugin build shows none of it.
- The historian's 400 (I1) is now explained: the gateway requires `x-opencode-session` and the plugin's
  historian call carried no session id (fixed in `f5bf2f84a`, not yet re-measured on the 1M route).

## 6. 真实环境问题清单

Columns: 组 / 轮次, 证据路径 (artifact name / file:line, all under the run's per-run artifact), 能否复现,
归因 (plugin = dsh-magic-context adapter, DSH = shipped DeepSeek Harness / its adapters, model, pipeline =
this bench, core = Magic Context core), 证据等级 (确证 = directly visible in logs / bodies; 定位 =
mechanism traced in code + logs; 单次 = one observation; 推断 = derived, not directly logged), 状态.

| # | 现象 | 组 / 轮次 | 证据路径 | 能否复现 | 归因 | 证据等级 | 状态 |
|---|---|---|---|---|---|---|---|
| I1 | **historian 请求被上游拒绝（HTTP 400），无任何压缩，日志里也看不到失败**：turn 20 末起 `historian trigger … fires=true` 共 31 行，只有 2 个 historian 请求到达代理（23 ms / 45 ms 内 400），之后会话一直涨到 647 176（64.7 %）结束；stderr 无失败行（失败只进 ctx.logger / notifyIssue） | native / 20、21（1M） | `dsh-e2e-evobench-native-run2-42262946905/requests.jsonl` n=503、518；`turn-20.log:63`、`turn-21.log`；`bodies.tar.zst` 503.json（system 63 203 字符、user 69 382 字符、`max_tokens` 384 000） | 1 次（同组另 2 次没到 historian 阈值）；`dc916285b` 上的验证运行 42274076026（evo-9，`dc916285b`）native 同样 2 × 400（resp/365.json、377.json，fires=true 13 行），原因见右 | 未定：400 原因当时未记录（代理不存非 2xx 响应体 = pipeline 缺口，已修）；请求形状与主请求相同（同模型、同 `max_tokens`），候选是 OpenCode Go 对该请求的校验 | 确证（400、无压缩）；原因未知 | pipeline 部分已修（`5a39caac5` 记录 errorBody；`analyze.py` 标记 "fired but no successful historian request"）；原因 已定位（42274076026 errorBody）：`{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently"}`。主循环请求由 loop 盖 `GenerateOptions.sessionId`，pi-ai 适配器映射成该头；DSH 自己的 compaction-basic 传 `sessionId: agent.session.id`；插件 historian 的 `ctx.llm.stream` 没传 → 归因插件。**已修** `f5bf2f84a`（RED `a889abf10`），只加路由元数据；真实路由复验待下一次 1M 运行 |
| I2 | **1M 真实路由上压缩不预留输出**：catalog maxTokens 384 000 由适配器逐请求截断（`max_tokens` 随 prompt 降到 306 038），不进请求头 maxTokens / defaultMaxTokens → DSH 与插件都按 0 预留：DSH 800 000、插件兜底 900 000；22 项内无人压缩（baseline 峰值 592 597） | baseline、native 全部（1M） | 各 run 的 `evo-maxtokens.json`；`native-run2-42262946905/turn-20.log:4` `thresholdPct=90 window=1000000` | 是（每次都如此） | DSH（pi-ai 适配器 / compaction-basic 的预留来源） | 定位（日志 + DSH 源码 `reservedCompletionTokens`） | 只记录；`evo-model.yml` 注释改正（原写 550 464） |
| I3 | **fold（插件默认）在 1M 真实路由上推理暴涨，几乎每轮超时，被成本上限截停**：每个主请求推理中位 4 897 / 8 765 / 6 028 token（baseline 34–141、native 44–121），请求中位耗时 35–50 s（其余组 3–5 s）；35 轮里 33 轮 rc 124（1200 s），3 次都在 11–13 / 22 轮触发 $3 上限；输出 97 % 是推理。推理反复重建状态（「Previous turns are compacted」「turn-01 made no changes」），并试图回忆上游 2.0.3 代码 | fold / 全部（1M，3 次） | `fold-run1-42262946905/resp/37.json`（42 271 推理 token、268 s）；各 fold run `requests.jsonl`、`turns.jsonl` | 是（3/3；200k stress 也是同向：turn 1、2、5 超时，3、4 max-tokens） | 插件（fold 呈现：之前的 assistant 步骤和工具结果都变成 user 消息 "Magic Context note: these tool calls already ran …"）× 模型 | 确证（现象）；机制为推断 | 只记录：改 fold 呈现即改语义，不在授权内；native roles（`MAGIC_CONTEXT_DSH_NATIVE_ROLES=1`）不出现此问题。待用户决定是否把 native roles 设为默认 |
| P3 | 代理把正常结束的请求记成 `clientAborted`：DSH 读到 `data: [DONE]` 就关连接，上游响应尚未 end | 验证运行 native（55 个，53 个带 usage + finish，无一轮超时） | `native-run1-42274076026/requests.jsonl` | 是 | pipeline（`proxy.mjs`，`5a39caac5` 引入） | 确证 | **已修** `af6a810ca`；RED `6fdf5e9a1`（只影响标记，usage 一直有记录） |
| S9 | **显式 maxTokens 的路由上原生兜底先于 MC**：1M + 请求 maxTokens 384 000 → 兜底 min(0.9w, w − 384 000 − 0) = 616 000（61.6 %）< MC 执行线 650 000（65 %），也低于 MC 强制带 85 % | 插件（真实 1M catalog 路由上**不发生**，见 I2；200k stress 路由同一机制给出 83.6 %） | 单测 `compaction-pressure.test.ts` S9（`738e3312a`）；200k stress `native-run1-42238241963/turn-06.log`（thresholdPct 83.6） | 是（确定性，单测） | 插件（MC 阈值按整窗、兜底受 w − maxTokens 封顶） | 定位 + RED 单测 | **待用户确认修法**（§7）；RED 以 `it.failing` 提交，CI 绿 |
| S4 | 每轮超时杀掉 DSH 后，代理里的上游请求继续生成并计费 | fold / 1、2（200k）；native / 1（1M：71 步后 rc 124，req 72 在杀掉后又跑了 18 s） | 200k：`fold-run1-42238241963/requests.jsonl` t1 > turns.jsonl t1（82–151 s）；1M：`native-run1-42262946905/requests.jsonl` n=72 | 是（每次超时） | pipeline（代理不随客户端断开中止上游） | 确证 | **已修** `5a39caac5`（客户端断开 → 中止上游，记 `clientAborted`）；RED `b26f73dca` |
| S6 | historian 忙时第二次过兜底的检查打印 "already deferred once … compacting now"，随后 compaction-basic 的剪枝就让会话回到阈值下、返回 null（outcome=none），实际没有压缩 | native / 6 起（200k stress，7 次） | `native-run1-42238241963/turn-06.log:22,32` | 是（单测复现）；1M 不触发（兜底不活跃） | 插件（日志在结果前打印） | 定位 + 单测 | **已修** `60f92181a`（只改日志：报告实际结果）；RED `aa3ce9fc4` |
| S5 | 原生兜底触发的 DSH tool-result pruner 改写前缀：命中 98.3 % → 25.9 %，prompt 只降 6 % | native / 5（200k stress） | `native-run1-42238241963/bodies.tar.zst` 143 vs 144 | 结构性（每次原生压缩先 prune）；1M 不触发 | 原版 DSH（pruner），经插件兜底触发 | 单次 + 机制定位 | 只记录 |
| P1 | 分析把 subagent 请求与主会话交替算成"上下文缩减边界" | 1M：native 1 / baseline 1 / native 2 | `x/an` 重算前后（7 / 50 / 27 → 0） | 是 | pipeline（analyze.py） | 确证 | **已修** `dc916285b`；RED `3fd165782` |
| M1 | agent 用 subagent 从预训练记忆里"回忆"上游 2.0.3 的实现（"Using only your pretrained knowledge of the public Conan 2.x project … do NOT inspect …"） | native / 5（1M，42262147533） | `native-run1-42262147533/resp/119.json`（2 个 subagent 调用）、`bodies.tar.zst` 121.json | 1 次 | 模型（SWE-EVO 记忆污染风险） | 确证 | 只记录（无法用网络封锁防住） |
| M2 | agent 在每个 1M run 里翻 bench 自己的快照库 `~/work/_temp/evo/<run>/snap.git`，并读 bench 自身目录 `~/work/_temp/bench/<run>`（请求体、patches、meta；1M 下 fold 每 run 10–14 次、snap.git 6–149 次，其余组 bench 目录 0–7 次、snap.git 2–28 次）（`git log --all`、`fsck --unreachable`、`git show` 快照提交） | 全部组 / 1、5 | `analyze` history probes 1–6 / run，例 `native-run1-42262147533/turn-05.log` | 是 | pipeline 卫生（快照库只含 agent 自己的轮次，无上游内容，无泄漏） | 确证 | 只记录（可移出 `$HOME`） |
| S7 | 未读先改被拒（"file has not been read"）后重读重试；`old_string matched 2 times`；`offset out of range` | baseline、native 都有（1M 每 run 0–11 次） | 各 run `turn-*.log`（analyze tool errors） | 是 | 原版 DSH 守卫 + 模型 | 确证（影响小） | 只记录 |
| S2 | 单轮 1200 s 超时 | fold / 1、2、5（200k）；native / 1（1M，正常工作 71 步） | `turns.jsonl` rc 124 | 1M 6 次中 1 次 | pipeline 参数（每轮上限）× 模型 | 单次 | 只记录（下一轮继续同一会话，工作不丢） |
| S1 | 实例镜像带上游完整 git 历史（fold 取上游提交 apply） | fold / 5（200k） | `fold-run1-42238241963/turn-05.log` | 是 | pipeline（SWE-EVO 镜像） | 确证 | 已修 `786eca88a`（1M runs 无一触及原始镜像） |
| S3 | `turn_end` max-tokens（32 768 被推理吃光） | fold / 3、4（200k stress） | `fold-run1-42238241963/turn-03.log` | 只在 stress 设置（1M：0 次） | 模型 × stress maxTokens | 两次运行 | 只记录 |
| S8 | jobs 工具误用（"Action 'list' is not allowed"、"unknown job"） | fold / 2（200k） | `fold-run1-42238241963/turn-02.log:24,67` | 1 次 | 原版 DSH / 模型 | 单次 | 只记录 |
| S10 | baseline 原生 compaction 后命中 ~97 % → ~11 %（前缀重写，预期代价） | baseline（200k） | `baseline-run1-42238241963/summary.md` | 是 | 原版 DSH | 确证 | 只记录 |

(The 200k stress list was numbered S1–S9 in the working notes; its old S9 is S10 here so that S9 names
the backstop-threshold question as in the user's instruction.)

## 7. S9 — native backstop vs Magic Context's execute threshold (located, fix not applied)

Mechanism. The MC main backstop sets compaction-basic's `headroomTokens = 0` and `thresholdRatio = 0.9`
(the 90 % native backstop above MC's 85 % force band). compaction-basic prices pressure at
`min(window × ratio, window − reserved − headroom)`; Magic Context prices its own 65 % / 85 % against the
whole window (reserved output not subtracted). When the route's request maxTokens is large relative to the
window, the cap `window − reserved` wins: 1M / 384 000 → 616 000 = 61.6 % — below MC's execute threshold,
so native compaction (pruner, then a Magic-rendered checkpoint) would pre-empt the historian.

Where it does and does not happen. On the shipped opencode-go 1M route the reservation is 0 (I2), the
backstop is 900 000 and the 1M runs never reached it; the historian's 650 000 came first (and failed, I1).
It happens on any route whose header carries maxTokens (user config, or an adapter that materializes
`defaultMaxTokens`): the 200k stress route (maxTokens 32 768) logged thresholdPct 83.6, i.e. between MC's
execute (65 %) and force (85 %) bands. RED `738e3312a` (`compaction-pressure.test.ts`, `it.failing` so CI
stays green; plain `it()` fails 2/2: fires at 62 % / 64 %, policy view 61.6 < 65).

Fix options (each changes what an MC threshold means, so the user decides):

| option | change | effect | risk |
|---|---|---|---|
| A. MC prices against the usable window | the adapter reports `window − reserved output` as MC's context limit on routes with a header maxTokens | 65 % / 85 % of 616 000 = 400 400 / 523 600; backstop 616 000 stays the highest; ordering restored | the historian and drops start earlier on such routes (more historian cost, earlier cache rewrites); `/ctx-status` percentages change meaning; core thresholds unchanged, only their base |
| B. Suppress the main backstop below MC's force band | when `min(0.9w, w − reserved)` < force band, skip native pressure compaction on MC main sessions (log once), leave DSH overflow recovery as the last line | MC keeps the lead up to the cap; native only reacts to a real overflow | no pre-emptive native safety net between 616k and the overflow; overflow recovery is the stock DSH path (heavier) |
| C. Keep it, make it visible | doctor / setup warn when a route's backstop falls below the execute (or force) band; no runtime change | users learn to raise the window / lower maxTokens | the inversion remains on such routes |
| D. Lower the request reservation for compaction pricing | adapter prices compaction with min(maxTokens, a cap such as 10 % of the window) | backstop 900 000 on 1M / 384k | under-reserves when the model really emits long outputs (output overflow at the provider) — changes DSH's safety margin |

My recommendation: A (it keeps "backstop above MC" true by construction and is local to the adapter),
with C's doctor warning in any case. Not committed: it waits for the user's choice.

## 8. Commits of this line after the 1M switch

| commit | kind | what | CI |
|---|---|---|---|
| `738e3312a` | RED (it.failing) | S9 threshold inversion on 1M / 384k | push CI 42273089229 ✓ (with the next four) |
| `aa3ce9fc4` | RED | S6 log claims "compacting now" before the outcome | 42273089229 ✓ |
| `60f92181a` | fix (plugin, log only) | S6 line reports the real outcome | 42273089229 ✓ (dsh-plugin 700 / 0) |
| `b26f73dca` | RED (pipeline) | proxy: client abort must abort upstream; non-2xx body must be kept | 42273089229 ✓ |
| `5a39caac5` | fix (pipeline) | S4 + I1 visibility in `proxy.mjs`; analyze non-2xx / client-aborted / historian fired-vs-requests | 42273089229 ✓ |
| `3fd165782` | RED (pipeline) | analyze counts subagent interleavings as reductions | 42273703071 ✓ |
| `dc916285b` | fix (pipeline) | subagent kind, packed-bodies streaming, versioned kinds cache | 42273703071 ✓ |
| `786eca88a` | fix (pipeline, earlier) | sanitized image (S1) | push CI 42255035634 ✓ |
| `6fdf5e9a1` | RED (pipeline) | P3 proxy flags a close after `[DONE]` as clientAborted | push CI 42309810588 ✓ |
| `a889abf10` | RED (plugin) | I1 historian request has no session id | 42309810588 ✓ |
| `af6a810ca` | fix (pipeline) | P3 close after `[DONE]` = complete response | 42309810588 ✓ |
| `f5bf2f84a` | fix (plugin, routing metadata only) | I1 historian `ctx.llm.stream` gets `sessionId = agent.session.id` (compaction-basic parity) | 42309810588 ✓ |

Verification run after the fixes: 42274076026 (slot evo-9, native + fold × 1, 22 items, commit `dc916285b`; reported separately from the `6c624362f` runs). **native** (done): 22/22 turns, all rc 0, turn_end completed 22, 95.7 % raw, F2P 1/8, P2P 310/317, $1.219, hit 99.6 %, 0 compactions, peak prompt 632 096, 54.3 min; historian fired (13 `fires=true` lines) but both historian requests got HTTP 400 MissingSessionID (I1, now located and fixed in `f5bf2f84a`). S4: no turn timed out in native, so the kill path was not exercised; the 55 `clientAborted` marks were normal completions closed after `[DONE]` (P3, fixed `af6a810ca`); every request has usage except 2. **fold**: still running at 07:10 CST (job started 02:48 CST; the three earlier fold runs needed 207–259 min of turn time until the $3 cap) — its S4 kill-path evidence (turns at rc 124) is pending.

## 9. Differences from the paper (what this bench is not)

- **Scale.** One transition, all 22 items on the 1M route (10 on the 200k stress route), 3 runs per
  group (paper: 8 transitions, 315 items, 5 trials). The raw test-weighted rate is dominated by 317 P2P
  tests and only spans 95.1 % (empty patch) … 98.2 % (gold); F2P (8 tests) is the discriminating part.
- **Model / harness.** deepseek-v4.1-flash through OpenCode Go in DSH 0.2.1-rc.5, the shipped catalog
  route (1M window), each item a fresh `dsh --session-id` process (paper: GPT-5.6 Sol in OpenClaude,
  400k window, one live process).
- **No compaction at 1M.** The paper fires every policy at the same ρ inside the run. On the real-use
  route nothing fires within 22 items (DSH 800 000, plugin backstop 900 000, MC 650 000 reached once and
  its historian rejected, I1), so the 1M numbers compare the plugin's per-request surface, not compaction
  policies. Only the 200k stress smoke (n = 1, 10 items) exercised compaction, with unequal trigger points
  (101 696 vs 130 000).
- **Anti-shortcut stricter than the paper.** The paper strips git history from the image. With a
  networked, docker-capable agent that was not enough twice: GitHub API / changelog fetches
  (pipeline run) and the instance image's own upstream history (smoke-2 fold). Web tools off, code
  hosts / registries blocked, sanitized flat test image, pristine image absent during the run.
- **Cost model.** DeepSeek flash peak list price over every proxied request (main, historian,
  summarizer, titles); the paper reports its own provider's billing.
- **Metrics we add.** gold-valid rate (6 P2P tests fail with the gold patch in this environment),
  history probes, `turn_end` reasons, per-kind cost.

## 10. Evidence level

- **确证** (directly in the artifacts): the 1M tables (§5), I1's two HTTP 400s and the absence of any
  compaction, S1, S4, S7, P1, M1, M2, S10.
- **定位** (mechanism traced in code + logs, reproduced by a unit test where noted): I2 (DSH source
  `reservedCompletionTokens` + plugin log thresholdPct=90), S9 (unit test RED), S6 (unit test), S5.
- **单次**: S2 at 1M, S3, S8; I1 has one occurrence (the other two native runs never reached the
  historian threshold).
- **未知**: the cause of I1's 400 (body not recorded before the proxy fix).
- Fold on the 1M route: 3 runs (42262147533 run 1, 42262946905 runs 1–2), all stopped by the $3 cost cap after 11–13 of 22 turns, 33 of 35 turns at the 1200 s timeout, reasoning-dominated output (I3); evidence `dsh-e2e-evobench-fold-run*-4226*`.

## 11. Limitations

- n = 3 per group on one task: variance between runs of the same group (cost $0.87–1.44 baseline,
  $0.95–1.69 native) is larger than the difference between groups (§5); no significance claim.
- The agent runs with `danger-full-access` and sudo on the runner: the network block and the
  sanitized image raise the cost of a shortcut, they do not make one impossible (it could rewrite
  `/etc/hosts`). `analyze.py` counts history / network probes; a run with an applied upstream commit
  would need a manual read of its logs.
- F2P tests encode upstream API names (conf keys, messages); a correct independent implementation
  still fails them. This is the SWE-EVO design, but it makes F2P a weak signal for compaction quality
  at n = 3.
- Each turn is a new process. On the 1M route the historian is not awaited (shipped default): a pass
  started at turn end runs while the process exits, unlike an interactive session; on the 200k stress
  route it is awaited 60 s.
- I1's cause is not established (the 400 body was not recorded before `5a39caac5`).
- Bench findings only changed the plugin where the user authorised it (02:18 CST: non-core, RED first,
  CI green): S6 is a log-text fix; S9 is located with a RED test and left for the user; no default,
  threshold, assertion or peer range changed.

