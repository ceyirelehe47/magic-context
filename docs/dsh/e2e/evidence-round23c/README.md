# Round 23c evidence — P0-2 (process crash vs DB consistency), 23b close-out

No keys in this directory (the mock model's key is the literal `mock-not-a-secret`;
CI artifacts are redacted by `ci-check.py redact`).

## Unit / cross-process (bun, real child process + file DB)

`packages/dsh-plugin/src/agent/crash-recovery.test.ts` — process A is a real
child (`crash-recovery.fixture.ts`) SIGKILLed by the e2e-only fault injection
(`MAGIC_CONTEXT_DSH_E2E=1` + `MAGIC_CONTEXT_DSH_E2E_CRASH_AT=<point>`); process B
(the test) reopens the same SQLite file and restores the DSH session from the
durable per-event log the child left behind.

- `crash-recovery-before-fix.txt` — at `4d8746309` (RED commit): 3 pass / 3 fail.
  All three failures are the same product defect: `isDshHistorianBusy` returns
  `true` for a lease whose owner pid is dead (historian-leased,
  historian-publish, historian-published).
- `crash-recovery-after-fix.txt` — at `e37619117`: 6 pass / 0 fail
  (+ `PRAGMA integrity_check` = ok after every crash).

Fixture correction before the red run (test, not product): the seeded
assistant messages lacked `source.provider/model` and `stream: []`, which
DSH's `Session.create(id, events)` seed validation rejects (`seed
assistant/message at index 1 message must have model source` / `has invalid
settlement fields`). Live `append` does not validate, so the child process ran
and only the restore failed.

## Scenario Y — real DSH (rc.5) + mock model, external `kill -9`

`local-y/` — local run of `scripts/e2e/ci-x.sh` @ `615dabcb4` (plugin built
and installed into the scratch profile):

- `y-kill.json` — the hold line was logged, then `kill -9 8964` (the node pid).
- `db-y-1k.json` — after the kill: lease row `owner_pid 8964`, `expires_at`
  ~5 min ahead (unexpired), 0 compartments, `compartment_in_progress = 1`,
  `integrity_check = ok`.
- `y-2.log`, `y-2-status.jsonl`, `db-y-2.json` — restart: rc=0 in 23 s; the
  first pass of y-2 already reclaimed the dead lease (before the first
  pre-step observer: `historianBusy:false, leases:[]`); y-2's passes were
  `noop` ("nothing to compact (eligibleEnd=1 <= offset=1)" — the kill came
  after one read). NOTE: the `historianRuns` field of `db-y-1k.json` /
  `db-y-2.json` was added afterwards by hand from the real `historian_runs`
  rows (ids 65, 66, created during y-2) because `ci-x.ts` only started dumping
  that table in `96c27be69`; CI dumps it directly.
- `y-3.log`, `db-y-3.json` — second restart: compartment (1,1) published, no
  duplicate; tags 2 → 3 → 5, every earlier tag kept its number/message.
- Local verdict with the final checks: Y1–Y6 PASS, X1–X8 PASS.

## 23b close-out — e2e 41636248583 @ `6db89d4d1`

86 PASS / 1 FAIL. R12 PASS (`holdRemainingMs=20780` > 0, waited 21 s, "lease
acquired", `/compact` success). X1–X5, X7, X8 PASS. X6 FAIL was the scenario:
the workflow's redact step (run before `check`) rewrites `$HOME` → `~`
inside `x-session.jsonl`, so the tool-result text no longer hashed to
`original_sha` (CI `original_chars` = log length + 15 for all 7 tags). The DSH
log itself was intact. Fixed in `fa309b67d` (hash before redaction);
reproduced locally by redacting the 23b local evidence: X6 FAIL → PASS.

## Round 23c e2e — 41640093586 @ `96c27be69`

`summary-41640093586.md`: 92 PASS / 1 FAIL of 93 judged (87 + Y1–Y6).
X1–X8 PASS (X6 with `hashedBeforeRedact: true`), Y1–Y6 PASS (kill -9 pid
4927 inside the hold; tool results 1–3 whole in the log; y-2 passes noop, no
busy; y-3 published (1,1); tags 4 → 5 → 7 stable; integrity ok ×3), R12 PASS
(`holdRemainingMs=27958`). R10 FAIL: two backstop compactions in scenario L
ended with "summary is not smaller than the shadowed content (423 >= 239)"
(lock-session events 65, 82) — intermittent, model-dependent, not P0-2; see
DSH-MAINTENANCE known limitation 18 (f). `summary-41636248583.md` is 23b's run.

## Concurrent first migration (found in 23c, core, not fixed)

`repro-concurrent-first-migration.ts` spawns the two crash-recovery fixtures on
a fresh DB (3 × 15 in parallel): 2 / 45 runs lost one process to
"table temporal_decisions already exists" (core migration v95 check-then-create).
Push run 41642824046 hit it in the two-process unit case (A died before its
first event, the old `codeA != 0` assertion hid why). Fixed in the test (DB
migrated once before spawning; A must log its crash point); 12/12 under
parallel load locally.

## e2e 41642823892 @ `74de2508f`

91 PASS / 2 FAIL. R10 again (backstop "summary is not smaller … 819 >= 475",
second occurrence; see known limitation 18 (f)). Y6 FAIL was the check: the
kill landed after read #2 was printed on stdout but before DSH made it
durable; DSH's restore recorded `TOOL_OUTCOME_UNKNOWN` for that call (by
design). Y6 now requires "whole or TOOL_OUTCOME_UNKNOWN per call, no partial
original, every call has a result" (re-judged: 41642823892 / 41640093586 /
local all PASS). Checks job of this run passed; the push run on the same
commit (41642824046) hit the concurrent-first-migration flake.
