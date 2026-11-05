# Round 33 evidence (2026-11-05) — dsh.7 candidate, CI audit, checker fixes

No keys, tokens or account data in this directory (npm logs: runner paths replaced by `<path>`).
Times CST. No tag, no GitHub release, no npm publish, no soak triggered this round.

Three groups of files:

- **`a-*`** — lane A: P0 dsh.7 release-candidate acceptance, P1-B CI false-positive audit, P1-C
  compatibility matrix.
- **`b-*`** — lane B: P1-A R14 checker, P2-A remaining WARN / FAIL items (E2, T3, Y2, C3), P2-B
  several processes on one profile (ST1 / DN1), P2-C soak freshness, upstream issue drafts.
- **`c-*`** — integration: ci-check.py empty-input fix (CI audit finding 11), RED → GREEN.

Summary of the round, decisions pending and the run table: `docs/DSH-MAINTENANCE.md`, "Baseline
(round 33)". Release-note text: `docs/dsh/RELEASE-NOTES.md`, "0.49.35-dsh.7 — 待发".

## Lane A (`a-*`)

| file | what |
|---|---|
| `a-release-candidate.md` | **start here for dsh.7**: what is released (product code `c096b8a68`, version commit `e80118969`), how `dsh-install.yml` verified it, tarball summary, the three install runs, B2 / B4 / B5 verdicts, **B6** (npm ERESOLVE through the absent optional client peer; options a / b / c), verdict |
| `a-install-rc5-42051595084.md` | dsh-install @ `89dbfe543`, DSH 0.2.1-rc.5, node 22.23.4, dsh.6 ⇄ dsh.7: A0–A4, A6–A8 PASS, **A5 FAIL** (B6) |
| `a-install-alpha3-42051600910.md` | same, DSH 0.2.2-alpha.3, node 24.22.2: A0–A4, A6–A8 PASS, **A5 FAIL** (B6) |
| `a-install-rc1-42051607781.md` | same, DSH 0.2.2-rc.1, node 24.22.1: A0–A8 PASS |
| `a-npm-eresolve-rc5-head.txt`, `a-npm-eresolve-alpha3-head.txt` | the npm ERESOLVE output behind B6 (HEAD tarball next to rc.5 / alpha.3) |
| `a-tarball-head-inspect.md`, `a-tarball-old-dsh6-inspect.md` | `tarball-inspect.py` on the HEAD (dsh.7 candidate) and dsh.6 tarballs: files, manifest, bin, peers, entry files |
| `a-b4-symlink-control-local.txt` | B4 control: dsh.6 `node <link> --version` prints nothing, dsh.7 prints the version (same CI tarballs, local node 22) |
| `a-ci-audit.md` | **CI audit, 15 findings** across dsh-ci / dsh-install / dsh-ref-eval / dsh-soak (`wf-lint.py` rules, simulate / selftest), status per finding, commits |
| `a-sim-contracts-overlay-before.txt`, `a-sim-contracts-overlay-after.txt` | finding 1 reproduced: the contracts-dsh overlay step exits 0 on a failing overlay (before), 1 after `0e128bb9e` |
| `a-contracts-dsh-history.txt` | finding 1 latency: every successful contracts-dsh job since round 31 really overlaid the requested DSH |
| `a-ci-check-empty-dir.txt` | finding 11: `ci-check.py check` on an empty CI_OUT — 54 FAIL, **10 PASS on no data** (fixed in `c-*`) |
| `a-compat-matrix.md` | compatibility matrix rc.5 / alpha.3 / rc.1 / DSH master × 7 dimensions, each cell with boot / model / evidence; master is overlay / unit only |
| `a-e2e-alpha3-42051660209.md` | the round's one new real e2e: alpha.3, node 24.22.2 @ `89dbfe543`, **134 / 0 / 1** (E2 WARN) |

## Lane B (`b-*`)

| file | what |
|---|---|
| `b-runs.md` | lane B run table (e2e 42050071694 rc.5 134 / 0 / 1), offline replays, commits, evidence index, notes for the integrator (duplicate check ids T3 / R10) |
| `b-r14.md` | R14 judged on structural fold evidence (`originSeqs` / `shadowedBy` / `onRawSurface`): old vs new semantics, why it is not weaker, tests |
| `b-r14-red.txt`, `b-r14-green.txt`, `b-r14-replay.txt` | R14 RED (`573d01342`) → GREEN (`98fa03b9b`), replays of 7 real artifacts (42034146821 FAIL → PASS) |
| `b-r14-ci-42050071694.txt` | first CI run with the structural `history-lock.json`: R14 PASS |
| `b-p2a.md` | E2 (core RRF ranking, upstream), T3 (WARN accurate, not changed), **Y2** (checker fix `80f52b940`), C3 (DSH token-meter, option c evaluated, not applied) |
| `b-y2-red.txt`, `b-y2-green.txt`, `b-y2-replay.txt` | Y2 RED (`e0c8a7bbf`) → GREEN (12/12), replays (alpha.3 ×4 FAIL → PASS "own fresh lease") |
| `b-c3-meter-repro.ts.txt`, `b-c3-meter-repro-output.txt` | C3 executed repro on DSH's `foldSurfaceProjection`: a claim-less replace folds with zero delta |
| `b-p2b-st1.md` | ST1 / DN1: DSH rewrites `cordis.yml` in place on every boot; no adapter seam; **user guidance draft** (merged into DSH-MAINTENANCE) |
| `b-st1-cordis-yml-race-repro.mjs.txt`, `b-st1-repro-output.txt` | ST1 boot race reproduced |
| `b-p2c-soak.md` | soak 41775904921 freshness: delta since round 26, risk by area, **recommendation** (2 × 120 min rc.5 regression soak; no dsh_version input in dsh-soak.yml) |
| `b-upstream-issue-drafts.md` | drafts, **not filed**: §1 core ranking, §2 DSH token-meter, §3 DSH cordis.yml boot race |

## Integration (`c-*`)

| file | what |
|---|---|
| `c-empty-input-red.txt` | RED @ `7c1c6158a`: `test_ci_check_empty.py` 11 failures — S3, S5, R5, R8, R10 (P), R15, DN1, I1, I2, P1 PASS on an empty CI_OUT |
| `c-empty-input-green.txt` | GREEN @ `25b43db8c`: 4/4; R14 14/14, Y2 12/12; empty CI_OUT PASS 10 → 0; the 10 rows identical old vs new on 8 real full artifacts; wf-lint simulate of the new CI step |

Push CI 42055877063 @ `25b43db8c` (success): dsh-plugin 643, adapter-api 15, contracts:dsh 105
(rc.5; contracts-dsh alpha.3 and rc.1 success), ci-check.py unit tests 30 (R14 14 + Y2 12 + empty 4),
wf-lint 0 FAIL.
