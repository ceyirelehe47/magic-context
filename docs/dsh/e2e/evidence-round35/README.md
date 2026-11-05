# Round 35 evidence (2026-11-06) — scan + fix of the adapter layer

User request 2026-11-06 00:29 CST: one more scan-and-fix round. Standing decisions unchanged (T3 WARN
kept; C3 waits for upstream; E2 = core, ST1 = DSH-native, not fixed; upstream issue drafts not filed;
soak not run). No tag, no release, no npm. Version stays `0.49.35-dsh.8` (untagged).

Scope scanned: `packages/dsh-plugin/src` (host bootstrap / open-lock / liveness, agent plane timers and
fail-open catches, worker / subagent spec, remote input bounds), CLI (`doctor/cli.ts`), setup /
doctor (`doctor/env.ts`, `doctor/setup.ts`), migrate-legacy (backup / restore / CLI), the package
manifest after B6, the client bundle's module source, `dsh-ci.yml` / `dsh-soak.yml` /
`dsh-install.yml` (round 34 input checks, `test_ci_check_ids.py`, the id rename), docs vs code.

## Findings

| id | severity | finding | status |
|---|---|---|---|
| F1 | high (boot hang) | `acquireDshOpenLock`: an open-lock path that EXISTS but cannot be read (directory, file without read permission in a shared storage dir, I/O error) made `readLock()` return null, taken as "released", retried without an await or the MAX_WAIT check → synchronous busy loop, DSH boot hung forever at 100 % CPU, no log | 已复现并修复 (`88f2ac2ef`) |
| F1b | medium | same function: a stale lock whose takeover mutex can never be taken (a `.takeover` no stale rule can remove, e.g. a directory) polled forever — the stale branch had no MAX_WAIT bound | 已复现并修复 (`1f9941f8d`) |
| F2 | medium (silent divergence) | `writeFileAtomic` (temp + rename) replaced a SYMLINKED profile `package.json` / `cordis.patch.yml` (or a symlinked user config) with a regular file: the linked file kept its old content, the link was gone | 已复现并修复 (`936ce4521`) |
| F3 | medium (wrong DB) | `migrate-legacy`: `--db` / `--storage-dir` with no value fell back to the DEFAULT storage DB (`--backup --storage-dir` backed up the default store, `--apply --db` would migrate it); `--db --apply` took `--apply` as the path (exit 0); `--restore` alone ran a scan | 已复现并修复 (`7f3e6d451`) |
| P1 | low (latent) | `dist/entries/*` import `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-subagent` at runtime (externals), but neither is a peer or dependency: they resolve only as hoisted transitive deps of DSH (npm flat tree, pnpm's default `.pnpm/node_modules` hoist). A strict layout (`hoist=false`, PnP) would fail to load the agent / tools entries. **Not fixed:** declaring them as exact-list peers would let pnpm `auto-install-peers` / npm pick the HIGHEST listed version (rc.1) next to rc.5 / alpha.3 — the B6 failure mode again; every supported path resolves them (A0–A8 PASS ×3). Needs a user decision | 已复现（静态，dist 导入 vs 清单）未修 |
| N1 | — | client bundle after B6: `client.js` takes `react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/dsh-client-store` only from `window.__ModuleLoader__`; the web boot `staticModules` of dsh-web-frontend rc.5 / alpha.3 / rc.1 provide all of them (alpha.3 and rc.1 ship the same index file) | 非缺陷 (`client-react-static-modules.txt`) |
| N2 | — | round 34 CI: dsh-soak input checks (`dsh-declared.py` rejects padded / multi / empty versions; node regex + ≥ 24.9 for 0.2.2), `test_ci_check_ids.py` wired into the gating step and counted (33), no leftover old-id reference in ci-check / scripts / workflows (scenario T / P / M keep T0–T3 / R10 / M4 by design) | 非缺陷 |
| N3 | — | timers in auto-search / historian-drain / worker / recomp are cleared in `finally`; historian-drain's `track` swallows rejections so `drain` cannot leak its timer; fail-open `catch {}` blocks are diagnostics / nudges / telemetry only | 非缺陷 |
| O1 | low (not fixed, noted) | `restoreDatabase` copies the backup over the DB with `copyFileSync` (not temp + rename): a crash mid-copy leaves a torn DB; the pre-restore safety copy is taken first, so nothing is lost. `bootstrap`: if `initializeDshAdapterTables` throws after the open, the handle is not closed (process then runs without Magic) | 待验证 / 未改 |

## RED → GREEN

| file | what |
|---|---|
| `f1-open-lock-unreadable-red.txt` | `open-lock-unreadable.test.ts` before the fix: both children (directory / mode 000 lock) killed at the 15 s deadline |
| `f1b-takeover-unreadable-red.txt` | third case before F1b: child killed at 15 s (stale lock + directory `.takeover`) |
| `f2-setup-symlink-red.txt` | `setup-symlink.test.ts` before the fix: 2/2 fail (link replaced by a regular file) |
| `f3-migrate-legacy-args-red.txt` | `migrate-legacy-args.test.ts` before the fix: 7 fail / 1 pass |
| `p1-undeclared-runtime-imports.txt` | static: bare `@deepseek-ai/*` imports left in a fresh `dist/` vs the manifest |
| `client-react-static-modules.txt` | static: the client's requires vs the three web boots' `staticModules` |
| `install-rc5-42070371822.md`, `install-alpha3-42070380440.md`, `install-rc1-42070387621.md` | `dsh-install.yml` at `7f3e6d451`, old_ref `dsh/0.49.35-dsh.7`: **A0–A8 PASS** on all three (setup is on the install path: F2) |

GREEN: push CI 42069775942 @ `7f3e6d451` — dsh-plugin **660** (647 + 3 F1/F1b + 2 F2 + 8 F3), adapter-api 15,
contracts:dsh 105 (rc.5; contracts-dsh alpha.3 / rc.1 105 each), typecheck 0, test-file typecheck 0,
ci-check unit 33, wf-lint 0.

## Runs

| run id | kind | DSH | result |
|---|---|---|---|
| 42069775942 | push @ `7f3e6d451` | lockfile rc.5 (+ alpha.3 / rc.1 contracts) | success 660 / 15 / 105, ci-check 33 |
| 42070371822 | dsh-install, old dsh.7 | rc.5 (node 22.23.4) | A0–A8 PASS; C5 PASS, C6 / C7 WARN (as round 34) |
| 42070380440 | dsh-install, old dsh.7 | alpha.3 (node 24.22.2) | A0–A8 PASS; C5 PASS, C6 / C7 WARN |
| 42070387621 | dsh-install, old dsh.7 | rc.1 (node 24.22.2) | A0–A8 PASS; C5 / C6 / C7 WARN |
| 42070363765 | dsh-ci dispatch e2e slot r35 @ `7f3e6d451` | rc.5 (node 22) | **131 / 3 / 1** — R9, BS1, R15 FAIL (one cause, below); E2 WARN (core ranking, as always) |
| RERUN_ROW |

rc.1 e2e not run: no change is specific to the 0.2.2 line (open lock, setup file write and the
migrate-legacy CLI are the same code on every DSH; contracts-dsh and dsh-install cover alpha.3 / rc.1).

## e2e 42070363765: R9 / BS1 / R15 (scenario L, lock-a) — one cause, 待验证

All three come from lock-a hitting its 400 s run timeout (`lock-a.out`: `rc=124 elapsed=404.1s`):
- **R9** FAIL = that rc=124.
- **BS1** / **R15** FAIL = the one `compaction/end` error `summarize aborted while waiting for the compartment
  lease` — the backstop compaction that was waiting out the e2e 15 s historian hold when the timeout
  killed the run. Every earlier pressure check in lock-a deferred once (37.2 % ≥ 36 %) and then
  compacted after a 15 s lease wait, exactly as designed.

Why lock-a ran long: the real model took 11 steps for an 8-read task (read `p17` twice before any
compaction, then after the first compactions restarted at `p17` and re-read `p17`–`p19`), and every step
pays the scenario's 15 s e2e lease hold. The two previous rc.5 artifacts on this scenario
(42050071694, 42037652492) took 9 steps and 185 s / 234 s. Each `compaction/summary` carries the
read instruction verbatim (in `<unsummarized_tail>`) and mentions p17–p20, so the instruction was not
lost. This is model behaviour plus the scenario's time budget. Round 35's changes do not touch it:
lock-a booted normally (no open-lock line), and setup and migrate-legacy are not on this path.
No assertion was relaxed. RERUN_NOTE
