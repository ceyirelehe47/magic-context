# Round 30 evidence (2026-11-05 CST) — release dsh.5, declare DSH 0.2.2-rc.1

No keys in this directory: CI logs are the redacted artifacts; the real model key
only ever lived in the `OPENCODE_API_KEY` secret. Local outputs contain no
credentials.

## A. Release `dsh/0.49.35-dsh.5` (user-approved 2026-11-05 12:57 CST)

- tag `dsh/0.49.35-dsh.5` (annotated object `f32dce2a1cfa8d32978f4855fae667ba61d284d2`)
  → commit `9206770c330824c59b95953ecf95d761e84e0552` = round 29 code (`2d7130339`)
  + version bump `0.49.35-dsh.5` (package.json + the bun.lock workspace line) +
  `docs/dsh/RELEASE-NOTES.md`. Declares DSH `0.2.1-rc.5 || 0.2.2-alpha.3`.
- No GitHub release (dsh.1–dsh.4 had none either), no npm publish, no `v*` tag.

## B. DSH 0.2.2-rc.1 declared on the branch (no tag)

npm `@deepseek-ai/dsh` dist-tags on 2026-11-05: `latest` 0.2.1-rc.5, `alpha`
0.2.2-alpha.3, `next` **0.2.2-rc.1** (published 2026-11-04 17:20 CST; nothing newer).
Static comparison (`r30-dsh`, not committed): all 89 `@deepseek-ai/dsh-*` packages
in rc.1's dependency tree are **byte-identical** to 0.2.2-alpha.3 except
package.json version strings; cordis 4.1.0 / cordis-plugin-include 1.1.0 /
cordis-plugin-loader 1.1.0 / schemastery 3.19.0 are byte-identical to
4.0.6-alpha.2 / 1.0.11-alpha.2 / 1.0.7-alpha.2 / 3.18.6-alpha.2 (package.json
only). Same `evaluatePluginCompatibility`, preset / Cordis config code, settings
page, `engines.node >=24.9.0`. So no adapter code change was needed for rc.1.

| file | what |
|---|---|
| `a2-real-eval.mjs.txt` | `node real-eval.mjs <dir with dsh-app-boot@V installed> <package.json>` (DSH's own check) |
| `a2-real-plugin-manager-red.txt` / `-green.txt` | real app-boot 0.2.1-rc.5 / 0.2.2-alpha.3 / 0.2.2-rc.1 judging packages/dsh-plugin/package.json before (rc.1 REJECTED, 9 unmet) / after (rc.1 ACCEPTED on all three runtimes; 0.2.2-rc.2, alpha.2, alpha.4, 0.2.2 REJECTED both times) |
| `b2-y1-node24-comm.txt` | node ≥ 24 names its main thread `MainThread`: Y1's kill target lookup (`ps -o comm= == node`) found nothing on the node 24 lane (已复现 locally) |
| `c1-soak-41775904921-final.txt` | final K1–K9 of the 12 h soak |

## Runs

| run id | workflow | ref / sha | DSH | node | exemption | result | I1 | I2 | R10 (P / backstop) | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 41971621725 | dsh-ci push | `9206770c3` (dsh.5) | lockfile rc.5 | — | — | success: dsh-plugin 631/0, adapter 15, contracts 105 | | | | release commit |
| 41971919183 | dsh-install | tag dsh.5 | 0.2.1-rc.5 | 22 | none | A0–A4 PASS | | | | dsh.5 acceptance |
| 41971923016 | dsh-install | tag dsh.5 | 0.2.2-alpha.3 | 22 | dsh.2 steps a/d only | A0 WARN, A1–A4 PASS | | | | `headNeeded: []`; tag's workflow still node 22 (EBADENGINE warning) |
| 41971926453 | dsh-ci e2e r30r5 | `9206770c3` | 0.2.1-rc.5 | 22 | none | 133 / 1 FAIL (C3) / 1 WARN (E2) | PASS | PASS | PASS / PASS | C3 re-run, see below |
| 41972038622 | dsh-install | `91fdde883` | 0.2.2-rc.1 | 24.22.1 | **eval lane** (HEAD undeclared) | A0 FAIL (expected: HEAD needed the exemption), A1–A4 PASS | | | | evaluation |
| 41972042372 | dsh-ci e2e r30c1a | `91fdde883` | 0.2.2-rc.1 | 24 | **eval lane** | 132 / 1 (Y1) / 2 (T3, E2) | PASS | PASS | PASS / PASS | Y1 = harness on node 24 |
| 41972046384 | dsh-ci e2e r30c1b | `91fdde883` | 0.2.2-rc.1 | 24.22.1 | **eval lane** | 133 / 1 (Y1) / 1 (E2) | PASS | PASS | PASS / PASS | Y1 = harness on node 24 (`killedPid: null`) |
| 41972435035 | dsh-ci push | `60b078463` | lockfile rc.5 | — | — | success 632/15/105 | | | | rc.1 declared |
| 41972809339 | dsh-install | `60b078463` | 0.2.2-rc.1 | 24.22.2 | HEAD **none**; dsh.2 a/d only | A0 WARN, A1–A4 PASS | | | | `headNeeded: []` |
| 41972814902 | dsh-install | `60b078463` | 0.2.1-rc.5 | 22.23.4 | none | A0–A4 PASS | | | | no regression |
| 41972820096 | dsh-install | `60b078463` | 0.2.2-alpha.3 | 24.22.1 | HEAD none; dsh.2 a/d only | A0 WARN, A1–A4 PASS | | | | alpha.3 on its required node 24 |
| 41972825602 / 41972830751 / 41972834893 | dsh-ci e2e | `60b078463` | rc.1 ×2, alpha.3 | 24 | none | **cancelled** | | | | would hit the Y1 harness bug; re-dispatched after `a2f503dc6` |
| 41974187111 | dsh-ci push | `a2f503dc6` | lockfile rc.5 | — | — | **failure** 631/1: host-unload-release "Cannot use a closed database" | | | | test isolation, fixed `5daa53311` |
| 41974240164 | dsh-ci e2e r30e1a | `a2f503dc6` | 0.2.2-rc.1 | 24.22.2 | **none** | **133 / 0 / 2** (T3, E2) | PASS | PASS | PASS / PASS | U6 strict PASS, Y1/Y2/C3 PASS |
| 41974243694 | dsh-ci e2e r30e1b | `a2f503dc6` | 0.2.2-rc.1 | 24.22.1 | **none** | **134 / 0 / 1** (E2) | PASS | PASS | PASS / PASS | U6 strict PASS, Y1/Y2/C3 PASS |
| 41974247003 | dsh-ci e2e r30a3m | `a2f503dc6` | 0.2.2-alpha.3 | 24.22.1 | **none** | **133 / 0 / 2** (T3, E2) | PASS | PASS | PASS / PASS | Y2 PASS (first time on alpha.3; 4/4 FAIL on node 22) |
| 41974989721 | dsh-ci push | `5daa53311` | lockfile rc.5 | — | — | success 633/15/105 | | | | same file order that failed (magic-settings → doctor.test → host-unload-release) now green |

`a2f503dc6` → `5daa53311` changes only doctor's CLI teardown (`closeDatabase()`)
and adds a test; e2e U6 runs doctor as its own process, so the three e2e runs at
`a2f503dc6` stand for the code at `5daa53311` (静态推断).

## C3 on rc.5 (41971926453) — 待验证, check unchanged

    cmp-01 [10179]  cmp-02 [10254, 15045, 18960]  cmp-03 [19094, 18974, 19509]
    cmp-04 [19809, 23440, 23559, 23708]  cmp-q [23817]  use-search [23867, 24100]
    use-memory [24185, 24261]  use-expand [24374, 24530]  → peak 24530 = LAST step → FAIL

The historian fired at cmp-03 on a projected trigger pct of 71 (threshold 65)
while every SENT prompt stayed ≤ 61.3 % of the 40k window; after the e2e
corrupt-once + repair retry (C10 PASS) it published one compartment [1, 3] (the
codeword turn; C2/C4/C6/C7/C8 PASS). The trigger pct then read 49–61, below the
threshold, so nothing else fired and the sent prompt kept growing slowly to the
end. Same signature as 28c #1 (peak at the last step); rc.5 C3 is now 2 FAIL in
4 runs since 28c (41842386831 FAIL, 41845836776 PASS, 41859559537 PASS,
41971926453 FAIL). No adapter fault found; the check assumes a drop after the
peak that this scenario does not guarantee when the historian covers little.
Assertion not relaxed.

## Y1 on the node 24 lane — 已复现, harness fixed (`a2f503dc6`)

The scenario Y kill step looked for the DSH node process with `ps -o comm= == node`.
Node ≥ 24 renames its main thread `MainThread`, so `/proc/<pid>/comm` is no longer
`node`: the harness saw the historian hold but never sent SIGKILL (`{"held": 1,
"killedPid": null}`), Y1 FAILed and Y2 passed trivially. The kill target is now
picked by `/proc/<pid>/exe` (or comm `node` / `MainThread`). After the fix Y1 PASS
on all three node 24 runs. Assertions Y1–Y6 unchanged.

## Y2 — observation (待验证)

Y2 (pending the user since 28c) PASSed on alpha.3 on node 24 (41974247003) and on
both rc.1 runs, after 4/4 FAIL on alpha.3 under node 22. Same DSH code (rc.1 =
alpha.3); the difference is the node version / timing. Not treated as resolved;
the user decision on the Y2 criterion still stands.

## push-check flake (41974187111) — 已复现 locally, fixed (`9edc285bc` / `5daa53311`)

Round 27 C3 recurrence. doctor's shared-DB check opened the DB through core
`openDatabaseAsync` (per-path cached handle) and did a bare `db.close()`, leaving
a closed handle in core's cache; in one bun process the order magic-settings
(creates the default test DB) → doctor.test → host-unload-release then failed.
New `doctor-shared-handle.test.ts` 0/1 → 1/1; doctor now closes through core
`closeDatabase()` (doctor is CLI-only; production unaffected).

## C. Soak 41775904921 — final (12.04 h)

K1–K9 **all PASS** over the whole CSV: 14001/14001 mock runs, 0 leftover
processes, residue 0 of 14025, RSS 305 460 → 345 828 KB (1.13×), wall 3.06 →
2.65 s, WAL max 0, DB growth/run 14 142 → 14 178 B (DB 1.1 → 199 MB), 0
historian failures of 71 929, 0 mock requests over the window, real-model
samples 24/24. It ran round 26 code (`901fb7874`), i.e. none of the round 27–30
fixes. No new soak triggered.
