# R14 fixtures (round 33)

`ci-history.ts` output (with the round-33 structural fields `originSeqs`,
`shadowedBy`, `onRawSurface`, `inSummaryText`) replayed with the real DSH
0.2.1-rc.5 `Session` from the `dsh-e2e` artifacts of three real CI runs.
Used by `test_ci_check_r14.py`.

| file | source |
|---|---|
| `rc5-42034146821-summary-restates.json` | run 42034146821 `lock-session.jsonl` + `db-lock-d.json` as uploaded (the model stored the five checksums with `ctx_memory`; the checkpoint at seq 224 quotes them) |
| `rc5-42037652492-normal.json` | run 42037652492, as uploaded |
| `rc1-42034156577-normal.json` | run 42034156577 (DSH 0.2.2-rc.1), as uploaded |
| `rc5-42034146821-before-lockd-compaction.json` | run 42034146821 `lock-session.jsonl` cut at seq 221 (before lock-d's `/compact`, seq 222): lock-c's reads are not folded by any compaction yet |
| `rc5-42034146821-no-compartment-32.json` | run 42034146821 full session, `db-lock-d.json` with compartment 32-43 removed (the reads are in no compartment) |

The remaining cases in the test are single-field mutations of these files,
spelled out in the test itself.
