# Round 29 evidence (2026-11-04 23:25 – 2026-11-05 CST) — declare DSH 0.2.2-alpha.3

No keys in this directory: CI logs are the redacted artifacts; the real model key
only ever lived in the `OPENCODE_API_KEY` secret. Local outputs contain no
credentials.

Declared DSH releases: **0.2.1-rc.5** (default; lockfile, devDependencies, CI
default) and **0.2.2-alpha.3**. Form: every `@deepseek-ai/dsh-*` peer is
`0.2.1-rc.5 || 0.2.2-alpha.3` — exact versions only, judged by DSH's plugin
manager (`@deepseek-ai/dsh-app-boot` `evaluatePluginCompatibility`, identical in
both releases: `engines.dsh` else every DSH peer, `semver.satisfies(…, {
includePrerelease: true })`). 0.2.2-rc.1 / 0.2.2-alpha.2 / 0.2.2 are still refused.

## Files

| file | what |
|---|---|
| `a1-declaration-red.txt` / `a1-declaration-green.txt` | `dsh-compat-declaration.test.ts` 3/5 → 5/5, doctor round-29 cases 0/2 → 2/2 |
| `a2-real-plugin-manager-red.txt` / `-green.txt` | the REAL dsh-app-boot 0.2.1-rc.5 and 0.2.2-alpha.3 judging packages/dsh-plugin/package.json before / after (alpha.3 REJECTED → ACCEPTED on both runtimes; rc.1/alpha.2/0.2.2 REJECTED both times) |
| `a2-real-eval.mjs.txt` | the script used for a2 (`node real-eval.mjs <dir with dsh-app-boot@V installed> <package.json>`) |
| `b1-a3-r11-y2.md` | R11 (once) and Y2 (twice) on alpha.3, classified |

## Runs (HEAD `0ef173b60` unless noted)

| run id | workflow | DSH | exemption | result | I1 | I2 | R10 (P / backstop) | notes |
|---|---|---|---|---|---|---|---|---|
| 41859522777 | dsh-ci checks (push) | lockfile rc.5 | — | success | | | | dsh-plugin **631**/0 (+7), adapter-api 15, contracts 105 |
| 41859544648 | dsh-install | 0.2.1-rc.5 | none | A0–A4 PASS | | | | |
| 41859553540 | dsh-install | 0.2.2-alpha.3 | HEAD: **none**; dsh.2 steps a/d only | A0 WARN, A1–A4 PASS | | | | HEAD steps b/c: no exemption, doctor `[ok] DSH version`; A0 WARN = the OLD dsh.2 tarball (peers rc.5 only) still needs DSH's exemption on alpha.3 (`headNeeded: []`) |
| 41859559537 | dsh-ci e2e slot r29r5 | 0.2.1-rc.5 | none | 133 PASS / 0 FAIL / 2 WARN (T3, E2) — 135 judged | PASS | PASS | PASS / PASS | U6 PASS, Y2 PASS, R11 PASS |
| 41859567651 | dsh-ci e2e slot r29a3 | 0.2.2-alpha.3 | **none** | 131 / 2 FAIL (R11, Y2) / 2 WARN (T3, E2) | PASS | PASS | PASS / PASS | U6 PASS (strict); Y2 known timing (pending user); R11 real model said DONE after 2/8 reads (`b1-…`) |
| 41859577345 | dsh-ci e2e slot r29a3b | 0.2.2-alpha.3 | **none** | 133 / 1 FAIL (Y2) / 1 WARN (E2) | PASS | PASS | PASS / PASS | U6 PASS; Y2 known timing (pending user) |

The docs commit that adds this directory is docs-only over `0ef173b60`; its own
push run is reported in the round 29 hand-off, not here.

Observed, not changed: DSH 0.2.2-alpha.3 declares `engines.node >=24.9.0`
(`npm warn EBADENGINE` in 41859553540); the CI lanes run node 22. All alpha.3
runs above ran on node 22, so alpha.3 on its required node 24 is **待验证**.
