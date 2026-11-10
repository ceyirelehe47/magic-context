# Round 37 evidence (2026-11-07)

User request 13:44 CST: fix the fold-view reasoning blow-up of the DSH adapter (I3) — new-session default
may change, old fold sessions are not migrated.

| file | what |
|---|---|
| `i3-native-default.md` | root cause, implementation (native roles default for new sessions), compatibility, offline tests, real paired runs (layer 2), context-management runs (layer 3), remaining issues, commits |
| `i3-pairs-1m-tables.md` | generated tables of the three fold / native pairs on the 1M catalog route (42345522531, 42348194793) |
| `phase2-i4-isolation-integration.md` | round 37 phase 2 (user request 16:53 CST): I4 fix, real `ctx_expand`, cold-process resume, backstop outcome (RED / fix / verification each); bench isolation (four layers, env allowlist and iso/patches gaps, residual boundary); real runs (pair 42365193718, catalog-hist 429 stops); verified vs not verified; §6 I4 real-publication rerun 42459290880; §7 checkpoint + m0 overlap fix (RED / fix / real run 42613997607, real rerun 42729564554 §7.5) and `max_completion_tokens: 1` investigation; §7.6 segment 9: tail coverage after compaction (lim 36) + historian boundary / noop log (lim 37), offline only |
| `phase2-tables/` | generated pair table of 42365193718 and per-request I4 / pairing / backstop scans (`i4scan-*.md`) of the phase-2 runs |
| `phase2-tables/ckpt-fix-42613997607.md` | §7.4: checkpoint + m0 overlap fix validation run (turn 1 timeout; no compaction, no publication — fixed path not reached; probe 0 leaks, $0.229) — ckscan / i4scan / analyze extracts |
| `phase2-tables/ckpt-fix-42729564554.md` | §7.5: real rerun with turn timeout 2400 s (10/10 turns, 2 compactions, 12 publications; checkpoint retired at main 310; overlap 95 / 306; $1.262) — ckscan / i4scan / duplicate bytes / historian timing / analyze extracts |
| `phase2-tables/noop-replay-42729564554.txt` | §7.6: replay of the 42729564554 session log per `fires=true` pre-step (last five meaningful user messages, historian requests); order check only — the replay's ordinals are not Magic's (header explains) |
| `i3-scripts/` | analysis scripts: `i4scan.py` (active m0 / m1 per body, publications, pairing, reasoning kept, backstop lines), `pair.py` (per-kind stats, first-request equality), `cmp.py` (structure / repeated calls), `pairing.py` + `pairall.py` (tool-call pairing check on every recorded body); they read run artifacts and `packages/dsh-plugin/scripts/e2e/evo-bench/analyze.py` |

User request 16:53 CST (phase 2): fix I4, isolate the bench for real, add the real integration-path checks.

Every pre-isolation evo-bench result here (`i3-native-default.md`, `i3-pairs-1m-tables.md`) carries the
contamination caveat of DSH-MAINTENANCE known limitation 32 and ran with `danger-full-access`. Phase-2 runs
are isolated (probe 0 leaks, workspace-write + approval never) and are not directly comparable with them.
