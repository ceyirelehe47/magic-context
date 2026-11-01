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
