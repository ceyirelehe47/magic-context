# Round 34 evidence (2026-11-06)

User decisions 2026-11-06 00:09 CST: release dsh.7; B6 option (a); keep the T3 WARN; C3 waits for an
upstream fix (no change); unfreeze dsh-soak.yml (running it still needs approval); do not file the
upstream issue drafts yet; rename the duplicate check ids.

| file | what |
|---|---|
| `b6-red.txt` | RED: `dsh-optional-peers.test.ts` before the package.json change (3 fail / 1 pass) |
| `install-rc5-42064124868.md`, `install-alpha3-42064140623.md`, `install-rc1-42064155721.md` | dsh-install at `3006f8c9a` (B6 option a + version dsh.8), old_ref `dsh/0.49.35-dsh.7`: A0–A8 PASS on all three |
| `install-rc5-42066064277.md`, `install-alpha3-42066083404.md`, `install-rc1-42066100857.md` | dsh-install at `d7d3064e5` (final code: + react devDependency for client.test.ts), same inputs: A0–A8 PASS on all three |
| `ids-replay-8-artifacts.txt` | ci-check.py before / after the id rename on 8 real artifacts: summary.md identical after the old→new id map, same exit codes |

Controls (OLD = dsh.7 now, not dsh.6): C5 PASS on rc.5 / alpha.3 (dsh.7 still hits B6 there — B6
reproduced on the control) and WARN on rc.1 (dsh.7 already resolves on rc.1, B2). C6 / C7 WARN on all
three because dsh.7 already carries the B4 / B5 fixes, so the probes have nothing to see in the
control — expected, not a regression. Experiment X5 is now a no-op (HEAD has no optional peers left).
