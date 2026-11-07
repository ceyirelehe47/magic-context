# Round 37 evidence (2026-11-07)

User request 13:44 CST: fix the fold-view reasoning blow-up of the DSH adapter (I3) — new-session default
may change, old fold sessions are not migrated.

| file | what |
|---|---|
| `i3-native-default.md` | root cause, implementation (native roles default for new sessions), compatibility, offline tests, real paired runs (layer 2), context-management runs (layer 3), remaining issues, commits |
| `i3-pairs-1m-tables.md` | generated tables of the three fold / native pairs on the 1M catalog route (42345522531, 42348194793) |
| `i3-scripts/` | analysis scripts: `pair.py` (per-kind stats, first-request equality), `cmp.py` (structure / repeated calls), `pairing.py` + `pairall.py` (tool-call pairing check on every recorded body); they read run artifacts and `packages/dsh-plugin/scripts/e2e/evo-bench/analyze.py` |

Every evo-bench result here carries the isolation caveat of DSH-MAINTENANCE known limitation 32.
