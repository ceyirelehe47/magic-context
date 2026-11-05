# Round 33 B · P2-C — how fresh is the 12 h soak?

**Status:** 待验证 (assessment only; no soak triggered, as instructed).

## Baseline

Soak 41775904921 (`dsh-soak.yml`, 4 × 180 min, finished 2026-11-05 00:58 CST): code
`901fb7874` (round 26, committed 2026-11-04 04:50 UTC), DSH 0.2.1-rc.5, node 22, mock
main model + mock historian (24k window enforced), one real-model sample every 30 min.
Result: K1–K9 PASS — 14 001/14 001 mock runs, residue 0 of 14 025, RSS 1.13×, wall
3.06 → 2.65 s, WAL max 0, DB growth/run flat (1.1 → 199 MB), 0 historian failures of
71 929, real 24/24 (`evidence-round30/c1-soak-41775904921-final.txt`).

What the soak exercises: **one** `dsh headless` process at a time (process per turn),
three rotating sessions retired after 40 turns, pressure → historian passes → native
compaction backstop, a shared DB that only grows. What it never exercised: concurrent
processes, a long-lived process (in-process growth), DSH alpha.3 / rc.1, node 24.

## Delta `901fb7874..HEAD`

`git log 901fb7874..origin/dsh-integration`: 77 commits (round 26 M5 → round 33).
`packages/plugin` (core) and `packages/adapter-api`: **unchanged**. Soak harness
(`dsh-soak.yml`, `soak.sh`, `soak-check.py`, `soak-probe.ts`): unchanged; `bootstrap.sh`
+10/−1 (round 33 A lane). Adapter production code (`packages/dsh-plugin/src`, tests and
fixtures excluded) +832/−105 in 17 files:

| file | +/− | commits |
|---|---|---|
| `host/open-lock.ts` | +200/−18 | b679849f2 (takeover TOCTOU, hard-link create, takeover mutex), bb86b923c (crash-residue sweep at acquire) |
| `agent/transcript.ts` | +195/−19 | e7e31f2a3 / 77a6c3b2f / cc96eb02e (fold rendering v0→v2 prose), 374a7e978 / 8ea0321a8 (re-own absorbed tail tags) |
| `agent/embedding-wiring.ts` | +128/−4 | 7c0a50ff9 (auto-embed deferral diagnostic: in-memory counter, `dsh_adapter_meta` row at N, 2N, 4N …) |
| `agent/historian.ts` | +33/−11 | 8c2ef3c26 (`<unsummarized_tail>` linear size, surrogate-safe clip) |
| `agent/context-plane.ts` | +35/−6 | 952a3970a (fail-open catches log once, set capped at 256), 5bddc27df (e2e-only crash point) |
| `agent/tools.ts`, `knowledge-gate.ts`, `commands.ts` | +17/−11 | 4a29a6bf5 (ctx_expand strips injected text), fold-note prose for todo restore |
| `compat/dsh-0.1/subagent.ts` | +15/−7 | c096b8a68 (activation spec both shapes) |
| `entries/preset-include.ts`, `compat/dsh-0.1/profile-patch.ts` | +43/−0 | bdeb8bfa0 (alpha.3 `commit()` no-op), declarations |
| `doctor/*` (cli, doctor, env, setup, migrate-legacy) | +160/−27 | CLI only (72beaaa19, 31e92d398, 47125f480, 5daa53311, e443057d6, declarations) — not on the soak path |

## Risk by area

| area | what changed on the soak path | soak-relevant risk | covered since by |
|---|---|---|---|
| **concurrency** | open lock: hard-link exclusive create, takeover mutex, exact-record removal | low for the soak (it never runs two processes); the risk is in races, which the soak does not create | unit tests with real processes (open-lock-race 8 racers, open-lock-residue SIGKILL), e2e scenario S (5 processes × 4 rounds, every run) |
| **resource management** | open lock: `readdirSync` of the DB directory + stat per matching temp **on every process start**; embed-deferral `WeakMap<db, Map<session, …>>`; plane-failure set capped at 256 | low–medium: the per-start sweep is the only new work on every one of the soak's ~14 000 starts (cost grows with the number of files in the storage dir, which the soak keeps small); the maps live per process and the soak's process-per-turn design hides in-process growth anyway | unit tests; the soak's K5 (wall time) would catch a slow start |
| **SQLite** | new `dsh_adapter_meta` rows `embed-deferral:<session>` (written at 10, 20, 40 … consecutive deferrals, deleted when the FTS index catches up); `doctor` closes via core `closeDatabase()` | low: bounded, self-clearing rows; only when the message-history FTS index lags compartments (real embedding path; the soak uses the mock and may never hit it) | embed-deferral unit tests, e2e scenario H |
| **historian** | `<unsummarized_tail>` construction now linear (was O(n²)); clip never splits a surrogate pair; trigger failures logged once | low, positive (less CPU on long tails); used by `/compact` with `<unprocessed_from>`, which the soak's backstop path rarely takes | unsummarized-tail(-edge) tests, e2e scenario T |
| **session lifecycle** | fold rendering prose (every pre-step on every tool arc); re-own of absorbed tail tags after a crash; ctx_expand view filter | **medium**: the fold text is rebuilt on every step and is what the next request and the meter count — the soak would show it as RSS/wall/DB-growth slope (K4/K5/K6) and as window overruns (K8). Re-own runs only after a crash | fold-format tests, e2e I1/I2 (every run), scenario F (kill during tail fold) |
| **compaction** | indirect only: the fold text changes how many tokens a tool arc costs, so pressure / historian / backstop timing on a 24k route shifts | medium: the soak's 24k mock route is exactly where timing shifts matter (K7 historian failures, K8 over-window) | e2e X1–X8 (24k mock) every run |

No change since the soak touches core migrations, compartment publication, the outbox,
lease acquisition/renewal or tag allocation.

## Recommendation

- The 12 h result is still evidence for the unchanged core paths (outbox, leases,
  compartments, tags, migrations) but **not** for the per-step fold text (round 27–28),
  the per-start open-lock sweep (round 28) or the embed-deferral writes (round 27b) —
  all on the soak's hot path.
- **Regression soak before the next tag that is meant to be "soak-backed":** `dsh-soak.yml`
  on HEAD, rc.5, `segments=2 segment_minutes=120` (4 h of runs; job timeout 160 min each,
  ≈ 5 h 20 min wall, two serial runner jobs), `real_every_minutes=30` (≈ 8 real-model
  turns on the 24k route — small key spend). Judge with the same K1–K9 and compare the
  slopes with 41775904921 (RSS 1.13×, wall 0.87×, DB growth/run ≈ 14.1 KB, historian
  failures 0). 4 h reaches ≈ 4 700 runs, enough for the K4/K5 first-vs-last-10 % medians
  to be meaningful; 12 h adds little for the changed code (none of it accumulates state
  across processes beyond the bounded meta rows).
- **Not covered by any soak (gap to note, not to fix in this lane):** DSH alpha.3 / rc.1 on
  node 24 — `dsh-soak.yml` has no `dsh_version` input and pins node 22. A 2 × 60 min rc.1
  soak would need a workflow change (A lane / integrator decision).
- Optional, cheap, no runner: a local micro-benchmark of `sweepOpenLockResidue` with
  1 000 files in the storage dir, to bound the per-start cost (not done).
- Priority: medium. Every changed path above is exercised by the 135-check e2e on each
  run and by unit tests; the soak adds the long-horizon growth/leak signal only.
