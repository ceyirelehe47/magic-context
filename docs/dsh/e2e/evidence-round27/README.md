# Round 27 evidence (2026-11-04)

No keys in this directory: CI logs are the redacted artifacts; the real model key
only ever lived in the `OPENCODE_API_KEY` secret. Local repro outputs contain no
credentials.

## Runs

| run id | workflow | head | result | notes |
|---|---|---|---|---|
| 41784617324 | dsh-ci e2e | 0cf582631 | e2e 127 PASS / 4 FAIL / 1 WARN (E2) | F1–F3 + T3 on real DSH: the undurable tool result is restored as `interrupted-tool-result-…`, the tail owner is a new synthetic owner → duplicate tag (adapter; fixed 374a7e978, red fa16f0217) |
| 41784636699 | dsh-install | 0cf582631 | A1–A4 PASS (4/4) | install → upgrade → disable → roll back |
| 41785194154 | dsh-ci checks (push) | b679849f2 | success | dsh-plugin 603/0 |
| 41784866391 | dsh-ci checks (push) | e0297f5ce | failure | C5 RED commit (expected) |
| 41786892642 / 41787291338 / 41787727909 | dsh-ci checks (push) | 8c2ef3c26 / fa16f0217 / 374a7e978 | failure | test-file typecheck (`CommandResult.text` optional) — fixed fc928cbb4; fa16f0217 is also the F RED commit. Pushes 4751d7521…77581e2df were cancelled by the next push (cancel-in-progress) |
| 41787740600 | dsh-ci checks + e2e | 374a7e978 | checks failure (test typecheck, fixed fc928cbb4); e2e 128 PASS / 2 FAIL / 2 WARN (132) | R0 `pnew-03` pi-ai clamp (upstream, won't fix); ST1 `sw-1-3`/`sw-2-3` DSH-native cordis.yml boot race (won't fix; `c7-st1-cordis-yml-dsh-native.txt`); WARN E2, T3; F1–F3 PASS; I1 PASS |
| 41787772332 | dsh-ci e2e | 374a7e978 | cancelled | superseded by 41788066023 |
| 41788039793 | dsh-ci checks (push) | fc928cbb4 | success | dsh-plugin 610/0, adapter-api 15, contracts 104, test typecheck 0 |
| 41788066023 | dsh-ci checks + e2e | fc928cbb4 | checks success; e2e 130 PASS / 1 FAIL / 1 WARN (132) | R0 `pnew-05` pi-ai clamp (1 output token → max-tokens; upstream, won't fix); WARN E2 (real MiniLM ranks 3/8, 8/8, 2/8, 1/8); ST1, F1–F3, I1 PASS |
| 41790564442 | dsh-ci checks + e2e | fc928cbb4 | checks success; e2e 131 PASS / 0 FAIL / 1 WARN (132) | WARN E2 (real MiniLM 1/3, 2/3, 1/3, 1/3); R0, ST1, F1–F3, I1 PASS |
| 41792847109 | dsh-ci checks (push) | 605a8f7a4 | success | dsh-plugin 610/0, adapter-api 15, contracts 104 |
| 41792968900 | dsh-ci checks + e2e | 605a8f7a4 | checks success; e2e 131 PASS / 0 FAIL / 2 WARN (133) | first run with scenario S on per-session profiles (ST1 PASS, profiles test-s1…s5) and DN1 (PASS, no race signature); WARN E2 (real MiniLM 4/9, 9/9, 1/9, 3/9) and **I1** (h-a4: model copied the new `<recorded-tool-activity>` record, 8 124 chars — `c8-i1-recurrence-41792968900.md`) |
| 41775904921 | dsh-soak (12 h: 4 × 180 min, real every 30) | 901fb7874 (round 26 code) | segment 1/4 success, K1–K9 PASS; segments 2–4 running | seg 1: 3310/3310 mock, residue 0/3316, RSS 1.02×, wall 1.00×, WAL 0, DB 1.1 → 48 MB, historian failures 0/16 958, real 6/6 |

Two consecutive e2e at `fc928cbb4` with no FAIL besides the known won't-fix items:
41788066023 (only R0, upstream pi-ai clamp) and 41790564442 (0 FAIL). The run after
them at 605a8f7a4 (41792968900) is 0 FAIL too, with I1 WARN.

## Files

- `c1-*` — C1 fold format red/green and the imitation base rate before the change.
- `c2-*` — doctor after a full disable, red/green.
- `c3-host-unload-closed-db.txt` — host-unload-release flake = test isolation.
- `c4-*`, `c4b-*` — crash point `tail-fold-pending` / scenario F (local), red/green.
- `c5-open-lock-race-*` — open-lock races, red/green.
- `c5b-embed-deferral-*`, `c5b-message-index-*` — auto-embed deferral diagnostic; message-index cost.
- `c6-migrate-concurrent-*`, `c6-unsummarized-tail-*` — migrate-legacy stale plan; unsummarized tail linear + surrogate.
- `c8-i1-recurrence-41792968900.md` — limitation 21 after the format change: 1 of 5 runs, new format copied.
- `c7-st1-cordis-yml-dsh-native.txt`, `c7-cordis-yml-race-repro.mjs.txt` — ST1 root cause (DSH-native), mechanism repro, disposition.
