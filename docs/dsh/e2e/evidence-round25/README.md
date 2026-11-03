# Round 25 evidence (DSH 0.2.1-rc.5, core v0.49.35)

## e2e runs (dsh-ci.yml dispatch `e2e=true`)

| run | head | judged | result | failures and what they were |
|---|---|---|---|---|
| 41679402115 | `e5ce3b756` | 107 | 105 PASS / 2 FAIL | R14 — checker (replay did not decode DSH storage-form seq ranges; fixed `7d8ebad5d`); Y3 — scenario precondition (no real eligible history after `a529b7846`; fixed `d8daa0264`) |
| 41682984222 | `d8daa0264` | 107 | 106 PASS / 1 FAIL | U21 — **product**: historian re-promoted the corrected todo under the raw directory (memory 20 = archived 16, different `project_path`); fixed `8a7864594` (red `505d03fbe`) |
| 41688260239 | `b1cc19ce6` | 108 | 107 PASS / 1 FAIL | U14 — **checker**: FILE-HERON-2261 in compartment [11, 15] is the agent's own `ctx_memory` call at ordinal 11; `u14-41688260239-analysis.md`; fixed `955a12d08`. U21/U22/U26 PASS (first real verification of `8a7864594`) |
| 41693402758 | `955a12d08` | 117 | 116 PASS / 1 FAIL | ST5 — scenario precondition: every S historian pass noop 'nothing to compact (eligibleEnd=1 <= offset=1)' (4 user turns < 5-turn protected tail); fixed `79615e408`. H (U13–U26) all PASS; W1–W4 PASS; ST4 RSS 271 868 / 273 468 KB |
| 41696491092 | `79615e408` | 117 | 115 PASS / 2 FAIL | U16 — checker (folded compartment hit whose historian title names its own range's facts; `u16-x8-41696491092-analysis.md`; fixed `9e9b828a7`); X8 — scenario bug from `79615e408` (warm-up plans shared across sessions; fixed `40c5013a5`). ST5 PASS |
| **41699491685** | `40c5013a5` | 117 | **117 PASS / 0 FAIL** | all green, checks green in the same run; ST4 RSS 301 132 / 299 144 KB; ST5 5 compartments in each S session |
| 41699579212 | `40c5013a5` | 117 | 116 PASS / 1 FAIL | U20 — model (answered the facts' contents instead of their codewords; injected memory had all four codes, U15 PASS) → H consecutive count reset |
| 41705543125, 41705587583 | `40c5013a5` | 117 | in progress | H consecutive passes after the U20 reset |

## Unit before/after

- `u21-historian-memory-identity-{before,after}.txt` — 0/3 → 3/3
- `b1-open-lock-stale-{before,after}.txt` — 1/3 → 3/3
- `b2-lease-pid-reuse-{before,after}.txt` — 0/1 → 2/2; `b2-lease-repro-*` (adapter path)

## Scenario local dry runs

- `p12-scenario-s-local-*` (scenario S, local sandbox). Locally two S sessions
  got compartments without warm-ups while CI's never did; the difference was not
  investigated (CI is the reference).
- `p13-scenario-w-local-*` (scenario W, local)
