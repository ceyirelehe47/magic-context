# Round 33 A — P1-C: compatibility matrix (dsh.7 candidate, product code `c096b8a68`)

Rule of the round: reuse existing runs and tests, cheap deterministic checks first, at most one
new real e2e per DSH version and only for a key gap. The one gap found: **alpha.3 had no real e2e on
the current code** (its last e2e runs, 41842392546 / 41859577345, predate rounds 30–32, i.e. B4 / B5 /
c096b8a68 and node-24 fixes). One alpha.3 e2e was run (42051660209: 134 / 0 / 1). rc.5 and rc.1 already had e2e on
the current product code; no new real e2e for them.

Legend — **boot**: a real `dsh` process loaded the bundle through DSH's plugin manager; **model**:
real model (OpenCode Go) / mock (deterministic, `mock-llm.mjs`) / none. Results: PASS / FAIL / WARN.
Product code is `c096b8a68` in every run below unless stated (no adapter/core source change since).

## Evidence used

| id | kind | DSH | node | code | boot | model | result |
|---|---|---|---|---|---|---|---|
| U-push | push checks 42052963848 @ `9136032d6` | lockfile 0.2.1-rc.5 | bun 1.4.2 | c096b8a68 | no | none | dsh-plugin **643/0**, adapter-api **15/0**, contracts:dsh **105/0**, typecheck:dsh + test-file typecheck + core typecheck success, wf-lint 0 FAIL |
| K-a3 / K-rc1 | push contracts-dsh 42052963848 | 0.2.2-alpha.3 / 0.2.2-rc.1 (installed, asserted) | 24.22.2 | c096b8a68 | no | none | typecheck:dsh success, contracts:dsh **105/0** each |
| I-rc5 | dsh-install 42051595084 @ `89dbfe543` | 0.2.1-rc.5 | 22.23.4 | c096b8a68 + dsh.7 | yes | mock | A0–A4, A6–A8 PASS; **A5 FAIL** (npm ERESOLVE, B6) |
| I-a3 | dsh-install 42051600910 | 0.2.2-alpha.3 | 24.22.2 | same | yes | mock | A0–A4, A6–A8 PASS; **A5 FAIL** (B6) |
| I-rc1 | dsh-install 42051607781 | 0.2.2-rc.1 | 24.22.1 | same | yes | mock | **A0–A8 PASS** |
| E-rc5 | dsh-ci e2e 42037652492 @ `49b83e250` | 0.2.1-rc.5 | 22 | c096b8a68 | yes | real (+ mock scenarios X/M/E/W) | **133 / 0 / 2** (E2 WARN: core RRF ranking, upstream; T3 WARN: model restated the constraint) |
| E-rc1 | dsh-ci e2e 42034156577 @ `fb8621502` | 0.2.2-rc.1 | 24 | c096b8a68 | yes | real (+ mock) | **134 / 0 / 1** (E2 WARN) |
| E-a3 | dsh-ci e2e 42051660209 @ `89dbfe543` (slot a, this round) | 0.2.2-alpha.3 | 24 | c096b8a68 | yes | real (+ mock) | **134 / 0 / 1** (E2 WARN: core RRF ranking, upstream) — `a-e2e-alpha3-42051660209.md` |
| S-rc5 | dsh-soak 41775904921 @ `901fb7874` (round 26 code) | 0.2.1-rc.5 | 22 | **old (round 26)** | yes | mock + 24 real samples | 12 h, K1–K9 PASS (14 001 mock runs, 0 residue, RSS 1.13×) |
| R-master | dsh-ref-eval 42035098645 @ `49b83e250` | 0.2.2-rc.1 tree + master `fcc0ad4621` dsh-agent / subagent / llm / session compiled on top | 24 | c096b8a68 | **no** | none | typecheck:dsh, test-file typecheck, contracts:dsh, dsh-plugin 643/0 on the mixed tree |
| B1-master | round 32 `b1-worker-spec-green.txt` | master `fcc0ad4621` subagent runtime | — | c096b8a68 | no (real `startActivation`, stubs around it) | none | worker spec reaches `manager.startLocal` |

## Matrix

| dimension | 0.2.1-rc.5 (node 22) | 0.2.2-alpha.3 (node 24) | 0.2.2-rc.1 (node 24) | DSH master `fcc0ad4621` |
|---|---|---|---|---|
| **plugin registration & boot** | **PASS** — boot ✔ model real+mock — E-rc5 C0, M0.1–3, N0, U6; I-rc5 A1/A2 (Magic lines in a real turn, no exemption A0) | **PASS** — boot ✔ model real+mock — E-a3 C0, M0.1–3, N0–N5, U6; I-a3 A0–A2 (no exemption) | **PASS** — boot ✔ model real+mock — E-rc1 (same checks); I-rc1 A0–A2 | **WARN** — boot ✘ model ✘ — not done: master is unpublished; only the overlay (R-master) and the worker spec (B1-master). Registration through DSH's plugin manager on master never exercised |
| **setup / doctor** | **PASS** — boot ✔ mock — I-rc5 A1–A3 (setup / doctor rc 0, `disabled in every preset`), E-rc5 U6 (doctor after all runs, rc 0) | **PASS** — boot ✔ mock — I-a3 A1–A3; E-a3 U6 | **PASS** — boot ✔ mock — I-rc1 A1–A3; E-rc1 U6 | **WARN** — not run (no profile / no boot); doctor's DSH-version check would refuse master's `0.2.2-rc.1` label only if it differed (it does not) — 静态推断 |
| **config read/write & disable** | **PASS** — boot ✔ real — E-rc5 U4, U5, U7–U12 (live jsonc edit, settings page, /ctx-status pending-restart, hot keys); I-rc5 A3 (disable: no Magic line, no write) | **PASS** — boot ✔ real — E-a3 U4, U5, U7–U12; I-a3 A3 | **PASS** — boot ✔ real — E-rc1 U4–U12; I-rc1 A3 | **WARN** — unit only (R-master: settings / config tests inside the 643) |
| **tool calls & context recovery** | **PASS** — boot ✔ real — E-rc5 U1–U3, U2b, U13–U26 (multi-session memory, ctx_search / ctx_expand verbatim, no cross-session mixing), C4/C7/C8; I-rc5 A7 (packed tarball ctx_memory + ctx_expand, no injected text) | **PASS** — boot ✔ real — E-a3 U1–U3, U2b, U13–U26 (U14 PASS), C4/C7/C8; I-a3 A7 | **PASS** — boot ✔ real — E-rc1 U1–U26 (U14 PASS after B5), C4/C7/C8; I-rc1 A7 | **WARN** — unit only (R-master); worker spec on the real master subagent runtime (B1-master) |
| **integrity after /compact** | **PASS** — boot ✔ real — E-rc5 T1, T2, T4 (/compact with `<unprocessed_from>`, codeword after restart), R7, R12, R13, R14, C6 (T3 WARN: model restated the constraint in its own live tail; not a Magic copy) | **PASS** — boot ✔ real — E-a3 T1–T4 (T3 PASS this run), R7, R12–R14, C6, C3 PASS | **PASS** — boot ✔ real — E-rc1 T1–T4, R7, R12–R14, C6 | **WARN** — unit only (native-compaction ordinal tests inside the 643) |
| **crash recovery** | **PASS** — boot ✔ real (kill -9 of a real process) — E-rc5 Y1–Y6, F1–F3, X5/X6; S-rc5 K3 (0 residue in 14 025 runs; round-26 code → supporting only) | **PASS** — boot ✔ — E-a3 Y1–Y6 (Y2 judged by the checker at `89dbfe543`, incl. the B line's Y2 change `80f52b940`), F1–F3, X5/X6 | **PASS** — boot ✔ — E-rc1 Y1–Y6 (node 24 `/proc/<pid>/exe` lookup), F1–F3 | **WARN** — unit only (open-lock / lease tests inside the 643) |
| **install & rollback** | **PASS (pnpm path) / FAIL (npm path)** — boot ✔ mock — I-rc5 A0–A4, A6–A8 PASS (dsh.6 → dsh.7 → disable → dsh.6); **A5 FAIL**: `npm install <tgz>` next to DSH → ERESOLVE (B6) | **PASS (pnpm path) / FAIL (npm path)** — I-a3 A0–A4, A6–A8 PASS; **A5 FAIL** (B6) | **PASS** — I-rc1 A0–A8 | **n/a** — master is not published; nothing to install |

Cells read: result — boot / model — evidence. "PASS (pnpm path)" = the documented `dsh plugin add`
path; the npm path is a separate verdict because it fails on two versions (see
`a-release-candidate.md` B6).

## Gaps and caveats

- **Master** is type / contract / unit level only ("master overlay tests passed" ≠ "real DSH master
  app boot", `a-ci-audit.md`). No real boot, no model, no setup/doctor, no install on master.
- **Soak** ran on round-26 code and on rc.5 only; it is supporting evidence for crash recovery /
  long-run stability, not a verdict on the current code or on alpha.3 / rc.1.
- **Model-dependent checks** (C3, R14, T3, I1, R10-P, U14…) can flip on model behaviour; one e2e per
  version is a sample, not a rate. rc.5 C3 failed 2 of 4 runs since 28c (round 31: scenario property).
- e2e checker version: E-rc5 / E-rc1 were judged by `ci-check.py` before the B line's R14 / Y2
  changes (`98fa03b9b`, `80f52b940`); E-a3 by the checker at `89dbfe543`, which includes them.
- The B6 npm failure is the only FAIL in the matrix; it is an adapter manifest issue (optional
  client peers), not a DSH or core issue, and it does not touch the pnpm install path.
