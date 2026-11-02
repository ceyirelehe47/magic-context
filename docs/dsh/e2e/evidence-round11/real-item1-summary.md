# Round 11 item 1 — real rc.5, 24k window, pressure truncation (build 5ce41da9d)

Same profile/patch/turns as round 10 item 4 (`protected-4000.yml`, opencode-go deepseek-v4.1-flash,
contextWindow 24000, maxTokens 4096; historian threshold 65 % from the patch). Session `session-30c75e4e…`.

| turn | round 10 (8e40ba126, no truncation) | round 11 (5ce41da9d) |
|---|---|---|
| 3 read meter.ts | step 2 input 19 121 tok → `max-tokens` after 1 token, empty answer | pre-step at 79 % + 4096 reserve ≈ 96 % ≥ force 85 % → §6§ (outbox.ts read, 14 957 chars, protected) truncated to head 1440 + tail 480 (seq 56 replace 38-38); step 2 input 15 331 tok; answer `§10§ wrapPressureDefinition` (correct: first export of meter.ts) |
| 4 ctx_reduce | `max-tokens`, tool never called | `ctx_reduce {drop:"9"}` called → `Queued: deferred drop §9§.` (§9§ is the newest read, still in core's protection window → stays pending: core parity) ; reply `DROPPED` |
| 5 quote LICENSE | `max-tokens` | "The first line of the LICENSE file is "MIT License"." |
| 6 OK | `max-tokens` | `OK` (historian compartment drop `[dropped §1§]` landed, seq 93) |

Consistency: one `dsh_pressure_truncations` row (§6§, basis usage seq 51); the truncated copy (seq 56) was written
ONCE and stayed on the surface through turns 4–6 (each turn is a fresh `dsh` process = restart): no further replace
of it, outbox has exactly one `drops` op for it. Turn 4 step 2 (68 % + reserve) made no second batch.
§N§ ownership over raw events + surface: 0 duplicate numbers. The newest read (§9§, meter.ts) was never truncated.

Files: `real-item1-session-events.txt` (events + surface + §N§ check), `real-item1-session-db.txt` (tags),
`real-item1-truncations-db.txt` (truncation rows, pending_ops, outbox), `real-item1-seq56-excerpt.txt`
(head / marker / tail of the truncated copy as the model saw it). Logs: run-20..25.
Note: after this run the marker wording was refined (numbered-listing line range); an existing truncation re-renders
once with the new wording on the next pass (one replace), then is stable again.
