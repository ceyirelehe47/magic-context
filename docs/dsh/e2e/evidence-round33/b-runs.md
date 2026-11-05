# Round 33 B — runs, commits, evidence index

## CI runs triggered by lane B

| run | workflow / inputs | DSH / node | sha | result | notes |
|---|---|---|---|---|---|
| 42050071694 | dsh-ci `{"e2e":"true","slot":"b"}` | 0.2.1-rc.5 / 22 | `98fa03b9b` | success — e2e **134 / 0 / 1** (E2 WARN) | first CI run of the round-33 `ci-history.ts`; R14 PASS on the structural basis; T3, C3, Y2 PASS this time |

Push CI on lane-B commits (automatic `push` runs, checks + contracts-dsh): 42049424622
@ `98fa03b9b` success, 42050669304 @ `80f52b940` success. No soak, no install lane, no
second e2e (P2-A needed none; budget was 1 + 2).

## Replays of existing artifacts (offline, no runner)

| run | DSH | R14 old → new | Y2 old → new |
|---|---|---|---|
| 42034146821 | rc.5 | FAIL → **PASS** | PASS → PASS (probe false) |
| 42037652492 | rc.5 | PASS → PASS | PASS → PASS (probe false) |
| 42034156577 | rc.1 | PASS → PASS | PASS → PASS (probe false) |
| 41842392546 | alpha.3 | PASS → PASS (regenerated) | FAIL → **PASS** (own fresh lease) |
| 41842397847 | alpha.3 | PASS → PASS (regenerated) | FAIL → **PASS** (own fresh lease) |
| 41859567651 | alpha.3 | PASS → PASS (regenerated) | FAIL → **PASS** (own fresh lease) |
| 41859577345 | alpha.3 | PASS → PASS (regenerated) | FAIL → **PASS** (own fresh lease) |

All other checks identical on every replay (U6 wording on the alpha.3 artifacts differs
because of the round-29 declaration, not this lane).

## Commits (lane B)

| sha | content | why | risk |
|---|---|---|---|
| `573d01342` | RED: `ci-history.ts` emits `originSeqs` / `shadowedBy` / `onRawSurface` / `inSummaryText`; R14 fixtures from 3 real runs (+2 derived); `test_ci_check_r14.py` (case 1 RED) | R14 false negative needs structural data | low: e2e helper only; output file name and CLI unchanged |
| `98fa03b9b` | FIX: R14 judges the fold structurally; lost / reaches on the raw surface; missing fields FAIL; `b-r14*.md/txt` | 42034146821 false FAIL; not weaker (see b-r14.md) | low: CI judgement only; stricter in 4 sub-conditions |
| `e0c8a7bbf` | RED: Y2 fixtures (alpha.3 ×2, rc.5 ×1) + `test_ci_check_y2.py` | Y2 4/4 FAIL on alpha.3/node 22 was a timing assumption | none (tests only) |
| `80f52b940` | FIX: Y2 accepts a busy probe only for the new process's own fresh lease (pid, holder, write time, y-2 run); `b-y2-*.txt` | user-allowed refinement, property unchanged | low: depends on core lease TTL constant (5 min), copied with a pointer |
| `f58134a49` | docs: P2-A/B/C evidence, upstream issue drafts, C3 meter repro, ST1 repro | analysis deliverables | none |
| (this commit) | docs: CI run record, R14 CI evidence, this index | close P1-A validation | none |

## Evidence files (`docs/dsh/e2e/evidence-round33/`)

- P1-A: `b-r14.md`, `b-r14-red.txt`, `b-r14-green.txt`, `b-r14-replay.txt`, `b-r14-ci-42050071694.txt`;
  fixtures `packages/dsh-plugin/scripts/e2e/fixtures/r14/` (+ README)
- P2-A: `b-p2a.md`, `b-y2-red.txt`, `b-y2-green.txt`, `b-y2-replay.txt`,
  `b-c3-meter-repro.ts.txt`, `b-c3-meter-repro-output.txt`; fixtures `fixtures/y2/`
- P2-B: `b-p2b-st1.md`, `b-st1-cordis-yml-race-repro.mjs.txt`, `b-st1-repro-output.txt`
- P2-C: `b-p2c-soak.md`
- Upstream drafts (not filed): `b-upstream-issue-drafts.md` (§1 core ranking, §2 DSH
  token-meter, §3 DSH cordis.yml boot race)

## For the integrator

- The two new unit tests are not wired into CI (dsh-*.yml is outside lane B):
  `python3 packages/dsh-plugin/scripts/e2e/test_ci_check_r14.py` and
  `… /test_ci_check_y2.py` (stdlib only, < 0.1 s each). Suggest adding them to the
  `checks` job.
- ci-check.py reuses ids: `T3` (worker 1500 ms timeout: child has 0 Magic rows) and `T3`
  (scenario T: tail carries the constraint); `R10` (scenario P ctx_reduce) and `R10`
  (backstop deferral). Not changed here (renaming would break every cross-reference in
  DSH-MAINTENANCE); worth a note when the docs are consolidated.
- DSH-MAINTENANCE / RELEASE-NOTES / memory were not touched (lane rule).
