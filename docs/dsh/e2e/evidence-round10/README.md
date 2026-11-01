# Round 10 evidence (DSH 0.2.1-rc.5, headless profile `test`)

Model route: OpenCode Go deepseek-v4.1-flash, 24k window; historian on the 200k route;
`MC_HISTORIAN_THRESHOLD=12` (env only, no profile file changed). Paths and the home hash are
redacted (`<work>`, `dsh:<home>:`); message ids are shortened to 8 hex.

## Item 1 — runtime-context snapshot vs the model's own reply prefix (fix 53f3fdd37)

| File | What it shows |
|---|---|
| `unit-item1-rc-red-before-fix.txt` | new `runtime-context-tags.test.ts` on the old code: model wrote `§2§`, core gave the reply 3 (the snapshot took 2); snapshot tagged |
| `validate-item1-summary.txt`, `unit-item1-dsh-plugin-summary.txt` | typecheck:dsh 0 errors; dsh-plugin 377/0; adapter-api 14/0; contracts:dsh 98/0 |
| `real1-session-events.txt` | real 4-turn session (turn 3 calls `read`): raw events, reconstructed surface, `§N§` ownership over raw assistant events + surface — 0 duplicate numbers; raw reply prefixes §2§ §4§ §7§ §9§ equal core's tags; ONE runtime-context event in 4 turns, still on the surface (round 9: one per turn, old ones as Magic copies) |
| `real1-session-db.txt` | tag rows: 7 message tags all `:p0`, 1 tool tag, no runtime-context tag, 0 bare, 0 duplicate keys |

## Item 2 — new input after an unfolded tool call (fix a81db15fb)

| File | What it shows |
|---|---|
| `unit-item2-red-before-fix.txt` | `new-input-fold-tags.test.ts` on the old preview: payload fold (no pre-tag) and session-tail fold (pre-tag at `:p0`, which core gives to the absorbed assistant text) both fail; the landed-replace case passes |
| `validate-item2-summary.txt` | typecheck:dsh 0 errors; dsh-plugin 380 pass / 0 fail (+1 pre-existing unhandled between-tests storage-open error, also in round 9); adapter-api 14/0; contracts:dsh 98/0 |
| `unit-item2-flaky-unhandled-first-run.txt` | full dsh-plugin log with that unhandled error |

Real rc.5: the landed-replace path is the one real runs take (real1 turn 3: the step after the
`read` call shows the model's `§7§` equal to core's tag). A failed replace cannot be forced live.

## Item 4 — pruner vs Magic drops (fix 347a76d3c)

| File | What it shows |
|---|---|
| `unit-item4-drop-red-before-fix.txt` | `drop-after-tag.test.ts` on the old walk: a drop queued after tagging stays `active` (op copies read as baselines); steady-state (no churn) passes on both |
| `validate-item4-summary.txt` | typecheck:dsh 0 errors; dsh-plugin 382/0 (+1 pre-existing unhandled error); adapter-api 14/0; contracts:dsh 98/0 |
| `real-item4-summary.md` | what the real session shows (drops land; the protected-tool-result gap) |
| `real-item4-session-events.txt`, `real-item4-session-events-after.txt` | raw events + surface before / after turns 6-8 (`[dropped §1§]`, `[dropped §2§]` replaces) |
| `real-item4-session-db.txt`, `real-item4-db-after.txt`, `real-item4-queued.txt` | tag rows before / after; the hand-queued tool drops (pending, protected) |
| `protected-4000.yml` | the extra patch used |
