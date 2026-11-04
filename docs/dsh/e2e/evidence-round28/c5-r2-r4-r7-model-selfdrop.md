# Round 28b — R2 / R4 / R7 on fold v2 (cc96eb02e): model ctx_reduce against the prompt

No keys here (redacted CI artifacts only).

## What failed

| run | check | why (from the run logs) |
|---|---|---|
| 41832514940 | R4, R7 | pold-02: after answering, the model called `ctx_reduce drop=5-12` (its own 8 reads) although the prompt says "Do not call ctx_reduce". Pressure 25 % -> 19 %; pold-03's 8 reads then ended at 27.6 % < 30.4 % (old DSH threshold) -> no native compaction -> R4 FAIL; R7 needs a completed main-session native compaction -> FAIL (cascade of R4). |
| 41832534523 | R2 | pnew-03 step 2: thinking "These big file dumps have served their purpose … a large paste inside one is fine once used … stamp 5-12 and 16-23" -> `ctx_reduce drop=5-12,16-23` (43.9 % -> 19.4 %), then `ctx_expand {"tag":16}` x4 (invalid args), then re-read p09-p12; pnew-04 again `drop=24-32,34-37,40-48` (44.8 % -> 20 %). 40 fixtures ended at 43 %: MC never fired -> R2 FAIL. |

Pressure curves (per run: steps, max prompt tokens, last MC pct): see `r28-p.py` output below.
Tool-call counts in P: reads 48–64 per run in every run (same as round 27); the difference is the drops.

## Is it the v2 fold? (statistical inference, not reproduced deterministically)

ctx_reduce calls in scenario P that the prompt forbids (pnew before MC's first fire; pold at any time):

```
41644306462 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41647689313 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41665756434 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41669354809 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41672370986 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41679402115 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41682984222 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41688260239 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41693402758 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41696491092 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 1
41699491685 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41699579212 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41705543125 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41705587583 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 1
41769676548 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41771964169 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41774795839 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41777488761 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41784617324 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41787740600 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41788066023 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41790564442 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41792968900 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41828791422 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41828796915 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41828802371 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41832514940 R2 True R4 False R7 False pnew_prefire_reduce 0 pold_reduce 1
41832520000 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41832524393 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41832529681 R2 True R4 True R7 True pnew_prefire_reduce 0 pold_reduce 0
41832534523 R2 False R4 True R7 True pnew_prefire_reduce 2 pold_reduce 0
```

- Rounds 21–28 v1 (26 runs, 41644306462 … 41828802371): pnew pre-fire drops 0/26 runs; pold drops 2/26 (both small, R4 still passed); R2/R4/R7 failures 0/26.
- Fold v2 (5 runs @cc96eb02e): pre-fire/pold drops in 2/5 runs, both failed. Fisher exact (2 failures among 31 runs, both in the 5 v2 runs): p = C(5,2)/C(31,2) = 10/465 ≈ 0.02.
- Mechanism (static inference from the thinking text): v2 labels the folded results "merged below as plain reference text"; core's ctx_reduce guidance explicitly allows stamping "a large paste inside a user message … once used", and the model applied it to the current turn's folded reads.
- The model considers stamping in every run (thinking mentions ctx_reduce/stamp in 5–14 thoughts per run, also round 27); it acted on it pre-fire only in v2 runs.

## Disposition

- Root cause: real-model behaviour (ignores the explicit "Do not call ctx_reduce"), likely made more frequent by the v2 wording (p ≈ 0.02, 5 runs). Stamping spent reads is core's intended ctx_reduce behaviour; not a product bug in the adapter. The fold wording is NOT changed: v2 is what brought I1 to 0 copies and I2 to 0 re-read storms in 5/5 runs; trading that for scenario P's preconditions would be the wrong way round.
- Scenario fix (adapter e2e script, assertions unchanged): pnew gets up to 8 batches (64 fixtures; 1–40 byte-identical) while MC has not fired; pold runs batches until the old-policy native compaction happened (2 minimum, 4 maximum). R1–R4, R7 are judged exactly as before.
- New WARN-only R10 reports every such drop (offline: 41832514940 WARN pold-02 5-12; 41832534523 WARN pnew-03/04; 41832520000 / 41792968900 PASS).
- Open: whether the v2 wording raises self-stamping is 待验证 (needs more runs; R10 now counts it).
