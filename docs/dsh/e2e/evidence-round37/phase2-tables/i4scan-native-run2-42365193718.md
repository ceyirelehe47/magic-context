# I4 scan — dsh-e2e-evobench-native-run2-42365193718

```json
{
 "main_bodies": 23,
 "max_active_m0": 1,
 "bodies_with_m0_gt1": [],
 "bodies_with_m1_gt1": [],
 "publications_at": [],
 "historian_requests": [],
 "pair_violations": 0,
 "distinct_hist_assistant_toolcall_msgs": 21,
 "without_reasoning_content": 1,
 "reasoning_lost_vs_response": 0,
 "coverage_gaps_in_latest": {},
 "pressure_lines": 23
}
```

## Publications (main request where the newest m0 gains a range): before / at / after

| n | kind | active m0 | m1 | newest m0 ranges | body bytes | msgs | prompt tok | cached | reasoning | ms |
|---|---|---|---|---|---|---|---|---|---|---|

## Backstop / pressure lines (turn logs)

- `turn-01.log:3` [magic-context] native pressure check: child=false pct=0 thresholdPct=90 window=1000000 outcome=skipped:no-routed-request backstop=0->0/?
- `turn-01.log:12` [magic-context] native pressure check: child=false pct=1.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=10597->10597/900000
- `turn-01.log:20` [magic-context] native pressure check: child=false pct=1.3 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=13071->13071/900000
- `turn-01.log:31` [magic-context] native pressure check: child=false pct=1.8 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=18238->18238/900000
- `turn-01.log:40` [magic-context] native pressure check: child=false pct=2.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=21364->21364/900000
- `turn-01.log:49` [magic-context] native pressure check: child=false pct=2.3 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=23350->23350/900000
- `turn-01.log:56` [magic-context] native pressure check: child=false pct=2.4 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=23615->23615/900000
- `turn-01.log:65` [magic-context] native pressure check: child=false pct=2.4 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=23851->23851/900000
- `turn-01.log:74` [magic-context] native pressure check: child=false pct=2.8 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=27644->27644/900000
- `turn-01.log:83` [magic-context] native pressure check: child=false pct=3 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=30472->30472/900000
- `turn-01.log:92` [magic-context] native pressure check: child=false pct=3.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=31211->31211/900000
- `turn-01.log:101` [magic-context] native pressure check: child=false pct=3.2 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=31745->31745/900000
- `turn-01.log:108` [magic-context] native pressure check: child=false pct=3.2 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=32067->32067/900000
- `turn-01.log:117` [magic-context] native pressure check: child=false pct=3.4 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=34462->34462/900000
- `turn-01.log:126` [magic-context] native pressure check: child=false pct=3.5 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=35068->35068/900000
- `turn-01.log:130` {"type":"tool_result","callId":"call_a827fcdd3c304f2293edea8b","status":"completed","result":"===~/work/_temp/evo/native-run2/iso/patches/bench-evo.yml\n# Round 36 line I evo bench, ALL groups: the DSH web tools are off (web_search /\n# web_fetch would hand the agent the release's PR diffs; the first pipeline run\n# 42229338110 fetched docs.conan.io's changelog and, through bash curl, the\n# GitHu
- `turn-01.log:133` [magic-context] native pressure check: child=false pct=3.6 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=36112->36112/900000
- `turn-01.log:142` [magic-context] native pressure check: child=false pct=3.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=37342->37342/900000
- `turn-01.log:151` [magic-context] native pressure check: child=false pct=3.9 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=38606->38606/900000
- `turn-01.log:158` [magic-context] native pressure check: child=false pct=4.5 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=44714->44714/900000
- `turn-01.log:165` [magic-context] native pressure check: child=false pct=4.6 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=45728->45728/900000
- `turn-01.log:174` [magic-context] native pressure check: child=false pct=5 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=49932->49932/900000
- `turn-01.log:181` [magic-context] native pressure check: child=false pct=5.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=51196->51196/900000

## Every request (main / subagent / historian)

| n | kind | status | finish | active m0 | m1 | cover max | gaps | bytes | msgs | asst w/ tool_calls | … without reasoning | tool msgs | pairing violations | prompt | cached | reasoning | out | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | main | 429 | None | 1 | 1 | 0 | [] | 43051 | 5 | 0 | 0 | 0 | 0 | None | None | None | None | 2757 |
| 3 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 43051 | 5 | 0 | 0 | 0 | 0 | 10177 | 0 | 25 | 161 | 53674 |
| 4 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 44410 | 8 | 1 | 0 | 2 | 0 | 10537 | 9984 | 0 | 189 | 40771 |
| 5 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 54705 | 11 | 2 | 1 | 4 | 0 | 13277 | 10368 | 176 | 381 | 35147 |
| 6 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 75186 | 15 | 3 | 1 | 7 | 0 | 18212 | 13056 | 536 | 741 | 73090 |
| 7 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 87860 | 18 | 4 | 1 | 9 | 0 | 21429 | 18048 | 714 | 894 | 60122 |
| 8 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 95664 | 21 | 5 | 1 | 11 | 0 | 23476 | 21248 | 74 | 121 | 25216 |
| 9 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 96306 | 23 | 6 | 1 | 12 | 0 | 23621 | 23296 | 9 | 188 | 74055 |
| 10 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 97612 | 27 | 7 | 1 | 14 | 0 | 23974 | 23424 | 188 | 358 | 56275 |
| 11 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 112572 | 30 | 8 | 1 | 16 | 0 | 27729 | 23808 | 859 | 1088 | 67102 |
| 12 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 123932 | 33 | 9 | 1 | 18 | 0 | 30582 | 27520 | 77 | 299 | 43433 |
| 13 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 126232 | 36 | 10 | 1 | 20 | 0 | 31329 | 30336 | 106 | 358 | 26346 |
| 14 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 127854 | 39 | 11 | 1 | 22 | 0 | 31774 | 31104 | 26 | 150 | 50777 |
| 15 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 129020 | 41 | 12 | 1 | 23 | 0 | 32211 | 31616 | 1943 | 2128 | 85838 |
| 16 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 138350 | 44 | 13 | 1 | 25 | 0 | 34505 | 32000 | 22 | 208 | 38286 |
| 17 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 140509 | 47 | 14 | 1 | 27 | 0 | 35152 | 34304 | 27 | 127 | 48697 |
| 18 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 144388 | 49 | 15 | 1 | 28 | 0 | 36264 | 34944 | 339 | 488 | 57532 |
| 19 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 148725 | 52 | 16 | 1 | 30 | 0 | 37436 | 36096 | 102 | 337 | 46370 |
| 20 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 153406 | 55 | 17 | 1 | 32 | 0 | 39108 | 37248 | 377 | 688 | 56828 |
| 21 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 176320 | 57 | 18 | 1 | 33 | 0 | 44748 | 38912 | 136 | 214 | 62006 |
| 22 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 180378 | 59 | 19 | 1 | 34 | 0 | 46087 | 44544 | 497 | 661 | 26508 |
| 23 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 196392 | 62 | 20 | 1 | 36 | 0 | 50095 | 45824 | 581 | 663 | 62961 |
| 24 | main | 200 | None | 1 | 1 | 0 | [] | 201052 | 64 | 21 | 1 | 37 | 0 | None | None | None | None | 37063 |
