# Round 9 evidence — duplicate `§N§` fix (DSH 0.2.1-rc.5, headless profile `test`)

Model route: OpenCode Go deepseek-v4.1-flash, 24k window; historian on the 200k route;
`MC_HISTORIAN_THRESHOLD=12` (env only, no profile file changed) so the historian fires from turn 1.
Paths and the home hash are redacted (`<work>`, `dsh:<home>:`); message ids are shortened to 8 hex.

| File | What it shows |
|---|---|
| `unit-red-before-fix.txt` | regression test on the pre-fix code: 6 bare-id rows (10181d774, previous run) |
| `unit-legacy-fold-red-without-fold.txt` | legacy-fold test fails when the fold is disabled (befdcea2e) |
| `unit-new-input-red-without-preassign.txt` | new-input test fails without the pre-assign (7471bfd42) |
| `validate-summary.txt`, `unit-*.txt` | typecheck:dsh 0 errors; dsh-plugin 375/0; adapter-api 14/0; contracts:dsh 98/0 |
| `real-new-session-*` | real run 1, build befdcea2e: 3 turns, 2 compartments, 6 message tags, all unique `:p0` keys, 0 bare; model lists §1§–§6§ on 6 distinct texts. The step's new prompt was untagged on its first call, and the model's own reply prefix guessed low (raw reply `§4§` vs. the turn-2 prompt's later `§4§`) |
| `real2-*` | real run 2, build 7471bfd42: 3 turns, 2 compartments, 7 message tags, all unique `:p0` keys, 0 bare; the new prompt is tagged on its first call (`§1§`, `§4§`, `§7§` in the raw user events); model lists §1§–§7§ on 7 distinct texts |
| `real-db-legacy-fold.txt` | the shipped fold on a copy of the real pre-fix DB: 9 bare rows in 4 sessions removed, every owner left with one tag |

Not verified live: resuming a pre-fix session in DSH (those sessions run under the `standard` preset, which the one-shot runner refuses), so the fold was verified on a DB copy.
