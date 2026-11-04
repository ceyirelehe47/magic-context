# Round 26 evidence (2026-11-04)

No keys in this directory: all logs are the CI's redacted artifacts; the real
model key only ever lived in the `OPENCODE_API_KEY` secret.

## Runs

| run id | workflow | head | result | notes |
|---|---|---|---|---|
| 41769676548 | dsh-ci (checks + e2e) | 5e8380dd7 | checks 587/1, e2e 113/4 | bun 1.4.2 SQLITE_MISUSE (fixed 8ba07a9fa); R9/R11 model imitates folded tool format; U14/U22 checker — `run-41769676548-analysis.md` |
| 41771964169 | dsh-ci e2e | 946f7b1ca | e2e 124/2 | T2 (no historian_runs row on the /compact path → 07284476f), Y4 (tag drift of an unreplaced tail fold after kill -9 → 906ce5fc5) — `run-41771964169-analysis.md` |
| 41773273940 | dsh-soak (short: 2 × 10 min, real every 8) | ade660ee6 | K1–K9 PASS | 348/348 mock runs rc 0, 3/3 real samples; RSS 289 502 → 311 864 KB (1.08×); wall 3.24 → 4.00 s; WAL max 0; 0 historian failures of 1 656 |
| 41774382966 | dsh-ci checks (push) | 07284476f | failure | test-file typecheck: `.query` on core `Database` (fixed 10d8dc8d2) |
| 41775057793 | dsh-ci checks (push) | 96677e175 | success | dsh-plugin 590/0 |
| 41775611238 | dsh-ci checks (push) | 901fb7874 | dsh-plugin 589/1 | `host-unload-release` "Cannot use a closed database" — intermittent (same code green on 96677e175); pending verification |
| 41775066316 | dsh-install | 96677e175 | A1–A4 FAIL | pnpm 9: `ERR_PNPM_ADDING_TO_ROOT` in the profile workspace; job falsely green (tee) — both fixed 901fb7874 |
| 41775619062 | dsh-install | 901fb7874 | A1–A4 PASS | install dsh.2 → upgrade dsh.4 (HEAD) → disable → roll back dsh.2 |
| 41774795839 | dsh-ci e2e | 906ce5fc5 | e2e 121/6 (+E2 WARN) | T2 + Y4 PASS; M5 real (backup name collision inside one second → 47125f480); T3 real model restated the codeword in its own reasoning (seq 81) — model; S2/S6/S7 child's stock compaction-basic "summary is not smaller" ×7 → max-tokens — native/model; U23 model answered from injection without ctx_search; E2 real MiniLM ranks 5/7, 6/7, 2/7, 1/7 |
| 41777488761 | dsh-ci checks + e2e | 47125f480 | checks green (dsh-plugin 591/0); e2e 127 PASS + 1 WARN, 0 FAIL | E2 WARN: real MiniLM ranks 1/6, 1/6, 1/6, 2/6 |
| 41775904921 | dsh-soak (12 h: 4 × 180 min, real every 30) | 901fb7874 | dispatched | not awaited this round |

## Files

- `p0-migrate-legacy-{red,green}.txt`, `p1-2-compact-tail-{red,green}.txt` — unit before/after.
- `run-41769676548-analysis.md`, `run-41771964169-analysis.md` — per-dispatch analyses.
