# Round 32 evidence (2026-11-05 CST) — DSH master (cordis 4.1.0 / loader 1.1.0) compatibility

No keys in this directory: CI logs stay in Actions (the model key only ever lived in the
`OPENCODE_API_KEY` secret); local outputs contain no credentials. No tag, no dsh.7.

## A. What DSH master changed relative to 0.2.2-rc.1

Repo: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), default
branch `master`, HEAD **`fcc0ad4621`** (2026-11-04 16:40 CST, "Merge pull request #7873 …
merge/release-dsh-0.2.2-rc.1-to-master"; no newer push to master at 2026-11-05 20:20 CST).

- The cordis upgrade is commit **`60d811de43`** "release(vendor): cordis 4.1.0, cosmokit 1.9.0,
  group 1.1.0, hmr 1.1.0, include 1.1.0, loader 1.1.0, logger-console 1.1.0, schemastery 3.19.0,
  timer 1.2.0" (2026-11-04 15:48 CST, package.json version lines only). It is an **ancestor of tag
  `dsh-v0.2.2-rc.1`** (`66491b05e3`), i.e. it is what rc.1 shipped; master got it through the
  merge `fcc0ad4621`.
- `git merge-base dsh-v0.2.2-rc.1 master` = the rc.1 tag commit: master = rc.1 + 811 commits
  (2559 files).
- `git diff dsh-v0.2.2-rc.1 master -- vendor/` is **empty**: cordis 4.1.0, cordis-plugin-loader
  1.1.0, cordis-plugin-include 1.1.0, schemastery 3.19.0 are source-identical to rc.1. No 4.1.x /
  1.1.x patch, no 4.2.
- Every master package.json still reads `0.2.2-rc.1`; root `engines.node` `>=24.9.0` unchanged.
- npm (2026-11-05): `@deepseek-ai/dsh` dist-tags latest 0.2.1-rc.5, alpha 0.2.2-alpha.3, next
  0.2.2-rc.1 (newest publish 2026-11-04 17:20 CST); no nightly / canary / newer rc or alpha.
  `@deepseek-ai/cordis` latest = 4.1.0, next = 4.0.6-alpha.2 (same for loader/include 1.1.0).
  No `release/*` branch remains; tags stop at `dsh-v0.2.2-rc.1`.

Changed source the adapter can reach (excerpts: `a1-master-vs-rc1-source.diff.txt`):

| package (dir) | master change | adapter impact |
|---|---|---|
| dsh-subagent (`subagent/subagent`) | `SubagentActivationSpec` flattened: `extends Omit<SubagentStartRequest,'label'\|'signal'>`, nested `request` removed, new optional `name`; `startActivation` reads `spec.parent` / `spec.prompt` / `spec.maxDepth`; `SubagentActivation.name`; `dispose()` releases only this activation; removed `waitForChildren`, `drainChildren`, `listChildren`, `interruptByParent`, `list`; `./internal` export removed; `SubagentRunInfo.parentSessionId`; interrupt authority `user` lost `parentSessionId` | **breaks the worker spec** (B1, fixed); nothing else used (grep) |
| dsh-agent (`core/agent`) | `CreateAgentOptions.parentAgent`, `ResumeAgentOptions.parentAgent`, `AgentRegistry.isOwnedBy()`, `roots()` removed; `enter(agent)` one argument | none used (grep) |
| dsh-session (`core/session`) | `KNOWN_SESSION_EVENT_TYPES` + `team/mode` | none |
| dsh-llm (`llm/llm`) | `projectToolUpdates` addition-only rebase (internal) | none (not called) |
| dsh-plugin-manager (`boot/plugin-manager`) | missing-bundle rows no longer copy `listedByDefault`; `evaluatePluginCompatibility` / `versions.ts` untouched | none |
| dsh-agent-preset-registry | doc comment of `agent-preset/selected` only; PresetTree untouched | none |
| dsh-client-ui-slots | new slot kind `'hoc'` (additive) | none (client is plain JS) |
| dsh-agent-loop, dsh-system-prompt | `parentAgent` plumbing removed; `TEAM_IDENTITY` order removed | none |
| vendor cordis / loader / include | **no change** | preset write-back unchanged (B2) |

## B. Verification with real master code

Master packages were compiled from source at `fcc0ad4621` (tsc; emits JS + .d.ts in the published
`lib/types` layout, const enums such as cordis `FiberState` inlined) on top of the 0.2.2-rc.1 npm
tree, in a scratch overlay — never the repo's node_modules. Built: dsh-agent, dsh-subagent,
dsh-llm, dsh-session (every master-changed package the adapter imports); all others are rc.1 npm
(their source is unchanged on master except UI / unrelated packages listed above).

### B1. Worker activation spec — 已复现 → fixed (adapter only)

- `b1-worker-spec-repro.ts.txt`: runs the **real** `SubagentRuntime.prototype.startActivation` of
  master and of rc.1 on the spec from `magicWorkerActivation` (only the provider registry, manager
  and agents service are stubs).
- `b1-worker-spec-red.txt` (adapter `ffd40242a`): master → `TypeError: undefined is not an object
  (evaluating 'spec.parent.id')`; rc.1 → reaches `manager.startLocal`. `typecheck` against master
  dsh-subagent: `TS2353 'request' does not exist in type 'SubagentActivationSpec'`. Unit
  `subagent-spec.test.ts` at RED `67d6d0a6f`: 1 pass / 2 fail.
- Fix `c096b8a68`: the spec carries the task both nested (`request`, read by rc.5 / alpha.3 / rc.1)
  and flattened (`parent` / `prompt` / `maxDepth`, read by master); built as a variable so both
  declarations type-check.
- `b1-worker-spec-green.txt`: master and rc.1 both reach `manager.startLocal` with parent / prompt /
  maxDepth; typecheck src + test files 0 errors on the master overlay; unit 26/26; the full
  dsh-plugin suite on the master overlay 643/0.
- Reach: the worker has no production caller (limitation 2; only the env-gated
  `ctx_worker_selftest`). Without the fix the next DSH release would make every worker call return
  `null` (logged) and the self-test fail; no user-visible path breaks.

### B2. Preset write-back (preset-include) — 已复现 unchanged

`b2-preset-include-master.txt`: the round 28 repro (`evidence-round28/b1-preset-include-commit-repro.mjs.txt`)
on cordis 4.1.0 / loader 1.1.0 / include 1.1.0 (= master vendor): raw `Include` rewrites the stock
file (`self1` gets `disabled: true`); the built `entries/preset-include.ts` leaves it unchanged.
Include 1.1.0's only file writes are (a) `Service.init` creating a **missing** file from
`config.initial` (not used by the thin preset row) and (b) the journal drained from `commit()` /
`stop()` / `flush()`; with `commit()` a no-op the journal stays empty. Loader 1.1.0 persists only
through `tree.commit({...})` (7 call sites); `write()` is never called. No new write path, no
signature change, nothing removed.

### B3. Contracts / setup / doctor

- `contracts:dsh` 105/105 on the master overlay (local and CI `dsh-ref-eval`).
- setup / doctor / profile patch use js-yaml on `profile/cordis.yml`, the plugin manager's
  version gate and app-boot paths; app-boot / config-editor have no master source change,
  plugin-manager only the `listedByDefault` row change. setup / doctor / presets / migrate-legacy
  tests pass on the master overlay (in the 643). Real `dsh` CLI boot of master not run (静态推断
  for app boot).

### B4. CI evaluation lane `dsh-ref-eval.yml` (manual, evaluation only)

`overlay-dsh-ref.sh <base> <ref> <scratch> <pkg-dir>…`: npm overlay of `<base>` (round 31
script), shallow blob-less sparse fetch of the DSH ref, tsc of the listed package dirs in a trimmed
npm tree, copy into the full tree; vendor versions reported, not rebuilt.

## Runs

| run id | workflow | sha | DSH | result | notes |
|---|---|---|---|---|---|
| 42033679422 | dsh-ci push | `fb8621502` | lockfile rc.5; contracts-dsh alpha.3 / rc.1 | success **643/15/105**; contracts-dsh 105 + 105 | RED + fix + lane |
| 42033780423 | dsh-ref-eval | `fb8621502` | rc.1 + master pkgs | **false green**: overlay step failed (tsc OOM ~4 GB on dsh-agent next to the full rc.1 tree), `tee` hid it, later steps tested plain rc.1 (643, 105) | fixed `49b83e250` |
| 42035083245 | dsh-ci push | `49b83e250` | same | success | lane fix only |
| 42035098645 | dsh-ref-eval | `49b83e250` | rc.1 + master dsh-agent / subagent / llm / session (`fcc0ad4621`) | **success**: 4 packages built (0 tsc errors), typecheck:dsh + test-file typecheck pass, contracts 105, dsh-plugin **643/0** | vendor 4.1.0 / 1.1.0 = installed |
| 42034146821 | dsh-ci e2e (dispatch) | `fb8621502` | 0.2.1-rc.5 | **133 PASS / 1 FAIL / 1 WARN** (135 judged): FAIL **R14**, WARN E2 | R14 = checker non-vacuity guard tripped by the model quoting the checksums verbatim (section C) |
| 42037652492 | dsh-ci e2e (dispatch, rerun) | `49b83e250` | 0.2.1-rc.5 | **133 PASS / 0 FAIL / 2 WARN** (135 judged): WARN E2, T3; **R14 PASS** | checks / contracts alpha.3 / rc.1 green in the same run |
| 42034156577 | dsh-ci e2e (dispatch) | `fb8621502` | 0.2.2-rc.1 | **134 PASS / 0 FAIL / 1 WARN** (135 judged) | |

`fb8621502` → `49b83e250` changes only the evaluation script and workflow, so the two e2e runs
at `fb8621502` stand for the code at `49b83e250` (静态推断).

## C. e2e R14 on rc.5 (42034146821): checker non-vacuity guard, model behaviour — not Magic, not core/DSH

**Verdict:** the judgement is reproduced exactly from the artifact (已复现, recomputed from
`history-lock.json`); the cause (the model put the checksums into a memory and the historian
quoted them verbatim, so the summary keeps them on the surface) is read straight off the session
log; that this is model variance rather than a regression is supported by the rerun on the same
DSH at HEAD (42037652492, R14 PASS) and by rc.1 at the same sha — 待验证 only in the sense that
a model-dependent event cannot be forced. No code change, no assertion change.

**Checker:** `packages/dsh-plugin/scripts/e2e/ci-check.py` `check_r23_history` (R14) reads
`history-lock.json` written by `scripts/e2e/ci-history.ts` (replays the lock session with the
real DSH `Session`; per item `onSurface` = the text occurs in the model-visible surface,
`coveredBy` = the compartment whose range holds its history ordinal). PASS needs: lock-d rc=0 and
`/compact` `kind=success`; ≥ 2 compactions; the lock-c prompt found; files found;
**`shadowed` non-empty** (at least one item no longer verbatim on the surface — the guard that
keeps R14 from passing vacuously when the compaction did not reach lock-c); `lost` empty (every
item on the surface or inside a compartment); the last summary's highest compartment end ≥ every
shadowed ordinal.

**Recomputed conjuncts** (`r14-judgement-42034146821.txt`, `r14-history-lock-rc5-42034146821.json`,
`r14-history-lock-rc1-42034156577.json`):

| conjunct | rc.5 42034146821 (FAIL) | rc.1 42034156577 (PASS) |
|---|---|---|
| lock-d rc=0, `/compact` done | success, 15 items (~14440 tok) | success, 14 items (~13914 tok) |
| compactions | 8 | 8 |
| prompt (ordinal 35) | found, onSurface, in 32-43 | found, onSurface, in 32-42 |
| p27–p31 checksums (ordinals 37–41) | **onSurface = true** ×5, in 32-43 | onSurface = false ×5, in 32-42 |
| shadowed non-empty | **false** `[]` | true `[37..41]` |
| lost | `[]` | `[]` |
| summary reaches | true only vacuously (summaryMaxEnd 43, nothing shadowed to compare) | 42 ≥ 41 |

The only false conjunct is the non-vacuity guard. Why the checksums are on the surface: in lock-c
the model (rc.5 run only) called `ctx_memory update id 12` (CONFIG_VALUES) with the five checksums
(`lock-c.log`), and the historian's compartment 32-43 then wrote "updated CONFIG_VALUES memory
[ID 12] … with the new checksums P19-27-AA15A2, P19-28-6B2FF9, P19-29-1B8737, P19-30-0903C6,
P19-31-2789DE" into the summary of lock-d's compaction (seq 224, compartments 1-6 … 32-43). The
substring probe finds them in that checkpoint text, so nothing counts as shadowed. In the rc.1
run the model made no memory call and the summary quotes no checksum. Everything R14 exists to
protect held in the failing run: nothing lost, all five reads inside compartment 32-43
(recoverable by `ctx_expand(32, 43)`), and the checkpoint summary reaches 43.

**Not timing:** lock-d took 22.7 s (`/compact` 20.0 s), the hold was off (`historianBusy=false
fakeLease=no`), the compaction succeeded.

**Not our round-32 change:** `c096b8a68` only changes `magicWorkerActivation`, whose only caller
is `runMagicWorker`, reached only from the env-gated worker self-test tool (child scenario);
scenario L / lock-c / lock-d logs contain no worker or subagent activation. The rc.1 run of the
same sha passed R14, and so did the rerun at `49b83e250` on rc.5.

**Not core / DSH native:** the compaction, compartment publication and checkpoint all behaved
as specified; the difference is model-written text.

**History:** R14 passed every run in rounds 28–31; this is its first FAIL since its round-23
checker fix. **Possible checker refinement (not done, would need user sign-off):** judge
"shadowed" by the read result's seq being in a `compaction/summary` `shadowedSeqs` (history
view) instead of by substring absence from the surface, so a summary that restates a checksum
does not make the check vacuous. Until then a FAIL with `shadowed: []`, `lost: []` and the
checksums present in the summary text is this model-behaviour case.
