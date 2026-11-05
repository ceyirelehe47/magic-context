# Round 33 A — P1-B: CI false-positive audit of the fork's DSH workflows

Scope: `.github/workflows/dsh-ci.yml`, `dsh-install.yml`, `dsh-ref-eval.yml`, `dsh-soak.yml`
and the scripts they call (`packages/dsh-plugin/scripts/e2e/*.sh`, `install-accept-check.py`,
`ci-check.py` read-only). Upstream workflows were not touched; `dsh-soak.yml` was not changed
(round constraint); `ci-check.py` was not changed (B line).
No keys in this directory. Times CST.

## Tool: `packages/dsh-plugin/scripts/ci/wf-lint.py` (new, gating in `dsh-ci.yml` checks)

| mode | what |
|---|---|
| `lint` | PIPE: a top-level pipeline in a step whose shell has no pipefail. GitHub's default `run:` shell without `shell:` is **`bash -e {0}`** (no pipefail) — confirmed in run 42040731195: 16 steps log `shell: /usr/bin/bash -e {0}`. COE: `continue-on-error` with no later gate on `steps.<id>.outcome`. REPORT: a job that installs/overlays a DSH must put `DSH version (installed): <v>` (from the installed package.json), `node -v` and `GITHUB_SHA` in the step summary. `dsh-soak.yml` findings are WARN (frozen). |
| `simulate <wf> <job> <step> --fail <cmd>` | runs that step's real `run:` text with the runner's own shell line and `<cmd>` replaced by a stub that exits 1; prints the step's exit code |
| `selftest` | fixtures for each rule + the PIPE rule proven on bash itself (`bash -e`: rc 0, `shell: bash`: rc 1) |

RED `7bf6e5672` (lint on `165ab6d69`: 10 FAIL, 1 WARN) → FIX `0e128bb9e` + `093bf7b79` + `89dbfe543`
(lint: 0 FAIL, 1 WARN = dsh-soak REPORT). Push run 42050273426 @ `e80118969`: wf-lint step success,
`selftest PASS`, `1 finding(s), 0 FAIL`.

## Findings

| # | where | question | finding | evidence level | status |
|---|---|---|---|---|---|
| 1 | dsh-ci `contracts-dsh` "Overlay DSH" | pipefail | `overlay-dsh-types.sh … \| tee -a $GITHUB_STEP_SUMMARY` under `bash -e`: a failing overlay exits 0 (tee). The next steps (`typecheck:dsh`, `contracts:dsh`) then run on whatever is in `node_modules` — the lockfile's **rc.5** — and pass: a green "alpha.3 / rc.1 contracts" without alpha.3 / rc.1. | **已复现**: `a-sim-contracts-overlay-before.txt` (exact workflow text, stub `bash` fails → step exit **0**); after `0e128bb9e`: `a-sim-contracts-overlay-after.txt` exit **1**. History: all 14 successful contracts-dsh jobs since round 31 carry `overlay: 12 entries -> DSH <V>` (`a-contracts-dsh-history.txt`) → latent, never happened. | 已复现并修复 (`0e128bb9e`) |
| 2 | dsh-install `pack` (`tar -tzf \| wc -l`, `tar -xzOf \| python3`), `accept` "Clean env" (`echo \| tee`), dsh-ci checks "Summary" (`} \| tee`, `count()`) | pipefail | informational pipelines; an earlier command or a later step fails first, so no green result can come out of them | 静态推断 | 非缺陷 (pipefail added anyway, lint-clean) |
| 3 | dsh-ci `e2e` | real DSH version | bootstrap printed `bin.js --version \|\| true`; the summary printed the **input** `$DSH_VERSION`, never the installed one; no SHA | 静态推断 | 已修复 (`0e128bb9e`: bootstrap step fails when installed ≠ requested; summary `DSH version (installed)`, plugin version, `GITHUB_SHA`) |
| 4 | dsh-install `accept` | real DSH version | same: summary had `node` only; installed DSH not checked | 静态推断 | 已修复 (`093bf7b79`: installed must equal `dsh_version`, summary names DSH / node / npm / pnpm / SHA / both tarballs @ SHA). Verified in 42051595084 / 42051600910 / 42051607781 (`a-install-*.md` first lines) |
| 5 | dsh-ci `checks`, `contracts-dsh`, dsh-ref-eval | report fields | no installed DSH / node / SHA (checks had `GITHUB_SHA::9` only) | 静态推断 | 已修复; 42050273426 summary: `DSH version (installed): 0.2.2-alpha.3 (expected 0.2.2-alpha.3) · node -v v24.22.2 · GITHUB_SHA e80118969…`, checks `0.2.1-rc.5 (lockfile) · node -v v24.22.1 (tests run on bun 1.4.2)` |
| 6 | `bootstrap.sh` | stale install | an existing `$E2E_ROOT/dsh` was reused whatever its version (`if [[ ! -x …/.bin/dsh ]]`). CI is unaffected (fresh `RUNNER_TEMP`); local runs are: the sandbox's `/workspace/work/e2e/dsh` holds **0.2.1-rc.5**, so `DSH_VERSION=0.2.2-rc.1 bootstrap.sh` printed "bootstrap ok" on rc.5 | 静态推断 (precondition observed locally) | 已修复 (`0e128bb9e`: reinstall on mismatch + final assert). Note: `dsh-soak.yml` calls bootstrap.sh with `DSH_VERSION=0.2.1-rc.5`; the assert only fails there if the install is not rc.5 (soak not triggered this round) |
| 7 | `overlay-dsh-ref.sh` (dsh-ref-eval) | skipped = passed | a requested package missing from the base tree was skipped with a stderr line (tee captures stdout only) and the lane stayed green on `<base>` | 静态推断 | 已修复 (`0e128bb9e`: exit 1, message on stdout + stderr) |
| 8 | `overlay-dsh-ref.sh` | tolerated errors | DSH source `tsc` errors are tolerated (`noEmitOnError: false`); the count is printed into the summary | 静态推断 | 非缺陷 (evaluation lane by design; count visible) |
| 9 | `install-accept.sh` A4 | WARN masking a FAIL | the "explicit schema refusal" WARN path counted **any** line with `schema`; run 42050299481 turn d had `schemaLines: 1` with no refusal (the ctx_expand result quoting ARCHITECTURE.md). Had that rollback broken, A4 would have read WARN, not FAIL | **已复现** (42050299481 `accept.jsonl` step d) | 已复现并修复 (`89dbfe543`: only core's `refusing to open … upstream migration lane vN is newer than this binary supports`) |
| 10 | `install-accept-check.py` | vacuous PASS | on an empty `accept.jsonl` A0 ("no exemption needed") and A8 (`'' == ''`) read PASS (overall still FAIL) | **已复现** (local run) | 已复现并修复 (`dfc649e0f`) |
| 11 | `install-accept.sh`, `ci-e2e.sh`, `ci-*.sh` | later steps after a failure | `set -uo pipefail` without `-e`: the driver always continues and the step exits 0; the checker is the only gate. `install-accept-check.py` FAILs every A-check on missing data (I() = −1). `ci-check.py` on an **empty** `CI_OUT`: rc 1, 54 FAIL, but **10 rows PASS on no data** (S3, S5, R5, R8, R10, R15, DN1, I1, I2, P1 — "nothing bad happened" checks) — `a-ci-check-empty-dir.txt` | 已复现 (local) | 非缺陷 for the job result (positive checks of the same scenarios FAIL); the vacuous rows are a `ci-check.py` matter → B line / user (not changed here) |
| 12 | dsh-ci checks gate, contracts-dsh, e2e, dsh-install | skipped counted as passed | checks' gate loop requires `success` for every outcome (a `skipped` outcome fails it); contracts-dsh / dsh-install steps run on `success()`; e2e `Check` has no `if: always()` (a failed driver step fails the job); dsh-ref-eval later steps run only when the overlay succeeded | 静态推断 | 非缺陷 |
| 13 | all | stale dependencies / cache | no `actions/cache` in any dsh-*.yml; workspace install is lockfile-filtered; DSH is installed at an exact version into a fresh dir. Floating: `npm i -g pnpm@latest` (12.16.1 today), `setup-node '22'/'24'` minor, DSH's own transitive deps (no lockfile in the accept dir) | 静态推断 | 非缺陷 / note: versions now printed in the summaries; pinning pnpm is a possible follow-up |
| 14 | dsh-soak.yml | report fields; per-segment `soak-check.py … \|\| true` | summary lacks installed DSH / node / SHA (REPORT WARN); a segment never fails on the trend (the final `check` job gates it; the run is red if any segment job failed) | 静态推断 | 未修复 (frozen this round), per-segment `\|\| true` is by design |
| 15 | job conclusion vs reality | — | dsh-install `Check` (`set -o pipefail; python … \| tee`) and `pack` (tarball-inspect gates the HEAD tarball) propagate; e2e `Check` keeps `ci-check`'s rc | 静态推断 + runs 42051595084 / 42051600910 (failure, A5 FAIL) / 42051607781 (success) | 非缺陷 |

## "master overlay test passed" ≠ "real DSH master app boot"

- `dsh-ref-eval.yml` (run 42035098645, round 32): npm-installs released DSH 0.2.2-rc.1 and compiles
  four package dirs (`core/agent`, `subagent/subagent`, `llm/llm`, `core/session`) from
  deepseek-harness master `fcc0ad4621` on top. It runs **typecheck:dsh, test-file typecheck,
  contracts:dsh and the dsh-plugin unit suite** in that mixed tree. It never starts `dsh`, never
  loads the bundle through DSH's plugin manager / cordis loader, never calls a model, never runs
  setup/doctor against a profile. The lane's summary now says "Not a real DSH app boot".
- A **real DSH master app boot has not been done**: master is not published to npm (every master
  package.json still reads `0.2.2-rc.1`), and booting it would need the whole monorepo built.
  So for master the evidence is type / contract / unit level only (see `a-compat-matrix.md`).

## Commits (A line, P1-B)

| SHA | what | why | risk |
|---|---|---|---|
| `7bf6e5672` | RED: `scripts/ci/wf-lint.py` (lint / simulate / selftest) | prove the false positives before fixing | none (not wired) |
| `0e128bb9e` | contracts-dsh pipefail + summary; checks summary + wf-lint gate; e2e installed-DSH assert + summary; ref-eval summary; bootstrap.sh reinstall/assert; overlay-dsh-ref.sh missing package fails | findings 1, 3, 5, 6, 7 | a run that used to be green on a broken overlay / wrong DSH is now red (intended); bootstrap.sh also used by soak (rc.5) |
| `093bf7b79` / `89dbfe543` | dsh-install pipefail + summary (installed DSH asserted); A4 schema line tightened | findings 2, 4, 9 | A4 can no longer soften a broken rollback |
| `dfc649e0f` | A0 / A8 non-vacuous; static tarball probes labelled presence-only | finding 10 | none |
