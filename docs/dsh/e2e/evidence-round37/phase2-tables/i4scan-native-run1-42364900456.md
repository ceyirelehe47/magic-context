# I4 scan — dsh-e2e-evobench-native-run1-42364900456

```json
{
 "main_bodies": 76,
 "max_active_m0": 1,
 "bodies_with_m0_gt1": [],
 "bodies_with_m1_gt1": [],
 "publications_at": [],
 "historian_requests": [],
 "pair_violations": 0,
 "distinct_hist_assistant_toolcall_msgs": 73,
 "without_reasoning_content": 8,
 "reasoning_lost_vs_response": 0,
 "coverage_gaps_in_latest": {},
 "pressure_lines": 77
}
```

## Publications (main request where the newest m0 gains a range): before / at / after

| n | kind | active m0 | m1 | newest m0 ranges | body bytes | msgs | prompt tok | cached | reasoning | ms |
|---|---|---|---|---|---|---|---|---|---|---|

## Backstop / pressure lines (turn logs)

- `turn-01.log:3` [magic-context] native pressure check: child=false pct=0 thresholdPct=90 window=1000000 outcome=skipped:no-routed-request backstop=0->0/?
- `turn-01.log:12` [magic-context] native pressure check: child=false pct=1.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=10758->10758/900000
- `turn-01.log:20` [magic-context] native pressure check: child=false pct=1.3 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=12599->12599/900000
- `turn-01.log:29` [magic-context] native pressure check: child=false pct=1.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=16668->16668/900000
- `turn-01.log:38` [magic-context] native pressure check: child=false pct=1.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=17494->17494/900000
- `turn-01.log:45` [magic-context] native pressure check: child=false pct=2.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=20946->20946/900000
- `turn-01.log:54` [magic-context] native pressure check: child=false pct=2.2 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=22066->22066/900000
- `turn-01.log:63` [magic-context] native pressure check: child=false pct=2.2 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=22472->22472/900000
- `turn-01.log:72` [magic-context] native pressure check: child=false pct=2.3 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=23279->23279/900000
- `turn-01.log:81` [magic-context] native pressure check: child=false pct=2.4 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=23587->23587/900000
- `turn-01.log:90` [magic-context] native pressure check: child=false pct=2.4 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=23772->23772/900000
- `turn-01.log:97` [magic-context] native pressure check: child=false pct=2.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=27043->27043/900000
- `turn-01.log:106` [magic-context] native pressure check: child=false pct=2.9 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=28693->28693/900000
- `turn-01.log:115` [magic-context] native pressure check: child=false pct=3 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=30438->30438/900000
- `turn-01.log:122` [magic-context] native pressure check: child=false pct=3.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=30862->30862/900000
- `turn-01.log:125` {"type":"tool_result","callId":"call_ef5d49e2e6464faa891ba7b4","status":"completed","result":"# Round 36 line I evo bench, ALL groups: the DSH web tools are off (web_search /\n# web_fetch would hand the agent the release's PR diffs; the first pipeline run\n# 42229338110 fetched docs.conan.io's changelog and, through bash curl, the\n# GitHub API for PR 13450). Bash-level network to code hosts / pac
- `turn-01.log:128` [magic-context] native pressure check: child=false pct=3.2 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=31794->31794/900000
- `turn-01.log:137` [magic-context] native pressure check: child=false pct=3.2 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=32336->32336/900000
- `turn-01.log:146` [magic-context] native pressure check: child=false pct=3.4 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=34008->34008/900000
- `turn-01.log:155` [magic-context] native pressure check: child=false pct=3.6 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=36408->36408/900000
- `turn-01.log:164` [magic-context] native pressure check: child=false pct=4 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=39718->39718/900000
- `turn-01.log:171` [magic-context] native pressure check: child=false pct=4.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=40944->40944/900000
- `turn-01.log:180` [magic-context] native pressure check: child=false pct=4.3 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=42612->42612/900000
- `turn-01.log:187` [magic-context] native pressure check: child=false pct=4.4 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=44255->44255/900000
- `turn-01.log:196` [magic-context] native pressure check: child=false pct=4.5 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=45043->45043/900000
- `turn-01.log:203` [magic-context] native pressure check: child=false pct=4.6 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=45680->45680/900000
- `turn-01.log:210` [magic-context] native pressure check: child=false pct=4.6 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=46024->46024/900000
- `turn-01.log:216` [magic-context] native pressure check: child=false pct=4.6 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=46119->46119/900000
- `turn-01.log:225` [magic-context] native pressure check: child=false pct=4.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=47003->47003/900000
- `turn-01.log:232` [magic-context] native pressure check: child=false pct=5 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=49677->49677/900000
- `turn-01.log:241` [magic-context] native pressure check: child=false pct=5.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=51243->51243/900000
- `turn-01.log:248` [magic-context] native pressure check: child=false pct=5.3 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=53063->53063/900000
- `turn-01.log:255` [magic-context] native pressure check: child=false pct=5.4 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=53953->53953/900000
- `turn-01.log:262` [magic-context] native pressure check: child=false pct=5.5 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=54694->54694/900000
- `turn-01.log:269` [magic-context] native pressure check: child=false pct=5.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=56791->56791/900000
- `turn-01.log:276` [magic-context] native pressure check: child=false pct=5.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=57022->57022/900000
- `turn-01.log:283` [magic-context] native pressure check: child=false pct=5.9 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=59373->59373/900000
- `turn-01.log:292` [magic-context] native pressure check: child=false pct=6 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=59870->59870/900000
- `turn-01.log:299` [magic-context] native pressure check: child=false pct=6.2 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=61708->61708/900000
- `turn-01.log:308` [magic-context] native pressure check: child=false pct=6.3 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=63207->63207/900000
- `turn-01.log:315` [magic-context] native pressure check: child=false pct=7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=70233->70233/900000
- `turn-01.log:323` [magic-context] native pressure check: child=false pct=7.5 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=74857->74857/900000
- `turn-01.log:330` [magic-context] native pressure check: child=false pct=7.5 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=75349->75349/900000
- `turn-01.log:337` [magic-context] native pressure check: child=false pct=7.6 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=75903->75903/900000
- `turn-01.log:343` [magic-context] native pressure check: child=false pct=7.6 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=76083->76083/900000
- `turn-01.log:350` [magic-context] native pressure check: child=false pct=7.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=76507->76507/900000
- `turn-01.log:357` [magic-context] native pressure check: child=false pct=7.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=77053->77053/900000
- `turn-01.log:364` [magic-context] native pressure check: child=false pct=7.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=77194->77194/900000
- `turn-01.log:373` [magic-context] native pressure check: child=false pct=7.8 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=77928->77928/900000
- `turn-01.log:380` [magic-context] native pressure check: child=false pct=7.8 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=78157->78157/900000
- `turn-01.log:387` [magic-context] native pressure check: child=false pct=8 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=80161->80161/900000
- `turn-01.log:394` [magic-context] native pressure check: child=false pct=8.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=80621->80621/900000
- `turn-02.log:4` [magic-context] native pressure check: child=false pct=8.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=81323->81323/900000
- `turn-02.log:13` [magic-context] native pressure check: child=false pct=8.2 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=82152->82152/900000
- `turn-02.log:21` [magic-context] native pressure check: child=false pct=8.6 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=85715->85715/900000
- `turn-02.log:30` [magic-context] native pressure check: child=false pct=8.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=87013->87013/900000
- `turn-02.log:39` [magic-context] native pressure check: child=false pct=9 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=90060->90060/900000
- `turn-02.log:46` [magic-context] native pressure check: child=false pct=9.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=91296->91296/900000
- `turn-02.log:55` [magic-context] native pressure check: child=false pct=9.6 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=96231->96231/900000
- `turn-02.log:62` [magic-context] native pressure check: child=false pct=9.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=96705->96705/900000
- `turn-02.log:69` [magic-context] native pressure check: child=false pct=9.9 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=98687->98687/900000
- `turn-02.log:78` [magic-context] native pressure check: child=false pct=10 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=100240->100240/900000
- `turn-02.log:85` [magic-context] native pressure check: child=false pct=10.1 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=101320->101320/900000
- `turn-02.log:92` [magic-context] native pressure check: child=false pct=10.2 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=102188->102188/900000
- `turn-02.log:99` [magic-context] native pressure check: child=false pct=10.2 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=102412->102412/900000
- `turn-02.log:105` [magic-context] native pressure check: child=false pct=10.3 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=102676->102676/900000
- `turn-02.log:112` [magic-context] native pressure check: child=false pct=10.3 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=102982->102982/900000
- `turn-02.log:119` [magic-context] native pressure check: child=false pct=10.4 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=104072->104072/900000
- `turn-02.log:126` [magic-context] native pressure check: child=false pct=10.5 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=105346->105346/900000
- `turn-02.log:133` [magic-context] native pressure check: child=false pct=10.7 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=106738->106738/900000
- `turn-02.log:140` [magic-context] native pressure check: child=false pct=10.8 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=107789->107789/900000
- `turn-02.log:147` [magic-context] native pressure check: child=false pct=10.8 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=108265->108265/900000
- `turn-02.log:154` [magic-context] native pressure check: child=false pct=10.9 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=108840->108840/900000
- `turn-02.log:160` [magic-context] native pressure check: child=false pct=10.9 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=109122->109122/900000
- `turn-02.log:166` [magic-context] native pressure check: child=false pct=11 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=109609->109609/900000
- `turn-02.log:173` [magic-context] native pressure check: child=false pct=11 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=109754->109754/900000
- `turn-02.log:182` [magic-context] native pressure check: child=false pct=11 thresholdPct=90 window=1000000 outcome=skipped:below-threshold backstop=110154->110154/900000

## Every request (main / subagent / historian)

| n | kind | status | finish | active m0 | m1 | cover max | gaps | bytes | msgs | asst w/ tool_calls | … without reasoning | tool msgs | pairing violations | prompt | cached | reasoning | out | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 43051 | 5 | 0 | 0 | 0 | 0 | 10175 | 0 | 29 | 171 | 3815 |
| 3 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 45066 | 8 | 1 | 0 | 2 | 0 | 10716 | 10112 | 0 | 179 | 2611 |
| 4 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 52705 | 11 | 2 | 1 | 4 | 0 | 12749 | 10624 | 308 | 471 | 5026 |
| 5 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 68541 | 14 | 3 | 1 | 6 | 0 | 16775 | 12672 | 384 | 581 | 6506 |
| 6 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 71318 | 17 | 4 | 1 | 8 | 0 | 17531 | 16768 | 11 | 78 | 2088 |
| 7 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 85512 | 19 | 5 | 1 | 9 | 0 | 21327 | 17408 | 367 | 597 | 7179 |
| 8 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 88379 | 22 | 6 | 1 | 11 | 0 | 22075 | 21248 | 22 | 203 | 3365 |
| 9 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 89967 | 25 | 7 | 1 | 13 | 0 | 22532 | 22016 | 281 | 482 | 5238 |
| 10 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 92845 | 28 | 8 | 1 | 15 | 0 | 23444 | 22528 | 19 | 107 | 2753 |
| 11 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 93524 | 31 | 9 | 1 | 17 | 0 | 23596 | 23424 | 4 | 132 | 2228 |
| 12 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 94233 | 34 | 10 | 1 | 19 | 0 | 23782 | 23552 | 496 | 597 | 6428 |
| 13 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 107533 | 36 | 11 | 1 | 20 | 0 | 26694 | 23680 | 1180 | 1410 | 13558 |
| 14 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 115425 | 39 | 12 | 1 | 22 | 0 | 28771 | 26624 | 992 | 1165 | 15570 |
| 15 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 121968 | 42 | 13 | 1 | 24 | 0 | 30563 | 28672 | 58 | 168 | 2323 |
| 16 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 123097 | 44 | 14 | 1 | 25 | 0 | 30934 | 30464 | 0 | 80 | 1724 |
| 17 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 126606 | 46 | 15 | 2 | 26 | 0 | 31925 | 30848 | 142 | 330 | 4756 |
| 18 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 128198 | 49 | 16 | 2 | 28 | 0 | 32366 | 31872 | 1373 | 1592 | 16470 |
| 19 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 134861 | 52 | 17 | 2 | 30 | 0 | 34023 | 32256 | 533 | 703 | 8322 |
| 20 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 144500 | 55 | 18 | 2 | 32 | 0 | 36343 | 33920 | 66 | 255 | 4141 |
| 21 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 158603 | 58 | 19 | 2 | 34 | 0 | 39909 | 36224 | 696 | 787 | 10269 |
| 22 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 162752 | 60 | 20 | 2 | 35 | 0 | 40968 | 39808 | 1206 | 1466 | 15822 |
| 23 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 169202 | 63 | 21 | 2 | 37 | 0 | 42701 | 40960 | 1406 | 1539 | 17530 |
| 24 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 175708 | 65 | 22 | 2 | 38 | 0 | 44267 | 42624 | 427 | 665 | 7460 |
| 25 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 178493 | 68 | 23 | 2 | 40 | 0 | 45066 | 44160 | 45 | 129 | 2747 |
| 26 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 180851 | 70 | 24 | 2 | 41 | 0 | 45928 | 45056 | 30 | 78 | 2808 |
| 27 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 181288 | 72 | 25 | 2 | 42 | 0 | 46030 | 45824 | 0 | 67 | 2111 |
| 28 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 181669 | 74 | 26 | 3 | 43 | 0 | 46124 | 45952 | 620 | 857 | 8805 |
| 29 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 185095 | 77 | 27 | 3 | 45 | 0 | 47012 | 46080 | 68 | 138 | 2776 |
| 30 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 196262 | 79 | 28 | 3 | 46 | 0 | 49829 | 46976 | 1095 | 1331 | 14726 |
| 31 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 201767 | 82 | 29 | 3 | 48 | 0 | 51296 | 49792 | 1615 | 1695 | 18411 |
| 32 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 208655 | 84 | 30 | 3 | 49 | 0 | 53076 | 51200 | 139 | 301 | 4476 |
| 33 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 212155 | 86 | 31 | 3 | 50 | 0 | 54349 | 52992 | 24 | 132 | 2565 |
| 34 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 213555 | 88 | 32 | 3 | 51 | 0 | 54757 | 54272 | 880 | 971 | 10976 |
| 35 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 221777 | 90 | 33 | 3 | 52 | 0 | 56757 | 54656 | 83 | 253 | 3504 |
| 36 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 222723 | 92 | 34 | 3 | 53 | 0 | 57027 | 56704 | 2177 | 2271 | 25460 |
| 37 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 232187 | 94 | 35 | 3 | 54 | 0 | 59416 | 56960 | 150 | 430 | 5570 |
| 38 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 233860 | 97 | 36 | 3 | 56 | 0 | 59877 | 59392 | 490 | 569 | 6658 |
| 39 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 241500 | 99 | 37 | 3 | 57 | 0 | 61598 | 59776 | 414 | 675 | 8248 |
| 40 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 247904 | 102 | 38 | 3 | 59 | 0 | 63796 | 61568 | 5751 | 5859 | 60280 |
| 41 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 273686 | 104 | 39 | 3 | 60 | 0 | 70183 | 63744 | 3344 | 3463 | 36371 |
| 42 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 293040 | 106 | 40 | 3 | 61 | 0 | 74933 | 70144 | 167 | 378 | 5996 |
| 43 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 294832 | 108 | 41 | 3 | 62 | 0 | 75353 | 74880 | 331 | 512 | 5400 |
| 44 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 297278 | 110 | 42 | 3 | 63 | 0 | 75907 | 75264 | 0 | 138 | 2146 |
| 45 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 297947 | 112 | 43 | 4 | 64 | 0 | 76087 | 75904 | 12 | 382 | 3961 |
| 46 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 299731 | 114 | 44 | 4 | 65 | 0 | 76511 | 76032 | 135 | 498 | 4474 |
| 47 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 301882 | 116 | 45 | 4 | 66 | 0 | 77058 | 76416 | 3 | 99 | 2307 |
| 48 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 302423 | 118 | 46 | 4 | 67 | 0 | 77193 | 77056 | 470 | 643 | 7114 |
| 49 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 305551 | 121 | 47 | 4 | 69 | 0 | 77946 | 77184 | 32 | 113 | 2197 |
| 50 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 306476 | 123 | 48 | 4 | 70 | 0 | 78162 | 77824 | 387 | 476 | 6236 |
| 51 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 314713 | 125 | 49 | 4 | 71 | 0 | 80138 | 78080 | 159 | 237 | 3643 |
| 52 | main | 200 | stop | 1 | 1 | 0 | [] | 316734 | 127 | 50 | 4 | 72 | 0 | 80601 | 80128 | 544 | 722 | 8686 |
| 53 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 320042 | 129 | 50 | 4 | 72 | 0 | 81380 | 80512 | 21 | 180 | 2489 |
| 54 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 323296 | 132 | 51 | 4 | 74 | 0 | 82412 | 81280 | 0 | 178 | 2495 |
| 55 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 337147 | 135 | 52 | 5 | 76 | 0 | 86462 | 82304 | 146 | 328 | 3897 |
| 56 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 339278 | 138 | 53 | 5 | 78 | 0 | 87097 | 86400 | 231 | 440 | 5776 |
| 57 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 351420 | 141 | 54 | 5 | 80 | 0 | 90488 | 87040 | 79 | 177 | 2401 |
| 58 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 354912 | 143 | 55 | 5 | 81 | 0 | 91666 | 90368 | 1357 | 1516 | 14076 |
| 59 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 373028 | 146 | 56 | 5 | 83 | 0 | 96412 | 91648 | 16 | 94 | 2735 |
| 60 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 374249 | 148 | 57 | 5 | 84 | 0 | 96707 | 96384 | 100 | 175 | 2670 |
| 61 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 382554 | 150 | 58 | 5 | 85 | 0 | 98686 | 96640 | 67 | 256 | 3641 |
| 62 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 388916 | 153 | 59 | 5 | 87 | 0 | 100439 | 98560 | 56 | 152 | 2677 |
| 63 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 392464 | 155 | 60 | 5 | 88 | 0 | 101500 | 100352 | 477 | 641 | 6442 |
| 64 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 394850 | 157 | 61 | 5 | 89 | 0 | 102197 | 101376 | 13 | 107 | 2216 |
| 65 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 395666 | 159 | 62 | 5 | 90 | 0 | 102474 | 102144 | 0 | 164 | 2186 |
| 66 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 396362 | 161 | 63 | 6 | 91 | 0 | 102682 | 102400 | 24 | 96 | 1987 |
| 67 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 397675 | 163 | 64 | 6 | 92 | 0 | 102990 | 102656 | 454 | 536 | 5705 |
| 68 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 402160 | 165 | 65 | 6 | 93 | 0 | 104093 | 102912 | 22 | 114 | 2082 |
| 69 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 407359 | 167 | 66 | 6 | 94 | 0 | 105585 | 104064 | 463 | 553 | 5226 |
| 70 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 411991 | 169 | 67 | 6 | 95 | 0 | 106814 | 105472 | 377 | 466 | 6320 |
| 71 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 416106 | 171 | 68 | 6 | 96 | 0 | 107840 | 106752 | 328 | 413 | 4447 |
| 72 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 417924 | 173 | 69 | 6 | 97 | 0 | 108270 | 107776 | 187 | 290 | 4510 |
| 73 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 420301 | 175 | 70 | 6 | 98 | 0 | 108915 | 108160 | 0 | 160 | 2503 |
| 74 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 421101 | 177 | 71 | 7 | 99 | 0 | 109128 | 108800 | 0 | 434 | 3778 |
| 75 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 423032 | 179 | 72 | 8 | 100 | 0 | 109615 | 109056 | 4 | 105 | 2274 |
| 76 | main | 200 | tool_calls | 1 | 1 | 0 | [] | 423577 | 181 | 73 | 8 | 101 | 0 | 109750 | 109568 | 111 | 293 | 3373 |
| 77 | main | 200 | stop | 1 | 1 | 0 | [] | 425213 | 184 | 74 | 8 | 103 | 0 | 110174 | 109696 | 685 | 836 | 9748 |
