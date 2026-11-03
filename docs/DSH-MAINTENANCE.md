# DSH (DeepSeek Harness) integration — maintenance guide

Branch: `dsh-integration` of `ceyirelehe47/magic-context` (fork of
`cortexkit/magic-context`). It carries Magic Context **core** unchanged from an
upstream release tag plus a DeepSeek Harness adapter layer:

| path | what |
|---|---|
| `packages/adapter-api/` | host-neutral facade (`dsh-magic-context-adapter`): harness identity (`setDshHarness`), model map, session/runtime types |
| `packages/dsh-plugin/` | the DSH plugin (`dsh-magic-context`): host bootstrap, agent plane (context plane, knowledge gate, coordinator, historian, dreamer, nudges, tools, commands), compat layer, setup/doctor CLI, Typert remote + client |
| `packages/dsh-plugin/src/contracts/` | contract tests (compile-time DSH API + runtime core import surface) |
| `.github/workflows/upstream-sync.yml` | scheduled upstream sync (fork only) |
| `docs/dsh/` | community port notes + e2e harness from the original repo |

Provenance: imported verbatim from the community port
[xiaohj233/dsh-magic-context@6c82abd](https://github.com/xiaohj233/dsh-magic-context/tree/6c82abd)
(v0.1.2, MIT, © 2026 xiao_hj909). `LICENSE`, `NOTICE` and
`THIRD_PARTY_NOTICES.md` are kept in both packages; see `IMPORTED.md`.

Pinned versions: `@deepseek-ai/dsh*` **0.2.1-rc.5** (exact, devDependencies +
peers), `@deepseek-ai/cordis ~4.0.5`, core = the upstream tag the branch is
based on (currently **v0.49.35**, merged in round 16). `doctor` checks the installed DSH against
`DSH_COMPAT_EXPECTED_VERSION` in `src/doctor/env.ts`.

## Commands

```bash
# install only the lanes the adapter needs (no OpenCode CLI, dashboard, e2e)
bun install --ignore-scripts \
  --filter '@cortexkit/opencode-magic-context' --filter '@cortexkit/retina-local-fs' \
  --filter 'dsh-magic-context-adapter' --filter 'dsh-magic-context'

bun run typecheck:dsh   # tsc for adapter-api + dsh-plugin (includes src/contracts/dsh-api.contract.ts)
bun run test:dsh        # bun test for both packages
bun run contracts:dsh   # DSH vocabulary gate + core import-surface contract
```

Use **bun 1.4.4** (`packageManager` says 1.4.2; 1.4.4 is what the e2e
bootstrap and the last full verification used). Do not use npm: it is
OOM-killed on small (8 GB) sandboxes. On sandboxes whose root/home overlay is
RAM-backed, a full unfiltered `bun install` is also OOM-killed because the bun
cache (~3 GB) lands in `~/.bun/install/cache`; use the filtered install above
and point `BUN_INSTALL_CACHE_DIR` at a disk-backed directory.

Baseline (round 19, 2026-11-03, DSH 0.2.1-rc.5, core v0.49.35; push run
41591790570 @ `6615a8d5b` and dispatch run 41592114076 (`e2e=true`)):
`typecheck:dsh` **0 errors**, core typecheck **0 errors**, `dsh-plugin`
**485 pass** (65 files; round 19 +17), `adapter-api` **15 pass**,
`contracts:dsh` **98 pass**, 0 fail; real-model `e2e` **64/65 PASS** on run 41592114076 (only C8 failed: the model answered the codeword correctly but called `ctx_search` first; C8 no longer judges retrieval calls, re-verified by a follow-up dispatch)
(round 18's 57 + C10 + R0–R6 = 65 judged). Evidence:
`docs/dsh/e2e/evidence-round19/`.

Round 19 fixes (adapter only, no core change):
- `b7eb34acf` **native pressure compaction no longer pre-empts MC.**
  compaction-basic prices pressure at `min(window × 0.8, window − maxTokens −
  65 536)`: a ≤ ~70k window threw `TargetPressureConfigError` (pressure
  compaction never fired) and a 128k window fired at ≈ 44–46 %, before MC's
  65 % execute threshold. `MagicCompactionEngine` now overrides
  `compactIfNeeded` for the `pressure` trigger only: an MC-managed **main**
  session gets `headroomTokens: 0` and `thresholdRatio` = MC's
  force-materialization band for the route (core `escalationBands`:
  `max(85, execute + 2)` → 85 % at 65 %), registered by the agent plane on
  `magicContextHost.nativePressurePercentage` (live-disabled MC → DSH
  defaults); a **child** session keeps the native policy (round 16) and only
  retries with headroom 0 when the default headroom makes it illegal.
  Explicit top-level `headroomTokens` / `thresholdRatio` and per-route
  `modelPolicies` always win. The effective config is swapped in only for
  compaction-basic's synchronous policy resolution (before its first await),
  so the summarizer / overflow paths read the original. `setup` prints and
  `doctor` checks it (`native-pressure.<profile>`, WARN when user values make
  a 128k main session compact before 65 %). 12 tests (8 red before).
- `a88385f60` the child fallback also covers the second default-headroom
  config error the real host showed (run 41589483637, 80k route):
  `retainTokens (12144) must be less than threshold tokens 10368` (0.16 ×
  message budget ≥ the shrunken threshold on ≈ 70–82k windows) — unless the
  retention is user-set. +1 test (red before).
- `932ffef20` e2e-only one-shot historian corruption
  (`MAGIC_CONTEXT_DSH_E2E_CORRUPT_HISTORIAN_ONCE` = absolute marker path,
  O_EXCL, unset/relative/existing = no-op, repair output never touched) so the
  `f8c663fee` repair retry runs on the real host (C10). +2 tests.
- `9d16d6fab`, `34e728b60`: headless-visible diagnostics (stderr under
  `MAGIC_CONTEXT_DEBUG_HISTORIAN=1`: one `native pressure check: child pct
  thresholdPct window outcome` line per pre-step, `native compaction region`
  per native compaction, repair-retry / injection lines — `ctx.logger` is not
  printed by `dsh headless`); e2e scenario P (`opencode-go-100k` route, 40
  generated fixtures); `cc024e807`, `6615a8d5b` scenario C asks the model not
  to `ctx_reduce` its reads (+2 pairs) and C9 ignores model-authored text.

Native pressure trigger, before → after (real rc.5, e2e P, 100k route,
maxTokens 4096): **before** (compaction-basic defaults, set explicitly in
`patch-r19-dsh-default.yml`; threshold 30.4 %) the MC main session was
natively compacted at **44.0 %** (first pre-step above 30.4 %; run
41591017319), i.e. before MC's 65 %; **after** (shipped policy, threshold 85 %)
the same session climbed to **77.9 %** with **0** native compactions while
MC's historian fired first at **74 %** (runs 41591017319, 41592114076). On the
80k route the old default was not even legal (retain ≥ threshold → never
fired; run 41589483637); on the 40k / 24k routes it threw "no pressure
budget". After: 24k/40k/80k/100k/128k main → 85 %; child 24k/40k/80k → 80 %
(headroom-0 fallback), child 100k/128k → DSH native 30.4 % / 43.8 %.

Previous baseline (round 18, 2026-11-03, DSH 0.2.1-rc.5, core v0.49.35; push run
41554474179 and dispatch run 41554794748 (`e2e=true`) @ `f8c663fee`):
`typecheck:dsh` **0 errors**, core typecheck **0 errors**, `dsh-plugin`
**468 pass** (64 files; round 17 +13, round 18 +4), `adapter-api` **15 pass**,
`contracts:dsh` **98 pass**, 0 fail; real-model `e2e` **57/57 PASS**
(N*/T*/M*/P1 + round 17/18 real-use scenarios C1–C9, U1–U6, S0–S7). Evidence:
`docs/dsh/e2e/evidence-round18/`.

Round 17 fixes (real rc.5 e2e run 41537851210 found them; each test red before):
- `f27757b6b` one `[dropped §N§]` per tag per folded copy even when the parts
  are not adjacent (parallel-call steps rendered `[dropped §6§] [dropped §7§]`
  twice). Real rc.5 re-check: e2e C9 (round 18 runs: 6–8 placeholders, 0 dups).
- `929dbafc9` `/ctx-status` no longer prints core's "OpenCode DB: MISSING …
  historian disabled" line on DSH, and the context plane persists
  `last_input_tokens`. Real rc.5 re-check: U5.
- `17bd7279c` strip copied `§N§` from assistant text at the `llm/stream`
  boundary (12 of 12 replies leaked it). Real rc.5 re-check: C5 clean in all
  three round 18 runs.

Round 18 fixes:
- `a1b94d6b5` **(severe) headless sessions never saw their compartments.** The
  historian's post-publish "materialize on the next pre-step" signal lived only
  in process memory (`historian.ts` `deferredSignalsBySession`); `dsh headless`
  runs each turn in a new process, so the next process found a cache-valid m0,
  replayed the old EMPTY `<session-history>` under the same watermark while the
  compartmentalized raw messages were dropped → history lost (round 17 the
  model needed `ctx_search` for the codeword). The knowledge gate now also
  forces the fold when the durable publish is newer than the cached baseline
  (`dsh_context_compaction_marker.published_at` or `MAX(compartments.created_at)`
  > `session_meta.cached_m0_materialized_at`; self-consuming like core's
  `ttl_idle` / `host_compaction`; skipped in compaction-off mode). Adapter only,
  no core change. Test: `cross-process-materialize.test.ts` runs process A
  (first gate pass + real historian publish) in a child `bun` process and
  process B on the same DB. Real rc.5: C7 (compartment written in turn N,
  in the injected m0 from turn N+1), C8 (codeword answered from
  `<session-history>` with no retrieval tool).
- `43dc2a27e` persist `last_response_time` from the latest completed
  `assistant/message` (`/ctx-status` said "Last response: never"; core's
  `ttl_idle` HARD fold could not arm). Real rc.5: U5 ("Last response: 0s ago").
- `f8c663fee` one historian **repair retry** on invalid XML (upstream
  `runHistorianPrompt` re-prompts once with `buildHistorianRepairPrompt`; the
  DSH pass failed outright — e2e run 41552779443: "output left uncovered
  messages 11-13 without `<unprocessed_from>`" → failure backoff, C6).
  Round 19: exercised on the real host through the e2e-only injection (C10,
  run 41589483637: "Historian returned no usable compartments." → repair →
  compartment published, 0 failures).
- e2e harness (`3b73594bc`, `7917d6bc4`, `e9e10eca2`, `ea6cbd2dc`, `0e624bfd0`):
  C1 accepts core's proactive trigger (threshold−2 = 63 %) but requires the
  context to have exceeded 65 % (trigger pct or prompt tokens / 40k); C3 compares
  the peak with the lowest later step; scenario C reads two files per turn (one
  file per turn let the proactive fold land before 65 %); the child scenario
  reads eight generated <8 KB files so compaction-basic must run its
  **summarizer** (round 17's big files were only pruned: 4 prune / 0 summary;
  round 18: 3 summary / 0 prune, child 0 Magic rows, 8/8 checksums returned);
  new checks C7/C8/C9.

Previous baseline (round 16, 2026-11-03, DSH 0.2.1-rc.5, core **v0.49.35** merged at
`3d9511f23`; push run 41531086184 and dispatch run 41531489091 (`e2e=true`)
@ `3d9511f23`): `typecheck:dsh` **0 errors**, core typecheck **0 errors**,
`dsh-plugin` **451 pass** (62 files; +4 = `child-session-compaction.test.ts`),
`adapter-api` **15 pass**, `contracts:dsh` **98 pass**, 0 fail; real-model
`e2e` **35/35 PASS**. The e2e does not drive a child session to its context
limit, so the round 16 child-compaction fix is verified by unit tests only.

Previous baseline (round 15, 2026-11-03, DSH 0.2.1-rc.5, CI `dsh-ci.yml` on bun 1.4.2
with the filtered install above, push run 41495367987 and dispatch run
41497195497 (`e2e=true`) @ `5f8fe562b`): `typecheck:dsh` **0 errors**, core
typecheck (`packages/plugin`) **0 errors**, `adapter-api` **15 pass**,
`dsh-plugin` **447 pass** (61 files), `contracts:dsh` **98 pass**, 0 fail
everywhere; the real-model `e2e` job passed all 35 checks (N*/T*/M*/P1, the
M5 warning did not fire). The filtered install is enough for a clean
typecheck; nothing else has to be installed. (Round 14: 433 / 15 / 98 at
run 41474648027 @ `19d79cb24`; round 13 local on bun 1.4.4: 425 / 15 / 98.)

Round 14 fixes (each with a unit test that was red before):
`--version` reads `package.json` (was a stale `0.2.0` copy);
Settings overlay — a DSH per-model threshold in the DSH-native spelling
(`deepseek-official/…`) now beats a jsonc key of the same model in the
canonical spelling (`deepseek/…`); dreamer re-discovers projects on every
tick (a fresh DB / a project first seen while the process runs used to stay
unscheduled until restart); `agent/created` session tracking writes the
resolved project identity instead of the raw cwd (the two writers used to
flip `session_projects.project_path`; existing raw-path rows are not
migrated); the compaction summarize hook is built per call (a cached hook
held the transcript snapshot of the first compaction, so a second compaction
of the same session in one process failed "summarize range unresolvable").

Round 15 fixes (one commit each, each with a unit test that was red before
unless noted):
- `b8a31a055` worker: the `agent/created` listener matches the worker's own
  child by a reserved `childId` (two concurrent workers of one parent used to
  apply each other's tool allowlist to both children).
- `84803faa8` session tracking: legacy raw-path `session_projects` rows are
  normalized once at startup (round 14 left existing rows unmigrated).
- `5b595e807` S6: unreplayable `dsh_pressure_truncations` rows are pruned at
  startup (dropped/compacted tags, sessions with no tags left; the per-session
  latch row is kept).
- `02c7623fe` outbox: reconcile closes `retryable` rows as abandoned instead of
  leaving them `pending` forever (they were counted as pending ops in the MC
  popover / context endpoint on every restart).
- `2719c0920` outbox: terminal rows (committed/abandoned) older than 14 days are
  pruned at startup.
- `a88ade224` remote: `magicContext/diagnostics` resolves the wire session id to
  the canonical key (it queried with the raw id and always reported zeros);
  `magicContext/context` no longer throws for an id containing `:`.
- `0281e49b9` settings: per-model threshold keys must be `provider/model`
  (<=256 chars, no `__proto__`/`constructor`), at most 64 entries, length cap on
  `historianModel`.
- `48b7a7988` historian: failures go through core `incrementHistorianFailure`
  (real count in the notice, failing state visible in the popover); background
  passes back off (1 min doubling to 15 min) instead of re-running a full LLM
  pass on every step above the threshold while the historian model is broken.
- `2979ddf51` context details: a stale `compartment_in_progress` flag (process
  killed mid-pass) only counts as "running" while an unexpired
  `compartment_state_lease` exists.
- `f1655e966` test-only: the `2979ddf51` test title had unescaped double quotes,
  a parse error that made CI run 41490193904 fail ("Unhandled error between
  tests"); the test is verified red against the pre-`2979ddf51` source.
- `f30066fdf` config hot reload: the agent plane re-reads `magic-context.jsonc`
  with a 3 s TTL (it read it once at apply time, so after a jsonc edit the
  settings page showed the new effective enabled/threshold while the agent kept
  the old values until restart). Mount-time knobs bridged by
  `bridgeMagicConfig` (memory/dreamer/compaction…) still need a restart.
- `5f8fe562b` unload/reload: the host entry releases this instance's liveness
  marker on dispose (an unloaded host in a still-running process kept the core
  migration guard refusing other processes' migrations); the marker is removed
  only while it still carries this instance's pid + `started_at`, so a reload
  that re-applied first keeps its own. The shared DB is intentionally not
  closed (core keeps one connection per path; a reload reuses it).

Round 16 fixes (each with a unit test that was red before):
- 子会话撞上下文上限的压缩路径对齐上游（`child-session-compaction.test.ts`）：上游 core
  对 `isSubagent` 会话不跑 historian（`event-handler.ts` 溢出时只记 `reportedLimit`）。
  DSH 里原生 `compaction-basic` 被 `MagicCompactionEngine` 替换（默认 `auto=true`），
  它的 `summarize()` 对所有会话都调 MC historian hook，于是子会话撞限时 historian 会
  给未打标的子会话写 `compartments` / `compartment_history_versions` /
  `dsh_context_compaction_marker`（修复前测试实测各 +1）。现在
  `MagicCompactionEngine.summarize()` 对子会话（`compat/dsh-0.1/child-session.ts`
  的 `isDshChildSession`，`isMagicChildSession` 现在直接委托它，同一个判定：
  `origin === 'subagent'` 或 `delegationDepth ≥ 1`）调 `super.summarize()`，即
  compaction-basic 自带的 LLM 摘要器（替换前的 stock 行为，经 `ctx.llm`，
  `purpose: "compaction"`），MC 不读不写库；`registerMagicHistorianPlane` 注册的
  wrapper 再加一道防线，收到子会话直接拒绝（不触库）。主会话路径不变。
  **待决「子会话撞限路径」由此关闭。** 上游的 reduced mode（子会话打标 / 对子会话
  开放 `ctx_reduce`）**暂未移植**：DSH 子会话仍完全跳过 MC 处理，只在压缩时走 stock
  摘要。

Round 15 scans with no confirmed bug (static analysis, plus the one empirical
check noted): **SQLite concurrency** — every DSH write goes through the one
connection opened by core `openDatabaseAsync` (WAL, `synchronous=NORMAL`,
`busy_timeout=5000`); core's tracked `db.transaction()` defaults writable
handles to `BEGIN IMMEDIATE` (verified: a second connection with
`busy_timeout=0` gets "database is locked" while a DSH transaction has only
run a SELECT), and the historian publish uses an explicit `BEGIN IMMEDIATE`,
so there is no deferred read→write upgrade (`SQLITE_BUSY_SNAPSHOT`) path.
Benign: `foldLegacyBareMessageTags` and the feedback watermark read before
their transaction (idempotent writes). **Unload** — dreamer interval (unref +
clear via `ctx.effect`), historian drain, system-guidance / remote disposers,
abort listeners and timers in embed/recomp/worker/auto-search are all
released. **Core boundary** — see "Upstream v0.49.35" under Open
compatibility points.

## CI (`.github/workflows/dsh-ci.yml`)

DSH 自己的 CI，只在本 fork 运行（`if: github.repository == 'ceyirelehe47/magic-context'`）。
上游的 `ci.yml` 在 fork 的 Actions 设置里禁用，**不要改上游的 workflow 文件**；`dsh-ci.yml`
是新文件，只存在于 DSH 分支上。能交给 Actions 的验证都交给它，本地只做快速迭代
（本地 2 核 / 8 GB 的沙箱跑全量 tsc 很慢，还容易被 OOM）。

| job | 何时运行 | 做什么 |
|---|---|---|
| `checks` | push 到 `dsh-integration` / `dsh-sync/**`，以及每次手动触发 | bun 1.4.2（与 `packageManager` 一致）→ filtered install（同 `upstream-sync.yml`）→ `typecheck:dsh` → core typecheck（`packages/plugin`）→ dsh-plugin 测试 → adapter-api 测试 → `contracts:dsh`；各步 `continue-on-error`，最后的 Summary 步骤汇总结果和 pass/fail 数，任何一步失败则 job 失败 |
| `e2e` | **只在** `workflow_dispatch` 且输入 `e2e=true` 时运行（消耗模型额度） | 真实 `@deepseek-ai/dsh` 0.2.1-rc.5 headless + OpenCode Go（与本地 r9–r13 相同的 `model-opencode-go.yml`：24k 主路由 + 200k historian 路由），见下文 |

`e2e` 的步骤（脚本都在 `packages/dsh-plugin/scripts/e2e/`）：

1. `bootstrap.sh`（`INSTALL_TIMEOUT=600`；runner 已有 bun 1.4.2，不会另外下载）→
   `bun run build` → `install-profile.sh test headless` → `setup --profile test` → `doctor`。
   全部装在 `$RUNNER_TEMP/e2e` 下（`E2E_ROOT`），不碰 runner 的全局 `~/.dsh`。
2. `ci-e2e.sh`：每次 `run-headless.sh` 都是一个新的 `dsh` 进程。
   - `selftest-normal`：`MAGIC_CONTEXT_DSH_WORKER_SELFTEST=1`，默认 worker 超时；
   - `selftest-timeout`：同上，`MAGIC_CONTEXT_DSH_WORKER_SELFTEST_TIMEOUT_MS=1500`；
     模型没调用 `ctx_worker_selftest` 时各重试一次；
   - `multi-1..3`：同一个会话跑三轮（中间两次进程重启），每轮之后用 `ci-db.ts` 导出该会话的 tags；
   - 解码两个子会话的 `session.v4.jsonl.zstd`，导出子会话在 Magic 各表中的行数，记录残留的 `dsh` 进程。
3. `ci-check.py redact`：把 `OPENCODE_API_KEY` 的字面值（只在内存里比对，不打印）、
   `sk-…` / `token=…` 一类的串和 `$HOME` 路径替换掉；`ci-check.py check` 写 `summary.md`
   （同时贴到 job summary），任何 FAIL 都会让 job 失败。
4. `actions/upload-artifact@v4` 上传 `$RUNNER_TEMP/e2e/ci`（脱敏后的 turn 日志、子会话事件、
   DB 导出、`summary.md`），名为 `dsh-e2e-<run_id>`，保留 7 天。一次运行约 30 KB，远低于 500 MB 上限。

检查项（`ci-check.py`）：

| id | 内容 |
|---|---|
| N0–N5, Nc1–Nc3 | 正常 worker：`ok:true`；子会话可见工具与实际请求里的工具 ⊆ `read/grep/glob`；`bash/write/edit/ctx_*` 在子会话作用域解析为 `child:false`（执行器会报 `UNKNOWN_TOOL`）；`workerText`、子会话 system prompt 和回复里都没有 `§N§`；子会话在 Magic 表里 0 行 |
| T0–T3, Tc1–Tc4 | 1500 ms 超时：`ok:false`；`workerLog` 写明 `worker timed out after 1500ms; child disposed`（复验 `502d74b94`）；子会话 `turn/end` 为 `aborted {kind: parent}`；子会话 0 行 |
| M0–M4 | 三个进程、同一个会话：每轮退出码 0；每轮之后 tag 号和 message id 都唯一、从 1 连续编号；重启前已有的 tag 号在之后的导出里都不变 |
| M5（WARN） | 模型回复开头的 `§N§` 当时没有被其他消息占用（属于模型行为，只告警） |
| P1 | 运行结束后没有残留的 `dsh` 进程 |
| Nc5 / Tc5 | 子会话的 `sandbox/mode` 事件，仅记录（见下文 worker 沙箱一节） |

触发与查看（本环境没有 `gh`，用 `apicall github`）：

```bash
# 手动跑一次 e2e（checks 也会一起跑）
apicall github workflow_dispatch owner=ceyirelehe47 repo=magic-context \
  workflow_id=dsh-ci.yml ref=dsh-integration inputs='{"e2e":"true"}'
apicall github workflow_runs_list_for_workflow owner=ceyirelehe47 repo=magic-context workflow_id=dsh-ci.yml per_page=5
apicall github workflow_run_jobs_list owner=ceyirelehe47 repo=magic-context run_id=<id>
apicall github workflow_job_logs_get owner=ceyirelehe47 repo=magic-context job_id=<job id>
apicall github workflow_run_artifacts_list owner=ceyirelehe47 repo=magic-context run_id=<id>
```

前提：仓库 secret `OPENCODE_API_KEY`（只通过 step 的 `env` 传入；GitHub 会在日志里把它
显示成 `***`；`ci-e2e.sh` 不用 `set -x`，也不打印环境变量）。没有设置这个 secret 时，
`e2e` 会在第一轮之前报错退出。

注意：`typecheck:dsh` 不覆盖 `*.test.ts`。测试文件里的语法错误只会在 `dsh-plugin tests`
一步表现为 `# Unhandled error between tests`（整个文件不运行，Summary 里多 1 fail），
round 15 的 run 41490193904 就是这样失败的。

Round 17/18 新增检查：

| id | 内容 |
|---|---|
| C0–C9 | 主会话（40k 路由，阈值 65 %，每轮新进程）：C1 historian 在 ≥63 %（阈值−2）触发且上下文确实超过 65 %；C2 写出 compartments；C3 峰值之后的最低 prompt tokens 低于峰值；C4 暗号仍可答出；C5 可见输出无 `§N§`；C6 compartments 连续不重叠、无存活 lease、historian 非 running/failed；C7 缓存 m0 的 `<session-history>` 含 compartments（及暗号那段）；C8 m0 的 `<session-history>` 含暗号时 cmp-q 答出暗号（检索调用只记录，不判定；第 19 轮起）；C9 解码后的会话事件中同一 tag 的 `[dropped §N§]` 不重复 |
| U1–U6 | ctx_search / ctx_memory / ctx_expand 各调用一次且有结果；设置页 / popover 读数与 DB 一致；`/ctx-status` 与 DB 一致（无 OpenCode DB 横幅、Last input tokens ≠ 0、Last response ≠ never）；doctor 干净 |
| S0–S7 | 子会话（24k 路由）读 8 个生成的 <8 KB 文件：委派成功；compaction-basic 走到 **summary**（不只是 prune）；摘要不是 MC 输出；子会话在 Magic 表 0 行；父会话增长只属于自己；子会话 completed；≥6/8 个 CHECKSUM 回到父会话或子会话最终回复 |
| C10 | （round 19）e2e 专用开关把 scenario C 第一次 historian 输出换成截断的 XML（只一次，O_EXCL 标记文件）：之后出现 `historian repair retry`，compartment 仍写出，historian 无失败 |
| R0–R6 | （round 19）scenario P，100k 主会话路由：R1 MC 管理的主会话里没有低于 65 % 的原生压缩；R2 MC historian 先触发（≥63 %，阈值 65）；R3 会话越过旧默认阈值（30.4 %）时没有原生压缩；R4 旧策略（显式写入 compaction-basic 默认值）实测在 65 % 之前原生压缩；R5 所有日志里没有 "leaving no pressure budget"；R6 引擎每步打印的有效主会话阈值 ≥ 65 % |

Round 19：dispatch run 41586948399 @ `9d16d6fab`（2 FAIL：R2，读结果被截到 ~8 KB 且模型自己 ctx_reduce，P 只到 52 %；R4，headless 不打印 ctx.logger）→ 41589483637 @ `34e728b60`（2 FAIL：R4，80k 上 DSH 默认值本身非法：retain 12144 ≥ 阈值 10368；R6 首个 pre-step 没有 header；C10 **PASS**）→ 41591017319 @ `0eb2e69c4`（R0–R6 **全过**；C 场景因模型每轮 ctx_reduce、峰值 61 % 而失败 8 项）→ 41592114076 @ `6615a8d5b`（64/65；仅 C8 失败：模型答对暗号但先调了一次 `ctx_search`，属模型行为。C8 改为只判答案 + m0 含暗号，检索调用仅记录）。

Round 18：dispatch run 41550425336 @ `e9e10eca2`（1 FAIL：C1，主动触发在 61.7 % 就压缩，未超过 65 %）→ 41552779443 @ `0e624bfd0`（1 FAIL：C6，historian XML 无效且没有 repair 重试）→ 41554794748 @ `f8c663fee`（**57/57 PASS**）。注意 41554794748 的 C1 是靠触发点的投影值 66 % 通过的，实际发出的 prompt 峰值 52.5 %（同一 pre-step 的 drop 已落地）；实测 prompt 超过 65 % 的是 41552779443（74.2 %）。

Round 15：push run 41495367987 @ `5f8fe562b`（`checks` 全绿：dsh-plugin 447 / adapter-api 15 /
contracts 98，两个 typecheck 0 错误）；dispatch run 41497195497（`e2e=true`，`checks` + `e2e`
全部 PASS，35 项检查无 FAIL）。

首次结果（round 14）：push run 41464023149（`checks` 全绿：dsh-plugin 425 / adapter-api 15 /
contracts 98，typecheck:dsh 和 core typecheck 均 0 错误）；dispatch run 41464255692
（`e2e=true`，`checks` + `e2e` 全部 PASS，`T2` 在真实 rc.5 上确认了 `502d74b94` 的超时原因日志）。

## Syncing with upstream

### Automatic (`upstream-sync.yml`)

Schedule (Mon 03:17 UTC) or manual dispatch (`strategy: rebase|merge`,
optional `tag`). Runs **only** when `github.repository` is this fork.

1. fetch upstream tags; target = newest `vX.Y.Z` (or the given tag);
2. exit if `dsh-integration` already contains it;
3. `rebase --onto <tag> <merge-base>` (or merge) on `dsh-sync/<tag>`;
4. filtered install → `typecheck:dsh` → `test:dsh` → `contracts:dsh`;
5. all green → push `dsh-sync/<tag>` to the fork (never master /
   dsh-integration); otherwise open/update an issue labelled `dsh-sync` in the
   fork with the failing step logs and conflicting files.

A human fast-forwards `dsh-integration` to a green `dsh-sync/<tag>`.

### Manual

```bash
git remote add upstream https://github.com/cortexkit/magic-context.git
git fetch upstream --tags
git checkout -b dsh-sync/vX.Y.Z dsh-integration
git rebase --onto vX.Y.Z $(git merge-base dsh-integration vX.Y.Z)
# conflicts can only be in the files listed under "上游 core 改动清单" below:
# root package.json / bun.lock / README.md and three small core files in
# packages/plugin (everything else is new: adapter-api, dsh-plugin, docs/, upstream-sync.yml)
bun install --lockfile-only   # regenerate bun.lock if root/workspace deps moved
bun run typecheck:dsh && bun run test:dsh && bun run contracts:dsh
```

Triage order when something breaks:

1. **core import surface** (`core-import-surface.contract.test.ts`) — a core
   export the adapter calls was renamed/removed. Find the replacement in core
   (`git log -S<name> vOLD..vNEW -- packages/plugin/src`) and port the call
   site; mirror what the Pi adapter (`packages/pi-plugin`) did — Pi is the
   closest sibling harness.
2. **tsc errors in `src/agent/*`** — core signature changes (as with
   `applyPendingOperations`, `executeStatus`, `buildDreamTaskRuntimeConfigs`
   in 0.49).
3. **behavioural test failures** — core semantics changed (e.g. 0.49 seeds
   dreamer schedules only once a project has input). Update the test when the
   new core behaviour is intended; fix the adapter when it is not.

### DSH upgrades

All `@deepseek-ai/*` vocabulary is supposed to live behind
`src/compat/dsh-0.1/` (name kept for history; it now targets 0.2). A DSH bump:

1. bump the exact versions in `packages/dsh-plugin/package.json`
   (dev + peer) and `DSH_COMPAT_EXPECTED_VERSION`;
2. `bun install` → `bun run typecheck:dsh`. `src/contracts/dsh-api.contract.ts`
   pins every DSH interface shape the adapter relies on; a failing
   `Assert<…>` line names the exact contract that moved;
3. fix the compat layer first, then call sites;
4. `bun run test:dsh`, then a real-DSH smoke (see "E2E scripts (real DSH, Linux)" below; `docs/dsh/e2e/README.md` is the historical 0.1 harness).

## 下游发行版（downstream distribution）

`dsh-integration` 不是一次性移植，而是持续吸收官方 Magic Context 发布的下游发行版：
core 原样来自上游 release tag，DSH 层（`packages/adapter-api`、`packages/dsh-plugin`、
`docs/dsh`）叠加在上面。

### 版本命名

- 发行版版本：`<upstream>-dsh.N`，例如 `0.49.35-dsh.1`。`<upstream>` 是 core 所基于的
  上游 tag（去掉 `v`），`N` 在同一上游版本上的每次 DSH 发布递增，换上游版本时重置为 1。
  DSH 基线（当前 0.2.1-rc.5）写进发布说明，不进版本号。
- git tag 用 `dsh/<upstream>-dsh.N`（例如 `dsh/0.49.35-dsh.1`）。**不要用 `v*` 或
  `dashboard-v*`**：fork 里保留着上游的 `release.yml`（`push: tags: v*`）和
  `dashboard-release.yml`（`dashboard-v*`），这类 tag 一推就会在 fork 上跑上游的发布流程。
- `packages/dsh-plugin/package.json` 的版本号按此规则：round 14 为 `0.49.34-dsh.1`，
  round 16 合并上游 v0.49.35 后为 `0.49.35-dsh.1`，打 tag 时用同一个号（`dsh/0.49.35-dsh.1`）。`dsh-magic-context --version` 直接读
  `package.json`，不再单独维护一份；`src/doctor/cli-version.test.ts` 同时检查版本号符合
  `<upstream>-dsh.N`。`bun.lock` 里 workspace 条目的 `version` 在 round 16 手工对齐
  （`dsh-magic-context` 0.49.35-dsh.1，cli / plugin / pi-plugin 0.49.35，只改这 4 行；
  v0.49.35 没有依赖变化，所以没有重新生成 lockfile）。

### 同步节奏

- 上游：`upstream-sync.yml` 每周一 03:17 UTC 自动检查最新 `vX.Y.Z`；上游发布后也可以
  手动触发（`workflow_dispatch`，可指定 `tag`）。只同步正式 release tag，不跟上游
  `master`。
- DSH：只在 DSH 发布新版本时升级（见上文「DSH upgrades」），与上游同步分开做，
  一次只动一边，出问题时容易定位。
- 上游连续发布多个补丁时，可以直接同步到最新的那个，不必逐个跟。

### `dsh-sync/<tag>` 分支的验收流程

1. **CI 门**：`upstream-sync.yml` 在 `dsh-sync/<tag>` 上跑过 filtered install →
   `typecheck:dsh` → `test:dsh` → `contracts:dsh`，全部通过才会推送该分支；
   失败时会在 fork 里开或更新标记为 `dsh-sync` 的 issue，分支不会推送。
2. **冲突面核对**：`git diff --stat <tag> dsh-sync/<tag> -- . ':!packages/dsh-plugin'
   ':!packages/adapter-api' ':!docs/dsh'` 的结果应仍只有下面清单里的文件。
   出现新文件就说明 rebase 时把 DSH 改动带进了 core，或者上游改了我们改过的地方，
   需要人工审一遍。
3. **测试基线**：数字不能低于上一次的基线（见上文 Baseline）；有测试被删或被跳过，
   必须在提交信息里说明理由。
4. **真实 DSH 冒烟**（`packages/dsh-plugin/scripts/e2e/`，Linux）：`bootstrap.sh` →
   `bun run build` → `install-profile.sh` → `setup --profile test` → `doctor` →
   `run-headless.sh` 至少跑三轮：普通回合（§N§ 连续不重复）、`ctx_reduce` drop
   落地、historian 压缩发布。用 `inspect-db.ts` 核对 `harness='dsh'` 行。结束后确认
   没有残留的 `dsh` 进程。
5. **合入**：以上都通过后，把 `dsh-integration` 快进（rebase 策略下是
   `reset --hard origin/dsh-sync/<tag>` 再 `push --force-with-lease`，命令见该 workflow
   的输出），然后打 `dsh/<upstream>-dsh.1` tag，并写发布说明（上游版本、DSH 基线、
   测试数字、已知限制的变化）。

### 上游 core 改动清单（冲突面）

对比上游 tag `v0.49.35`（`git diff --numstat v0.49.35 dsh-integration`，round 16 合并后复核，仍是这 3 个文件，排除
`packages/dsh-plugin`、`packages/adapter-api`、`docs/dsh`）：

| 文件 | 改动 | 说明 |
|---|---|---|
| `packages/plugin/src/shared/harness.ts` | +4 / −1 | `HarnessId` 增加 `"dsh"`（加注释） |
| `packages/plugin/src/features/magic-context/subagent-token-capture.ts` | +2 / −0 | `hostLabel` 的 `dsh` 分支（`"DeepSeek Harness"`），`switch` 穷尽性要求 |
| `packages/plugin/src/shared/prompt-surface-runtime.ts` | +2 / −2 | `dsh` 和 `opencode2` 一样回落到 `opencode` 的旧配置目录 |
| `package.json`（根） | +3 / −0 | `typecheck:dsh`、`test:dsh`、`contracts:dsh` 脚本 |
| `bun.lock` | +151 / −3 | 新 workspace 包与 `@deepseek-ai/*` 依赖；冲突时用 `bun install --lockfile-only` 重新生成，不要手工合并 |
| `README.md`（根） | +27 / −0 | DSH 安装说明的折叠块 |
| `.github/workflows/upstream-sync.yml` | 新文件 | 只在 fork 上运行 |
| `docs/DSH-MAINTENANCE.md` | 新文件 | 本文档 |

真正的 core 代码改动只有前三项，共 8 行增、3 行删。新增 core 改动之前，先确认能否
放进 DSH 层；如果必须改 core，就在这张表里补一行。

### fork 上会运行的上游 workflow

把 fork 的默认分支设为 `dsh-integration` 之后：

- `ci.yml` 的 `schedule`（每天 03:17 UTC）会在 fork 上跑。定时任务总是使用默认分支上的
  workflow 文件，也就是 `dsh-integration` 里的上游 `ci.yml`：二十来个 OpenCode/Rust/
  dashboard 任务，与 DSH 无关，耗 Actions 额度，而且容易因为缺少上游的 secrets 而报红。
- `smoke-opencode-linux.yml` 没有定时触发，但会在 fork 的 `pull_request`，以及向
  `master`/`main`/`train/**` 推送时运行（例如在 GitHub 上点「Sync fork」更新 fork 的
  `master`）。
- `release.yml`（`v*` tag）、`dashboard-release.yml`（`dashboard-v*` tag）会在推送
  对应 tag 时运行，所以发行版 tag 必须用 `dsh/…`（见上文）。

**推荐做法**：在 fork 的 Actions 页面（Actions → 选中该 workflow → 右上角 `…` →
*Disable workflow*）禁用 `CI` 和 `Smoke (opencode bring-up on Linux)`，需要的话把发布类
workflow 一起禁用。**不要修改上游的 workflow 文件**：每次改动都会在下一次同步时变成
额外的冲突面。禁用是仓库设置，不在 git 里，同步不会影响它。`upstream-sync (DSH)`
保持启用。

### S6（已在 round 15 `5b595e807` 修复）：`dsh_pressure_truncations` 不会被清理

> 现在 adapter 启动时会在一个 IMMEDIATE 事务里删除 tag 已 dropped/compacted 的行和已无任何 tag 的会话的行（保留 active tag 的行、tag 行缺失的行，以及每个会话 `basis_usage_seq` 最大的那一行）。下面是修复前的描述，仅供参考。

压力截断的决定按 `(session_id, tag_number)` 持久化在 `dsh_pressure_truncations`
（见下文 Known limitations 中的压力截断一条），之后每一轮都按这些行逐字节重放。
目前没有任何代码删除这些行：会话删除、tag 被 drop、historian 压缩把对应内容移出
surface 之后，行都会留在共享 SQLite 里（dropped 的 tag 只是不再重放）。每行只有几个
整数和一个 sha256，增长量与「被截断过的 tag 数」成正比，正确性不受影响，但库会单调
增长。修复方向：在会话清理路径（core 的 `pending_session_cleanup`）或 adapter 启动时，
删除会话已不存在、或 tag 已 dropped 的行。修复前，需要的话可以手动
`DELETE FROM dsh_pressure_truncations WHERE session_id = ?`。

## `setup` / `doctor` (0.2 profile layer)

`dsh-magic-context setup|doctor` is the package bin (`dist/cli.js`, built
from `src/doctor/cli.ts`; `@deepseek-ai/cordis` is inlined so it runs outside
a DSH tree). It is **not** a `dsh` sub-command.

```bash
dsh-magic-context setup  [--dsh-home <dir>] [--dsh-install <dir>] [--profile <name>] [--dry-run]
                         [--preset <id>[,<id>]]... [--all-presets] [--disable-preset <id>]...
dsh-magic-context doctor [--dsh-home <dir>] [--dsh-install <dir>] [--profile <name>] [--directory <dir>]
                         [--preset <id>]... [--all-presets] [--disable-preset <id>]...   (expectations)
```

### Native pressure compaction (round 19)

`setup` leaves the `magic-compaction` row at `{ auto: true }` and prints the
effective native pressure policy; `doctor` reports it as
`native-pressure.<profile>` (merged over every `magic-compaction` row of the
patch layer, nested inserts included):

- main sessions: MC-led — `headroomTokens 0`, `thresholdRatio` = MC's force
  band for the route (85 % at the default 65 % execute threshold; per route
  `max(85, execute + 2)`), so native compaction is only the backstop behind
  MC's historian / drops;
- child sessions: DSH native (`0.8` / `65 536`), with headroom 0 when that is
  illegal for the window (24k/40k/80k → 80 %);
- user-set top-level `thresholdRatio` / `headroomTokens` / retention and
  per-route `modelPolicies` win; `doctor` WARNs when they make a 128k main
  session compact before 65 %.

### Enabling Magic Context per agent preset

Web profiles compose several **agent presets** (UI "modes": `standard`,
`ptc`, `minimal`, `cordis` = Creator mode). Magic Context is enabled per
preset; flat (headless/tui) profiles have a single pseudo-preset `root`.

| flag | effect |
|---|---|
| *(none, first run)* | web: generate `magic-standard` (a clone of `standard` with Magic) and enable only that; flat: `root` |
| `--preset standard,ptc` (repeatable, comma lists ok) | **add** these stock presets to the current selection — the stock preset rows are patched in place (`compaction-basic` disabled, `magic-compaction` + `magic-agent` inserted) |
| `--all-presets` | enable every stock preset found in the installed layout (all except the generated `magic-standard`) |
| `--disable-preset ptc` (repeatable) | **remove** these presets from the selection; their stock rows are restored |
| *(none, later runs)* | keep the recorded selection and just refresh the block |

The selection is recorded in the managed block itself
(`# magic-presets: cordis,minimal,ptc,standard`), so every run adds/removes
relative to what is there. An empty selection removes the whole block (Magic
fully off for the profile, native compaction and meter back). New sessions of
a changed preset pick the change up; running sessions keep their composition
until restarted.

`doctor` reports every preset of the profile as `enabled`/`disabled` (plus
`unsupported (<why>)` for presets whose stock layout has no compaction group)
and which composer indicator is active. Passing the same flags to `doctor`
turns them into expectations — e.g. `doctor --disable-preset ptc` fails if
`ptc` is still enabled. `magic-standard: disabled` simply means the generated
clone is not in use (stock presets are patched instead).

Verified on real rc.5 (round 8, `docs/dsh/e2e/evidence-round8/`):
`setup --disable-preset ptc` leaves `cordis`/`minimal`/`standard` enabled and
reports `ptc: disabled`; the composed tree (`dsh --dump-config`) has
`preset-ptc` back on stock `compaction-basic` with no magic rows while the
other three keep `compaction-basic: disabled` + `magic-compaction`/
`magic-agent`, and `magic-meter.magicPresets` drops `ptc`. `doctor
--all-presets` fails (rc=1) while `ptc` is off; `setup --all-presets`
restores it and the profile patch comes back byte-identical.

How `setup` works (`src/doctor/setup.ts`, `profile-wiring.ts`, `env.ts`,
`compat/dsh-0.1/profile-patch.ts`):

1. **Locate the DSH install through the launcher.** DSH 0.2 ships no
   `config/agent-presets` tree; every bundle is a dependency of the
   `@deepseek-ai/dsh` launcher package. Candidate order: `--dsh-install`,
   `$DSH_INSTALL_DIR`, the `dsh` executable on `PATH` realpath'd up to its
   package root (what `dsh` actually boots), `$DSH_HOME/profiles/node_modules/…`
   and `$DSH_HOME/profiles/<name>/node_modules/…`, then global bun/npm roots.
   Stock patch files are resolved from that launcher's dependency tree.
2. **Pick the profile**: `--profile`, or the only profile under
   `$DSH_HOME/profiles` (`DSH_HOME` empty = `~/.dsh`). Several profiles and no
   flag → it asks for `--profile`.
3. **Contract-scan the stock layout** for the profile's flavour — flat
   (headless/tui): `@deepseek-ai/dsh-base/cordis.patch.yml` root
   `compaction-basic`; web: `@deepseek-ai/dsh-web-app` `preset-standard`. A
   mismatch **fails closed**: nothing is written.
4. Add `dsh-magic-context` to the profile `package.json`
   `dsh.profile.bundles` — only when the package is resolvable from that
   profile (otherwise it refuses).
5. **Write the managed block** into the profile's own patch layer
   `$DSH_HOME/profiles/<name>/cordis.patch.yml` (applied after every bundle
   layer). The block is delimited by

   ```yaml
   # >>> dsh-magic-context (managed by `dsh-magic-context setup`; do not edit inside) >>>
   # magic-presets: root
   - id: compaction-basic
     disabled: true
   - id: token-meter
     disabled: true
   - insert:
       - id: magic-compaction
         name: dsh-magic-context/compaction
         config:
           auto: true
       - id: magic-agent
         name: dsh-magic-context/agent
       - id: magic-meter
         name: dsh-magic-context/meter
         config: { flat: true }
   # <<< dsh-magic-context <<<
   ```

   (flat layout; web layouts instead get one `- id: preset-<id>` row per
   enabled stock preset — the stock preset's plugin list with
   `compaction-basic` disabled and `magic-compaction`/`magic-agent` added —
   plus `token-meter: disabled` and the `magic-meter` row with
   `magicPresets: [...]`). Re-running replaces the block in place
   (`mergeManagedBlock`) and keeps every user row outside it; a flow-style
   non-empty list is refused. `--dry-run` prints the block and writes
   nothing. Put your own overrides (e.g. `magic-agent` `historian.model`)
   **outside** the block, as separate `- id: magic-agent` rows.

   **DSH's settings writer.** Saving anything on the DSH Settings page
   (including the Magic Context section) makes DSH re-serialise the profile
   patch file and append the changed row at the end of the file. `setup`
   therefore always leaves an *edit anchor* row after the block, compares the
   block semantically (a re-serialised block is still "up to date"), and
   moves foreign rows that DSH appended *inside* the block back out (doctor
   reports them as a warning first).
6. Create `~/.config/cortexkit/magic-context.jsonc` from defaults once; an
   existing file is never overwritten (only missing recommended keys are
   hinted).

`doctor` re-derives the same plan and checks: DSH version == exact
`DSH_COMPAT_EXPECTED_VERSION` (0.2.1-rc.5); bundle present in the profile;
**profile wiring** — the managed block exists and equals the rows derived
from the *current* stock layout (fails on "never set up", "Magic rows present
but not in the managed block (hand-written layer)" and "managed block is
stale"); shared DB open classification (schema fence / migration guard /
fatal) + liveness markers; config load outcome. After a DSH upgrade run
`doctor`, and if the block is stale just re-run `setup`.

Reference outputs: `docs/dsh/e2e/evidence-0.2.1-rc.5/{setup.txt,doctor.txt,profile-cordis.patch.yml}`.
The old hand overlay is kept only for diffing:
`packages/dsh-plugin/scripts/e2e/manual-overlay-headless.yml`.

## DSH Settings page (Magic Context section)

The `magic-host` row (host bundle `cordis.patch.yml`) declares a small
**volatile** Cordis config; DSH's settings service (`@deepseek-ai/dsh-settings`)
publishes it as the settings namespace `magic-host` (`applies: live`), and the
client bundle renders an editable **Magic Context** section on the Settings
page (`settings.section` slot + `plugins.bundle.config`). Fields (all optional;
*unset = inherit*):

| field | type / bounds | inherits from (jsonc) |
|---|---|---|
| `enabled` | boolean — live: pauses per-step Magic work | `enabled` |
| `historianModel` | `provider/model` string | `historian.model` (then `historian.opencode.model`) |
| `historianAwaitAtTurnEndMs` | 0–60000 ms | env `MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS`, else 0 |
| `executeThresholdPercentage` | 20–90 % | `execute_threshold_percentage` (number form) |
| `executeThresholdByModel` | `provider/model` → 20–90 % (DSH or canonical form) | merged over jsonc per-model `execute_threshold_percentage` keys |
| `protectedTokens` | 4000–1000000 | `protected_tokens` (else core's derived default) |

**Precedence (one-way overlay, never a sync):**
**DSH override > `magic-context.jsonc` (project > user) > core default.** A
field set in DSH wins; an unset field inherits the jsonc value; an unset jsonc
key falls back to the core schema default. DSH never writes the jsonc file
(other harnesses share it); "reset to jsonc" = unset the DSH field. The force
(execute + 20, capped) and emergency (95 %) bands are derived from the
effective execute threshold exactly as in core.

Wire: the client talks to the `magicContext/*` Typert endpoints of the
`magic-remote` row — `settings` (effective values with a `source` per field:
`dsh` / `jsonc` / `default`, bounds, jsonc path, revision) and
`updateSettings({ ops: [{op:"set"|"unset", path:[field], value}],
expectedRevision })`. `updateSettings` goes through `settings.mutate`, which
writes a `- id: magic-host  config: {…}` row into the **active profile's**
`cordis.patch.yml` (outside the managed block) and refreshes the volatile
config in place — readers dereference it on every use, so the next agent
step uses the new value without a remount. A stale `expectedRevision` returns
`conflict` with the reloaded view (the page rebases and asks to save again).

**Where the section lives in the rc.5 web UI.** rc.5 has no URL route for
Settings: it is a body-portaled modal owned by
`@deepseek-ai/dsh-client-ui-settings-general` (it occupies
`sidebar.settings` and renders exactly one `settings.section` entry at a time,
`renderSlot("settings.section", { close }, { only: activeId })`). It opens
from the sidebar settings launcher (account menu) or the `settings.open`
shortcut (`Cmd/Ctrl+Alt+,` on web macOS/Windows; rc.5 ships no web-Linux
default). The nav lists every registered `settings.section` entry by its
`label`; ours is `id: "magic-context"`, `order: 60`. The same form is also
mounted as `plugins.bundle.config` on the bundle's page in **Plugins**.

**Why the popover link opens Plugins, not the Settings section.** A plugin
cannot open the Settings modal at a section in rc.5: the shell's
`openSection(id)` is only handed to `settings.onboarding` steps, and the only
navigation service plugins get, `pluginNavigation` (provided by
`dsh-client-ui-plugin-manager`), has just `openList()` and
`openBundle(packageName)`. DSH's own voice-input plugin uses
`openBundle(...)` for its "open settings" action, so the meter popover does
the same (`openBundle("dsh-magic-context")` → Plugins → our bundle, where
`plugins.bundle.config` shows the same editable form). When
`pluginNavigation` is missing the link turns into the text hint
"Open Settings → Magic Context".

Verified live on rc.5 (round 8, `evidence-round8/settings-section.json`,
`r8-settings-*.png`): Account menu → **Settings** opens the modal; its nav
lists General, Models, Built-in plugins, Agent presets, **Magic Context**.
The Magic Context entry renders the status card and the editable form;
Execute threshold → Override → `55` → Save wrote the `magic-host` row
(effective 55, source `dsh`, revision 1), and Inherit → Save removed it
again. While an agent turn was running on the (heavily loaded) test sandbox
the Save button stayed on "Saving…" for more than 3 s although the row was
already written; it completed on its own.

Verified live on rc.5 (round 8, `docs/dsh/e2e/evidence-round8/settings-live.json`):
`updateSettings set executeThresholdPercentage=50` wrote
`- id: magic-host / config: { executeThresholdPercentage: 50 }` into the
profile patch and `settings`/`context` reported 50 (source `dsh`); the ring
stayed grey at 54 % until the next agent step, then turned yellow
(`ckmc-warn`) at 56 %; the popover showed `Execute threshold 50 % · 12K`
and a Nudge line with the band name only (`none · note nudge pending`, no raw
JSON). A stale revision answered `conflict` (expected 0, actual 1, fresh view
attached); `5` (out of bounds) and an unknown field answered `invalid` and
wrote nothing. `unset` removed the row and both endpoints fell back to 65
(source `jsonc`).

## Magic Context composer meter (replacing the native context indicator)

Goal: the composer's context ring shows Magic Context's view (yellow at the
MC execute threshold, red near force, click → MC details) instead of DSH's
native one.

How it works (`entries/meter.ts`, `host/meter.ts`, `client/client.js`):

- `setup` disables the stock **`token-meter`** row and inserts **`magic-meter`**
  (`dsh-magic-context/meter`). `magic-meter` mounts the **real
  `@deepseek-ai/dsh-token-meter`** inside a child scope whose
  `sessionProjections` is a renaming facade: the unit TokenMeter registers as
  `contextPressure` is re-registered as **`magicContextPressure`**, its wire
  view extended with the MC thresholds (`executePercentage`,
  `forcePercentage`, `emergencyPercentage`, mode), `managed` (is this session's
  agent preset in `magicPresets` / flat) and `enabled`. Every other
  projection (`tokenUsage`, `contextBreakdown`, …) passes through unchanged.
- **Why rename instead of just disabling token-meter:** the stock web client
  renders its native ring whenever a `contextPressure` projection exists, so
  that key must disappear; but **`tool-result-pruner` injects `tokenMeter`**
  (`static inject = ["tokenMeter"]`, it prices pruned nodes with
  `tokenMeter.estimateMessage`). Disabling token-meter outright would leave
  the pruner — and anything else injecting `tokenMeter` — pending forever.
  Running the real TokenMeter under a renamed projection keeps the
  `tokenMeter` service global and the pruner alive, while the native ring
  sees no `contextPressure` and stays hidden.
- If the stock `token-meter` row is still mounted (setup not run / hand
  patch), `magic-meter` never provides a second `tokenMeter`; it only adds
  `magicContextPressure` beside the native key (both rings show) and logs a
  hint to run setup.
- The client registers a `conversation.composer.dock` component: a ring + %
  (`ckmc-meter`), **yellow ≥ execute**, **red ≥ force − 3**; clicking opens a
  popover fed by `magicContext/context` (thresholds, system/tools/conversation
  breakdown from `contextBreakdown`, compartments + historian state, pending
  drops/outbox, tag counts, m0/m1 knowledge tokens, nudge band) with a link to
  the Settings section through `pluginNavigation`. Unmanaged sessions (preset
  not enabled) get no MC ring.

## Historian configuration

The historian runs as a background pass fired from the pre-step chain when
context pressure crosses `historian.executeThresholdPercentage` (proactive
floor = threshold − 2). Config lives on the **`magic-agent` row**
(cordis plugin config), e.g. in the profile patch layer or a `--patch` file:

```yaml
- id: magic-agent
  config:
    historian:
      model: opencode-go-big/deepseek-v4.1-flash   # provider/model, large-window route
      executeThresholdPercentage: 40
      awaitAtTurnEndMs: 60000                      # optional, headless only
```

- **`historian.model`** (`provider/model`) routes the compartment call (and
  the Magic compaction summarize hook) to a dedicated route. Point it at a
  **large-window** route: the compartment prompt alone is ~60 KB (~18k
  tokens), so a small-window main route fails with `finish=max-tokens` after
  ~1 output token (the error message says "point historian.model at a
  larger-window route"). Without it the current session route is used.
  Fallback when unset on the row: core config `historian.model` (legacy flat
  string) or `historian.opencode.model` (string or `{ model }`) — DSH reads
  the `opencode` harness block because DSH refs are `provider/model`.
- **Drain** (`agent/historian-drain.ts`). Passes are fire-and-forget, and
  `dsh headless` exits right after the turn (~5 s shutdown budget), which
  used to kill the pass mid-flight (`reclaimed compartment lease from dead
  owner`, no compartment written). Two bounded waits, neither cancels the pass:
  1. on plugin unload: wait up to `UNLOAD_DRAIN_MS` = 4000 ms (always on);
  2. at the turn boundary (`agent/turn-stopping`, which DSH awaits): wait up
     to **`historian.awaitAtTurnEndMs`**, falling back to env
     **`MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS`**. Config wins over
     env; non-positive / unset = **off** (default). It also re-evaluates the
     trigger with the final pressure. Enable it only for headless/one-shot
     runs — interactive surfaces (web/tui) must not stall the turn end.

## E2E scripts (real DSH, Linux)

`packages/dsh-plugin/scripts/e2e/` (the Linux/0.2 harness; `docs/dsh/e2e/`
keeps the original Windows/0.1 notes, helpers and the 0.2.1-rc.5 evidence).
Everything is isolated under `E2E_ROOT` (default `~/w/e2e`): `dsh/` = local
`@deepseek-ai/dsh` install, `home/` = scratch `DSH_HOME`, `xdg/` = XDG dirs
(Magic SQLite + user config). Nothing global (`~/.dsh`, `~/.config`) is touched.

```bash
cd packages/dsh-plugin
scripts/e2e/bootstrap.sh                 # bun 1.4.4 + filtered workspace install + local DSH (DSH_VERSION, default 0.2.1-rc.5)
bun run build                            # dist/ (required by install-profile)
scripts/e2e/install-profile.sh test headless   # profile "test" from the headless template; packs + extracts the plugin,
                                         # symlinks node_modules/@deepseek-ai to the launcher install (single module
                                         # instances), copies the ai-tokenizer runtime dep
source scripts/e2e/env.sh
node dist/cli.js setup  --profile test   # managed block in $DSH_HOME/profiles/test/cordis.patch.yml
node dist/cli.js doctor --profile test
export OPENCODE_API_KEY=...              # real model runs only
scripts/e2e/run-headless.sh "<task>" [session-id]   # -> $E2E_ROOT/logs/run-<n>.log, prints rc/elapsed
bun scripts/e2e/inspect-db.ts [db-path]  # harness attribution, compartments, historian_runs, tags
```

`run-headless.sh` always applies `model-opencode-go.yml` (OpenCode Go:
`opencode-go` 24k window to create real pressure, `opencode-go-big` 200k
window as the historian route, `magic-agent.historian.model` set to it).
Knobs: `PROFILE` (test), `EXTRA_PATCH` (extra `--patch` file),
`MC_HISTORIAN_THRESHOLD` (default 40), `RUN_TIMEOUT` (240 s),
`MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS` (default **60000** in this
script), `MAGIC_CONTEXT_DEBUG_HISTORIAN` (1), `OPENCODE_SESSION` (random).

## Known limitations

1. **Surface replacement turns assistant content into `user` role.** DSH
   never lets a plugin rewrite a message in place; tagging/drops are applied
   as surface-replace ops, and folded tool results *and their tool-call
   assistant message* land in the following `user` message
   (`agent/transcript.ts`). This is a DSH design constraint, not a bug to fix
   in the adapter.
   Observed on real rc.5 (round 7): after the first tool step the surface
   holds the folded `[tool: …]` user message *and* a Magic-sourced re-tagged
   copy of the user prompt (`§2§ …`, `source.kind: "magic-context"`) after
   it. The model still answers correctly, but the ordering is a side effect
   of range replacement worth watching on long sessions.
2. **Core borrows the `opencode` model harness** (`historian.opencode`,
   `dreamer.opencode`); there is no first-class `dsh` harness in core. See
   open point 1.
3. **Worker tool allowlist — verified on real rc.5 (round 13 locally, round 14 in
   CI `dsh-ci.yml` e2e N*/T*), still not used by any production path.** See open
   point 2. **Worker sandbox:** the child runs with the parent's
   `sandbox/mode` (`workspace-write` in the test profile) and `approval/policy
   never`. This is rc.5's native delegation behaviour, not ours:
   `@deepseek-ai/dsh-subagent` `lib/index.js` `SubagentRuntime.startActivation`
   → `startLocal()` calls `captureDelegatedPolicyOverrides(parent)`
   (`sandboxMode = sandboxPolicy.overrideOf(parent.session)`, approval pinned to
   `never`), and the child `setup` in `materializeTracked()` calls
   `appendDelegatedPolicyOverrides(child.session, …)`, which appends
   `sandbox/mode {source: "delegation"}`. `runMagicWorker` passes no sandbox
   parameter (`SubagentStartRequest` has none in rc.5); its `agent/created`
   listener re-appends the same captured pair, which is why child logs show
   `sandbox/mode` + `approval/policy` twice (seq 1–2 from DSH, 3–4 from us,
   identical values). Left as is: a read-only child would need a DSH-side
   option; the worker's write capability is already removed by the tool
   allowlist (no `bash`/`write`/`edit` resolvable in the child scope).
4. **No bubblewrap on the verification machine.** The Linux sandbox used for
   the e2e runs has no `bwrap`, so DSH's sandboxed shell/tool execution was
   not exercised there; in the web UI every shell call asks for
   *danger-full-access* approval on such a host.
5. **The Settings page edits the active profile only.** `updateSettings`
   writes the `magic-host` row into the profile DSH is running; another
   profile (e.g. headless `test`) keeps its own overrides. The jsonc file is
   never written from DSH.
6. **The MC meter needs `setup`.** Without the managed block (hand-written
   layer, or the stock `token-meter` row re-enabled) both the native ring and
   the MC ring show. A preset that is not in `magicPresets` shows no ring at
   all (the native one is disabled profile-wide).
7. **`tool-result-pruner` is loaded but idle under Magic; Magic's drops now
   do land (round 10, 347a76d3c).** Its only caller in rc.5 is
   `compaction-basic.compactIfNeeded` (pressure ≥ the compaction threshold or a
   provider overflow), which Magic disables; nothing else calls
   `pruneSession`, and it only looks at `tool/result` surface nodes, which
   Magic folds into its own copies anyway. It stays mounted (its `tokenMeter`
   dependency satisfied) so re-enabling native compaction needs no rewiring.
   Magic's replacement is its own drop pipeline (ctx_reduce, historian
   compartment drops, heuristic cleanup) — which, until round 10, never
   landed: the coordinator's surface copy of a tagged message (`mc-op:` source)
   was read back as a knowledge baseline, so every drop queued after the first
   tagging pass stayed in `pending_ops` forever (unit test red before; on real
   rc.5 the historian's compartment drops now replace the surface:
   `docs/dsh/e2e/evidence-round10/real-item4-*`). Fix: the surface walk expands
   op copies back into their source events (stable core keys, copy node/seq as
   coverage, fold boundaries around a copy) and skips ops that re-render the
   copy's current text (no churn). Old sessions: a copy whose sources include
   a non-copy Magic message (knowledge, temporal merge) stays a baseline.
   Small-window deadlock (real, round 10, 24k window) — **fixed in round 11
   (cc3d6469f, 5c8f5c1e3)**: core's token-floor protection keeps the newest
   tool results (there: all three), core's emergency drop yields only at
   ≥95 % of INPUT, and nothing under Magic calls the native pruner, so two
   15 kB reads left the request at 80 % with no room for `maxTokens` 4096
   (`max-tokens` after 1 token, ctx_reduce unreachable). Magic now has a DSH
   emergency tier, `agent/pressure-truncation.ts`: when projected input +
   output reserve (latest `request/header` `maxTokens`) reaches the force band
   (`max(85, execute + 2)`), active tool results ≥ 3× the keep budget are
   middle-truncated — protected ones included, oldest first, the newest only
   if the others cannot get under the force band — to head + tail (~8 % of the
   window in chars, 1.2k–12k; 75/25) with a marker naming the tag and the
   omitted (numbered) lines. The `§N§` prefix stays in the head; the original
   output stays in the DSH event log (historian, re-reading). Core `drop_mode`
   semantics: the decision is persisted (`dsh_pressure_truncations`: head/tail
   sizes + sha256 of the untruncated output + the usage seq it was based on)
   and replayed byte-identically every pass, so the rebuilt view never
   re-renders the full output and the coordinator sees the copy as current
   (no op, no event, no cache bust); a tag is truncated at most once; one
   batch per usage sample (a new batch needs a newer usage-bearing assistant
   message); a drop wins (dropped tags are not replayed); a digest mismatch
   skips the row. `pressureTruncation: false` in the context-plane config stops
   new decisions (persisted ones keep replaying). Verified: unit tests red
   before (`docs/dsh/e2e/evidence-round11/unit-item1-*`); real rc.5 with the
   round 10 turns (`evidence-round11/real-item1-*`): §6§ truncated once at
   ≈96 % effective, turns 3–8 all answer (round 10: empty `max-tokens`),
   ctx_reduce callable again, the truncated copy written once and unchanged
   across 6 process restarts (one re-render after the marker-wording change).
   Limits: the trigger reads the token-meter projection, which lags one step;
   a single tool result larger than the whole window is still truncated only
   down to the keep budget; protected drops queued by ctx_reduce still wait
   for the window (core parity).
   Also fixed in round 11 (3218f6148): a dropped tool arc rendered its
   placeholder once per part (`[dropped §3§]\n\n[dropped §3§]`, real rc.5);
   it now renders once (existing copies re-render once).
8. **Client bundle is plain JS against the rc.5 web boot.** It may only
   `require` the web boot's static modules (`react`, `react/jsx-runtime`,
   `react-dom`, `@deepseek-ai/dsh-client-store`, `…-ui-slots`, …); the test
   `client.test.ts` pins that allowlist. A DSH web release that renames those
   modules or the slot ids (`conversation.composer.dock`, `settings.section`)
   breaks the UI part only — the server side keeps working.
9. **The popover's settings link opens Plugins, not the Settings modal.**
   rc.5 gives plugins no way to open Settings at a section (see "Where the
   section lives" above); the link uses `pluginNavigation.openBundle`, whose
   bundle page carries the same form. Revisit if a later DSH exposes
   `openSection` to plugins.
10. **Ring refresh on Save and slow saves — improved in round 11
    (313b67393).** Round 8: a settings change was live for the agent at once
    but the ring reads the `magicContextPressure` projection, recomputed per
    agent step, so after 50 % it stayed grey until the next step, and the
    Save button could sit on "Saving…" > 3 s with no feedback (DSH serializes
    the profile write with a running turn). Now a successful Save bumps a
    client-side settings epoch; the composer indicator (another slot
    component) re-reads `magicContext/context` and shows its thresholds /
    `enabled` until the projection itself moves (then the projection is
    authoritative again; a change made outside this page — another tab, a
    hand edit — still shows on the next step). The editor shows "Still
    saving…" after 3 s and after 20 s stops blocking the form, reloads the
    real values (draft kept) and still applies a late reply. The popover also
    lists truncated tool results (limitation 7). Verified on real rc.5 web
    (`docs/dsh/e2e/evidence-round11/web-item2-*`, `r11-*.png`): override 54
    → ring yellow ≤1 s after "Saved" with no step, Inherit → grey at once;
    during a running turn Save took 4.9 s with the hint at 4.0 s. The 20 s
    give-up path is unit/static only.
11. **Duplicate `§N§` prefixes — root-caused and fixed in round 9
    (10181d774, befdcea2e, 7471bfd42).** Root cause: the first-call payload
    preview in `agent/context-plane.ts` allocated its own tag under the BARE
    DSH message id (`tagger.assignTag(sessionId, msg.id, …)`), before and
    independently of core `tagTranscript`, which keys text tags
    `${viewMessageId}:p${n}`. One message therefore owned two numbers (round 9
    pre-fix DB: bare `b43756fb`=1 / `b43756fb:p0`=3, bare `3717b6de`=2 /
    `3717b6de:p0`=8), the model saw the bare number on the first call and the
    `:p0` number afterwards, and its own "highest + 1" reply prefix landed on
    a number the next message received (the round 7/8 `§2§` / `§10§` pairs).
    Fix: (a) the preview runs after the plan derivation and only reads the
    core key, mapped per source text block by `textTagContentIdsBySource`
    (handles the tool-call assistant text folded into the next user message);
    (b) the step's new input (prompt, runtime-context snapshot), which rc.5
    appends to the log only after the pre-step, is pre-assigned under the
    exact key core will use (`${id}:pN`), so the model's next number is right;
    skipped after an unfolded tool call/result, where the ordinals are not
    knowable; (c) old DBs: bare-id `message` rows are folded once per session
    per process (`agent/legacy-tag-cleanup.ts`): row deleted, a still-pending
    drop moved onto the core tag of the same text or discarded when there is
    none; dropped status is not propagated; the counter never goes back.
    Verified: unit tests (red on the old code, see
    `docs/dsh/e2e/evidence-round9/unit-*-red-*.txt`) and real rc.5 (a new
    session through two historian compartments: every message tag a unique
    `:p0` key, no bare rows, the model lists six distinct numbers; the fold
    on a copy of the real pre-fix DB removes all 9 bare rows in 4 sessions;
    a second real session on 7471bfd42 shows the new prompt tagged on its
    first call and 7 unique tags across two compartments).
    Remaining edge (1) — the model's own "highest + 1" reply prefix vs the
    runtime-context snapshot — fixed in round 10 (53f3fdd37): rc.5 appends
    the runtime-context snapshot (`source.kind: "runtime-context"`) after the
    pre-step, so tagging it on the following pass gave it the number the model
    had already typed into its raw reply (round 9: raw `§2§` / snapshot copy
    `§2§`). The snapshot is now a baseline like the knowledge and
    skill-catalog messages: never a fold target (pending tool results flush
    before it), never tagged, dropped or replaced. Side effect, also fixed:
    replacing it nulled rc.5 `RuntimeContextProjection.retained`, so DSH
    re-appended an identical snapshot every turn (round 9: snapshots at seq
    11/28/41, each old one kept as a Magic copy); now one snapshot stays on
    the surface until its content changes. Verified: unit test red before
    (model prefix 2, core gave 3), real rc.5 4-turn session incl. a tool step
    (`docs/dsh/e2e/evidence-round10/real1-*`): every raw reply prefix equals
    the core tag of that reply, 0 duplicate numbers across raw events and the
    surface, one runtime-context event in 4 turns. Older sessions keep their
    already-tagged snapshot copies (harmless); a snapshot that followed tool
    results in an old session no longer hosts the folded results, so those
    get fresh keys once (`synth-user-…:pN`).
    Remaining edge (2) — new input after an unfolded tool call — fixed in
    round 10 (a81db15fb): the ordinals ARE knowable. A user/message that
    follows a tool-call assistant / tool results with no closing user
    message absorbs them (walkDshLog fold), so its own text starts at
    `:p${n}`, n = text blocks of the absorbed tool-call assistant (tool parts
    are not text). The preview replays that fold over the payload in append
    order, starting from the session tail AFTER this pass's surface replace
    (the preview now runs after `enqueuePlan`): on real rc.5 the replace
    lands, the tail is no longer a fold and the offset is 0 (unchanged
    behaviour, real1 turn 3); when the replace did not land (stale input /
    generation mismatch / error) the offset is the synthetic tail's text
    count. Unit tests red before (payload fold and tail fold). Not reproduced
    live: a failed replace cannot be forced in a real run, and headless rc.5
    has no mid-turn steer. Residual: a Magic knowledge message inserted by an
    OUTER pre-step listener after this preview (ahead of the prompt) would
    absorb the fold instead; the knowledge gate is the outer listener but it
    appends to the batch before calling `next`, so the preview sees it;
    (3) resolved in round 10 by the op-copy expansion
    (limitation 7): a legacy bare tag of a folded tool-call assistant text
    keeps its source mapping, so its pending drop is retargeted, not
    discarded; (4) pre-fix
    sessions were created under the `standard` preset, which the one-shot runner
    cannot resume, so the fold was verified on a copy of the real DB, not
    inside a resumed DSH session.

12. **`dsh_context_compaction_marker` rows stay `pending` forever (round 14,
    static + DB).** The historian's atomic publish (`agent/historian.ts`
    `publishHistorianResult`) stages a marker (`stageDshCompactionMarker`, one
    row per session, `INSERT OR REPLACE`), mirroring Pi's
    `pending_pi_compaction_marker_state`. In Pi the marker is drained through
    Pi's `appendCompaction()` (native session trim). In the DSH port its
    consumer `applyDshCompactionMarkerIfCovered` has **no production caller**:
    the surface is trimmed by Magic's own path instead (the publish queues
    drops for the compartmentalized range → coordinator surface replace, plus
    `<session-history>` rendering of the compartments). So the round 13 run-31
    "pending at process exit" is not an exit race — every marker in the local
    DB (9 sessions, incl. multi-process sessions) is `pending`. Impact: no data
    loss (compartments, facts, drops and the publication floor commit in the
    same transaction; the marker is only a pointer; DSH keeps the original
    events in its log) and no double compaction (nothing reads the row; a newer
    publish overwrites it). Not wired on purpose: appending a DSH
    `compaction/summary` on top of Magic's drops would put the same summary in
    front of the model twice (Pi has to strip exactly that duplicate,
    `stripMcOwnedPiCompactionSummary`) and bust the prompt cache. If DSH-native
    trimming is ever wanted, wire the consumer and drop Magic's own trim for
    that range in the same change.
    Round 18: the row's `published_at` is now read by the knowledge gate as
    the durable "a publish happened after the cached m0" signal
    (`hasUnmaterializedHistorianPublish`); `status` is still never consumed.
    Round 19 analysis (read-only, not changed): `status` is written only as
    `'pending'` (`stageDshCompactionMarker`); the only reader,
    `applyDshCompactionMarkerIfCovered`, is not wired in production and on
    success DELETEs the row (CAS clear) instead of writing `'applied'`, so the
    `'applied'` branch is dead. No consumer is needed today: liveness is
    "row exists", ordering is `published_at`. If the DSH-native trim above is
    ever wired, either keep the delete-on-apply and drop `status` from the
    TS type (schema column stays for compatibility), or write `'applied'` +
    `dsh_ack_seq` like the outbox and have the knowledge gate skip applied
    rows — decide in that change, not before.

13. **Small issues recorded in rounds 17/18.**
    - `/ctx-status` "Last response: never" — **fixed** in `43dc2a27e` (see
      round 18 fixes).
    - **compaction-basic defaults vs MC's 65 % — fixed in round 19**
      (`b7eb34acf`, `a88385f60`; see the round 19 fixes and the before/after
      numbers above). compaction-basic's threshold is `min(window ×
      thresholdRatio(0.8), window − maxTokens − headroomTokens(65 536))` and it
      also refuses a default retention (0.16 × message budget) that is not
      below the threshold. The defaults left ≤ ~70k windows with no pressure
      budget, ≈ 70–82k windows with an illegal retention, and fired at
      ≈ 30 % (100k) / 44–46 % (128k) — real rc.5: 44.0 % on 100k. Now MC-led
      on main sessions (85 % backstop), legal on small child windows, user
      values respected; `doctor` shows the effective policy. Remaining: the
      backstop percentage follows the global/per-model execute threshold via
      the agent plane; a session-level `/ctx` override is not consulted.
    - `ttl_idle` HARD folds can now arm on DSH (they need
      `last_response_time`); a session idle longer than the cache TTL re-folds
      m0 on its next turn, as upstream does.
    - The historian repair retry (`f8c663fee`) — **verified on the real host
      in round 19** (C10, e2e-only one-shot injection).


## DSH-specific layer inventory (what cannot live in core, and why)

| module | why it is DSH-only |
|---|---|
| `compat/dsh-0.1/session.ts` | DSH event-log access (`snapshotEvents`/`eventAt` — `Session.events` was removed in 0.2), branded surface-replace CAS, `MessageSourceMap["magic-context"]` augmentation + legacy `kind:"plugin"` recognition, exclusive `TokenUsage` → prompt pressure |
| `compat/dsh-0.1/{compaction,prestep,tools,commands,typert,preset,liveness}.ts` | DSH service seams: compaction engine hook, pre-step chain, tool/command registries, Typert remote registry, cordis preset patching, liveness marker for core's migration guard |
| `compat/dsh-0.1/subagent.ts` + `agent/worker.ts` | DSH subagent activation (`startActivation`, caller delivery), delegated-policy pinning, tool allowlist on the child scope |
| `agent/transcript.ts` | maps the DSH event log/surface to core `RawMessage[]` + a recording transcript so core tagging/drops become surface-replace ops (DSH never lets a plugin rewrite messages in place) |
| `agent/coordinator.ts`, `agent/outbox.ts` | CAS + saga that applies those ops through DSH's surface transaction with crash-safe SQLite outbox; no core equivalent (OpenCode/Pi mutate the request array) |
| `agent/context-plane.ts`, `agent/knowledge-gate.ts`, `agent/system-guidance.ts`, `agent/auto-search.ts` | DSH "inject, don't rewrite" delivery of m0/m1 knowledge, guidance and the `<ctx-search-hint>`: appended to the **current** pre-step batch (never `agent.inject`, no next-step inbox copy) + watermark de-dup |
| `agent/historian*.ts`, `agent/recomp.ts`, `agent/dreamer.ts` | drive core historian/recomp/wrapup/dreamer with a DSH LLM client facade (OpenCode-SDK-shaped) and a transcript-backed raw-message provider |
| `agent/nudge.ts`, `agent/protection.ts` | ctx_reduce nudges (core tail-hygiene walk over the DSH transcript, delivered by inject) and the core token-floor protection window fed with DSH inputs |
| `settings/magic-settings.ts`, `host/remote.ts` (settings/updateSettings/context) | DSH Settings-page overlay (volatile `magic-host` config over jsonc) and the endpoints behind the settings section and the meter popover |
| `entries/meter.ts`, `host/meter.ts`, `host/context-details.ts` | MC composer meter: real TokenMeter under a renamed `magicContextPressure` projection + per-session details |
| `agent/tools.ts`, `agent/commands.ts` | register core `ctx_*` tools and `/ctx-*` commands in DSH registries |
| `host/*`, `entries/*`, `client/client.js`, `cordis.patch.yml` | cordis plugin entry points, storage bootstrap (shared SQLite, `harness='dsh'`), Typert remote + web client panel |
| `doctor/*` | `dsh-magic-context setup|doctor` CLI (preset generation, install/version/profile/DB checks) |

## Open compatibility points (as of DSH 0.2.1-rc.5 / core v0.49.35)

Resolved since the import (kept here so nobody re-opens them): the nudge
baseline now feeds core's real tail-hygiene walk with the DSH transcript
(U/T, turn deltas, `hasRecentReduce`, post-reduce grace — `agent/nudge.ts`);
the protection window is core's token floor (`agent/protection.ts`,
`protected_tokens`); the context-pressure key is pinned by
`token-meter-projection.contract.test.ts` and read as `magicContextPressure`
(MC meter) or `contextPressure` (stock meter), falling back to the event log;
the client requires `@deepseek-ai/dsh-client-store` (the nonexistent
`dsh-client-runtime` is gone) and renders on real rc.5.

1. **Model harness.** Core's `ModelHarness` is `opencode | pi | omp`. DSH
   reads the `opencode` blocks (`dreamer.opencode`, `historian.opencode`)
   because DSH model refs are `provider/model`. A first-class `dsh` harness
   block would need a core change.
2. **Worker tool allowlist.** DSH 0.2 dropped `toolFilter`/`persona` from
   `SubagentStartRequest`. The worker restricts tools from an `agent/created`
   listener matched on `header.origin === "subagent"` and
   `header.parentSession === parent`, and fails closed if it cannot.
   Exercised on real rc.5 in round 13 through the env-gated
   `ctx_worker_selftest` (`docs/dsh/e2e/evidence-round13/`): the child's
   request carries only `glob/grep/read`, `tools.get(name, child)` is
   undefined for `bash/write/edit/ctx_*` (the executor's `resolveExecution`
   path → `UNKNOWN_TOOL`), a 1.5 s timeout disposes the child (`turn/end
   aborted{parent}`), and the child writes no Magic rows. A forced call of a
   masked tool was not observed (the model never sees its schema). The worker
   is still not used by any production path. DSH's own
   `ChildComposition.toolFilter` (`applyChildComposition`) may be the cleaner
   route.
**Upstream v0.49.35 (checked in round 15, static; merged in round 16 with
`git merge --no-ff`, no conflicts, no tag pushed).** 42 commits, no migration / schema-fence / storage-db
change. Of the 89 core modules the DSH layer imports, 7 changed, all
backward-compatible: `features/magic-context/search` (optional
`autoSearchDiagnostics`), `hooks/magic-context/apply-operations` (new
`prepareAgedToolSkeletonConversions` only), `compartment-runner-validation`
(issue 774: compartment text keeps only commit hashes present in its own raw
lines — safe because DSH builds the chunk with core `readSessionChunk`, which
now fills `commitHashes`, and `rawCommitHashes` scans any part shape; a DSH
path that built validation chunks by hand would silently lose every hash),
`event-resolvers` (proven input floor read path, internal),
`read-session-chunk` (optional `workerSource` /
`readMessageIdOrdinalsForRangeOffThread` on `RawMessageProvider`, consumed
only by core's ctx-expand tools, which DSH does not use — DSH's own
`ctx_expand` stays on the serving thread), `read-session-formatting` (optional
`commitHashes`), `tools/ctx-expand/render` (optional `attachments` argument;
`file` and `image` parts now render an attachment notice instead of
`[file]` / `[image]`). Re-run this check against the newest tag at the next
bump.

v0.49.35 features **not wired into DSH** (round 16): the OpenCode 2 idle host
fold (#632) and failed-step overflow recovery (#827) are OpenCode-2-only; the
subagent tool-skeleton retirement (#643) acts on subagent sessions, which DSH
keeps out of Magic entirely (reduced mode not ported, see Round 16 fixes);
the proven-floor-on-reload fix (#826) reaches DSH only through the internal
read path of core `event-resolvers` (DSH keeps its own threshold; not
separately verified on DSH); auto-search
diagnostics (#773) are an optional field DSH does not log. v0.49.35 has no
"proactive card" feature (checked against `.cortexkit/release-notes/v0.49.35.md`
and the 42 commits), so there was nothing of that name to wire.

3. **Removed upstream, removed here:** `/ctx-aug` (sidekick),
   `/ctx-session-upgrade`, `runManagedUpgrade`, `runMigration`. `/ctx-recomp
   --upgrade` answers with the core deprecation text.
4. **Dreamer facade is "hidden".** The DSH dream client sets
   `backgroundSessionsAreHidden: true`; without it core 0.49 skips every
   non-host-only scheduled task ("no ordinary parent session").
