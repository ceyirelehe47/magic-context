# C1 baseline: model imitating the folded tool format (before e7e31f2a3)

Re-scan of the downloaded e2e artifacts with the new I1 detector
(`ci-check.py`: model TEXT/final with a line `[tool: <name> #` / `[tool result: <name> #`,
or the new `<recorded-tool-activity` / `- called <name> (id ` record):

| run | head | hits |
|---|---|---|
| 41769676548 | 5e8380dd7 | lock-a: 2 assistant texts (8 181 / 8 314 chars) — R9/R11 FAIL |
| 41771964169 | 946f7b1ca | none |
| 41774795839 | 906ce5fc5 | none |
| 41777488761 | 47125f480 | lock-a: 1 assistant text (7 550 chars, `Reading the fifth fixture now.\n\n[tool: read #call_00_…]\ninput: {"file_path":"e2e-pressure-fixtures/p21.txt"}\n\n[tool result: read #call_00…`) — R9/R11 still PASS, so the round 26 "observed once" undercounted |

Base rate before the fix: 2 of 4 runs, always lock-a (the 40k pressure route with
dense `read` folds). All with the old `[tool: …]` format, which only the DSH adapter
renders (`agent/transcript.ts`); OpenCode/Pi keep real tool parts.
