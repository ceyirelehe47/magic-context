# Round 28 evidence (2026-11-04; rounds 28 / 28b / 28c)

No keys in this directory: CI logs are the redacted artifacts; the real model key
only ever lived in the `OPENCODE_API_KEY` secret. Local repro outputs contain no
credentials.

## Runs

| run id | workflow | DSH | head | result | I1 | I2 | R10 (P) | notes |
|---|---|---|---|---|---|---|---|---|
| 41828791422 | dsh-ci e2e | rc.5 | 2a2e9b592 | 130 PASS / 2 FAIL | PASS | — | — | T1/T2: fold v1 re-reads (p32.txt ×8 → pi-ai clamp); adapter, fixed `cc96eb02e` |
| 41828796915 | dsh-ci e2e | rc.5 | 2a2e9b592 | 128 PASS / 4 FAIL | PASS | — | — | T1/U7/U8/U10: same re-read cause |
| 41830959396 / 41830965910 | dsh-ci e2e | rc.5 | 952a3970a | cancelled | | | | superseded by fold v2 |
| 41830231542 | dsh-ci checks (push) | rc.5 | 952a3970a | success | | | | dsh-plugin 623/0, adapter-api 15, contracts 105 |
| 41832493443 | dsh-ci checks (push) | rc.5 | cc96eb02e | success | | | | dsh-plugin 623/0 |
| 41832514940 | dsh-ci e2e | rc.5 | cc96eb02e | 131 / 2 FAIL (R4, R7) | PASS | PASS | WARN (offline) | model ctx_reduce in pold against the prompt (`c5-…`) |
| 41832520000 | dsh-ci e2e | rc.5 | cc96eb02e | 133 / 0 | PASS | PASS | PASS (offline) | |
| 41832524393 | dsh-ci e2e | rc.5 | cc96eb02e | 132 / 0 | PASS | PASS | — | |
| 41832529681 | dsh-ci e2e | rc.5 | cc96eb02e | 132 / 0, T3 WARN | PASS | PASS | — | |
| 41832534523 | dsh-ci e2e | rc.5 | cc96eb02e | 132 / 1 FAIL (R2) | PASS | PASS | WARN (offline) | model ctx_reduce in pnew before MC fired |
| 41839132273 | dsh-ci checks (push) | rc.5 | f6ce05a22 | success | | | | |
| 41839150646 | dsh-ci e2e #0 | rc.5 | f6ce05a22 | 133 PASS / 0 FAIL / 2 WARN (E2, T3) — 135 judged | PASS | PASS | PASS | |
| 41840580191 | dsh-ci checks (push) | rc.5 | 21985b4ef | failure | | | | dsh-plugin 623/1: open-lock-residue test flake, fixed `5b3ae0917` |
| 41840699540 | dsh-install | rc.5 | 21985b4ef | A0–A4 PASS | | | | |
| 41840694149 | dsh-install | 0.2.2-alpha.3 | 21985b4ef | failure | | | | DSH plugin manager rejects (peer pin rc.5) → exemption lane `adb5ed80d` |
| 41841161491 | dsh-ci checks (push) | rc.5 | 5b3ae0917 | success | | | | |
| 41841941636 | dsh-ci checks (push) | rc.5 | adb5ed80d | success | | | | dsh-plugin **624**/0 |
| 41841943616 | dsh-install | 0.2.2-alpha.3 + allow-version | adb5ed80d | A0 WARN, A1–A4 PASS | | | | A0 WARN = only doctor's version pin failed; exemption needed (by design) |
| 41842386831 | dsh-ci e2e rc.5 #1 (28c) | rc.5 | adb5ed80d | 133 / 1 FAIL (C3) / 1 WARN (E2) | PASS | PASS | PASS | C3 peak at the last step, 待验证 (`c6-28c-c3-y2.md`) |
| 41845836776 | dsh-ci e2e rc.5 #2 (28c) | rc.5 | 95333e55d | 135 / 0 / 0 | PASS | PASS | PASS | — (C3 PASS again) |
| 41842392546 | dsh-ci e2e (slot a3) | 0.2.2-alpha.3 + allow-version | adb5ed80d | 132 / 1 FAIL (Y2) / 2 WARN (E2, T3) | PASS | PASS | PASS | Y2 check timing (`c6-28c-c3-y2.md`) |
| 41842397847 | dsh-ci e2e (slot a3b) | 0.2.2-alpha.3 + allow-version | adb5ed80d | 133 / 1 FAIL (Y2) / 1 WARN (E2) | PASS | PASS | PASS | Y2 same |
| 41775904921 | dsh-soak (12 h, 4 × 180 min) | rc.5 | 901fb7874 (round 26 code) | seg 1+2 success, K1–K9 PASS cumulative (6681/6681 mock, real 12/12); seg 3 running, seg 4 queued at 22:25 CST | | | | |

## Files

- `c1-*`, `c1b-*` — fold v1 / v2 red/green (limitations 21/22).
- `c2-open-lock-residue-*` — open-lock crash residues red/green.
- `c3-reown-multi-owner-*` — re-own with ≥ 2 stale owners red/green.
- `c4-silent-catch-*` — context plane silent catch red/green.
- `c5-r2-r4-r7-model-selfdrop.md` — R2/R4/R7 analysis (model ctx_reduce against the prompt).
- `c6-28c-c3-y2.md` — 28c: C3 on rc.5 #1 and Y2 on alpha.3, offline re-check.
- `b1-preset-include-commit-*` — alpha.3 preset include commit() red/green + repro.
