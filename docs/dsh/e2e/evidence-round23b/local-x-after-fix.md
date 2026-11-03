# Scenario X local run (after the P0-1 fix) — real DSH 0.2.1-rc.5 + mock-llm.mjs (24k enforced, real BPE count)

Plugin @ dd6900465 (fix) with ci-x.sh of 6c7364093.

| check | result | what | detail |
|---|---|---|---|
| X1 | PASS | x-1: a 50 KB Chinese read (> the whole 24k window, meter ≈ 12.5k) is truncated before the next request; no request over the window | {"rc": "rc=0 elapsed=12.3s log=~/work/e2e/logs/run-57.log", "truncated": [2], "maxPrompt": 9999, "steps": [1, 2], "requests": [[9559, 4096, "tool"], [9999, 4096, "text"]]} |
| X2 | PASS | x-2: four 5 000-char Chinese reads in a row — truncated as they accumulate, every request within the window, all steps ran | {"rc": "rc=0 elapsed=15.3s log=~/work/e2e/logs/run-58.log", "truncated": [5, 6, 7, 8], "maxPrompt": 15728, "steps": [1, 2, 3, 4, 5], "prompts": [10038, 14690, 15395, 15728, 12108]} |
| X3 | PASS | x-3: a 49 KB English and a big Chinese read arrive while the historian holds the lease (e2e hold): truncated anyway, within the window | {"rc": "rc=0 elapsed=35.0s log=~/work/e2e/logs/run-60.log", "holds": 1, "truncated": [13, 14], "maxPrompt": 13223, "prompts": [12181, 12782, 13223]} |
| X4 | PASS | x-4: fourteen sub-floor English reads at MC 95 %: the native backstop compacts (no error), at most one compaction per step, all steps ran, within the window | {"rc": "rc=0 elapsed=21.8s log=~/work/e2e/logs/run-61.log", "compacted": [["86", "82.9"], ["84.1", "82.9"], ["84", "82.9"]], "compactionErrors": [], "maxCompactionsPerStep": 1, "steps": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], "maxPrompt": 19266, "piAiClampedRequests(info, limit… |
| X5 | PASS | x-2r / x-5 (new processes, same session): truncations of active tags replay unchanged; no truncation re-decided or duplicated (kept rows byte-identical), only rows of dropped tags pruned (latch kept), outbox settled, no live lease | {"rc": "rc=0 elapsed=14.9s log=~/work/e2e/logs/run-62.log", "restartAfterX2": {"rc": "rc=0 elapsed=12.0s log=~/work/e2e/logs/run-59.log", "rows": [2, 5, 6, 7, 8], "identicalToX2": true, "activeTruncatedTags": [2, 5, 6, 7, 8]}, "rowsBefore": [2, 5, 6, 7, 8, 13, 14], "rowsAfter": [14… |
| X6 | PASS | every truncated tool result's untruncated original (sha256 in dsh_pressure_truncations) is still in the DSH session log (historian / ctx_expand / re-read source) | {"truncated": [2, 5, 6, 7, 8, 13, 14], "originalMissing": [], "toolResults": 21} |
| X7 | PASS | scenario X: the mock (real BPE count, 24k enforced) never received a request over the window | {"requests": 32, "overWindow": [], "maxPrompt": 19266} |
| X8 | PASS | no loop: no plan step was requested more than 3 times (a retry storm or a compaction loop would repeat it) | {"maxRepeats": 1, "repeated": {}} |
