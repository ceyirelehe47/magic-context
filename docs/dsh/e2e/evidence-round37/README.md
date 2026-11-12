# Round 37 evidence (2026-11-07)

User request 13:44 CST: fix the fold-view reasoning blow-up of the DSH adapter (I3) — new-session default
may change, old fold sessions are not migrated.

| file | what |
|---|---|
| `i3-native-default.md` | root cause, implementation (native roles default for new sessions), compatibility, offline tests, real paired runs (layer 2), context-management runs (layer 3), remaining issues, commits |
| `i3-pairs-1m-tables.md` | generated tables of the three fold / native pairs on the 1M catalog route (42345522531, 42348194793) |
| `phase2-i4-isolation-integration.md` | round 37 phase 2 (user request 16:53 CST): I4 fix, real `ctx_expand`, cold-process resume, backstop outcome (RED / fix / verification each); bench isolation (four layers, env allowlist and iso/patches gaps, residual boundary); real runs (pair 42365193718, catalog-hist 429 stops); verified vs not verified; §6 I4 real-publication rerun 42459290880; §7 checkpoint + m0 overlap fix (RED / fix / real run 42613997607, real rerun 42729564554 §7.5) and `max_completion_tokens: 1` investigation; §7.6 segment 9: tail coverage after compaction (lim 36) + historian boundary / noop log (lim 37), offline; §7.7 real check evo-22 run 42805322951; §7.8 segment 11: limitation 35 root cause corrected (rc.5 replay has no usage anchor; the restore pushed #426 to 1), prune/restore ping-pong fixed offline, noop stderr dedupe; §7.9 segment 12: S9 fixed (A+C: MC prices pressure against window − maxTokens, doctor backstop-first warning) and limitation 35 option B (near-window trigger), offline; §7.10 paired real run MC vs DSH native |
| `phase2-tables/` | generated pair table of 42365193718 and per-request I4 / pairing / backstop scans (`i4scan-*.md`) of the phase-2 runs |
| `phase2-tables/ckpt-fix-42613997607.md` | §7.4: checkpoint + m0 overlap fix validation run (turn 1 timeout; no compaction, no publication — fixed path not reached; probe 0 leaks, $0.229) — ckscan / i4scan / analyze extracts |
| `phase2-tables/ckpt-fix-42729564554.md` | §7.5: real rerun with turn timeout 2400 s (10/10 turns, 2 compactions, 12 publications; checkpoint retired at main 310; overlap 95 / 306; $1.262) — ckscan / i4scan / duplicate bytes / historian timing / analyze extracts |
| `phase2-tables/noop-replay-42729564554.txt` | §7.6: replay of the 42729564554 session log per `fires=true` pre-step (last five meaningful user messages, historian requests); order check only — the replay's ordinals are not Magic's (header explains) |
| `phase2-tables/evo22-42805322951.md` | §7.7: real check of segment 9 (10/10 turns, 24 historian requests, 22 publications, 3 compactions each retired in the next request, never 2 live summaries, no gap after compaction, 0 tail blocks needed; $1.972) — per-turn fire / request / publication timeline vs 42729564554 and 42459290880, ckscan, boundary content match, cost by kind |
| `i3-scripts/evo22scan.py` | §7.7: per-turn historian fire classification + publication cache hits for one evo run |
| `phase2-tables/lim35-estimate-42459290880-42805322951.md` | §7.8: pi-ai estimate recomputed from every main body of both runs (no usage anchor; matches max_completion_tokens within 0.1–0.3 %), pruned vs restored bodies, static what-if with every large result pruned |
| `phase2-tables/pair-evo23-evo24-43223273703-43223280088.md` | §7.10: paired real run @ `9382f3078`, MC (evo-23) vs DSH native without MC (evo-24): MC $1.655 vs DSH $1.122 (publication cache breaks = 82.5 % of MC main miss), MC 31 publications + 1 backstop compaction after 18 publications, DSH 7 compactions, Magic write-backs 0, min max_completion_tokens 22 253, 0 tail blocks, probe 0 leaks; DSH Score step failed (rows API 502) — pairscan table, token decomposition, boundaries, MC backstop lines, MC timeline |
| `i3-scripts/estscan.py`, `i3-scripts/prunesim.py` | §7.8: the recomputation and the what-if |
| `i3-scripts/pairscan.py` | §7.10: paired comparison of evo run dirs (cost by kind, cache hit incl. publication requests, compactions, write-backs, max_completion_tokens distribution, backstop order, tail blocks, probe, F2P / P2P + prefix-match rescore) |
| `i3-scripts/` | analysis scripts: `i4scan.py` (active m0 / m1 per body, publications, pairing, reasoning kept, backstop lines), `pair.py` (per-kind stats, first-request equality), `cmp.py` (structure / repeated calls), `pairing.py` + `pairall.py` (tool-call pairing check on every recorded body); they read run artifacts and `packages/dsh-plugin/scripts/e2e/evo-bench/analyze.py` |

User request 16:53 CST (phase 2): fix I4, isolate the bench for real, add the real integration-path checks.

Every pre-isolation evo-bench result here (`i3-native-default.md`, `i3-pairs-1m-tables.md`) carries the
contamination caveat of DSH-MAINTENANCE known limitation 32 and ran with `danger-full-access`. Phase-2 runs
are isolated (probe 0 leaks, workspace-write + approval never) and are not directly comparable with them.
