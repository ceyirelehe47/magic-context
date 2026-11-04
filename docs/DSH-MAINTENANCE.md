# DSH (DeepSeek Harness) integration — maintenance guide

Branch: `dsh-integration` of `ceyirelehe47/magic-context` (fork of
`cortexkit/magic-context`). It carries Magic Context **core** unchanged from an
upstream release tag plus a DeepSeek Harness adapter layer:

| path | what |
|---|---|
| `packages/adapter-api/` | host-neutral facade (`dsh-magic-context-adapter`): harness identity (`setDshHarness`), model map, session/runtime types |
| `packages/dsh-plugin/` | the DSH plugin (`dsh-magic-context`): host bootstrap, agent plane (context plane, knowledge gate, coordinator, historian, dreamer, nudges, tools, commands), compat layer, setup/doctor CLI, Typert remote + client |
| `packages/dsh-plugin/src/contracts/` | contract tests (compile-time DSH API + runtime core import surface) |
| `.github/workflows/upstream-sync.yml` | scheduled upstream sync (fork only) |
| `docs/dsh/` | community port notes + e2e harness from the original repo |

Provenance: imported verbatim from the community port
[xiaohj233/dsh-magic-context@6c82abd](https://github.com/xiaohj233/dsh-magic-context/tree/6c82abd)
(v0.1.2, MIT, © 2026 xiao_hj909). `LICENSE`, `NOTICE` and
`THIRD_PARTY_NOTICES.md` are kept in both packages; see `IMPORTED.md`.

Pinned versions: `@deepseek-ai/dsh*` **0.2.1-rc.5** (exact, devDependencies +
lockfile = the default path); **declared** DSH releases (peers, round 29):
exactly `0.2.1-rc.5 || 0.2.2-alpha.3` (`DSH_COMPAT_SUPPORTED_VERSIONS` in
`src/doctor/env.ts`; any other DSH, e.g. 0.2.2-rc.1, is refused by DSH's plugin
manager and by `doctor`), `@deepseek-ai/cordis ~4.0.5`, core = the upstream tag the branch is
based on (currently **v0.49.35**, merged in round 16). `doctor` checks the installed DSH against
`DSH_COMPAT_SUPPORTED_VERSIONS` (default `DSH_COMPAT_EXPECTED_VERSION`) in `src/doctor/env.ts`.

## Commands

```bash
# install only the lanes the adapter needs (no OpenCode CLI, dashboard, e2e)
bun install --ignore-scripts \
  --filter '@cortexkit/opencode-magic-context' --filter '@cortexkit/retina-local-fs' \
  --filter 'dsh-magic-context-adapter' --filter 'dsh-magic-context'

bun run typecheck:dsh   # tsc for adapter-api + dsh-plugin (includes src/contracts/dsh-api.contract.ts)
bun run test:dsh        # bun test for both packages
bun run contracts:dsh   # DSH vocabulary gate + core import-surface contract
```

Use **bun 1.4.4** (`packageManager` says 1.4.2; 1.4.4 is what the e2e
bootstrap and the last full verification used). Do not use npm: it is
OOM-killed on small (8 GB) sandboxes. On sandboxes whose root/home overlay is
RAM-backed, a full unfiltered `bun install` is also OOM-killed because the bun
cache (~3 GB) lands in `~/.bun/install/cache`; use the filtered install above
and point `BUN_INSTALL_CACHE_DIR` at a disk-backed directory.

Baseline (round 29, 2026-11-04/05, DSH **0.2.1-rc.5 (default) + 0.2.2-alpha.3
declared**, core v0.49.35; release tags unchanged — no dsh.5; code HEAD
`0ef173b60`): `typecheck:dsh` **0 errors**, `dsh-plugin` **631 pass** (+7 over
round 28's 624: `dsh-compat-declaration` 5, doctor 2), `adapter-api` **15**,
`contracts:dsh` **105**, 0 fail (push 41859522777 @ `0ef173b60`); real-model `e2e`
**135 judged** (unchanged). Install acceptance A0–A4 (A0 redefined, see below).
Evidence: `docs/dsh/e2e/evidence-round29/` (run table in its README). No
exemption on either declared DSH; the `allow-version` lane stays only for an
undeclared DSH or an old tarball that does not declare the running one.

| run id | kind | DSH | exemption | PASS / FAIL / WARN | FAIL classification | I1 | I2 | R10 (P / backstop) |
|---|---|---|---|---|---|---|---|---|
| 41859522777 | push checks | lockfile rc.5 | — | success | dsh-plugin 631/0, adapter 15, contracts 105 | | | |
| 41859544648 | install | rc.5 | none | A0–A4 PASS | — | | | |
| 41859553540 | install | alpha.3 | HEAD none; old dsh.2 (steps a, d) only | A0 WARN, A1–A4 PASS | — (A0 WARN = dsh.2 tarball's peers are rc.5-only; `headNeeded: []`) | | | |
| 41859559537 | e2e slot r29r5 | rc.5 | none | 133 / 0 / 2 (T3, E2) | — | PASS | PASS | PASS / PASS |
| 41859567651 | e2e slot r29a3 | alpha.3 | none | 131 / 2 / 2 (T3, E2) | Y2: known check timing (pending user); R11: real model said DONE after 2/8 reads right after the backstop deferral — no later check, 0 compartments (model, `evidence-round29/b1-a3-r11-y2.md`) | PASS | PASS | PASS / PASS |
| 41859577345 | e2e slot r29a3b | alpha.3 | none | 133 / 1 / 1 (E2) | Y2: same timing signature (holder = new process 4933, killed 4875) | PASS | PASS | PASS / PASS |

Round 29 commits (adapter manifest / doctor / CI / docs only, no core change; red test first):
- `b79200fa0` RED: real DSH plugin manager (app-boot rc.5 and alpha.3) rejects the manifest on alpha.3; doctor FAILs alpha.3.
- `5d8d4f58e` peers `0.2.1-rc.5 || 0.2.2-alpha.3`; `DSH_COMPAT_SUPPORTED_VERSIONS` / `isSupportedDshVersion` drive doctor and setup; devDependencies stay rc.5.
- `0ef173b60` CI: `dsh-declared.py`; exemption and the version-line-only doctor tolerance only for an undeclared DSH / tarball; U6 strict on declared DSHs; A0 can now FAIL if HEAD needs an exemption.

**Y2 — 待用户决定 (pending).** On alpha.3 Y2 FAILs every time (4/4: 28c ×2, 29 ×2;
0/5 on rc.5): the first step's busy probe sees the NEW process's own fresh lease.
Magic's behaviour is correct; the assertion is unchanged until the user decides
whether a busy probe whose only lease belongs to the live new process is acceptable.

Previous baseline (round 28 / 28b / 28c, 2026-11-04, DSH 0.2.1-rc.5 pinned, core v0.49.35;
release tags unchanged; HEAD `adb5ed80d`): `typecheck:dsh` **0 errors**, test-file
typecheck 0, `dsh-plugin` **624 pass** (+14 over round 27's 610), `adapter-api`
**15**, `contracts:dsh` **105**, 0 fail (push 41841941636 @ `adb5ed80d`); real-model
`e2e` **135 judged** from `f6ce05a22` (round 27's 133 + I2 + R10 scenario-P; I2 and
both R10 lines WARN-only). Install acceptance A0–A4 (A0 new in 28b: exemption
report). Evidence: `docs/dsh/e2e/evidence-round28/` (run table in its README).

| run id | kind | DSH | head | PASS / FAIL / WARN | FAIL classification | I1 | I2 | R10 (P) |
|---|---|---|---|---|---|---|---|---|
| 41828791422 | e2e | rc.5 | 2a2e9b592 (fold v1) | 130 / 2 | T1/T2: model re-read p32.txt ×8 → pi-ai clamp — regression of fold v1 (adapter) → `cc96eb02e` | PASS | (n/a) | (n/a) |
| 41828796915 | e2e | rc.5 | 2a2e9b592 (fold v1) | 128 / 4 | T1/U7/U8/U10: re-reads ×5 (same cause) | PASS | (n/a) | (n/a) |
| 41832514940 | e2e | rc.5 | cc96eb02e (fold v2) | 131 / 2 | R4/R7: model's own ctx_reduce in pold (prompt forbids) → room `f6ce05a22` | PASS | PASS | (offline WARN) |
| 41832520000 | e2e | rc.5 | cc96eb02e | 133 / 0 | — | PASS | PASS | (offline PASS) |
| 41832524393 | e2e | rc.5 | cc96eb02e | 132 / 0 | — | PASS | PASS | — |
| 41832529681 | e2e | rc.5 | cc96eb02e | 132 / 0 / T3 WARN | — | PASS | PASS | — |
| 41832534523 | e2e | rc.5 | cc96eb02e | 132 / 1 | R2: model's own ctx_reduce in pnew before MC fired | PASS | PASS | (offline WARN) |
| 41839150646 | e2e #0 | rc.5 | f6ce05a22 | 133 / 0 / 2 (E2, T3) — 135 judged | — | PASS | PASS | PASS |
| 41840699540 | install | rc.5 | 21985b4ef | A0–A4 PASS | — | | | |
| 41840694149 | install | alpha.3 | 21985b4ef | failure | DSH plugin manager rejects the bundle (peer pin 0.2.1-rc.5) → exemption lane `adb5ed80d` | | | |
| 41841943616 | install | alpha.3 (+allow-version) | adb5ed80d | A0 WARN, A1–A4 PASS | — (A0 WARN = pin-only doctor FAIL + exemption needed, by design) | | | |
| 41841941636 | push checks | rc.5 | adb5ed80d | success | dsh-plugin 624/0 | | | |
| 41842386831 | e2e rc.5 #1 (28c) | rc.5 | adb5ed80d | 133 / 1 / 1 (E2) | C3: peak at the last step (6th read pair, U turns at 66–72 %), 待验证, check unchanged (`evidence-round28/c6-28c-c3-y2.md`) | PASS | PASS | PASS |
| 41845836776 | e2e rc.5 #2 (28c) | rc.5 | 95333e55d (docs only over adb5ed80d) | 135 / 0 / 0 | — (C3 PASS again) | PASS | PASS | PASS |
| 41842392546 | e2e alpha.3 slot a3 (28c) | alpha.3 + allow-version | adb5ed80d | 132 / 1 / 2 (E2, T3) | Y2: first-step busy probe sees the NEW process's own fresh lease (check timing), Magic behaviour correct | PASS | PASS | PASS |
| 41842397847 | e2e alpha.3 slot a3b (28c) | alpha.3 + allow-version | adb5ed80d | 133 / 1 / 1 (E2) | Y2: same as a3 | PASS | PASS | PASS |

"Two consecutive green" for round 28c (no FAIL besides known won't-fix upstream /
DSH-native items) is **not met** at `adb5ed80d`: rc.5 #1 41842386831 has C3 FAIL
(待验证, not a known upstream item), rc.5 #2 41845836776 is 135 / 0 / 0. The
round 28b e2e #0 41839150646 @ `f6ce05a22` was also 0 FAIL, but on older code and
not consecutive with #2. No third run was dispatched this round (budget).

Round 28 commits (adapter / scenarios / scripts / CI only, no core change; red test first):
- `92c8f5127` RED: folded tool record must be one past-tense prose summary (fold-format).
- `77a6c3b2f` fold v1: the folded tool arc is one prose note + tagged result text (limitations 21/22).
- `2a2e9b592` CI: `dsh-ci` dispatch `slot` input, so repeated e2e runs go in parallel.
- `1a23d6827` RED: open-lock crash residues left by a SIGKILL inside createExclusive / takeover.
- `bb86b923c` open lock sweeps stale createExclusive temps and `.takeover` at acquire; never touches the live lock.
- `9ba465adc` RED: re-own with ≥ 2 stale synthetic owners mints a third tag number.
- `8ea0321a8` re-own folds every stale owner into one (core `adoptPiFallbackToolOwnerTag`) in one transaction.
- `cb3f31368` RED: context plane's historian trigger / pressure persistence swallow errors silently.
- `952a3970a` those stay fail-open but log once per distinct message.
- `cc96eb02e` fold v2: the prose names each call and its target in order (v1 caused 5–8× re-reads); ci-check I1 sees the new note, new WARN-only I2.
- `f6ce05a22` (28b) scenario P gets room (pnew ≤ 8 batches, pold until native compaction); new WARN-only R10 lists forbidden ctx_reduce calls.
- `046402042` (28b) RED: alpha.3 loader persists via `EntryTree.commit`, the no-write preset include only overrode `write()`.
- `bdeb8bfa0` (28b) preset include also overrides `commit()` as a no-op (alpha.3); `write()` kept for rc.5.
- `21985b4ef` (28b) CI: optional `dsh_version` input for dsh-ci / dsh-install (default rc.5); pin-only doctor FAIL tolerated off-pin.
- `5b3ae0917` (28b) open-lock-residue test flake: touch the lock before ageing residues (assertions unchanged).
- `adb5ed80d` (28b) off-pin lanes grant DSH's `plugin allow-version … --accept-risk` exemption; A0 WARN / U6 accept pin-only FAIL there.

Previous baseline (round 27, 2026-11-04, DSH 0.2.1-rc.5, core v0.49.35; release tags
unchanged; HEAD `605a8f7a4` — code head `fc928cbb4`, `605a8f7a4` changes only the
e2e scenario S launcher + ci-check): `typecheck:dsh` **0 errors**, test-file
typecheck 0, `dsh-plugin` **610 pass** (+19 over round 26's 591), `adapter-api`
**15**, `contracts:dsh` **104**, 0 fail (push 41788039793 @ `fc928cbb4`,
41792847109 @ `605a8f7a4`); real-model `e2e` **132 judged** @ `fc928cbb4` (round 26's
128 + scenario F F1–F3 + I1), **133** from `605a8f7a4` (+ DN1). Install acceptance
41784636699 A1–A4 PASS. Evidence: `docs/dsh/e2e/evidence-round27/` (run table in
its README).

| run id | kind | head | PASS / FAIL / WARN | FAIL classification | I1 |
|---|---|---|---|---|---|
| 41784617324 | e2e | 0cf582631 | 127 / 4 / 1 (E2) | F1–F3 + T3: adapter (re-own to a synthetic owner) → fixed `374a7e978` | PASS |
| 41787740600 | e2e (+checks) | 374a7e978 | 128 / 2 / 2 (E2, T3) | R0 pi-ai clamp (upstream); ST1 sw-1-3/sw-2-3 DSH-native cordis.yml boot race | PASS |
| 41788066023 | e2e (+checks) | fc928cbb4 | 130 / 1 / 1 (E2) | R0 pnew-05 pi-ai clamp (1 output token → max-tokens; upstream) | PASS |
| 41790564442 | e2e (+checks) | fc928cbb4 | 131 / 0 / 1 (E2) | — | PASS |
| 41792968900 | e2e (+checks) | 605a8f7a4 | 131 / 0 / 2 (E2, I1) — 133 judged | — (DN1 PASS; ST1 PASS on profiles test-s1…s5) | **WARN** (h-a4) |

"Two consecutive green" for round 27 means: no FAIL other than the known won't-fix
upstream / DSH-native items (R0 pi-ai clamp, DN1/ST1 cordis.yml boot race).
Met at `fc928cbb4`: 41788066023 (R0 only) then 41790564442 (0 FAIL). The
following run at `605a8f7a4` (41792968900) also has 0 FAIL, but I1 is WARN there
(see limitation 22).

Round 27 fixes (adapter / scenarios / scripts only, no core change; red test first):
- `8cba71367` / `e7e31f2a3` C1: folded tool arcs render as one framed
  `<recorded-tool-activity>` past-tense record instead of the imitable
  `[tool: read #call_N]` text (limitation 21; rate lowered, not solved — see
  limitation 22).
- `db54471ff` / `72beaaa19` C2: `doctor` after a full `setup --disable-preset`
  reports "Magic disabled in every preset" as a warn and exits 0.
- `3aa422ccf` C3: `host-unload-release` flake was test isolation — tests close the
  cached default DB through `closeDatabase`, not `db.close()`.
- `5bddc27df` / `0cf582631` C4: e2e-only crash point `tail-fold-pending`; e2e
  scenario F (F1–F3) and the I1 imitation detector.
- `e0297f5ce` / `b679849f2` C5: open-lock — two races that let two processes hold
  the first-open lock fixed (stale takeover serialised through `<lock>.takeover`;
  the lock record is hard-linked into place instead of exposed empty);
  open-lock-race 0/384 overlaps (before 4/48).
- `4751d7521` / `7c0a50ff9`: auto-embed deferred by FTS coverage now logs one
  diagnostic after 10 consecutive deferrals (was silent forever).
- `edca11500`: message-index per-step cost measured (O(N) view read off the step,
  writes only new rows) — no code change.
- `989b16147` / `31e92d398`: `migrate-legacy` concurrent `--apply` refuses a stale
  plan ("changed since the scan") instead of re-archiving.
- `77581e2df` / `8c2ef3c26`: `<unsummarized_tail>` size kept incrementally
  (O(n²) → linear; 30 000 msgs 4.1 s → 0.16 s) and the clip never splits a
  surrogate pair.
- `fa16f0217` / `374a7e978` F: tail tool tags also re-own to a synthetic owner
  (real DSH restores an undurable result as `interrupted-tool-result-…`); ci-check
  F1–F3 accept DSH's `TOOL_OUTCOME_UNKNOWN`, T3 is WARN when only the real model's
  own reasoning restated the codeword.
- `fc928cbb4`: embed-deferral test typechecks under `tsconfig.test.json`.
- `605a8f7a4` (27c): e2e scenario S runs each of its five sessions on its own copy
  of the test profile; ci-check DN1 reports the DSH-native cordis.yml boot race
  as WARN wherever it appears (see limitation 22).

Previous baseline (round 26, 2026-11-04, DSH 0.2.1-rc.5, core v0.49.35; release tags
unchanged; run 41777488761 @ `47125f480`, checks + e2e in one dispatch):
`typecheck:dsh` **0 errors**, test-file typecheck 0, `dsh-plugin` **591 pass** (+15
over round 25's 576: migrate-legacy 9, compact-unprocessed-tail 5, new-input-fold-tags
+1), `adapter-api` **15**, `contracts:dsh` **104**, 0 fail; real-model `e2e` **128
judged: 127 PASS + 1 WARN (E2, the P1-3 ranking observation), 0 FAIL** (round 25's
117 + scenarios T, M, E and the new T2/M checks). Soak short 41773273940 K1–K9 PASS;
install acceptance 41775619062 A1–A4 PASS. Evidence: `docs/dsh/e2e/evidence-round26/`.

Round 26 fixes (adapter only, no core change; red test first): migrate-legacy
`9565e87ef` (red `ec3a0aa67`), bun 1.4.2 open flags `8ba07a9fa`, backup-name
collision `47125f480`; /compact unprocessed tail `5e8380dd7` (red `a8dc67ede`);
/compact mini-historian telemetry `07284476f`; tail-fold tool-tag re-own `906ce5fc5`.
Tests/CI: scenarios T + M `946f7b1ca`, E `ee6d04e0e`, `dsh-soak.yml` `ade660ee6`,
`dsh-install.yml` `96677e175` / `901fb7874`, test typecheck `10d8dc8d2`; docs
`753413144`, `8cb85c5b3`.

Baseline (round 25, 2026-11-04, DSH 0.2.1-rc.5, core v0.49.35; release tags
unchanged; push run 41692123988 @ `34819c87a`, 41693389965 @ `955a12d08`):
`typecheck:dsh` **0 errors**, `dsh-plugin` **576 pass** (+9 over round 24's
567: historian-memory-identity 3, open-lock-stale 3, lease-pid-reuse 2,
e2e-hooks +1), `adapter-api` **15 pass**, `contracts:dsh` **104 pass**, 0 fail;
real-model `e2e` **117 judged** (round 24's 107 + U26 + scenario W W1–W4 +
scenario S ST1–ST5): **117/117 PASS on 41699491685 @ `40c5013a5`**
(checks green in the same run); 41699579212 @ the same head 116/117 (U20,
model: answered the four facts' contents instead of their codewords; the injected
`<project-memory>` carried all four, U15 PASS). H consecutive passes: PASS ×2 consecutive (41705543125 117/117, 41705587583 117/117 @ 40c5013a5).
Evidence: `docs/dsh/e2e/evidence-round25/`.

Round 25 fixes (adapter only, no core change; red test first):
- U21 `8a7864594` (red `505d03fbe`; e2e check U26 `b1cc19ce6`): historian memory
  promotion writes under the project identity (`resolveProjectIdentityForSession`,
  the `ctx_memory` resolver; core's runner uses `resolveProjectIdentity`), not the
  raw directory, so core's exact-hash dedup (archived rows included) sees the
  agent's row and a corrected fact is not re-activated; the historian prompt gets
  core's `<project-memory>` block (active/permanent memories, ≤ 10 % of the
  historian window) as dedup context. e2e 41682984222: memory 20 byte-identical
  to archived 16 under a different `project_path`. Verified on real e2e
  41688260239 / 41693402758 / 41699491685 (U21, U22, U26 PASS).
- B1 `658ea8f19` (red `509aec6a1`): the dsh open lock (`<db>.dsh-open.lock`) is
  taken over when its pid now belongs to a process started after the lock was
  written (pid reused, or our own pid after a crash + container restart) — before,
  every start waited MAX_WAIT 120 s. open-lock-stale 1/3 → 3/3.
- B2 `d1c19c6c8` (red `e75c0c286`; evidence corrected `addd75041`): a compartment
  lease whose owner pid was reused / is our own pid after a restart counts as gone
  (`isPidNewerThan(pid, acquiredAt)`, core's `isPidIdentityPlausible` rule);
  `reclaimDshLeaseOfGoneOwner` (core's exact-row DELETE) runs before every DSH
  acquire, since core's acquire reclaims only a DEAD pid. Before: busy for the
  rest of the 5-min TTL, acquire = null. lease-pid-reuse 0/1 → 2/2.
- e2e scenarios (P1-2 / P1-3): W (`34819c87a`, worker child forced to call
  bash/write) and S (`34819c87a`, 5 sessions × 4 parallel restarted rounds on one
  DB; `79615e408` adds 5 warm-up rounds so the historian has eligible history).
- e2e checker fixes, no assertion relaxed: `955a12d08` (U14 own codes from the
  full history view incl. tool calls/results; plus required history view,
  numbering agreement and no injected-block markup), `79615e408` (ST1 also
  requires the 25 warm-up runs), `9e9b828a7` (U16: a folded hit is judged on
  its Snippet; its title may name only codes of its own range), `40c5013a5`
  (warm-up plans per session, X8).

Baseline (round 24, 2026-11-04, DSH 0.2.1-rc.5, core v0.49.35; release tags
unchanged; push run 41679319893 @ `e5ce3b756`): `typecheck:dsh` **0 errors**,
`dsh-plugin` **567 pass** (+15 over round 23c's 552; 566 after 24a/24b,
24c adds `injected-history` 1), `adapter-api` **15 pass**,
`contracts:dsh` **104 pass**, 0 fail; real-model `e2e` **107 judged**
(round 23c's 93 + R15 + scenario H U13–U25): not all green within round 24 — 41679402115 105/107 (R14 checker, Y3
scenario precondition), 41682984222 106/107 (U21, product; fixed in round 25
`8a7864594`); all 107 round-24 checks first PASS together on 41693402758 @
`955a12d08` (round 25; see the round 25 baseline above).
Evidence: `docs/dsh/e2e/evidence-round24/`.

Round 24 fixes (adapter only, no core change; red test first):
- 24a `41e74f26d` (red `154b17192`): the first open of a fresh shared DB is
  serialised across DSH processes (O_EXCL `<db>.dsh-open.lock` around core
  `openDatabaseAsync`) — mitigates known limitation 18 (g) (core migration race).
- 24a `8a765eb7d` (red `877be0ccb`, R15 check): the MC main backstop skips a
  region whose Magic summary cannot be smaller, before `compaction/start` —
  fixes 18 (f) ("summary is not smaller", R10); e2e 2/2 (41665756434,
  41669354809).
- 24a `4a586cb21` (red `2c2ddbc30`): P1-1 — the DSH log feeds core's
  message-history FTS index (`scheduleReconciliation`, history view ordinals);
  ctx_search's message lane was always empty on DSH (round 21 U1 "No results found").
- 24b `f3d44e73b` (red `bb1d47b6e`/`14a6a9cab`): project embedding registered and
  compartments auto-embedded on DSH (`agent/embedding-wiring.ts`); ctx_search
  says visibly when semantic search is unavailable (FTS only).
- 24b `005a25850`: e2e scenario H (P1-1 memory correctness, U13–U25, embed-mock).
- 24c `a529b7846` (red `f8de60d87`): **Magic's own injected text is not
  history** — `historyContentProvider` / `withoutInjectedText`: the m0 baseline
  (`<session-history>`/`<project-memory>`) and `<ctx-search-hint>` messages
  (durable `magic-context` user messages on DSH, transform-only on OpenCode/Pi)
  no longer reach the message-history index, the background historian or the
  summarize hook (own text blocks removed; folded tool results, ordinals, ids
  kept). e2e 41672370986: the message lane returned the injected
  `<project-memory>` and compartments of unrelated read turns carried all four
  pinned facts.
- 24c e2e checker fixes, no assertion relaxed: `e5ce3b756` (U16–U18 fact
  ordinal from the FTS rows, fold-aware message hit, U17 range must cover the
  fact, new injected-block guards in U14/U16/U18), `7d8ebad5d` (R14 replay
  decodes DSH's storage-form seq ranges), `d8daa0264` (scenario Y gets real
  history: Y3 had passed on a compartment of the injected m0 block only).

Baseline (round 23c, 2026-11-03, DSH 0.2.1-rc.5, core v0.49.35; release tags
unchanged; push run 41640091776 and dispatch run 41640093586 (`e2e=true`) @ `96c27be69`; final e2e: see `evidence-round23c/README.md`):
`typecheck:dsh` **0 errors**, core typecheck **0 errors**, `dsh-plugin`
**552 pass** (round 23c +8 over round 23b's 544: crash-recovery 6, lease-liveness 2),
`adapter-api` **15 pass**, `contracts:dsh` **100 pass**, 0 fail; `e2e`
**Final: 93/93 PASS on dispatch 41647689313 @ `40379e65a` (checks green in the same run); also 93/93 on 41644306462 @ `eb541b837`.** Earlier 92/93 on 41640093586 (R10 FAIL — intermittent backstop "summary is not smaller" on a tiny region, real model, see known limitation 18 (f); seen in 2 of the last 4 runs) (round 23b's 87 = 79 + scenario X (X1–X8); round 23c adds
scenario Y (Y1–Y6, kill -9 during a historian hold)).
Evidence: `docs/dsh/e2e/evidence-round23c/` (23b: `evidence-round23b/`).

Round 23b/23c fixes (adapter only, red test first):
- **P0-1** `dd6900465` (red `c22f13669`, e2e scenario X `6c7364093`):
  pressure truncation prices dense output like the provider — DSH's
  4-chars/token meter under-counted a 50 KB Chinese read (27 700 real tokens
  into a 24k window, the session stuck re-sending it).
- **P0-2** `e37619117` (red `4d8746309`): a compartment lease whose owner
  process is confirmed dead (SIGKILL mid-pass) no longer reads as a running
  historian pass (`isDshHistorianBusy`: backstop deferral, `/compact` lease
  wait, busy probe; `/magic-context` status "running") — before, up to the
  5-min TTL. `agent/lease-liveness.ts` uses core's reclaim rule (local pid
  probe, only ESRCH = gone).
- e2e scenario fixes: X6 hashed after the redact step (`fa309b67d`);
  scenario Y (`615dabcb4`, `96c27be69`).

Baseline (round 23, 2026-11-03, DSH 0.2.1-rc.5, core v0.49.35; release tags
unchanged — `dsh/0.49.35-dsh.2` → `7848c0430`; push run 41628170286 @ `a39dc5ea7` and
dispatch run 41628590609 (`e2e=true`)):
`typecheck:dsh` **0 errors**, test-file typecheck **0 errors**, core typecheck
**0 errors**, `dsh-plugin` **536 pass** (round 23 +11 over round 22's 525),
`adapter-api` **15 pass**, `contracts:dsh` **99 pass**, 0 fail; real-model
`e2e` **78/79 PASS (R12 FAIL — scenario timing, made deterministic in round 23b)** on run 41628590609 (79 judged = round 22's 78 + R14).
Evidence: `docs/dsh/e2e/evidence-round23/`.

Round 23 fixes (adapter only, no core change; red test first, on the REAL
rc.5 log of run 41619627652 replayed by DSH's own `Session`):
- `a61d3c08f` (red `5d8e3b1d4`, typing `f86aa1489`) **history ordinals survive
  DSH native compaction.** compaction-basic (`/compact` or the pressure
  backstop) replaces surface nodes with one `compact-checkpoint` message; the
  surface view then restarted its ordinals (checkpoint = 1) while compartments
  keep the old numbering. Real run 41619627652: the second `/compact` judged
  compartments 1–17 "covered" (view had 10 messages) and replayed them as the
  summary, shadowing p27–p29 and the user's prompt (seq 147, shadowedSeqs
  114…139) with no summary of them. The unit replay also confirmed the two
  suspected effects: the background historian found nothing after ordinal 17
  (it would only resume once the view grew past 17 messages, skipping the
  first 17 new ones), and the post-compaction turn's messages were drop
  candidates of compartments ≤ 17. Fix: `transcriptRawMessageProvider` (the
  source of the historian, the summarize hook, recomp and the compartment drop
  queue) now reads `readDshHistory` — `expandCompactionCheckpoints` expands
  every checkpoint (and every Magic op copy that re-renders one, recursively)
  back into the surface nodes it shadowed, in surface order, and keeps every
  other node (op copies included) so pre-compaction ordinals are reproduced
  exactly; a checkpoint in a `/compact` region resolves to the whole history
  range it stands for (`readMessageOrdinalRangeById`), so the region starts at
  that range's first ordinal. The context plane (tags, drops, nudges) still
  works on the model-visible surface (`readDshTranscript`, unchanged).
  `native-compaction-ordinals.test.ts`: 1/5 before → 7/7.
- `d2ee6281c` (red `0a15d42cb`) **ctx_expand numbers like the compartments.**
  It walked the whole event log (op copies, re-injected knowledge counted), so
  a compartment's `start=`/`end=` expanded other messages — already before any
  native compaction (real log: 18 vs 17 messages at seq 88). It now reads the
  history view (op copies expanded to their sources, so a dropped tool output
  stays recoverable); DSH-0.1-shaped doubles without a surface keep the log walk.
- `a39dc5ea7` (red `88e62e0d7`) **the MC main backstop compacts once per
  pressure check.** First e2e of the ordinal fix (run 41625463298, 77/79):
  compaction-basic retries a pressure compaction while the session is still
  above the threshold; on an MC main session the retry's region is the
  checkpoint the first attempt just wrote, Magic renders the same compartments
  for it, and compaction-basic rejected it ("summary is not smaller than the
  shadowed content (626 … >= 626)") — 6 of 7 backstop checks in lock-a ended in
  an error although their first compaction had committed (R10/R11 FAIL). Before
  the ordinal fix the retry "succeeded" by rendering only the compartments that
  overlapped the checkpoint's restarted ordinal 1 — silently dropping the rest
  from the surface. Main sessions now run the backstop with
  `compactionRetries: 0` unless the user set it, and "still above threshold"
  after a committed compaction returns that compaction (logged); the residue is
  the retained tail / already-summarized history, left to MC; child sessions
  and user-set retries keep compaction-basic's policy. compaction-pressure 25 → 28.
- `ac00b1ddc` e2e **R14**: scenario L `lock-d` runs the session's second native
  compaction at idle (lease free); `ci-history.ts` replays the decoded log with
  DSH's `Session` and checks that lock-c's prompt and every checksum it read are
  still on the surface or inside a published compartment (`ctx_expand` of its
  range shows them) and that the second summary reaches them. On run
  41619627652's artifacts R14 fails (evidence-round23/history-lock-before-fix-41619627652.json).

Round 22 (2026-11-03, HEAD `c362790f2`, `dsh-plugin` **525 pass**, e2e 78
judged; runs 41616050491 71/77, 41618120979 75/78, 41619627652 76/78 —
summaries in `docs/dsh/e2e/evidence-round22/`):
- `42cd105cc` summarize lease wait / timeout lines also on stderr (headless
  never prints `ctx.logger`).
- `bac958987` e2e-only hooks (historian lease hold, `/compact` at idle through
  the DSH command registry, fake stuck lease + shortened summarize wait, live
  status dump; inert unless `MAGIC_CONTEXT_DSH_E2E=1` and the switch are set).
- `af16cbe15`, `914ed9905`, `edafbf2e0` e2e scenarios **L** (lock collision,
  R9–R13) and **K** (jsonc edited mid-turn, U7–U12).
- `4f0b97a96` settings page / popover show a profile-row `historian.model` /
  `protected_tokens` as the effective value (real rc.5 scenario K: the agent ran
  with the row value while the page said "default").
- `c362790f2` the native backstop defers **at most once per historian cycle**;
  the next over-threshold check compacts and the summarize hook waits for the
  lease (run 41619627652 R11: the backstop deferred on every step while MC
  re-fired the historian).
- Open after round 22: R11 (fixed by `c362790f2`, re-verified in round 23) and
  R13 (the timeout branch never ran: `/compact` was wrongly "covered" — the
  round 23 ordinal defect).

Previous baseline (round 21, 2026-11-03, DSH 0.2.1-rc.5, core v0.49.35; release
**`dsh/0.49.35-dsh.2` → `7848c0430`** (version bump only on top of round 20,
push run 41608723776 green; real e2e for that code: 41601119332 @ `542c6569e`
66/66); round 21 HEAD push run 41611430368 @ `6ce2603f9` and dispatch run
41611644712 @ `6ce2603f9` (`e2e=true`)):
`typecheck:dsh` **0 errors**, **test-file typecheck 0 errors (now gating)**,
core typecheck **0 errors**, `dsh-plugin` **515 pass** (round 21 +21),
`adapter-api` **15 pass**, `contracts:dsh` **99 pass**, 0 fail; real-model
`e2e` **67/67 PASS** on run 41611644712 (67 judged = round 20's 66 + R8; R7 1 completed main-session native compaction; R8 4 `compaction/end` events, 0 lease-busy errors, 0 backstop deferrals and 0 `/compact` waits in this run — the overlap did not occur, so the new wait/defer paths are unit-verified only; R6 now has **0** main-session checks with `pct=?`, i.e. P8 verified on real rc.5). Evidence: `docs/dsh/e2e/evidence-round21/`.

Round 21 fixes (adapter only, no core change; each with a red test first):
- `b27f24410` **lease busy no longer fails native compaction.** (a) The Magic
  summarize hook (`/compact`, or a backstop that raced the probe) now WAITS
  for a compartment lease held by a background historian pass — bounded,
  `DEFAULT_SUMMARIZE_LEASE_WAIT_MS` = 45 s, poll 500 ms, abortable —
  re-checking coverage on every poll (the background pass usually publishes
  exactly the range compaction needs, then no LLM call is made); still busy
  after 45 s → fails closed with "… after waiting Ns (retry once it
  finishes)". (b) The 90 % native pressure backstop on an MC main session
  checks `magicContextHost.historianBusy(agent)` (agent plane probe over
  `getCompartmentLeaseBlocker`) and, when the session is over the backstop
  while the lease is held, **defers**: returns no compaction, no error, logs
  `native pressure backstop deferred: a historian pass is running …; the
  next pressure check retries` (debug probe outcome `deferred:historian-busy`);
  below the backstop nothing is logged; child sessions ignore the probe;
  a throwing probe never blocks. The next step's pressure check retries.
  Unit: hook 5, pressure 5 (6 red before).
- `0927d1b40` **settings page vs runtime.** `historian.model` (incl.
  `historian.opencode.model`) and `protected_tokens` are now **hot**: the
  agent plane reads them per call/step from the live jsonc view (DSH override
  > explicit row config > current jsonc; `tools.protectedTokens` too, which
  previously did not even follow the DSH override). They left the restart
  notice. Every other restart-only section (memory, dreamer, compaction,
  other `historian` keys, mural, caveman, commit-cluster, temporal, prompt
  surface, cache TTL, protected_tags, history budget) is shown as
  **running value · pending restart: new value** — settings page
  (`MagicSettingsView.pendingRestart`, from the startup jsonc the agent plane
  registers via `magicContextHost.registerRunningConfig`) and `/ctx-status`
  ("Pending restart" block). Unit only (6 tests, 5 red before).
- `110acca0d` + `52f33bbf8` **test-file type errors 156 → 0** (fixture typing
  only: `as never` / `as unknown as` casts on branded `ToolCallId`, rc.5
  assistant-message inputs and `assistant/message` payloads, `PreStepDecision`
  stubs, a `bun:sqlite` view for `db.query`, a test-only `react` module shim
  in `test-types/`; no assertion or fixture value changed). `6ce2603f9` makes
  the step **gating** in `checks`.
- `a84fb1553` **pressure diagnostics** (P7/P8): the debug probe's threshold
  and outcome are per call (concurrent sessions printed each other's
  `thresholdPct`); the session route falls back to the agent's options when
  the session has no request header yet (first check printed `pct=?`).
- `9ab4c3a9e` **coordinator caches bounded**: `appliedOps` keeps 256 opIds per
  session (FIFO) and 64 sessions (LRU) — the outbox stays authoritative, an
  evicted id is still answered "already-applied" by `getOutboxRecord`; a
  settled per-session plan queue entry is removed.
- `5b30b1ae5` e2e **R8**: no `compaction/end` error and no log line says
  "summarize mini-historian lease busy" in any run; reports backstop
  deferrals, `/compact` lease waits and first-step `pct=?` counts.
- `7848c0430` release bump `0.49.35-dsh.2` (tag `dsh/0.49.35-dsh.2`).

Baseline (round 20, 2026-11-03, DSH 0.2.1-rc.5, core v0.49.35; HEAD after
the round 20 fixes, release tag `dsh/0.49.35-dsh.1` unchanged → `270629e75`;
push run 41600879637 @ `542c6569e` and dispatch run 41601119332 @ `542c6569e` (`e2e=true`)):
`typecheck:dsh` **0 errors**, core typecheck **0 errors**, `dsh-plugin`
**494 pass** (66 files; round 20 +9), `adapter-api` **15 pass**,
`contracts:dsh` **99 pass**, 0 fail; real-model `e2e` **66/66 PASS** on run 41601119332 (R7: the pold main-session native compaction completed, `outcome=compacted`, 0 `compaction/end` errors; C6/C10 PASS, historian `idle`, 0 failures). Previous run 41599626978 @ `4ee4a04ba` was 64/66 (R7 PASS; C6/C10 FAIL on the lease race fixed by `542c6569e`). Evidence: `docs/dsh/e2e/evidence-round20/`
(66 judged = round 19's 65 + R7). New informational step: `*.test.ts`
typecheck (`packages/dsh-plugin/tsconfig.test.json`) — **156 errors**, all in
test fixtures (DSH branded types `ToolCallId`, `stream` on assistant events,
`react` without types); it does not fail the job (see Known limitations 14).

Round 20 fixes (adapter only, no core change; each with a red test first):
- `ba38bff7f` **main-session native compaction no longer fails "summarize
  range unresolvable".** compaction-basic `buildSummarizationInput` prepends
  the system/message (surface node 0) to the region, and a region can end on
  a Magic op copy whose surface id the transcript view does not carry. The MC
  summarize hook resolved the literal first/last ids, so EVERY native
  compaction of an MC main session — the 90 % backstop and `/compact` — closed
  `compaction/end` with an error (real rc.5 run 41593887664, `pold-03/04`; the
  round 19 R4 check counted `compaction/start` only). The hook now skips system
  prompts and resolves the range as min..max over the ids the view knows, and
  the transcript provider maps surface event ids (op copies, via the view
  message spans) to the message they cover. Real: run 41599626978 R7 PASS (the
  pold native compaction completed, 0 errors).
- `b5710f7b9` **config reload** (two items, one module
  `settings/config-load.ts`): (a) core `parsePluginConfig` logs
  `clear_reasoning_age is deprecated …` on every parse and the agent plane /
  settings endpoints re-parse on a 3 s TTL, so the line repeated every few
  seconds — the load now runs behind a temporary core log-line forwarder that
  passes each distinct line once per process; (b) `createLiveSettings` reports
  each `configWarnings` entry once and, when a section bridged only at
  startup (`memory`, `dreamer`, `compaction`, `historian`, `mural`, caveman,
  commit-cluster, temporal, prompt surface, cache TTL, protected_*,
  history budget) differs from the startup config, warns once per new value
  (`ctx.logger.warn`) that DSH must be restarted. Live keys (`enabled`,
  `execute_threshold_*`) do not trigger it. Unit tests only (no e2e check).
- `542c6569e` **historian lease holder id unique per pass.** Core's compartment
  lease re-grants a lease to its own holder, and every DSH pass used
  `dsh-historian:<session>`; the trigger fires on each step above the
  threshold, so overlapping passes both "held" the lease and raced to publish
  the same sequence (real run 41599626978 `cmp-04`: `UNIQUE constraint failed:
  compartments.session_id, compartments.sequence`, historian `failed` → C6/C10
  FAIL). Now `dsh-historian:<session>:<pid>:<rand>`; an overlapping pass logs
  "lease busy" and skips. Side effect: a compaction mini-historian that starts
  while a background pass holds the lease fails closed ("lease busy") instead
  of racing.
- `a91cca79c` CI: `tsconfig.test.json` + informational test-file typecheck
  step (count shown in the Summary). `4ee4a04ba` e2e: **R7** — a main-session
  native compaction must complete (no `compaction/end` error, no
  "summarize range unresolvable" in any log); red on run 41593887664's
  artifacts.

Baseline (round 19, 2026-11-03, DSH 0.2.1-rc.5, core v0.49.35; release tag
`dsh/0.49.35-dsh.1` → `270629e75`; push run 41593684140 @ `270629e75` and
dispatch run 41593887664 (`e2e=true`)):
`typecheck:dsh` **0 errors**, core typecheck **0 errors**, `dsh-plugin`
**485 pass** (65 files; round 19 +17), `adapter-api` **15 pass**,
`contracts:dsh` **98 pass**, 0 fail; real-model `e2e` **0 FAIL** on run 41593887664 @ `270629e75` (native backstop 90 %: R6 effective threshold 90, no native compaction up to 77.7 %; MC first fire 73 %; C8 PASS with no retrieval call; C10 repair retry PASS). Previous run 41592114076 @ `6615a8d5b` was 64/65 (only C8: correct answer after a `ctx_search`; C8 no longer judges retrieval calls)
(round 18's 57 + C10 + R0–R6 = 65 judged). Evidence:
`docs/dsh/e2e/evidence-round19/`.

Round 19 fixes (adapter only, no core change):
- `b7eb34acf` **native pressure compaction no longer pre-empts MC.**
  compaction-basic prices pressure at `min(window × 0.8, window − maxTokens −
  65 536)`: a ≤ ~70k window threw `TargetPressureConfigError` (pressure
  compaction never fired) and a 128k window fired at ≈ 44–46 %, before MC's
  65 % execute threshold. `MagicCompactionEngine` now overrides
  `compactIfNeeded` for the `pressure` trigger only: an MC-managed **main**
  session gets `headroomTokens: 0` and `thresholdRatio` = the native
  backstop for the route, `max(90, MC force band + 5)` capped at 98 (force band
  = core `escalationBands` `max(85, execute + 2)`; → **90 %** at 65 %, raised
  from 85 % by user decision 2026-11-03 so MC's own 85 % force path always runs
  first), registered by the agent plane on
  `magicContextHost.nativePressurePercentage` (live-disabled MC → DSH
  defaults); a **child** session keeps the native policy (round 16) and only
  retries with headroom 0 when the default headroom makes it illegal.
  Explicit top-level `headroomTokens` / `thresholdRatio` and per-route
  `modelPolicies` always win. The effective config is swapped in only for
  compaction-basic's synchronous policy resolution (before its first await),
  so the summarizer / overflow paths read the original. `setup` prints and
  `doctor` checks it (`native-pressure.<profile>`, WARN when user values make
  a 128k main session compact before 65 %). 12 tests (8 red before).
- `a88385f60` the child fallback also covers the second default-headroom
  config error the real host showed (run 41589483637, 80k route):
  `retainTokens (12144) must be less than threshold tokens 10368` (0.16 ×
  message budget ≥ the shrunken threshold on ≈ 70–82k windows) — unless the
  retention is user-set. +1 test (red before).
- `932ffef20` e2e-only one-shot historian corruption
  (`MAGIC_CONTEXT_DSH_E2E_CORRUPT_HISTORIAN_ONCE` = absolute marker path,
  O_EXCL, unset/relative/existing = no-op, repair output never touched) so the
  `f8c663fee` repair retry runs on the real host (C10). +2 tests.
- `9d16d6fab`, `34e728b60`: headless-visible diagnostics (stderr under
  `MAGIC_CONTEXT_DEBUG_HISTORIAN=1`: one `native pressure check: child pct
  thresholdPct window outcome` line per pre-step, `native compaction region`
  per native compaction, repair-retry / injection lines — `ctx.logger` is not
  printed by `dsh headless`); e2e scenario P (`opencode-go-100k` route, 40
  generated fixtures); `cc024e807`, `6615a8d5b` scenario C asks the model not
  to `ctx_reduce` its reads (+2 pairs) and C9 ignores model-authored text.

Native pressure trigger, before → after (real rc.5, e2e P, 100k route,
maxTokens 4096): **before** (compaction-basic defaults, set explicitly in
`patch-r19-dsh-default.yml`; threshold 30.4 %) the MC main session was
natively compacted at **44.0 %** (first pre-step above 30.4 %; run
41591017319), i.e. before MC's 65 %; **after** (shipped policy, threshold 85 %)
the same session climbed to **77.9 %** with **0** native compactions while
MC's historian fired first at **74 %** (runs 41591017319, 41592114076). On the
80k route the old default was not even legal (retain ≥ threshold → never
fired; run 41589483637); on the 40k / 24k routes it threw "no pressure
budget". After (round 19 e2e runs, policy then 85 %; now 90 %): 24k/40k/80k/100k/128k main → 85 % (90 % since the follow-up commit); child 24k/40k/80k → 80 %
(headroom-0 fallback), child 100k/128k → DSH native 30.4 % / 43.8 %.

Previous baseline (round 18, 2026-11-03, DSH 0.2.1-rc.5, core v0.49.35; push run
41554474179 and dispatch run 41554794748 (`e2e=true`) @ `f8c663fee`):
`typecheck:dsh` **0 errors**, core typecheck **0 errors**, `dsh-plugin`
**468 pass** (64 files; round 17 +13, round 18 +4), `adapter-api` **15 pass**,
`contracts:dsh` **98 pass**, 0 fail; real-model `e2e` **57/57 PASS**
(N*/T*/M*/P1 + round 17/18 real-use scenarios C1–C9, U1–U6, S0–S7). Evidence:
`docs/dsh/e2e/evidence-round18/`.

Round 17 fixes (real rc.5 e2e run 41537851210 found them; each test red before):
- `f27757b6b` one `[dropped §N§]` per tag per folded copy even when the parts
  are not adjacent (parallel-call steps rendered `[dropped §6§] [dropped §7§]`
  twice). Real rc.5 re-check: e2e C9 (round 18 runs: 6–8 placeholders, 0 dups).
- `929dbafc9` `/ctx-status` no longer prints core's "OpenCode DB: MISSING …
  historian disabled" line on DSH, and the context plane persists
  `last_input_tokens`. Real rc.5 re-check: U5.
- `17bd7279c` strip copied `§N§` from assistant text at the `llm/stream`
  boundary (12 of 12 replies leaked it). Real rc.5 re-check: C5 clean in all
  three round 18 runs.

Round 18 fixes:
- `a1b94d6b5` **(severe) headless sessions never saw their compartments.** The
  historian's post-publish "materialize on the next pre-step" signal lived only
  in process memory (`historian.ts` `deferredSignalsBySession`); `dsh headless`
  runs each turn in a new process, so the next process found a cache-valid m0,
  replayed the old EMPTY `<session-history>` under the same watermark while the
  compartmentalized raw messages were dropped → history lost (round 17 the
  model needed `ctx_search` for the codeword). The knowledge gate now also
  forces the fold when the durable publish is newer than the cached baseline
  (`dsh_context_compaction_marker.published_at` or `MAX(compartments.created_at)`
  > `session_meta.cached_m0_materialized_at`; self-consuming like core's
  `ttl_idle` / `host_compaction`; skipped in compaction-off mode). Adapter only,
  no core change. Test: `cross-process-materialize.test.ts` runs process A
  (first gate pass + real historian publish) in a child `bun` process and
  process B on the same DB. Real rc.5: C7 (compartment written in turn N,
  in the injected m0 from turn N+1), C8 (codeword answered from
  `<session-history>` with no retrieval tool).
- `43dc2a27e` persist `last_response_time` from the latest completed
  `assistant/message` (`/ctx-status` said "Last response: never"; core's
  `ttl_idle` HARD fold could not arm). Real rc.5: U5 ("Last response: 0s ago").
- `f8c663fee` one historian **repair retry** on invalid XML (upstream
  `runHistorianPrompt` re-prompts once with `buildHistorianRepairPrompt`; the
  DSH pass failed outright — e2e run 41552779443: "output left uncovered
  messages 11-13 without `<unprocessed_from>`" → failure backoff, C6).
  Round 19: exercised on the real host through the e2e-only injection (C10,
  run 41589483637: "Historian returned no usable compartments." → repair →
  compartment published, 0 failures).
- e2e harness (`3b73594bc`, `7917d6bc4`, `e9e10eca2`, `ea6cbd2dc`, `0e624bfd0`):
  C1 accepts core's proactive trigger (threshold−2 = 63 %) but requires the
  context to have exceeded 65 % (trigger pct or prompt tokens / 40k); C3 compares
  the peak with the lowest later step; scenario C reads two files per turn (one
  file per turn let the proactive fold land before 65 %); the child scenario
  reads eight generated <8 KB files so compaction-basic must run its
  **summarizer** (round 17's big files were only pruned: 4 prune / 0 summary;
  round 18: 3 summary / 0 prune, child 0 Magic rows, 8/8 checksums returned);
  new checks C7/C8/C9.

Previous baseline (round 16, 2026-11-03, DSH 0.2.1-rc.5, core **v0.49.35** merged at
`3d9511f23`; push run 41531086184 and dispatch run 41531489091 (`e2e=true`)
@ `3d9511f23`): `typecheck:dsh` **0 errors**, core typecheck **0 errors**,
`dsh-plugin` **451 pass** (62 files; +4 = `child-session-compaction.test.ts`),
`adapter-api` **15 pass**, `contracts:dsh` **98 pass**, 0 fail; real-model
`e2e` **35/35 PASS**. The e2e does not drive a child session to its context
limit, so the round 16 child-compaction fix is verified by unit tests only.

Previous baseline (round 15, 2026-11-03, DSH 0.2.1-rc.5, CI `dsh-ci.yml` on bun 1.4.2
with the filtered install above, push run 41495367987 and dispatch run
41497195497 (`e2e=true`) @ `5f8fe562b`): `typecheck:dsh` **0 errors**, core
typecheck (`packages/plugin`) **0 errors**, `adapter-api` **15 pass**,
`dsh-plugin` **447 pass** (61 files), `contracts:dsh` **98 pass**, 0 fail
everywhere; the real-model `e2e` job passed all 35 checks (N*/T*/M*/P1, the
M5 warning did not fire). The filtered install is enough for a clean
typecheck; nothing else has to be installed. (Round 14: 433 / 15 / 98 at
run 41474648027 @ `19d79cb24`; round 13 local on bun 1.4.4: 425 / 15 / 98.)

Round 14 fixes (each with a unit test that was red before):
`--version` reads `package.json` (was a stale `0.2.0` copy);
Settings overlay — a DSH per-model threshold in the DSH-native spelling
(`deepseek-official/…`) now beats a jsonc key of the same model in the
canonical spelling (`deepseek/…`); dreamer re-discovers projects on every
tick (a fresh DB / a project first seen while the process runs used to stay
unscheduled until restart); `agent/created` session tracking writes the
resolved project identity instead of the raw cwd (the two writers used to
flip `session_projects.project_path`; existing raw-path rows are not
migrated); the compaction summarize hook is built per call (a cached hook
held the transcript snapshot of the first compaction, so a second compaction
of the same session in one process failed "summarize range unresolvable").

Round 15 fixes (one commit each, each with a unit test that was red before
unless noted):
- `b8a31a055` worker: the `agent/created` listener matches the worker's own
  child by a reserved `childId` (two concurrent workers of one parent used to
  apply each other's tool allowlist to both children).
- `84803faa8` session tracking: legacy raw-path `session_projects` rows are
  normalized once at startup (round 14 left existing rows unmigrated).
- `5b595e807` S6: unreplayable `dsh_pressure_truncations` rows are pruned at
  startup (dropped/compacted tags, sessions with no tags left; the per-session
  latch row is kept).
- `02c7623fe` outbox: reconcile closes `retryable` rows as abandoned instead of
  leaving them `pending` forever (they were counted as pending ops in the MC
  popover / context endpoint on every restart).
- `2719c0920` outbox: terminal rows (committed/abandoned) older than 14 days are
  pruned at startup.
- `a88ade224` remote: `magicContext/diagnostics` resolves the wire session id to
  the canonical key (it queried with the raw id and always reported zeros);
  `magicContext/context` no longer throws for an id containing `:`.
- `0281e49b9` settings: per-model threshold keys must be `provider/model`
  (<=256 chars, no `__proto__`/`constructor`), at most 64 entries, length cap on
  `historianModel`.
- `48b7a7988` historian: failures go through core `incrementHistorianFailure`
  (real count in the notice, failing state visible in the popover); background
  passes back off (1 min doubling to 15 min) instead of re-running a full LLM
  pass on every step above the threshold while the historian model is broken.
- `2979ddf51` context details: a stale `compartment_in_progress` flag (process
  killed mid-pass) only counts as "running" while an unexpired
  `compartment_state_lease` exists.
- `f1655e966` test-only: the `2979ddf51` test title had unescaped double quotes,
  a parse error that made CI run 41490193904 fail ("Unhandled error between
  tests"); the test is verified red against the pre-`2979ddf51` source.
- `f30066fdf` config hot reload: the agent plane re-reads `magic-context.jsonc`
  with a 3 s TTL (it read it once at apply time, so after a jsonc edit the
  settings page showed the new effective enabled/threshold while the agent kept
  the old values until restart). Mount-time knobs bridged by
  `bridgeMagicConfig` (memory/dreamer/compaction…) still need a restart.
- `5f8fe562b` unload/reload: the host entry releases this instance's liveness
  marker on dispose (an unloaded host in a still-running process kept the core
  migration guard refusing other processes' migrations); the marker is removed
  only while it still carries this instance's pid + `started_at`, so a reload
  that re-applied first keeps its own. The shared DB is intentionally not
  closed (core keeps one connection per path; a reload reuses it).

Round 16 fixes (each with a unit test that was red before):
- 子会话撞上下文上限的压缩路径对齐上游（`child-session-compaction.test.ts`）：上游 core
  对 `isSubagent` 会话不跑 historian（`event-handler.ts` 溢出时只记 `reportedLimit`）。
  DSH 里原生 `compaction-basic` 被 `MagicCompactionEngine` 替换（默认 `auto=true`），
  它的 `summarize()` 对所有会话都调 MC historian hook，于是子会话撞限时 historian 会
  给未打标的子会话写 `compartments` / `compartment_history_versions` /
  `dsh_context_compaction_marker`（修复前测试实测各 +1）。现在
  `MagicCompactionEngine.summarize()` 对子会话（`compat/dsh-0.1/child-session.ts`
  的 `isDshChildSession`，`isMagicChildSession` 现在直接委托它，同一个判定：
  `origin === 'subagent'` 或 `delegationDepth ≥ 1`）调 `super.summarize()`，即
  compaction-basic 自带的 LLM 摘要器（替换前的 stock 行为，经 `ctx.llm`，
  `purpose: "compaction"`），MC 不读不写库；`registerMagicHistorianPlane` 注册的
  wrapper 再加一道防线，收到子会话直接拒绝（不触库）。主会话路径不变。
  **待决「子会话撞限路径」由此关闭。** 上游的 reduced mode（子会话打标 / 对子会话
  开放 `ctx_reduce`）**暂未移植**：DSH 子会话仍完全跳过 MC 处理，只在压缩时走 stock
  摘要。

Round 15 scans with no confirmed bug (static analysis, plus the one empirical
check noted): **SQLite concurrency** — every DSH write goes through the one
connection opened by core `openDatabaseAsync` (WAL, `synchronous=NORMAL`,
`busy_timeout=5000`); core's tracked `db.transaction()` defaults writable
handles to `BEGIN IMMEDIATE` (verified: a second connection with
`busy_timeout=0` gets "database is locked" while a DSH transaction has only
run a SELECT), and the historian publish uses an explicit `BEGIN IMMEDIATE`,
so there is no deferred read→write upgrade (`SQLITE_BUSY_SNAPSHOT`) path.
Benign: `foldLegacyBareMessageTags` and the feedback watermark read before
their transaction (idempotent writes). **Unload** — dreamer interval (unref +
clear via `ctx.effect`), historian drain, system-guidance / remote disposers,
abort listeners and timers in embed/recomp/worker/auto-search are all
released. **Core boundary** — see "Upstream v0.49.35" under Open
compatibility points.

## CI (`.github/workflows/dsh-ci.yml`)

DSH 自己的 CI，只在本 fork 运行（`if: github.repository == 'ceyirelehe47/magic-context'`）。
上游的 `ci.yml` 在 fork 的 Actions 设置里禁用，**不要改上游的 workflow 文件**；`dsh-ci.yml`
是新文件，只存在于 DSH 分支上。能交给 Actions 的验证都交给它，本地只做快速迭代
（本地 2 核 / 8 GB 的沙箱跑全量 tsc 很慢，还容易被 OOM）。

| job | 何时运行 | 做什么 |
|---|---|---|
| `checks` | push 到 `dsh-integration` / `dsh-sync/**`，以及每次手动触发 | bun 1.4.2（与 `packageManager` 一致）→ filtered install（同 `upstream-sync.yml`）→ `typecheck:dsh` → core typecheck（`packages/plugin`）→ dsh-plugin 测试 → adapter-api 测试 → `contracts:dsh`；各步 `continue-on-error`，最后的 Summary 步骤汇总结果和 pass/fail 数，任何一步失败则 job 失败 |
| `e2e` | **只在** `workflow_dispatch` 且输入 `e2e=true` 时运行（消耗模型额度） | 真实 `@deepseek-ai/dsh` 0.2.1-rc.5 headless + OpenCode Go（与本地 r9–r13 相同的 `model-opencode-go.yml`：24k 主路由 + 200k historian 路由），见下文 |

`e2e` 的步骤（脚本都在 `packages/dsh-plugin/scripts/e2e/`）：

1. `bootstrap.sh`（`INSTALL_TIMEOUT=600`；runner 已有 bun 1.4.2，不会另外下载）→
   `bun run build` → `install-profile.sh test headless` → `setup --profile test` → `doctor`。
   全部装在 `$RUNNER_TEMP/e2e` 下（`E2E_ROOT`），不碰 runner 的全局 `~/.dsh`。
2. `ci-e2e.sh`：每次 `run-headless.sh` 都是一个新的 `dsh` 进程。
   - `selftest-normal`：`MAGIC_CONTEXT_DSH_WORKER_SELFTEST=1`，默认 worker 超时；
   - `selftest-timeout`：同上，`MAGIC_CONTEXT_DSH_WORKER_SELFTEST_TIMEOUT_MS=1500`；
     模型没调用 `ctx_worker_selftest` 时各重试一次；
   - `multi-1..3`：同一个会话跑三轮（中间两次进程重启），每轮之后用 `ci-db.ts` 导出该会话的 tags；
   - 解码两个子会话的 `session.v4.jsonl.zstd`，导出子会话在 Magic 各表中的行数，记录残留的 `dsh` 进程。
3. `ci-check.py redact`：把 `OPENCODE_API_KEY` 的字面值（只在内存里比对，不打印）、
   `sk-…` / `token=…` 一类的串和 `$HOME` 路径替换掉；`ci-check.py check` 写 `summary.md`
   （同时贴到 job summary），任何 FAIL 都会让 job 失败。
4. `actions/upload-artifact@v4` 上传 `$RUNNER_TEMP/e2e/ci`（脱敏后的 turn 日志、子会话事件、
   DB 导出、`summary.md`），名为 `dsh-e2e-<run_id>`，保留 7 天。一次运行约 30 KB，远低于 500 MB 上限。

检查项（`ci-check.py`）：

| id | 内容 |
|---|---|
| N0–N5, Nc1–Nc3 | 正常 worker：`ok:true`；子会话可见工具与实际请求里的工具 ⊆ `read/grep/glob`；`bash/write/edit/ctx_*` 在子会话作用域解析为 `child:false`（执行器会报 `UNKNOWN_TOOL`）；`workerText`、子会话 system prompt 和回复里都没有 `§N§`；子会话在 Magic 表里 0 行 |
| T0–T3, Tc1–Tc4 | 1500 ms 超时：`ok:false`；`workerLog` 写明 `worker timed out after 1500ms; child disposed`（复验 `502d74b94`）；子会话 `turn/end` 为 `aborted {kind: parent}`；子会话 0 行 |
| M0–M4 | 三个进程、同一个会话：每轮退出码 0；每轮之后 tag 号和 message id 都唯一、从 1 连续编号；重启前已有的 tag 号在之后的导出里都不变 |
| M5（WARN） | 模型回复开头的 `§N§` 当时没有被其他消息占用（属于模型行为，只告警） |
| P1 | 运行结束后没有残留的 `dsh` 进程 |
| Nc5 / Tc5 | 子会话的 `sandbox/mode` 事件，仅记录（见下文 worker 沙箱一节） |

触发与查看（本环境没有 `gh`，用 `apicall github`）：

```bash
# 手动跑一次 e2e（checks 也会一起跑）
apicall github workflow_dispatch owner=ceyirelehe47 repo=magic-context \
  workflow_id=dsh-ci.yml ref=dsh-integration inputs='{"e2e":"true"}'
apicall github workflow_runs_list_for_workflow owner=ceyirelehe47 repo=magic-context workflow_id=dsh-ci.yml per_page=5
apicall github workflow_run_jobs_list owner=ceyirelehe47 repo=magic-context run_id=<id>
apicall github workflow_job_logs_get owner=ceyirelehe47 repo=magic-context job_id=<job id>
apicall github workflow_run_artifacts_list owner=ceyirelehe47 repo=magic-context run_id=<id>
```

前提：仓库 secret `OPENCODE_API_KEY`（只通过 step 的 `env` 传入；GitHub 会在日志里把它
显示成 `***`；`ci-e2e.sh` 不用 `set -x`，也不打印环境变量）。没有设置这个 secret 时，
`e2e` 会在第一轮之前报错退出。

注意：`typecheck:dsh` 不覆盖 `*.test.ts`。测试文件里的语法错误只会在 `dsh-plugin tests`
一步表现为 `# Unhandled error between tests`（整个文件不运行，Summary 里多 1 fail），
round 15 的 run 41490193904 就是这样失败的。

Round 17/18 新增检查：

| id | 内容 |
|---|---|
| C0–C9 | 主会话（40k 路由，阈值 65 %，每轮新进程）：C1 historian 在 ≥63 %（阈值−2）触发且上下文确实超过 65 %；C2 写出 compartments；C3 峰值之后的最低 prompt tokens 低于峰值；C4 暗号仍可答出；C5 可见输出无 `§N§`；C6 compartments 连续不重叠、无存活 lease、historian 非 running/failed；C7 缓存 m0 的 `<session-history>` 含 compartments（及暗号那段）；C8 m0 的 `<session-history>` 含暗号时 cmp-q 答出暗号（检索调用只记录，不判定；第 19 轮起）；C9 解码后的会话事件中同一 tag 的 `[dropped §N§]` 不重复 |
| U1–U6 | ctx_search / ctx_memory / ctx_expand 各调用一次且有结果；设置页 / popover 读数与 DB 一致；`/ctx-status` 与 DB 一致（无 OpenCode DB 横幅、Last input tokens ≠ 0、Last response ≠ never）；doctor 干净 |
| S0–S7 | 子会话（24k 路由）读 8 个生成的 <8 KB 文件：委派成功；compaction-basic 走到 **summary**（不只是 prune）；摘要不是 MC 输出；子会话在 Magic 表 0 行；父会话增长只属于自己；子会话 completed；≥6/8 个 CHECKSUM 回到父会话或子会话最终回复 |
| C10 | （round 19）e2e 专用开关把 scenario C 第一次 historian 输出换成截断的 XML（只一次，O_EXCL 标记文件）：之后出现 `historian repair retry`，compartment 仍写出，historian 无失败 |
| R0–R6 | （round 19）scenario P，100k 主会话路由：R1 MC 管理的主会话里没有低于 65 % 的原生压缩；R2 MC historian 先触发（≥63 %，阈值 65）；R3 会话越过旧默认阈值（30.4 %）时没有原生压缩；R4 旧策略（显式写入 compaction-basic 默认值）实测在 65 % 之前原生压缩；R5 所有日志里没有 "leaving no pressure budget"；R6 引擎每步打印的有效主会话阈值 ≥ 65 % |
| R7 | （round 20）主会话原生压缩（MC summarize hook）必须成功：pold/pnew 会话里至少有一次 `compaction/end` 且都没有 error，所有日志里没有 "summarize range unresolvable" |
| R8 | （round 21）所有会话的 `compaction/end` 都没有 "lease busy" 错误，所有日志里没有 "summarize mini-historian lease busy"；details 里报告 90 % 兜底推迟次数、`/compact` 等锁次数、首步 `pct=?` 次数 |

Round 19：dispatch run 41586948399 @ `9d16d6fab`（2 FAIL：R2，读结果被截到 ~8 KB 且模型自己 ctx_reduce，P 只到 52 %；R4，headless 不打印 ctx.logger）→ 41589483637 @ `34e728b60`（2 FAIL：R4，80k 上 DSH 默认值本身非法：retain 12144 ≥ 阈值 10368；R6 首个 pre-step 没有 header；C10 **PASS**）→ 41591017319 @ `0eb2e69c4`（R0–R6 **全过**；C 场景因模型每轮 ctx_reduce、峰值 61 % 而失败 8 项）→ 41592114076 @ `6615a8d5b`（64/65；仅 C8 失败：模型答对暗号但先调了一次 `ctx_search`，属模型行为。C8 改为只判答案 + m0 含暗号，检索调用仅记录）→ 41593887664 @ `270629e75`（原生兜底改为 90 % 后复验，**0 FAIL**；R6 有效阈值 90；MC 首次触发 73 %；C8、C10 通过）。发行 tag `dsh/0.49.35-dsh.1` 指向 `270629e75`。

Round 18：dispatch run 41550425336 @ `e9e10eca2`（1 FAIL：C1，主动触发在 61.7 % 就压缩，未超过 65 %）→ 41552779443 @ `0e624bfd0`（1 FAIL：C6，historian XML 无效且没有 repair 重试）→ 41554794748 @ `f8c663fee`（**57/57 PASS**）。注意 41554794748 的 C1 是靠触发点的投影值 66 % 通过的，实际发出的 prompt 峰值 52.5 %（同一 pre-step 的 drop 已落地）；实测 prompt 超过 65 % 的是 41552779443（74.2 %）。

Round 15：push run 41495367987 @ `5f8fe562b`（`checks` 全绿：dsh-plugin 447 / adapter-api 15 /
contracts 98，两个 typecheck 0 错误）；dispatch run 41497195497（`e2e=true`，`checks` + `e2e`
全部 PASS，35 项检查无 FAIL）。

首次结果（round 14）：push run 41464023149（`checks` 全绿：dsh-plugin 425 / adapter-api 15 /
contracts 98，typecheck:dsh 和 core typecheck 均 0 错误）；dispatch run 41464255692
（`e2e=true`，`checks` + `e2e` 全部 PASS，`T2` 在真实 rc.5 上确认了 `502d74b94` 的超时原因日志）。

## Syncing with upstream

### Automatic (`upstream-sync.yml`)

Schedule (Mon 03:17 UTC) or manual dispatch (`strategy: rebase|merge`,
optional `tag`). Runs **only** when `github.repository` is this fork.

1. fetch upstream tags; target = newest `vX.Y.Z` (or the given tag);
2. exit if `dsh-integration` already contains it;
3. `rebase --onto <tag> <merge-base>` (or merge) on `dsh-sync/<tag>`;
4. filtered install → `typecheck:dsh` → `test:dsh` → `contracts:dsh`;
5. all green → push `dsh-sync/<tag>` to the fork (never master /
   dsh-integration); otherwise open/update an issue labelled `dsh-sync` in the
   fork with the failing step logs and conflicting files.

A human fast-forwards `dsh-integration` to a green `dsh-sync/<tag>`.

### Manual

```bash
git remote add upstream https://github.com/cortexkit/magic-context.git
git fetch upstream --tags
git checkout -b dsh-sync/vX.Y.Z dsh-integration
git rebase --onto vX.Y.Z $(git merge-base dsh-integration vX.Y.Z)
# conflicts can only be in the files listed under "上游 core 改动清单" below:
# root package.json / bun.lock / README.md and three small core files in
# packages/plugin (everything else is new: adapter-api, dsh-plugin, docs/, upstream-sync.yml)
bun install --lockfile-only   # regenerate bun.lock if root/workspace deps moved
bun run typecheck:dsh && bun run test:dsh && bun run contracts:dsh
```

Triage order when something breaks:

1. **core import surface** (`core-import-surface.contract.test.ts`) — a core
   export the adapter calls was renamed/removed. Find the replacement in core
   (`git log -S<name> vOLD..vNEW -- packages/plugin/src`) and port the call
   site; mirror what the Pi adapter (`packages/pi-plugin`) did — Pi is the
   closest sibling harness.
2. **tsc errors in `src/agent/*`** — core signature changes (as with
   `applyPendingOperations`, `executeStatus`, `buildDreamTaskRuntimeConfigs`
   in 0.49).
3. **behavioural test failures** — core semantics changed (e.g. 0.49 seeds
   dreamer schedules only once a project has input). Update the test when the
   new core behaviour is intended; fix the adapter when it is not.

### DSH upgrades

All `@deepseek-ai/*` vocabulary is supposed to live behind
`src/compat/dsh-0.1/` (name kept for history; it now targets 0.2). A DSH bump:

1. bump the exact versions in `packages/dsh-plugin/package.json`
   (dev + peer) and `DSH_COMPAT_EXPECTED_VERSION`;
2. `bun install` → `bun run typecheck:dsh`. `src/contracts/dsh-api.contract.ts`
   pins every DSH interface shape the adapter relies on; a failing
   `Assert<…>` line names the exact contract that moved;
3. fix the compat layer first, then call sites;
4. `bun run test:dsh`, then a real-DSH smoke (see "E2E scripts (real DSH, Linux)" below; `docs/dsh/e2e/README.md` is the historical 0.1 harness).

## 下游发行版（downstream distribution）

`dsh-integration` 不是一次性移植，而是持续吸收官方 Magic Context 发布的下游发行版：
core 原样来自上游 release tag，DSH 层（`packages/adapter-api`、`packages/dsh-plugin`、
`docs/dsh`）叠加在上面。

### 版本命名

- 发行版版本：`<upstream>-dsh.N`，例如 `0.49.35-dsh.4`。`<upstream>` 是 core 所基于的
  上游 tag（去掉 `v`），`N` 在同一上游版本上的每次 DSH 发布递增，换上游版本时重置为 1。
  DSH 基线（当前 0.2.1-rc.5）写进发布说明，不进版本号。
- git tag 用 `dsh/<upstream>-dsh.N`（例如 `dsh/0.49.35-dsh.4`）。**不要用 `v*` 或
  `dashboard-v*`**：fork 里保留着上游的 `release.yml`（`push: tags: v*`）和
  `dashboard-release.yml`（`dashboard-v*`），这类 tag 一推就会在 fork 上跑上游的发布流程。
- `packages/dsh-plugin/package.json` 的版本号按此规则：round 14 为 `0.49.34-dsh.1`，
  round 16 合并上游 v0.49.35 后为 `0.49.35-dsh.1`，round 21 发布为 `0.49.35-dsh.2`
  （tag `dsh/0.49.35-dsh.2`），round 25 发布为 `0.49.35-dsh.4`（tag `dsh/0.49.35-dsh.4`），打 tag 时用同一个号。
  注意：`dsh/0.49.35-dsh.3` → `40c5013a5` 发布时漏改版本号，其 package.json 仍为 `0.49.35-dsh.2`；
  代码与 dsh.4 相同，已发布 tag 不改写，请改用 dsh.4。`dsh-magic-context --version` 直接读
  `package.json`，不再单独维护一份；`src/doctor/cli-version.test.ts` 同时检查版本号符合
  `<upstream>-dsh.N`。`bun.lock` 里 workspace 条目的 `version` 在 round 16 手工对齐
  （`dsh-magic-context` 0.49.35-dsh.1，cli / plugin / pi-plugin 0.49.35，只改这 4 行；
  v0.49.35 没有依赖变化，所以没有重新生成 lockfile）。round 21 升到 dsh.2、round 25 升到 dsh.4 时同样只手改了
  `dsh-magic-context` 这一行。

### 同步节奏

- 上游：`upstream-sync.yml` 每周一 03:17 UTC 自动检查最新 `vX.Y.Z`；上游发布后也可以
  手动触发（`workflow_dispatch`，可指定 `tag`）。只同步正式 release tag，不跟上游
  `master`。
- DSH：只在 DSH 发布新版本时升级（见上文「DSH upgrades」），与上游同步分开做，
  一次只动一边，出问题时容易定位。
- 上游连续发布多个补丁时，可以直接同步到最新的那个，不必逐个跟。

### `dsh-sync/<tag>` 分支的验收流程

1. **CI 门**：`upstream-sync.yml` 在 `dsh-sync/<tag>` 上跑过 filtered install →
   `typecheck:dsh` → `test:dsh` → `contracts:dsh`，全部通过才会推送该分支；
   失败时会在 fork 里开或更新标记为 `dsh-sync` 的 issue，分支不会推送。
2. **冲突面核对**：`git diff --stat <tag> dsh-sync/<tag> -- . ':!packages/dsh-plugin'
   ':!packages/adapter-api' ':!docs/dsh'` 的结果应仍只有下面清单里的文件。
   出现新文件就说明 rebase 时把 DSH 改动带进了 core，或者上游改了我们改过的地方，
   需要人工审一遍。
3. **测试基线**：数字不能低于上一次的基线（见上文 Baseline）；有测试被删或被跳过，
   必须在提交信息里说明理由。
4. **真实 DSH 冒烟**（`packages/dsh-plugin/scripts/e2e/`，Linux）：`bootstrap.sh` →
   `bun run build` → `install-profile.sh` → `setup --profile test` → `doctor` →
   `run-headless.sh` 至少跑三轮：普通回合（§N§ 连续不重复）、`ctx_reduce` drop
   落地、historian 压缩发布。用 `inspect-db.ts` 核对 `harness='dsh'` 行。结束后确认
   没有残留的 `dsh` 进程。
5. **合入**：以上都通过后，把 `dsh-integration` 快进（rebase 策略下是
   `reset --hard origin/dsh-sync/<tag>` 再 `push --force-with-lease`，命令见该 workflow
   的输出），然后打 `dsh/<upstream>-dsh.1` tag，并写发布说明（上游版本、DSH 基线、
   测试数字、已知限制的变化）。

### 上游 core 改动清单（冲突面）

对比上游 tag `v0.49.35`（`git diff --numstat v0.49.35 dsh-integration`，round 16 合并后复核，仍是这 3 个文件，排除
`packages/dsh-plugin`、`packages/adapter-api`、`docs/dsh`）：

| 文件 | 改动 | 说明 |
|---|---|---|
| `packages/plugin/src/shared/harness.ts` | +4 / −1 | `HarnessId` 增加 `"dsh"`（加注释） |
| `packages/plugin/src/features/magic-context/subagent-token-capture.ts` | +2 / −0 | `hostLabel` 的 `dsh` 分支（`"DeepSeek Harness"`），`switch` 穷尽性要求 |
| `packages/plugin/src/shared/prompt-surface-runtime.ts` | +2 / −2 | `dsh` 和 `opencode2` 一样回落到 `opencode` 的旧配置目录 |
| `package.json`（根） | +3 / −0 | `typecheck:dsh`、`test:dsh`、`contracts:dsh` 脚本 |
| `bun.lock` | +151 / −3 | 新 workspace 包与 `@deepseek-ai/*` 依赖；冲突时用 `bun install --lockfile-only` 重新生成，不要手工合并 |
| `README.md`（根） | +27 / −0 | DSH 安装说明的折叠块 |
| `.github/workflows/upstream-sync.yml` | 新文件 | 只在 fork 上运行 |
| `docs/DSH-MAINTENANCE.md` | 新文件 | 本文档 |

真正的 core 代码改动只有前三项，共 8 行增、3 行删。新增 core 改动之前，先确认能否
放进 DSH 层；如果必须改 core，就在这张表里补一行。

### fork 上会运行的上游 workflow

把 fork 的默认分支设为 `dsh-integration` 之后：

- `ci.yml` 的 `schedule`（每天 03:17 UTC）会在 fork 上跑。定时任务总是使用默认分支上的
  workflow 文件，也就是 `dsh-integration` 里的上游 `ci.yml`：二十来个 OpenCode/Rust/
  dashboard 任务，与 DSH 无关，耗 Actions 额度，而且容易因为缺少上游的 secrets 而报红。
- `smoke-opencode-linux.yml` 没有定时触发，但会在 fork 的 `pull_request`，以及向
  `master`/`main`/`train/**` 推送时运行（例如在 GitHub 上点「Sync fork」更新 fork 的
  `master`）。
- `release.yml`（`v*` tag）、`dashboard-release.yml`（`dashboard-v*` tag）会在推送
  对应 tag 时运行，所以发行版 tag 必须用 `dsh/…`（见上文）。

**推荐做法**：在 fork 的 Actions 页面（Actions → 选中该 workflow → 右上角 `…` →
*Disable workflow*）禁用 `CI` 和 `Smoke (opencode bring-up on Linux)`，需要的话把发布类
workflow 一起禁用。**不要修改上游的 workflow 文件**：每次改动都会在下一次同步时变成
额外的冲突面。禁用是仓库设置，不在 git 里，同步不会影响它。`upstream-sync (DSH)`
保持启用。

### S6（已在 round 15 `5b595e807` 修复）：`dsh_pressure_truncations` 不会被清理

> 现在 adapter 启动时会在一个 IMMEDIATE 事务里删除 tag 已 dropped/compacted 的行和已无任何 tag 的会话的行（保留 active tag 的行、tag 行缺失的行，以及每个会话 `basis_usage_seq` 最大的那一行）。下面是修复前的描述，仅供参考。

压力截断的决定按 `(session_id, tag_number)` 持久化在 `dsh_pressure_truncations`
（见下文 Known limitations 中的压力截断一条），之后每一轮都按这些行逐字节重放。
目前没有任何代码删除这些行：会话删除、tag 被 drop、historian 压缩把对应内容移出
surface 之后，行都会留在共享 SQLite 里（dropped 的 tag 只是不再重放）。每行只有几个
整数和一个 sha256，增长量与「被截断过的 tag 数」成正比，正确性不受影响，但库会单调
增长。修复方向：在会话清理路径（core 的 `pending_session_cleanup`）或 adapter 启动时，
删除会话已不存在、或 tag 已 dropped 的行。修复前，需要的话可以手动
`DELETE FROM dsh_pressure_truncations WHERE session_id = ?`。

## `setup` / `doctor` (0.2 profile layer)

`dsh-magic-context setup|doctor` is the package bin (`dist/cli.js`, built
from `src/doctor/cli.ts`; `@deepseek-ai/cordis` is inlined so it runs outside
a DSH tree). It is **not** a `dsh` sub-command.

```bash
dsh-magic-context setup  [--dsh-home <dir>] [--dsh-install <dir>] [--profile <name>] [--dry-run]
                         [--preset <id>[,<id>]]... [--all-presets] [--disable-preset <id>]...
dsh-magic-context doctor [--dsh-home <dir>] [--dsh-install <dir>] [--profile <name>] [--directory <dir>]
                         [--preset <id>]... [--all-presets] [--disable-preset <id>]...   (expectations)
```

### Native pressure compaction (round 19)

`setup` leaves the `magic-compaction` row at `{ auto: true }` and prints the
effective native pressure policy; `doctor` reports it as
`native-pressure.<profile>` (merged over every `magic-compaction` row of the
patch layer, nested inserts included):

- main sessions: MC-led — `headroomTokens 0`, `thresholdRatio` = native
  backstop for the route (90 % at the default 65 % execute threshold; per route
  `max(90, MC force band + 5)`, cap 98), so native compaction is only the backstop behind
  MC's historian / drops;
- child sessions: DSH native (`0.8` / `65 536`), with headroom 0 when that is
  illegal for the window (24k/40k/80k → 80 %);
- user-set top-level `thresholdRatio` / `headroomTokens` / retention and
  per-route `modelPolicies` win; `doctor` WARNs when they make a 128k main
  session compact before 65 %.

### Enabling Magic Context per agent preset

Web profiles compose several **agent presets** (UI "modes": `standard`,
`ptc`, `minimal`, `cordis` = Creator mode). Magic Context is enabled per
preset; flat (headless/tui) profiles have a single pseudo-preset `root`.

| flag | effect |
|---|---|
| *(none, first run)* | web: generate `magic-standard` (a clone of `standard` with Magic) and enable only that; flat: `root` |
| `--preset standard,ptc` (repeatable, comma lists ok) | **add** these stock presets to the current selection — the stock preset rows are patched in place (`compaction-basic` disabled, `magic-compaction` + `magic-agent` inserted) |
| `--all-presets` | enable every stock preset found in the installed layout (all except the generated `magic-standard`) |
| `--disable-preset ptc` (repeatable) | **remove** these presets from the selection; their stock rows are restored |
| *(none, later runs)* | keep the recorded selection and just refresh the block |

The selection is recorded in the managed block itself
(`# magic-presets: cordis,minimal,ptc,standard`), so every run adds/removes
relative to what is there. An empty selection removes the whole block (Magic
fully off for the profile, native compaction and meter back). New sessions of
a changed preset pick the change up; running sessions keep their composition
until restarted.

`doctor` reports every preset of the profile as `enabled`/`disabled` (plus
`unsupported (<why>)` for presets whose stock layout has no compaction group)
and which composer indicator is active. Passing the same flags to `doctor`
turns them into expectations — e.g. `doctor --disable-preset ptc` fails if
`ptc` is still enabled. `magic-standard: disabled` simply means the generated
clone is not in use (stock presets are patched instead).

Verified on real rc.5 (round 8, `docs/dsh/e2e/evidence-round8/`):
`setup --disable-preset ptc` leaves `cordis`/`minimal`/`standard` enabled and
reports `ptc: disabled`; the composed tree (`dsh --dump-config`) has
`preset-ptc` back on stock `compaction-basic` with no magic rows while the
other three keep `compaction-basic: disabled` + `magic-compaction`/
`magic-agent`, and `magic-meter.magicPresets` drops `ptc`. `doctor
--all-presets` fails (rc=1) while `ptc` is off; `setup --all-presets`
restores it and the profile patch comes back byte-identical.

How `setup` works (`src/doctor/setup.ts`, `profile-wiring.ts`, `env.ts`,
`compat/dsh-0.1/profile-patch.ts`):

1. **Locate the DSH install through the launcher.** DSH 0.2 ships no
   `config/agent-presets` tree; every bundle is a dependency of the
   `@deepseek-ai/dsh` launcher package. Candidate order: `--dsh-install`,
   `$DSH_INSTALL_DIR`, the `dsh` executable on `PATH` realpath'd up to its
   package root (what `dsh` actually boots), `$DSH_HOME/profiles/node_modules/…`
   and `$DSH_HOME/profiles/<name>/node_modules/…`, then global bun/npm roots.
   Stock patch files are resolved from that launcher's dependency tree.
2. **Pick the profile**: `--profile`, or the only profile under
   `$DSH_HOME/profiles` (`DSH_HOME` empty = `~/.dsh`). Several profiles and no
   flag → it asks for `--profile`.
3. **Contract-scan the stock layout** for the profile's flavour — flat
   (headless/tui): `@deepseek-ai/dsh-base/cordis.patch.yml` root
   `compaction-basic`; web: `@deepseek-ai/dsh-web-app` `preset-standard`. A
   mismatch **fails closed**: nothing is written.
4. Add `dsh-magic-context` to the profile `package.json`
   `dsh.profile.bundles` — only when the package is resolvable from that
   profile (otherwise it refuses).
5. **Write the managed block** into the profile's own patch layer
   `$DSH_HOME/profiles/<name>/cordis.patch.yml` (applied after every bundle
   layer). The block is delimited by

   ```yaml
   # >>> dsh-magic-context (managed by `dsh-magic-context setup`; do not edit inside) >>>
   # magic-presets: root
   - id: compaction-basic
     disabled: true
   - id: token-meter
     disabled: true
   - insert:
       - id: magic-compaction
         name: dsh-magic-context/compaction
         config:
           auto: true
       - id: magic-agent
         name: dsh-magic-context/agent
       - id: magic-meter
         name: dsh-magic-context/meter
         config: { flat: true }
   # <<< dsh-magic-context <<<
   ```

   (flat layout; web layouts instead get one `- id: preset-<id>` row per
   enabled stock preset — the stock preset's plugin list with
   `compaction-basic` disabled and `magic-compaction`/`magic-agent` added —
   plus `token-meter: disabled` and the `magic-meter` row with
   `magicPresets: [...]`). Re-running replaces the block in place
   (`mergeManagedBlock`) and keeps every user row outside it; a flow-style
   non-empty list is refused. `--dry-run` prints the block and writes
   nothing. Put your own overrides (e.g. `magic-agent` `historian.model`)
   **outside** the block, as separate `- id: magic-agent` rows.

   **DSH's settings writer.** Saving anything on the DSH Settings page
   (including the Magic Context section) makes DSH re-serialise the profile
   patch file and append the changed row at the end of the file. `setup`
   therefore always leaves an *edit anchor* row after the block, compares the
   block semantically (a re-serialised block is still "up to date"), and
   moves foreign rows that DSH appended *inside* the block back out (doctor
   reports them as a warning first).
6. Create `~/.config/cortexkit/magic-context.jsonc` from defaults once; an
   existing file is never overwritten (only missing recommended keys are
   hinted).

`doctor` re-derives the same plan and checks: DSH version == exact
`DSH_COMPAT_EXPECTED_VERSION` (0.2.1-rc.5); bundle present in the profile;
**profile wiring** — the managed block exists and equals the rows derived
from the *current* stock layout (fails on "never set up", "Magic rows present
but not in the managed block (hand-written layer)" and "managed block is
stale"); shared DB open classification (schema fence / migration guard /
fatal) + liveness markers; config load outcome. After a DSH upgrade run
`doctor`, and if the block is stale just re-run `setup`.

Reference outputs: `docs/dsh/e2e/evidence-0.2.1-rc.5/{setup.txt,doctor.txt,profile-cordis.patch.yml}`.
The old hand overlay is kept only for diffing:
`packages/dsh-plugin/scripts/e2e/manual-overlay-headless.yml`.

## DSH Settings page (Magic Context section)

The `magic-host` row (host bundle `cordis.patch.yml`) declares a small
**volatile** Cordis config; DSH's settings service (`@deepseek-ai/dsh-settings`)
publishes it as the settings namespace `magic-host` (`applies: live`), and the
client bundle renders an editable **Magic Context** section on the Settings
page (`settings.section` slot + `plugins.bundle.config`). Fields (all optional;
*unset = inherit*):

| field | type / bounds | inherits from (jsonc) |
|---|---|---|
| `enabled` | boolean — live: pauses per-step Magic work | `enabled` |
| `historianModel` | `provider/model` string | `historian.model` (then `historian.opencode.model`) |
| `historianAwaitAtTurnEndMs` | 0–60000 ms | env `MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS`, else 0 |
| `executeThresholdPercentage` | 20–90 % | `execute_threshold_percentage` (number form) |
| `executeThresholdByModel` | `provider/model` → 20–90 % (DSH or canonical form) | merged over jsonc per-model `execute_threshold_percentage` keys |
| `protectedTokens` | 4000–1000000 | `protected_tokens` (else core's derived default) |

**Precedence (one-way overlay, never a sync):**
**DSH override > `magic-context.jsonc` (project > user) > core default.** A
field set in DSH wins; an unset field inherits the jsonc value; an unset jsonc
key falls back to the core schema default. DSH never writes the jsonc file
(other harnesses share it); "reset to jsonc" = unset the DSH field. The force
(execute + 20, capped) and emergency (95 %) bands are derived from the
effective execute threshold exactly as in core.

Wire: the client talks to the `magicContext/*` Typert endpoints of the
`magic-remote` row — `settings` (effective values with a `source` per field:
`dsh` / `jsonc` / `default`, bounds, jsonc path, revision) and
`updateSettings({ ops: [{op:"set"|"unset", path:[field], value}],
expectedRevision })`. `updateSettings` goes through `settings.mutate`, which
writes a `- id: magic-host  config: {…}` row into the **active profile's**
`cordis.patch.yml` (outside the managed block) and refreshes the volatile
config in place — readers dereference it on every use, so the next agent
step uses the new value without a remount. A stale `expectedRevision` returns
`conflict` with the reloaded view (the page rebases and asks to save again).

**Where the section lives in the rc.5 web UI.** rc.5 has no URL route for
Settings: it is a body-portaled modal owned by
`@deepseek-ai/dsh-client-ui-settings-general` (it occupies
`sidebar.settings` and renders exactly one `settings.section` entry at a time,
`renderSlot("settings.section", { close }, { only: activeId })`). It opens
from the sidebar settings launcher (account menu) or the `settings.open`
shortcut (`Cmd/Ctrl+Alt+,` on web macOS/Windows; rc.5 ships no web-Linux
default). The nav lists every registered `settings.section` entry by its
`label`; ours is `id: "magic-context"`, `order: 60`. The same form is also
mounted as `plugins.bundle.config` on the bundle's page in **Plugins**.

**Why the popover link opens Plugins, not the Settings section.** A plugin
cannot open the Settings modal at a section in rc.5: the shell's
`openSection(id)` is only handed to `settings.onboarding` steps, and the only
navigation service plugins get, `pluginNavigation` (provided by
`dsh-client-ui-plugin-manager`), has just `openList()` and
`openBundle(packageName)`. DSH's own voice-input plugin uses
`openBundle(...)` for its "open settings" action, so the meter popover does
the same (`openBundle("dsh-magic-context")` → Plugins → our bundle, where
`plugins.bundle.config` shows the same editable form). When
`pluginNavigation` is missing the link turns into the text hint
"Open Settings → Magic Context".

Verified live on rc.5 (round 8, `evidence-round8/settings-section.json`,
`r8-settings-*.png`): Account menu → **Settings** opens the modal; its nav
lists General, Models, Built-in plugins, Agent presets, **Magic Context**.
The Magic Context entry renders the status card and the editable form;
Execute threshold → Override → `55` → Save wrote the `magic-host` row
(effective 55, source `dsh`, revision 1), and Inherit → Save removed it
again. While an agent turn was running on the (heavily loaded) test sandbox
the Save button stayed on "Saving…" for more than 3 s although the row was
already written; it completed on its own.

Verified live on rc.5 (round 8, `docs/dsh/e2e/evidence-round8/settings-live.json`):
`updateSettings set executeThresholdPercentage=50` wrote
`- id: magic-host / config: { executeThresholdPercentage: 50 }` into the
profile patch and `settings`/`context` reported 50 (source `dsh`); the ring
stayed grey at 54 % until the next agent step, then turned yellow
(`ckmc-warn`) at 56 %; the popover showed `Execute threshold 50 % · 12K`
and a Nudge line with the band name only (`none · note nudge pending`, no raw
JSON). A stale revision answered `conflict` (expected 0, actual 1, fresh view
attached); `5` (out of bounds) and an unknown field answered `invalid` and
wrote nothing. `unset` removed the row and both endpoints fell back to 65
(source `jsonc`).

**Pending restart (round 21).** The view also carries `pendingRestart`: the
restart-only jsonc sections whose current value differs from the one the
running agent plane started with (`{ key, running, next }`). The page shows
them as "运行中的值 … · 待重启生效 …" under the precedence note, and
`/ctx-status` appends a "Pending restart" block with the same data.
`historian.model` and `protected_tokens` are not in that list: they apply
live.

## Magic Context composer meter (replacing the native context indicator)

Goal: the composer's context ring shows Magic Context's view (yellow at the
MC execute threshold, red near force, click → MC details) instead of DSH's
native one.

How it works (`entries/meter.ts`, `host/meter.ts`, `client/client.js`):

- `setup` disables the stock **`token-meter`** row and inserts **`magic-meter`**
  (`dsh-magic-context/meter`). `magic-meter` mounts the **real
  `@deepseek-ai/dsh-token-meter`** inside a child scope whose
  `sessionProjections` is a renaming facade: the unit TokenMeter registers as
  `contextPressure` is re-registered as **`magicContextPressure`**, its wire
  view extended with the MC thresholds (`executePercentage`,
  `forcePercentage`, `emergencyPercentage`, mode), `managed` (is this session's
  agent preset in `magicPresets` / flat) and `enabled`. Every other
  projection (`tokenUsage`, `contextBreakdown`, …) passes through unchanged.
- **Why rename instead of just disabling token-meter:** the stock web client
  renders its native ring whenever a `contextPressure` projection exists, so
  that key must disappear; but **`tool-result-pruner` injects `tokenMeter`**
  (`static inject = ["tokenMeter"]`, it prices pruned nodes with
  `tokenMeter.estimateMessage`). Disabling token-meter outright would leave
  the pruner — and anything else injecting `tokenMeter` — pending forever.
  Running the real TokenMeter under a renamed projection keeps the
  `tokenMeter` service global and the pruner alive, while the native ring
  sees no `contextPressure` and stays hidden.
- If the stock `token-meter` row is still mounted (setup not run / hand
  patch), `magic-meter` never provides a second `tokenMeter`; it only adds
  `magicContextPressure` beside the native key (both rings show) and logs a
  hint to run setup.
- The client registers a `conversation.composer.dock` component: a ring + %
  (`ckmc-meter`), **yellow ≥ execute**, **red ≥ force − 3**; clicking opens a
  popover fed by `magicContext/context` (thresholds, system/tools/conversation
  breakdown from `contextBreakdown`, compartments + historian state, pending
  drops/outbox, tag counts, m0/m1 knowledge tokens, nudge band) with a link to
  the Settings section through `pluginNavigation`. Unmanaged sessions (preset
  not enabled) get no MC ring.

## Historian configuration

The historian runs as a background pass fired from the pre-step chain when
context pressure crosses `historian.executeThresholdPercentage` (proactive
floor = threshold − 2). Config lives on the **`magic-agent` row**
(cordis plugin config), e.g. in the profile patch layer or a `--patch` file:

```yaml
- id: magic-agent
  config:
    historian:
      model: opencode-go-big/deepseek-v4.1-flash   # provider/model, large-window route
      executeThresholdPercentage: 40
      awaitAtTurnEndMs: 60000                      # optional, headless only
```

- **`historian.model`** (`provider/model`) routes the compartment call (and
  the Magic compaction summarize hook) to a dedicated route. Point it at a
  **large-window** route: the compartment prompt alone is ~60 KB (~18k
  tokens), so a small-window main route fails with `finish=max-tokens` after
  ~1 output token (the error message says "point historian.model at a
  larger-window route"). Without it the current session route is used.
  Fallback when unset on the row: core config `historian.model` (legacy flat
  string) or `historian.opencode.model` (string or `{ model }`) — DSH reads
  the `opencode` harness block because DSH refs are `provider/model`.
  Since round 21 the jsonc value is read live (≈3 s TTL, no restart needed);
  precedence: DSH settings override > explicit row value > jsonc.
- **Drain** (`agent/historian-drain.ts`). Passes are fire-and-forget, and
  `dsh headless` exits right after the turn (~5 s shutdown budget), which
  used to kill the pass mid-flight (`reclaimed compartment lease from dead
  owner`, no compartment written). Two bounded waits, neither cancels the pass:
  1. on plugin unload: wait up to `UNLOAD_DRAIN_MS` = 4000 ms (always on);
  2. at the turn boundary (`agent/turn-stopping`, which DSH awaits): wait up
     to **`historian.awaitAtTurnEndMs`**, falling back to env
     **`MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS`**. Config wins over
     env; non-positive / unset = **off** (default). It also re-evaluates the
     trigger with the final pressure. Enable it only for headless/one-shot
     runs — interactive surfaces (web/tui) must not stall the turn end.

## E2E scripts (real DSH, Linux)

`packages/dsh-plugin/scripts/e2e/` (the Linux/0.2 harness; `docs/dsh/e2e/`
keeps the original Windows/0.1 notes, helpers and the 0.2.1-rc.5 evidence).
Everything is isolated under `E2E_ROOT` (default `~/w/e2e`): `dsh/` = local
`@deepseek-ai/dsh` install, `home/` = scratch `DSH_HOME`, `xdg/` = XDG dirs
(Magic SQLite + user config). Nothing global (`~/.dsh`, `~/.config`) is touched.

```bash
cd packages/dsh-plugin
scripts/e2e/bootstrap.sh                 # bun 1.4.4 + filtered workspace install + local DSH (DSH_VERSION, default 0.2.1-rc.5)
bun run build                            # dist/ (required by install-profile)
scripts/e2e/install-profile.sh test headless   # profile "test" from the headless template; packs + extracts the plugin,
                                         # symlinks node_modules/@deepseek-ai to the launcher install (single module
                                         # instances), copies the ai-tokenizer runtime dep
source scripts/e2e/env.sh
node dist/cli.js setup  --profile test   # managed block in $DSH_HOME/profiles/test/cordis.patch.yml
node dist/cli.js doctor --profile test
export OPENCODE_API_KEY=...              # real model runs only
scripts/e2e/run-headless.sh "<task>" [session-id]   # -> $E2E_ROOT/logs/run-<n>.log, prints rc/elapsed
bun scripts/e2e/inspect-db.ts [db-path]  # harness attribution, compartments, historian_runs, tags
```

`run-headless.sh` always applies `model-opencode-go.yml` (OpenCode Go:
`opencode-go` 24k window to create real pressure, `opencode-go-big` 200k
window as the historian route, `magic-agent.historian.model` set to it).
Knobs: `PROFILE` (test), `EXTRA_PATCH` (extra `--patch` file),
`MC_HISTORIAN_THRESHOLD` (default 40), `RUN_TIMEOUT` (240 s),
`MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS` (default **60000** in this
script), `MAGIC_CONTEXT_DEBUG_HISTORIAN` (1), `OPENCODE_SESSION` (random).

## Known limitations

1. **Surface replacement turns assistant content into `user` role.** DSH
   never lets a plugin rewrite a message in place; tagging/drops are applied
   as surface-replace ops, and folded tool results *and their tool-call
   assistant message* land in the following `user` message
   (`agent/transcript.ts`). This is a DSH design constraint, not a bug to fix
   in the adapter.
   Observed on real rc.5 (round 7): after the first tool step the surface
   holds the folded `[tool: …]` user message *and* a Magic-sourced re-tagged
   copy of the user prompt (`§2§ …`, `source.kind: "magic-context"`) after
   it. The model still answers correctly, but the ordering is a side effect
   of range replacement worth watching on long sessions.
2. **Core borrows the `opencode` model harness** (`historian.opencode`,
   `dreamer.opencode`); there is no first-class `dsh` harness in core. See
   open point 1.
3. **Worker tool allowlist — verified on real rc.5 (round 13 locally, round 14 in
   CI `dsh-ci.yml` e2e N*/T*), still not used by any production path.** See open
   point 2. **Worker sandbox:** the child runs with the parent's
   `sandbox/mode` (`workspace-write` in the test profile) and `approval/policy
   never`. This is rc.5's native delegation behaviour, not ours:
   `@deepseek-ai/dsh-subagent` `lib/index.js` `SubagentRuntime.startActivation`
   → `startLocal()` calls `captureDelegatedPolicyOverrides(parent)`
   (`sandboxMode = sandboxPolicy.overrideOf(parent.session)`, approval pinned to
   `never`), and the child `setup` in `materializeTracked()` calls
   `appendDelegatedPolicyOverrides(child.session, …)`, which appends
   `sandbox/mode {source: "delegation"}`. `runMagicWorker` passes no sandbox
   parameter (`SubagentStartRequest` has none in rc.5); its `agent/created`
   listener re-appends the same captured pair, which is why child logs show
   `sandbox/mode` + `approval/policy` twice (seq 1–2 from DSH, 3–4 from us,
   identical values). Left as is: a read-only child would need a DSH-side
   option; the worker's write capability is already removed by the tool
   allowlist (no `bash`/`write`/`edit` resolvable in the child scope).
4. **No bubblewrap on the verification machine.** The Linux sandbox used for
   the e2e runs has no `bwrap`, so DSH's sandboxed shell/tool execution was
   not exercised there; in the web UI every shell call asks for
   *danger-full-access* approval on such a host.
5. **The Settings page edits the active profile only.** `updateSettings`
   writes the `magic-host` row into the profile DSH is running; another
   profile (e.g. headless `test`) keeps its own overrides. The jsonc file is
   never written from DSH.
6. **The MC meter needs `setup`.** Without the managed block (hand-written
   layer, or the stock `token-meter` row re-enabled) both the native ring and
   the MC ring show. A preset that is not in `magicPresets` shows no ring at
   all (the native one is disabled profile-wide).
7. **`tool-result-pruner` is loaded but idle under Magic; Magic's drops now
   do land (round 10, 347a76d3c).** Its only caller in rc.5 is
   `compaction-basic.compactIfNeeded` (pressure ≥ the compaction threshold or a
   provider overflow), which Magic disables; nothing else calls
   `pruneSession`, and it only looks at `tool/result` surface nodes, which
   Magic folds into its own copies anyway. It stays mounted (its `tokenMeter`
   dependency satisfied) so re-enabling native compaction needs no rewiring.
   Magic's replacement is its own drop pipeline (ctx_reduce, historian
   compartment drops, heuristic cleanup) — which, until round 10, never
   landed: the coordinator's surface copy of a tagged message (`mc-op:` source)
   was read back as a knowledge baseline, so every drop queued after the first
   tagging pass stayed in `pending_ops` forever (unit test red before; on real
   rc.5 the historian's compartment drops now replace the surface:
   `docs/dsh/e2e/evidence-round10/real-item4-*`). Fix: the surface walk expands
   op copies back into their source events (stable core keys, copy node/seq as
   coverage, fold boundaries around a copy) and skips ops that re-render the
   copy's current text (no churn). Old sessions: a copy whose sources include
   a non-copy Magic message (knowledge, temporal merge) stays a baseline.
   Small-window deadlock (real, round 10, 24k window) — **fixed in round 11
   (cc3d6469f, 5c8f5c1e3)**: core's token-floor protection keeps the newest
   tool results (there: all three), core's emergency drop yields only at
   ≥95 % of INPUT, and nothing under Magic calls the native pruner, so two
   15 kB reads left the request at 80 % with no room for `maxTokens` 4096
   (`max-tokens` after 1 token, ctx_reduce unreachable). Magic now has a DSH
   emergency tier, `agent/pressure-truncation.ts`: when projected input +
   output reserve (latest `request/header` `maxTokens`) reaches the force band
   (`max(85, execute + 2)`), active tool results ≥ 3× the keep budget are
   middle-truncated — protected ones included, oldest first, the newest only
   if the others cannot get under the force band — to head + tail (~8 % of the
   window in chars, 1.2k–12k; 75/25) with a marker naming the tag and the
   omitted (numbered) lines. The `§N§` prefix stays in the head; the original
   output stays in the DSH event log (historian, re-reading). Core `drop_mode`
   semantics: the decision is persisted (`dsh_pressure_truncations`: head/tail
   sizes + sha256 of the untruncated output + the usage seq it was based on)
   and replayed byte-identically every pass, so the rebuilt view never
   re-renders the full output and the coordinator sees the copy as current
   (no op, no event, no cache bust); a tag is truncated at most once; one
   batch per usage sample (a new batch needs a newer usage-bearing assistant
   message); a drop wins (dropped tags are not replayed); a digest mismatch
   skips the row. `pressureTruncation: false` in the context-plane config stops
   new decisions (persisted ones keep replaying). Verified: unit tests red
   before (`docs/dsh/e2e/evidence-round11/unit-item1-*`); real rc.5 with the
   round 10 turns (`evidence-round11/real-item1-*`): §6§ truncated once at
   ≈96 % effective, turns 3–8 all answer (round 10: empty `max-tokens`),
   ctx_reduce callable again, the truncated copy written once and unchanged
   across 6 process restarts (one re-render after the marker-wording change).
   Limits: the trigger reads the token-meter projection, which lags one step;
   a single tool result larger than the whole window is still truncated only
   down to the keep budget; protected drops queued by ctx_reduce still wait
   for the window (core parity).
   Also fixed in round 11 (3218f6148): a dropped tool arc rendered its
   placeholder once per part (`[dropped §3§]\n\n[dropped §3§]`, real rc.5);
   it now renders once (existing copies re-render once).
8. **Client bundle is plain JS against the rc.5 web boot.** It may only
   `require` the web boot's static modules (`react`, `react/jsx-runtime`,
   `react-dom`, `@deepseek-ai/dsh-client-store`, `…-ui-slots`, …); the test
   `client.test.ts` pins that allowlist. A DSH web release that renames those
   modules or the slot ids (`conversation.composer.dock`, `settings.section`)
   breaks the UI part only — the server side keeps working.
9. **The popover's settings link opens Plugins, not the Settings modal.**
   rc.5 gives plugins no way to open Settings at a section (see "Where the
   section lives" above); the link uses `pluginNavigation.openBundle`, whose
   bundle page carries the same form. Revisit if a later DSH exposes
   `openSection` to plugins.
10. **Ring refresh on Save and slow saves — improved in round 11
    (313b67393).** Round 8: a settings change was live for the agent at once
    but the ring reads the `magicContextPressure` projection, recomputed per
    agent step, so after 50 % it stayed grey until the next step, and the
    Save button could sit on "Saving…" > 3 s with no feedback (DSH serializes
    the profile write with a running turn). Now a successful Save bumps a
    client-side settings epoch; the composer indicator (another slot
    component) re-reads `magicContext/context` and shows its thresholds /
    `enabled` until the projection itself moves (then the projection is
    authoritative again; a change made outside this page — another tab, a
    hand edit — still shows on the next step). The editor shows "Still
    saving…" after 3 s and after 20 s stops blocking the form, reloads the
    real values (draft kept) and still applies a late reply. The popover also
    lists truncated tool results (limitation 7). Verified on real rc.5 web
    (`docs/dsh/e2e/evidence-round11/web-item2-*`, `r11-*.png`): override 54
    → ring yellow ≤1 s after "Saved" with no step, Inherit → grey at once;
    during a running turn Save took 4.9 s with the hint at 4.0 s. The 20 s
    give-up path is unit/static only.
11. **Duplicate `§N§` prefixes — root-caused and fixed in round 9
    (10181d774, befdcea2e, 7471bfd42).** Root cause: the first-call payload
    preview in `agent/context-plane.ts` allocated its own tag under the BARE
    DSH message id (`tagger.assignTag(sessionId, msg.id, …)`), before and
    independently of core `tagTranscript`, which keys text tags
    `${viewMessageId}:p${n}`. One message therefore owned two numbers (round 9
    pre-fix DB: bare `b43756fb`=1 / `b43756fb:p0`=3, bare `3717b6de`=2 /
    `3717b6de:p0`=8), the model saw the bare number on the first call and the
    `:p0` number afterwards, and its own "highest + 1" reply prefix landed on
    a number the next message received (the round 7/8 `§2§` / `§10§` pairs).
    Fix: (a) the preview runs after the plan derivation and only reads the
    core key, mapped per source text block by `textTagContentIdsBySource`
    (handles the tool-call assistant text folded into the next user message);
    (b) the step's new input (prompt, runtime-context snapshot), which rc.5
    appends to the log only after the pre-step, is pre-assigned under the
    exact key core will use (`${id}:pN`), so the model's next number is right;
    skipped after an unfolded tool call/result, where the ordinals are not
    knowable; (c) old DBs: bare-id `message` rows are folded once per session
    per process (`agent/legacy-tag-cleanup.ts`): row deleted, a still-pending
    drop moved onto the core tag of the same text or discarded when there is
    none; dropped status is not propagated; the counter never goes back.
    Verified: unit tests (red on the old code, see
    `docs/dsh/e2e/evidence-round9/unit-*-red-*.txt`) and real rc.5 (a new
    session through two historian compartments: every message tag a unique
    `:p0` key, no bare rows, the model lists six distinct numbers; the fold
    on a copy of the real pre-fix DB removes all 9 bare rows in 4 sessions;
    a second real session on 7471bfd42 shows the new prompt tagged on its
    first call and 7 unique tags across two compartments).
    Remaining edge (1) — the model's own "highest + 1" reply prefix vs the
    runtime-context snapshot — fixed in round 10 (53f3fdd37): rc.5 appends
    the runtime-context snapshot (`source.kind: "runtime-context"`) after the
    pre-step, so tagging it on the following pass gave it the number the model
    had already typed into its raw reply (round 9: raw `§2§` / snapshot copy
    `§2§`). The snapshot is now a baseline like the knowledge and
    skill-catalog messages: never a fold target (pending tool results flush
    before it), never tagged, dropped or replaced. Side effect, also fixed:
    replacing it nulled rc.5 `RuntimeContextProjection.retained`, so DSH
    re-appended an identical snapshot every turn (round 9: snapshots at seq
    11/28/41, each old one kept as a Magic copy); now one snapshot stays on
    the surface until its content changes. Verified: unit test red before
    (model prefix 2, core gave 3), real rc.5 4-turn session incl. a tool step
    (`docs/dsh/e2e/evidence-round10/real1-*`): every raw reply prefix equals
    the core tag of that reply, 0 duplicate numbers across raw events and the
    surface, one runtime-context event in 4 turns. Older sessions keep their
    already-tagged snapshot copies (harmless); a snapshot that followed tool
    results in an old session no longer hosts the folded results, so those
    get fresh keys once (`synth-user-…:pN`).
    Remaining edge (2) — new input after an unfolded tool call — fixed in
    round 10 (a81db15fb): the ordinals ARE knowable. A user/message that
    follows a tool-call assistant / tool results with no closing user
    message absorbs them (walkDshLog fold), so its own text starts at
    `:p${n}`, n = text blocks of the absorbed tool-call assistant (tool parts
    are not text). The preview replays that fold over the payload in append
    order, starting from the session tail AFTER this pass's surface replace
    (the preview now runs after `enqueuePlan`): on real rc.5 the replace
    lands, the tail is no longer a fold and the offset is 0 (unchanged
    behaviour, real1 turn 3); when the replace did not land (stale input /
    generation mismatch / error) the offset is the synthetic tail's text
    count. Unit tests red before (payload fold and tail fold). Not reproduced
    live: a failed replace cannot be forced in a real run, and headless rc.5
    has no mid-turn steer. Residual: a Magic knowledge message inserted by an
    OUTER pre-step listener after this preview (ahead of the prompt) would
    absorb the fold instead; the knowledge gate is the outer listener but it
    appends to the batch before calling `next`, so the preview sees it;
    (3) resolved in round 10 by the op-copy expansion
    (limitation 7): a legacy bare tag of a folded tool-call assistant text
    keeps its source mapping, so its pending drop is retargeted, not
    discarded; (4) pre-fix
    sessions were created under the `standard` preset, which the one-shot runner
    cannot resume, so the fold was verified on a copy of the real DB, not
    inside a resumed DSH session.

12. **`dsh_context_compaction_marker` rows stay `pending` forever (round 14,
    static + DB).** The historian's atomic publish (`agent/historian.ts`
    `publishHistorianResult`) stages a marker (`stageDshCompactionMarker`, one
    row per session, `INSERT OR REPLACE`), mirroring Pi's
    `pending_pi_compaction_marker_state`. In Pi the marker is drained through
    Pi's `appendCompaction()` (native session trim). In the DSH port its
    consumer `applyDshCompactionMarkerIfCovered` has **no production caller**:
    the surface is trimmed by Magic's own path instead (the publish queues
    drops for the compartmentalized range → coordinator surface replace, plus
    `<session-history>` rendering of the compartments). So the round 13 run-31
    "pending at process exit" is not an exit race — every marker in the local
    DB (9 sessions, incl. multi-process sessions) is `pending`. Impact: no data
    loss (compartments, facts, drops and the publication floor commit in the
    same transaction; the marker is only a pointer; DSH keeps the original
    events in its log) and no double compaction (nothing reads the row; a newer
    publish overwrites it). Not wired on purpose: appending a DSH
    `compaction/summary` on top of Magic's drops would put the same summary in
    front of the model twice (Pi has to strip exactly that duplicate,
    `stripMcOwnedPiCompactionSummary`) and bust the prompt cache. If DSH-native
    trimming is ever wanted, wire the consumer and drop Magic's own trim for
    that range in the same change.
    Round 18: the row's `published_at` is now read by the knowledge gate as
    the durable "a publish happened after the cached m0" signal
    (`hasUnmaterializedHistorianPublish`); `status` is still never consumed.
    Round 19 analysis (read-only, not changed): `status` is written only as
    `'pending'` (`stageDshCompactionMarker`); the only reader,
    `applyDshCompactionMarkerIfCovered`, is not wired in production and on
    success DELETEs the row (CAS clear) instead of writing `'applied'`, so the
    `'applied'` branch is dead. No consumer is needed today: liveness is
    "row exists", ordering is `published_at`. If the DSH-native trim above is
    ever wired, either keep the delete-on-apply and drop `status` from the
    TS type (schema column stays for compatibility), or write `'applied'` +
    `dsh_ack_seq` like the outbox and have the knowledge gate skip applied
    rows — decide in that change, not before.

13. **Small issues recorded in rounds 17/18.**
    - `/ctx-status` "Last response: never" — **fixed** in `43dc2a27e` (see
      round 18 fixes).
    - **compaction-basic defaults vs MC's 65 % — fixed in round 19**
      (`b7eb34acf`, `a88385f60`; see the round 19 fixes and the before/after
      numbers above). compaction-basic's threshold is `min(window ×
      thresholdRatio(0.8), window − maxTokens − headroomTokens(65 536))` and it
      also refuses a default retention (0.16 × message budget) that is not
      below the threshold. The defaults left ≤ ~70k windows with no pressure
      budget, ≈ 70–82k windows with an illegal retention, and fired at
      ≈ 30 % (100k) / 44–46 % (128k) — real rc.5: 44.0 % on 100k. Now MC-led
      on main sessions (90 % backstop; 85 % in the round 19 e2e runs), legal on small child windows, user
      values respected; `doctor` shows the effective policy. Remaining: the
      backstop percentage follows the global/per-model execute threshold via
      the agent plane; a session-level `/ctx` override is not consulted.
    - `ttl_idle` HARD folds can now arm on DSH (they need
      `last_response_time`); a session idle longer than the cache TTL re-folds
      m0 on its next turn, as upstream does.
    - The historian repair retry (`f8c663fee`) — **verified on the real host
      in round 19** (C10, e2e-only one-shot injection).


14. **Round 20 scan (2026-11-03) — status.**
    - **Fixed:** main-session native compaction failing "summarize range
      unresolvable" (`ba38bff7f`, real R7); deprecated-key log lines every
      ~3 s (`b5710f7b9`, unit); restart-only jsonc sections silently ignored
      by hot reload — now a one-time restart notice, the values are still
      applied only at startup (`b5710f7b9`, unit); overlapping historian
      passes double-publishing a compartment sequence (`542c6569e`; unit
      test red→green, real run 41601119332 C6/C10 PASS with no UNIQUE error —
      the overlap itself is timing-dependent and was not reproduced on demand,
      no "lease busy" line in that run).
    - **Partly (fixed in round 21, see 15):** `typecheck:dsh` still excludes `*.test.ts`; the new
      informational step type-checks them (156 errors in fixtures:
      branded `ToolCallId`, assistant events without `stream`, untyped
      `react`). Fixing them is mechanical but touches ~30 test files; make the
      step gating once it reaches 0.
    - **Not changed:** the agent-plane coordinator keeps `appliedOps` (one opId
      string per applied plan) and one settled promise per session for the
      process lifetime — small, bounded by the session's plan count, only
      matters for a very long-lived web server; the settings page shows a
      jsonc `historian.model` / `protected_tokens` as effective immediately
      while the agent applies them at restart (now announced by the restart
      notice); the first pre-step of a fresh session has no request header
      (`pct=?` in the native pressure diagnostic) — cosmetic; the e2e-only
      diagnostic `thresholdPct` is an engine instance field, so concurrent
      main/child checks can print the other session's value (run 41601119332:
      a child check printed 89.8 while compacting at 72.5 %) — diagnostic
      only, the effective policy is computed per call.
    - **Side effect to know:** with unique lease holders, `/compact` or the
      90 % backstop on a main session fails closed ("mini-historian lease
      busy") when a background historian pass is running at that moment; the
      next pressure check retries.
    - **Round 21 update:** all four "Not changed" items and the side effect
      are fixed — see 15.
15. **Round 21 (2026-11-03) — status.**
    - **Fixed:** lease-busy side effect (`b27f24410`: `/compact` waits ≤ 45 s
      for the background pass, the 90 % backstop defers quietly and retries
      on the next pressure check); settings page vs runtime (`0927d1b40`:
      `historian.model` / `protected_tokens` hot, other restart-only sections
      shown as running + pending restart); test-file typecheck 156 → 0 and
      gating (`110acca0d`, `52f33bbf8`, `6ce2603f9`); P7 / P8 diagnostics
      (`a84fb1553`); coordinator caches bounded (`9ab4c3a9e`).
    - **Verified how:** all by unit tests (red first); real e2e run
      41611644712 67/67 (R8 PASS, P8 real: 0 `pct=?` main checks). R8 is a
      regression scan — the overlap of a background pass with a native
      compaction is timing-dependent and no e2e scenario issues `/compact`
      (headless has no slash-command step), so the wait path itself is
      unit-verified only. The `/compact` wait is bounded at 45 s: a historian
      pass slower than that still fails `/compact` (with a clear "retry once
      it finishes" message).
    - **Still restart-only:** every jsonc section except `enabled`,
      `execute_threshold_*`, `historian.model` and `protected_tokens`
      (protected-token tier overrides included) — now visible as pending
      instead of silently ignored.

16. **Round 22 (2026-11-03) — status.** The lock-collision paths of round 21
    now run on the real host (scenario L): the backstop deferral (R10, 6
    deferrals in run 41619627652), the `/compact` wait (R12: waited 21.5 s,
    "lease acquired", completed) and the jsonc hot/pending split in one live
    process (scenario K, U7–U12). Two real defects surfaced: the backstop
    deferred on every step while MC kept re-firing (fixed `c362790f2`, R11
    re-verified in round 23) and the native-compaction ordinal defect (17).
17. **Round 23 (2026-11-03) — status.**
    - **Fixed (reproduced on the real log, then in e2e):** history ordinals
      across DSH native compactions (`a61d3c08f`; `/compact` #2 over stale
      compartments, background historian blind after the old last ordinal,
      post-compaction turn as drop candidates); `ctx_expand` numbering
      (`d2ee6281c`); the backstop retry over its own fresh checkpoint
      (`a39dc5ea7`, surfaced by the first e2e of the ordinal fix). Verified: unit replay of run 41619627652's log (7/7 + 1),
      e2e 41628590609 R13 (timeout branch now runs) and R14 (second compaction
      keeps lock-c's prompt + checksums visible or inside a compartment).
      The final run 41628590609 @ `a39dc5ea7` also confirmed `a39dc5ea7`: R10/R11
      PASS (no 'summary is not smaller' error after a committed compaction).
      Its only FAIL, R12, was scenario timing (no lease held when `/compact`
      started), fixed in round 23b (`c34eb964e`).
    - **Known, not changed — the first compaction's uncovered tail.** When the
      mini-historian leaves a trailing part of the `/compact` region
      unprocessed (`<unprocessed_from>`), the summary renders only what was
      covered, so that tail is shadowed without a summary (run 41619627652
      `/compact` #1: region through ordinal 20, compartments end 17 — two
      knowledge re-injections and the one-line prompt "Reply with the single
      word: ok."). Since round 23 the tail keeps its history ordinals, the next
      background pass reads it (unit case 2 starts at 18) and `ctx_expand`
      recovers it; failing `/compact` closed instead would make it fail
      whenever the historian defers the newest message. Observed once, minor.
    - **Known, not changed — pi-ai clamps `max_tokens` near the configured
      window (round 22's sporadic `max-tokens`, 1–174 output tokens on the
      40k / 100k e2e routes).** Investigation only, see
      `docs/dsh/e2e/evidence-round23/max-tokens-analysis.md`: our requests fit
      (prompt + 4096 < window) and the provider honours the `max_tokens` it is
      given; `@earendil-works/pi-ai` sets `max_tokens = min(maxTokens,
      max(1, window − estimate − 4096))` and DSH's `dsh-llm-pi-ai` replays
      assistant messages with empty usage, so the estimate is chars/3.5 of all
      messages + tool schemas (≈ 20 % above the provider's count). The model
      gets ≈ 0 output budget from ≈ 75 % real usage on a 40k window and ≈ 80–88 %
      on 100k — below the 85 % force band / 90 % backstop on small windows.
      Not P0 (not an oversized request; not Magic-specific). Options for a later
      decision: keep e2e scenarios under ~70 % on pi-ai routes; ask DSH to
      carry usage on replayed assistant messages; or lower the backstop on
      small pi-ai windows to `(window − 4096 − maxTokens) / 1.25`.
    - **Pending user decision — `/compact` behind a historian pass longer than
      45 s (analysis only, nothing implemented).** Today (re-verified in real
      rc.5, R12/R13): `/compact` → summarize hook waits (poll 500 ms, ≤ 45 s,
      re-checking coverage); past 45 s it throws and `/compact` prints DSH's
      fixed "Compaction could not produce a useful summary…" (our "retry once it
      finishes" text only reaches the session log). A queue was not built
      because (1) a plugin cannot change `/compact`'s reply text
      (`@deepseek-ai/dsh-command-compact` maps every error to a fixed sentence),
      so "queued" has no channel; (2) `compactNow` needs an idle agent, so a
      queued run races the next prompt, and in headless the process is gone —
      only a durable, invisible delayed action would survive; (3) a pass is one
      historian call (10–30 s measured; R12 waited 21.5 / 24 s), so 45 s only
      fails on an unusually slow historian route. Options, in order of
      preference: **A** keep waiting past 45 s while the holder is provably this
      process's own live pass (historian drain + lease TTL), hard cap ≈ 180 s,
      cross-process holders keep 45 s — no new UX, `/compact` just completes
      late; **B** queue + notice via a Magic surface (`/ctx-status`, composer
      popover) — contradicts `/compact`'s fixed failure sentence without a DSH
      change; **C** upstream DSH: a `ManualCompactionError` code such as
      `deferred` with plugin-supplied text, which would make B clean.
      **待用户决定。**

18. **Round 23b/23c (2026-11-03) — status (P0-1, P0-2).**
    - **P0-1 fixed** (`dd6900465`, see the baseline block): dense tool output
      under pressure. Verified: unit `pressure-dense` 4/4 (was 1/4); local
      real-rc.5 + mock repro (27 700-token request → 10 205 after the fix;
      the stuck session recovered); e2e scenario X X1–X8.
    - **P0-2 crash points** (e2e-only fault injection
      `MAGIC_CONTEXT_DSH_E2E_CRASH_AT`, inert without `MAGIC_CONTEXT_DSH_E2E=1`):
      outbox-pending and surface-applied (the coordinator saga) were already
      recoverable — the next process settles the row, tag numbers/message ids
      unchanged, no `§N§` duplicated; historian-publish rolls back with the
      process (no half-published compartment/marker) and the rerun publishes
      exactly once; historian-published keeps the single publication, no
      duplicate on rerun; two processes on one DB: the other session is
      untouched and `integrity_check` is ok. **Bug found and fixed**
      (`e37619117`): the dead owner's lease read as busy/"running" for up to
      5 min (the next acquire already reclaimed it — core's
      `acquireCompartmentLease` checks the pid — so publication itself never
      stuck; the read-only probes did).
    - **Real DSH kill -9 (scenario Y):** verified that a SIGKILL during the
      hold leaves an unexpired lease of the dead pid, the restarted process's
      first pass takes the lease at once (no TTL wait), the session resumes
      from the DSH log, the next pass publishes once, outbox settled,
      `integrity_check` ok, the other session unchanged.
    - **Known limits (not changed):** (a) liveness is a same-machine pid
      probe — a DB shared across machines/containers with separate pid
      namespaces is not supported (a foreign pid can read "dead" or "alive"
      by accident; core has the same assumption); (b) pid reuse can only make
      a dead owner look alive → back to the TTL wait (≤ 5 min), never a false
      "free"; (c) an "inconclusive" probe (EPERM in sandboxes) also keeps the
      TTL behaviour; (d) the e2e kill lands after the first read (the hold
      starts at the first trigger), so Y covers one interrupted pass, not a
      kill between several published passes — the unit cases cover the
      after-COMMIT point; (e) in real DSH the busy probe's dead-owner branch
      is not directly observable at the first step (the first pass already
      reclaimed the row before the step observer runs); it is covered by the
      cross-process unit cases; (f) **FIXED in round 24a (`8a765eb7d`, red
      `877be0ccb`; e2e 2/2: 41665756434, 41669354809 R10+R15 PASS) — was
      observed twice (P1 candidate):** e2e 41640093586 and 41642823892 ("819 >= 475") R10 — in scenario L two consecutive
      backstop checks at 38.2 % / 39.6 % (≥ 36 % on that route) right after a
      committed compaction failed with compaction-basic's "summary is not
      smaller than the shadowed content (423 estimated framed tokens >= 239)":
      the region since the fresh checkpoint was one step of output (239
      tokens) while Magic's rendered compartments were 423. The next checks
      compacted normally and the turn completed (rc 0); the error is only a
      failed `compaction/end` event. Model-dependent (R10 passed on
      41636248583 and in round 23); unrelated to the P0-2 change (the lease
      holder there is the live process itself). Option for later: skip the MC
      main backstop when the region after the last checkpoint is smaller than
      the Magic summary would be (this is what `8a765eb7d` does: the backstop
      guard skips such a region before `compaction/start`); (g) **MITIGATED in
      round 24a by the adapter (`41e74f26d`, red `154b17192`: an O_EXCL open
      lock serialises the first open of the shared DB across DSH processes;
      repro 8/48 → 0/48 pairs) — the core race itself is not changed;
      found in 23c, upstream core:** two processes opening a FRESH (never migrated) DB at the same
      moment can race core's migration — `migration-v95-perf-indexes.ts`
      checks `sqlite_master` and then runs `CREATE TABLE temporal_decisions`
      without `IF NOT EXISTS`/a write transaction, so the loser fails with
      "table temporal_decisions already exists" → "storage unavailable …
      Magic Context is disabled for this run" (fail-closed; the next start
      opens normally). Reproduced 2 of 45 parallel spawns
      (`evidence-round23c/repro-concurrent-first-migration.*`); it made the
      two-process unit case flaky on CI (push run 41642824046). That case now
      migrates the shared DB once before spawning (an existing DB, as for any
      second DSH process) and asserts process A died at the injected point;
      (h) **DSH behaviour under kill -9 (verified, by design):** a tool result
      already printed on headless stdout may not be durable yet; on resume DSH
      records that call as `TOOL_OUTCOME_UNKNOWN` ("interrupted … outcome is
      unknown … retry only if read-only or idempotent") instead of the output
      (e2e 41642823892: read #2 emitted, then killed). Magic tags that
      synthesized result after the restart (tag 3 in y-2); no partial original
      ever reaches the log. Y6 accepts exactly "whole or TOOL_OUTCOME_UNKNOWN".

19. **Round 24 (2026-11-04) — status (24a/24b/24c).**
    - **Fixed:** 18 (f) (`8a765eb7d`, e2e 2/2); P1-1 message lane
      (`4a586cb21`) and compartment lane (`f3d44e73b`); injected text as
      history (`a529b7846`). **Mitigated:** 18 (g) by the adapter open lock
      (`41e74f26d`); the core migration race itself is unchanged upstream.
    - **P1-1 verified by scenario H** (U13–U25, real model, mock embeddings):
      U13–U25 (+U26) all PASS on 41693402758 @ `955a12d08`; the U16 checker
      change `9e9b828a7` restarted the count: 41699491685 PASS (1), 41699579212 U20 FAIL (model answer
      format, not Magic) → reset; PASS ×2 consecutive (41705543125 117/117, 41705587583 117/117 @ 40c5013a5).
    - **Behaviour change (parity, intended):** injected messages no longer count
      as meaningful user turns for core's 5-user-turn protected tail
      (`PROTECTED_TAIL_USER_TURNS`), so on DSH the historian now starts after
      the same number of REAL user turns as on OpenCode/Pi — later than before
      in short sessions (scenario Y needed 3 more turns to have anything to
      publish).
    - **Known, not changed — exact-identifier ranking under RRF (core).** With
      the compartment lane on, core folds a message hit into its covering
      compartment and fuses lanes by rank (`mergeMessageAndCompartmentResults`);
      a codeword query can rank compartments that share a common token
      ("file") above the one whose message contains the codeword (41672370986
      and 41679402115: the fact's compartment was result [3]). Observed with the
      bag-of-words e2e mock only; behaviour with a real embedding model is
      **pending verification**. Same in OpenCode/Pi (core).
    - **Known, not changed — already-written data.** Compartments written by
      earlier builds may contain injected m0 / hint text (the historian read
      them since the history provider existed; `/ctx-recomp` rebuilds); FTS rows
      indexed by `4a586cb21`…`56cd64986` (unreleased) keep injected blocks —
      core re-reconciles incrementally and does not re-check old rows.
    - **Known, not changed — DSH's runtime-context snapshot** (`source.kind:
      runtime-context`, DSH's own) still counts as a user turn and is indexed;
      it is not Magic's text and is left as DSH writes it.
    - **Known, not changed — R0 / pi-ai clamp (limitation 17).** e2e
      41672370986 `pnew-05`: 87 669 provider tokens on the 100k route → 1
      output token, `max-tokens`, rc 1 (backstop correctly deferred at 94.2 %,
      historian busy). Same as round 22's r1 pnew; not Magic.
    - **Known, not changed — e2e replay tools** must decode DSH's storage-form
      `sourceEventSeqs` ranges (`decodeSeqRanges`); production code reads
      sessions through DSH's own API and is not affected.

20. **Round 25 (2026-11-04) — status.**
    - **Fixed (product, adapter):** U21 historian memory identity + dedup context
      (`8a7864594`); B1 stale open lock on a reused / own pid (`658ea8f19`); B2
      lease of a reused / own pid (`d1c19c6c8`). Unit before/after files in
      `evidence-round25/` (`u21-*`, `b1-*`, `b2-*`).
    - **Checker, not product — U14 in e2e 41688260239:** compartment [11, 15]
      carried FILE-HERON-2261 from the agent's own `ctx_memory` write call at
      ordinal 11 (the FTS rows U14 used hold text only). Ruled out: historian
      restating `<project-memory>` — all four memories were active for both
      passes and no compartment carried a code its range did not. Analysis:
      `evidence-round25/u14-41688260239-analysis.md`.
    - **P1-3 (child-agent permission boundary) — verified, scenario W:** a worker
      child forced (mock) to call bash and write gets "unknown tool" for both,
      nothing on disk, is offered only glob/grep/read, and the parent keeps
      bash/write after the worker. W1–W4 PASS on 41693402758 and 41699491685.
    - **P1-2 (long-run / multi-session) — scenario S:** 5 sessions × 4 rounds,
      each round in parallel, every run a restart, one shared DB. ST1–ST4 PASS on
      41693402758 (no duplicate/overlapping compartments or tag numbers,
      integrity ok, no live lease / in-progress flag / open outbox op / leftover
      process, DB+WAL 1 732 608 → 1 826 816 bytes over 4 rounds). **RSS is
      measured on CI** (GNU `/usr/bin/time -f %M` per run): max 271 868 KB in
      round 1, 273 468 KB in round 4; median wall time 3.24 s → 3.21 s. ST5
      FAILED there (no S session ever had eligible history: 4 real user turns sit
      inside core's 5-user-turn protected tail, every pass 'nothing to compact');
      `79615e408` adds 5 warm-up rounds: ST5 PASS on 41696491092,
      41699491685 and 41699579212 (41699491685: 5 compartments in each of the 5
      sessions; RSS 301 132 / 299 144 KB, median 5.51 s / 5.70 s, DB+WAL
      1 888 256 → 2 011 136 bytes).
      Scope: a short stress (minutes, mock model), not a soak test — hours-long
      growth is **pending verification**.
    - **Scan candidates (round 25) and status:** U21 historian identity — fixed;
      U26 memory identity / no exact duplicate — new check, PASS; B1 stale open
      lock — fixed; B2 lease pid reuse — fixed; U14 codeword in compartment —
      checker gap, fixed in the checker (`955a12d08`); ST5 — scenario precondition,
      fixed in the scenario (`79615e408`); U16 folded hit whose historian title
      names its own range's facts (41696491092) — checker, fixed `9e9b828a7`; X8 —
      warm-up plans shared across sessions (introduced by `79615e408`), fixed
      `40c5013a5`; P1-2 / P1-3 — covered by S / W as above.
    - **Known, not changed — orphan memories under the raw directory path.**
      Memories the historian promoted before `8a7864594` keep their raw directory
      `project_path`: they are not injected, not seen by dedup, and are **not
      migrated automatically** (a later correction cannot archive them). Cleanup
      is manual (re-pin under the project, then delete the raw-path rows).
    - **Known limits of B1/B2:** the start-time comparison needs
      `readProcessStartTime` (procfs; `ps` on macOS); when it is unreadable the
      old behaviour holds (wait / TTL). Same-machine pid namespaces only, as
      before (limitation 18 (a)).
    - **Not done this round:** P2 (release); no tag moved or created.

21. **Round 26 (2026-11-04) — status.**
    - **Limitation 19/20 (orphan raw-path memories, injected text in FTS /
      compartments) — repair path shipped:** `dsh-magic-context migrate-legacy`
      (scan / `--backup` / `--dry-run` / `--apply` / `--restore`, nothing deleted;
      `9565e87ef`, bun 1.4.2 open flags `8ba07a9fa`, backup-name collision inside one
      second `47125f480`). Scenario M (real DSH before/after, isolated data dir) M1–M5.
      Not automatic: the user runs it (doctor names it).
    - **Limitation 17 (/compact unprocessed tail) — fixed:** the checkpoint summary
      carries `<unsummarized_tail>` while the historian leaves the region uncovered
      (`5e8380dd7`); the /compact mini-historian now writes its `historian_runs` row
      (`07284476f`). Scenario T on e2e 41774795839: T2 `unprocessed_from` 9 = the
      constraint's ordinal, compartments [1, 8], T4 the restarted model answers the
      codeword from the summary with tools forbidden.
    - **Y4 — tag drift of an unreplaced tail fold (fixed `906ce5fc5`):** a process
      killed between a tail tool result and the landed surface replace left the
      call owned by `synth-user-…`; the next user message absorbed it and core gave
      the call a second tag (model saw §4§ for a §3§ result). Tool tags are re-owned
      before tagging; absorbed assistant TEXT still gets a new `:pN` tag (round 10).
    - **P1-3 exact-identifier ranking — reproduced with REAL embeddings, not every
      run (scenario E, `Xenova/all-MiniLM-L6-v2` = core's default local model, query =
      the code itself, rank of the memory holding it):** e2e 41774795839 — 5/7
      (ARCH-KESTREL-4127), 6/7 (RULE-MARMOT-5830), 2/7 (FILE-HERON-2261), 1/7
      (TODO-BISON-9074); e2e 41777488761 — 1/6, 1/6, 1/6, 2/6 (bag-of-words mock in the
      same run: 5/6 for ARCH-KESTREL-4127). Session A is written by the real main
      model, so the candidate set differs per run. An exact identifier is not reliably
      first: the fix belongs to core's RRF fusion (exact-token / FTS-match boost) —
      **won't fix in DSH (user decision 2026-11-04): upstream core behaviour, left as-is; scenario E stays as a WARN-only observation**.
    - **New: the model imitates the folded tool format (P1 candidate).** e2e
      41769676548 R9/R11 (lock-a): instead of calling `read`, the real model wrote an
      8 314-char assistant TEXT imitating Magic's folded `[tool: read #call_N]` /
      `[tool result: …]` blocks (limitation 1) with fabricated file content, until
      max-tokens. Observed once (not in 41771964169 / 41774795839). If it recurs,
      candidate mitigation in the adapter: a fold format that reads less like a
      transcript the model should continue (e.g. a framed, non-conversational
      header). Not changed this round.
    - **P1-4 soak:** `dsh-soak.yml` short run 41773273940 (2 × 10 min) K1–K9 PASS
      (348/348 mock runs, 3/3 real samples, RSS 1.08×, WAL 0, 0 historian failures).
      12-hour run (4 × 180 min) dispatched as 41775904921 — result pending.
    - **P2-5 release acceptance:** `dsh-install.yml` packs HEAD and tag
      `dsh/0.49.35-dsh.2`, installs on a clean runner through
      `dsh plugin --profile headless add <tgz>` (pnpm, DSH from npm): install →
      upgrade (rows kept, integrity ok) → disable → roll back, A1–A4 PASS on
      41775619062. Findings: (a) DSH's plugin manager needs pnpm 10+ (pnpm 9 refuses
      with `ERR_PNPM_ADDING_TO_ROOT` in the profile workspace); (b) pnpm warns
      "Issues with peer dependencies" — the `@deepseek-ai/*` peers are provided by
      the DSH install itself (`autoInstallPeers: false`), no duplicate copy was
      installed; (c) both tarballs are schema v95, so the rollback crossed no schema
      fence (a fence refusal is untested); (d) `doctor` exits 1 after
      `setup --disable-preset root` disabled the only preset ("Profile patch layer:
      no Magic rows" with a re-run-setup hint) — misleading, not fixed.
    - **Flaky (pending verification):** `host-unload-release` "Cannot use a closed
      database" once on checks 41775611238 (same code green on 41775057793).

22. **Round 27 (2026-11-04) — status (27 / 27b / 27c).**
    - **Limitation 21 (model imitates the folded tool format) — format changed,
      NOT solved (still open, P1).** C1 (`e7e31f2a3`): the DSH adapter (only
      place that renders the fold, `agent/transcript.ts`) writes one framed
      `<recorded-tool-activity note="already executed … not a tool-call syntax …">`
      record in past-tense prose; historian/FTS input is unchanged. Before: 2 of 4
      e2e runs (lock-a only, old `[tool: …]` form;
      `evidence-round27/c1-imitation-baseline.md`). After: I1 clean on 41784617324,
      41787740600, 41788066023, 41790564442, then **WARN on 41792968900**: scenario
      H run `h-a4` wrote an 8 124-char assistant TEXT copying the NEW record
      verbatim (note included) with a made-up `bash` result; the turn completed
      and H's own checks passed (`evidence-round27/c8-i1-recurrence-41792968900.md`).
      So 1 of 5 runs after vs 2 of 4 before, on a different route: the framing
      lowers the rate but the model still continues a transcript that contains
      tool records as text. Not changed in 27c (the next step is a design choice,
      not a wording tweak). Options for a later round: keep folded tool records
      out of the model-visible assistant/user text altogether (fold only into a
      one-line count, e.g. "3 earlier tool calls, results summarised by Magic",
      and rely on `ctx_expand` for detail); or render only the result summary
      without the call/id/input lines the model copies; measure each with I1 over
      ≥ 5 e2e runs. I1 stays in every e2e as a WARN with the text.
    - **不修（上游 / DSH 原生行为）— won't fix, documented only:**
      - **R0 — pi-ai `max_tokens` clamp (limitation 17, round 23 analysis).**
        Seen again: 41787740600 `pnew-03`, 41788066023 `pnew-05` (1 output token →
        `max-tokens`, rc 1; the native backstop correctly deferred while the
        historian ran). `@earendil-works/pi-ai` + `dsh-llm-pi-ai`, not Magic.
      - **DN1 / ST1 — DSH boot rewrites `<profile>/cordis.yml` in place
        (DSH-native).** 41787740600 sw-1-3 / sw-2-3: rc 1 in 0.3 s, "include
        (required) … config file must be a top-level array of entries:
        profiles/test/cordis.yml". Root cause (corrects round 27's "shared
        `.tmp`" inference): every boot's `prepareProfile()`
        (`dsh/lib/profile-boot-*.js`) does `writeFileSync(<profile>/cordis.yml,
        PROFILE_ROOT_CONFIG)` — truncate then write, no temp+rename — and a
        concurrent boot's `Include.read()` (`dsh-app-boot`) can read the empty
        file (`yaml.load('')` → `undefined` → TypeError). Locally: a boot leaves
        the file with the same inode and a new mtime; mechanism repro 163 135 of
        414 754 reads not an array in 3 s
        (`evidence-round27/c7-st1-cordis-yml-dsh-native.txt`,
        `c7-cordis-yml-race-repro.mjs.txt`). `Include._writeFile`'s fixed
        `<file>.tmp` name is a second, latent DSH race (Loader write-back only).
        **User impact:** several `dsh` processes started at the same instant on
        ONE profile can fail at startup; a retry works. **Scenario mitigation
        (`605a8f7a4`), and why:** scenario S tests Magic across five concurrent
        processes (shared DB, leases, open lock, historian), not DSH's profile
        boot, so each S session now runs on its own copy of the test profile
        (`test-s1`…`test-s5`, same DSH_HOME / sessions / DB / plugin build, all
        five still launched together). ST1 is unchanged; ci-check **DN1**
        scans every run log for the signature and reports WARN with the run
        names, so the DSH issue stays visible (offline on 41787740600: DN1 WARN
        sw-1-3, sw-2-3). Other scenarios still share profile `test`.
    - **不修（core）— won't fix, documented only (user rule: core and DSH-native
      issues are recorded, not patched):**
      - **P1-3 exact-identifier ranking under RRF** (scenario E, WARN-only E2):
        real MiniLM ranks for the four codes — 41788066023: 3/8, 8/8, 2/8, 1/8;
        41790564442: 1/3, 2/3, 1/3, 1/3; 41792968900: 4/9, 9/9, 1/9, 3/9.
        Core's `mergeMessageAndCompartmentResults` fusion, same in OpenCode/Pi.
      - **Core v95 first-migration race** (limitation 18 (g)): mitigated by the
        adapter's open lock (`41e74f26d`, hardened in C5 `b679849f2`); core's
        `migration-v95-perf-indexes.ts` is unchanged.
      - **Already-written data** (old compartments / FTS rows with injected
        text): repair is `migrate-legacy` (round 26) or `/ctx-recomp`; core does
        not re-check old rows.
    - **Fixed this round (adapter):** C2 doctor after a full disable (round 26
      finding (d)); C3 `host-unload-release` flake (test isolation); C5 open-lock
      races; auto-embed deferral diagnostic; `migrate-legacy` stale concurrent
      plan; `<unsummarized_tail>` O(n²) + surrogate split; scenario F tag
      re-own to a synthetic owner. One sentence each in the round 27 baseline
      block at the top of this file.
    - **Soak 41775904921 (12 h, 4 × 180 min @ `901fb7874`, i.e. round 26 code,
      none of the round 27 fixes):** segment 1 of 4 finished 2026-11-04 15:54 CST,
      K1–K9 PASS (3310/3310 mock runs, residue 0 of 3316, RSS 303 156 → 309 692 KB
      1.02×, wall 3.06 → 3.05 s, WAL max 0, DB 1.1 → 48 MB with flat growth per
      run, 0 historian failures of 16 958, real samples 6/6). Segments 2–4 still
      running (3 × ~3.3 h, ETA ≈ 02:00 CST 2026-11-05); the final K1–K9 over the whole CSV is pending.

23. **Round 28 (2026-11-04) — status (28 / 28b / 28c).**
    - **Limitations 21/22 (model imitates the folded tool record).**
      - **v1 (`77a6c3b2f`): count-only prose** ("1 file was read …", no targets).
        I1 clean, but the real model could not tell its own read had finished and
        re-read one file 5–8× per turn (41828791422 t-1 p32.txt ×8 → pi-ai clamp →
        T1/T2 FAIL; 41828796915 every pnew-02 file ×5). Reverted in v2.
      - **v2 (`cc96eb02e`): one prose sentence naming each call and its target in
        order**, results verbatim, no call id / input JSON / per-call header.
        **I1 0/5** on 41832514940…41832534523 (and PASS on every later run); I2
        (one file read ≥ 4× in a run, WARN-only) not triggered. Rate on v2 so far:
        0 imitation copies; still an observation, not a proof (limitation stays
        open at low priority; I1/I2 stay in every e2e).
      - **Side effect seen on v2: the model calls `ctx_reduce` on its own reads
        against the scenario-P prompt** (41832534523 R2, 41832514940 R4/R7;
        0/26 such runs rounds 21–28 on v1-era formats vs 2/5 on v2, p≈0.02 —
        statistical inference, not reproduced deterministically; wording
        suspected, not changed because v2 holds I1/I2). Not a Magic bug (the tool
        is exposed and allowed in production), but it breaks the scenario's
        preconditions. `f6ce05a22` gives scenario P room (more batches) instead of
        looser checks; R1–R4/R7 unchanged; **R10 (WARN-only) lists every forbidden
        ctx_reduce** so the rate stays observable
        (`evidence-round28/c5-r2-r4-r7-model-selfdrop.md`).
    - **T3 — 待用户确认 (pending user confirmation).** Since round 27, T3 is WARN
      (not FAIL) when the constraint is shadowed by the checkpoint and carried in
      `<unsummarized_tail>`, and the only other copy is the real model's own
      live-tail text restating it. Seen as WARN on 41832529681 and 41839150646.
      Whether this WARN classification is acceptable, or T3 should FAIL there, is
      the user's call; the check is unchanged until then.
    - **DSH 0.2.2-alpha.3 compatibility (round 28 evaluation; declared in round
      29 — user approved 2026-11-04 23:25 CST, see limitation 24).** The rows
      below are the round 28 findings; the two marked "resolved in round 29"
      changed with the declaration.

      | item | alpha.3 | evidence | disposition |
      |---|---|---|---|
      | thin preset no-write include | broke: loader 1.0.7 persists via `EntryTree.commit(change)`, would write `disabled: true` into the shipped stock preset | `046402042` RED (real alpha.3 packages: stock changed) | fixed `bdeb8bfa0` (override `commit` too; rc.5 still `write`), preset-include 4/4 on both package sets |
      | plugin manager install / boot | rejects the bundle: peers pin 0.2.1-rc.5 exactly | install 41840694149 failure | **resolved in round 29** (`5d8d4f58e`): peers `0.2.1-rc.5 \|\| 0.2.2-alpha.3`, accepted with no exemption (install 41859553540, e2e 41859567651 / 41859577345) |
      | doctor | exact-version pin FAILed (only that line) | 41841943616 A0 WARN `doctorPin=1` | **resolved in round 29**: `[ok] DSH version` on alpha.3 (41859553540 steps b/c, e2e U6 PASS strict) |
      | install → upgrade → disable → roll back | PASS | 41841943616 A1–A4 PASS | — |
      | real-model e2e (135 judged) | 132–133 PASS, **1 FAIL each (Y2)**, I1/I2/R10 PASS | 41842392546, 41842397847 vs rc.5 41839150646 / 41842386831 | Y2 已复现 2/2 on alpha.3, 0 on rc.5: the first step's busy probe catches the new process's own fresh lease 4 ms after it took over the dead one; takeover, noop passes, nothing left behind all correct. Check timing assumption; not relaxed — pending user. Every other check matches rc.5 (T3 PASS/WARN and E2 WARN vary on both) |
      | other e2e checks | same as rc.5 | same runs | no new FAIL other than Y2 |
    - **28c e2e findings (no code change; checks not relaxed):** Y2 FAIL on
      alpha.3 2/2 (check timing: first-step busy probe sees the new process's own
      fresh lease), C3 FAIL once on rc.5 (peak at the last step), both in
      `evidence-round28/c6-28c-c3-y2.md`. Neither is an adapter fault on the
      evidence; both are listed for the user.
    - **Fixed this round (adapter):** open-lock crash residues (`bb86b923c`);
      re-own with ≥ 2 stale owners (`8ea0321a8`); silent catch in context plane
      (`952a3970a`); alpha.3 preset include (`bdeb8bfa0`); test flake
      `5b3ae0917`. One sentence each in the round 28 baseline block.
    - **Unchanged by decision:** 90 % backstop, native summary for child
      sessions, sandbox inheritance for subagents; `/compact` queueing not
      implemented.

24. **Round 29 (2026-11-04/05) — DSH 0.2.2-alpha.3 declared.**
    - **Declaration.** Every `@deepseek-ai/dsh-*` peer is
      `0.2.1-rc.5 || 0.2.2-alpha.3` (exact alternatives, no range; no
      `engines.dsh`, which would make DSH ignore the peers). DSH's plugin manager
      (`dsh-app-boot` `evaluatePluginCompatibility`, same code in both releases)
      accepts it on both runtimes and still rejects 0.2.2-rc.1 / 0.2.2-alpha.2 /
      0.2.2 (real packages, `evidence-round29/a2-*`). `doctor` / `setup` accept
      exactly `DSH_COMPAT_SUPPORTED_VERSIONS`; devDependencies, the lockfile and
      every default CI lane stay on 0.2.1-rc.5. `dsh-compat-declaration.test.ts`
      keeps env and peers identical.
    - **CI.** `scripts/e2e/dsh-declared.py` judges a package.json / tarball the
      same way. `dsh-ci` (input `dsh_version`) and `dsh-install` grant DSH's
      `allow-version --accept-risk` only for a package that does not declare the
      running DSH; ci-check U6 is strict on a declared DSH. On alpha.3 the OLD
      dsh.2 tarball (peers rc.5 only) still needs the exemption in
      install-accept steps a/d; A0 = PASS (none), WARN (only dsh.2 steps),
      **FAIL (a HEAD step needed one)**.
    - **Results.** install rc.5 A0–A4 PASS, alpha.3 A0 WARN (dsh.2 only) A1–A4
      PASS; e2e rc.5 133/0/2, alpha.3 131/2/2 (Y2, R11) and 133/1/1 (Y2); I1/I2/R10
      PASS on all three. Y2 pending the user (above). R11 once: the real model
      stopped after 2 of 8 reads right after the backstop deferral (model
      behaviour; fold-note wording contribution 待验证), check unchanged.
    - **Not verified:** DSH alpha.3 requires node ≥ 24.9.0 (`engines`); every
      alpha.3 run here used node 22 (待验证 on node 24). The contract gate
      (`compat-upgrade.test.ts`, `dsh-api.contract.ts`) still runs only against
      the lockfile's rc.5 packages; alpha.3 is covered by the e2e / install runs
      and the round 28b preset-include check, not by the type-level contracts.
    - **Release:** no tag; `package.json` is still `0.49.35-dsh.4`, whose tag
      (`dsh/0.49.35-dsh.4`) declares rc.5 only. Shipping the declaration needs
      dsh.5 (user approval).

## DSH-specific layer inventory (what cannot live in core, and why)

| module | why it is DSH-only |
|---|---|
| `compat/dsh-0.1/session.ts` | DSH event-log access (`snapshotEvents`/`eventAt` — `Session.events` was removed in 0.2), branded surface-replace CAS, `MessageSourceMap["magic-context"]` augmentation + legacy `kind:"plugin"` recognition, exclusive `TokenUsage` → prompt pressure |
| `compat/dsh-0.1/{compaction,prestep,tools,commands,typert,preset,liveness}.ts` | DSH service seams: compaction engine hook, pre-step chain, tool/command registries, Typert remote registry, cordis preset patching, liveness marker for core's migration guard |
| `compat/dsh-0.1/subagent.ts` + `agent/worker.ts` | DSH subagent activation (`startActivation`, caller delivery), delegated-policy pinning, tool allowlist on the child scope |
| `agent/transcript.ts` | maps the DSH event log/surface to core `RawMessage[]` + a recording transcript so core tagging/drops become surface-replace ops (DSH never lets a plugin rewrite messages in place) |
| `agent/coordinator.ts`, `agent/outbox.ts` | CAS + saga that applies those ops through DSH's surface transaction with crash-safe SQLite outbox; no core equivalent (OpenCode/Pi mutate the request array) |
| `agent/context-plane.ts`, `agent/knowledge-gate.ts`, `agent/system-guidance.ts`, `agent/auto-search.ts` | DSH "inject, don't rewrite" delivery of m0/m1 knowledge, guidance and the `<ctx-search-hint>`: appended to the **current** pre-step batch (never `agent.inject`, no next-step inbox copy) + watermark de-dup |
| `agent/historian*.ts`, `agent/recomp.ts`, `agent/dreamer.ts` | drive core historian/recomp/wrapup/dreamer with a DSH LLM client facade (OpenCode-SDK-shaped) and a transcript-backed raw-message provider |
| `agent/nudge.ts`, `agent/protection.ts` | ctx_reduce nudges (core tail-hygiene walk over the DSH transcript, delivered by inject) and the core token-floor protection window fed with DSH inputs |
| `settings/magic-settings.ts`, `host/remote.ts` (settings/updateSettings/context) | DSH Settings-page overlay (volatile `magic-host` config over jsonc) and the endpoints behind the settings section and the meter popover |
| `entries/meter.ts`, `host/meter.ts`, `host/context-details.ts` | MC composer meter: real TokenMeter under a renamed `magicContextPressure` projection + per-session details |
| `agent/tools.ts`, `agent/commands.ts` | register core `ctx_*` tools and `/ctx-*` commands in DSH registries |
| `host/*`, `entries/*`, `client/client.js`, `cordis.patch.yml` | cordis plugin entry points, storage bootstrap (shared SQLite, `harness='dsh'`), Typert remote + web client panel |
| `doctor/*` | `dsh-magic-context setup|doctor` CLI (preset generation, install/version/profile/DB checks) |

## Open compatibility points (as of DSH 0.2.1-rc.5 / core v0.49.35)

Resolved since the import (kept here so nobody re-opens them): the nudge
baseline now feeds core's real tail-hygiene walk with the DSH transcript
(U/T, turn deltas, `hasRecentReduce`, post-reduce grace — `agent/nudge.ts`);
the protection window is core's token floor (`agent/protection.ts`,
`protected_tokens`); the context-pressure key is pinned by
`token-meter-projection.contract.test.ts` and read as `magicContextPressure`
(MC meter) or `contextPressure` (stock meter), falling back to the event log;
the client requires `@deepseek-ai/dsh-client-store` (the nonexistent
`dsh-client-runtime` is gone) and renders on real rc.5.

1. **Model harness.** Core's `ModelHarness` is `opencode | pi | omp`. DSH
   reads the `opencode` blocks (`dreamer.opencode`, `historian.opencode`)
   because DSH model refs are `provider/model`. A first-class `dsh` harness
   block would need a core change.
2. **Worker tool allowlist.** DSH 0.2 dropped `toolFilter`/`persona` from
   `SubagentStartRequest`. The worker restricts tools from an `agent/created`
   listener matched on `header.origin === "subagent"` and
   `header.parentSession === parent`, and fails closed if it cannot.
   Exercised on real rc.5 in round 13 through the env-gated
   `ctx_worker_selftest` (`docs/dsh/e2e/evidence-round13/`): the child's
   request carries only `glob/grep/read`, `tools.get(name, child)` is
   undefined for `bash/write/edit/ctx_*` (the executor's `resolveExecution`
   path → `UNKNOWN_TOOL`), a 1.5 s timeout disposes the child (`turn/end
   aborted{parent}`), and the child writes no Magic rows. A forced call of a
   masked tool was not observed (the model never sees its schema). The worker
   is still not used by any production path. DSH's own
   `ChildComposition.toolFilter` (`applyChildComposition`) may be the cleaner
   route.
**Upstream v0.49.35 (checked in round 15, static; merged in round 16 with
`git merge --no-ff`, no conflicts, no tag pushed).** 42 commits, no migration / schema-fence / storage-db
change. Of the 89 core modules the DSH layer imports, 7 changed, all
backward-compatible: `features/magic-context/search` (optional
`autoSearchDiagnostics`), `hooks/magic-context/apply-operations` (new
`prepareAgedToolSkeletonConversions` only), `compartment-runner-validation`
(issue 774: compartment text keeps only commit hashes present in its own raw
lines — safe because DSH builds the chunk with core `readSessionChunk`, which
now fills `commitHashes`, and `rawCommitHashes` scans any part shape; a DSH
path that built validation chunks by hand would silently lose every hash),
`event-resolvers` (proven input floor read path, internal),
`read-session-chunk` (optional `workerSource` /
`readMessageIdOrdinalsForRangeOffThread` on `RawMessageProvider`, consumed
only by core's ctx-expand tools, which DSH does not use — DSH's own
`ctx_expand` stays on the serving thread), `read-session-formatting` (optional
`commitHashes`), `tools/ctx-expand/render` (optional `attachments` argument;
`file` and `image` parts now render an attachment notice instead of
`[file]` / `[image]`). Re-run this check against the newest tag at the next
bump.

v0.49.35 features **not wired into DSH** (round 16): the OpenCode 2 idle host
fold (#632) and failed-step overflow recovery (#827) are OpenCode-2-only; the
subagent tool-skeleton retirement (#643) acts on subagent sessions, which DSH
keeps out of Magic entirely (reduced mode not ported, see Round 16 fixes);
the proven-floor-on-reload fix (#826) reaches DSH only through the internal
read path of core `event-resolvers` (DSH keeps its own threshold; not
separately verified on DSH); auto-search
diagnostics (#773) are an optional field DSH does not log. v0.49.35 has no
"proactive card" feature (checked against `.cortexkit/release-notes/v0.49.35.md`
and the 42 commits), so there was nothing of that name to wire.

3. **Removed upstream, removed here:** `/ctx-aug` (sidekick),
   `/ctx-session-upgrade`, `runManagedUpgrade`, `runMigration`. `/ctx-recomp
   --upgrade` answers with the core deprecation text.
4. **Dreamer facade is "hidden".** The DSH dream client sets
   `backgroundSessionsAreHidden: true`; without it core 0.49 skips every
   non-host-only scheduled task ("no ordinary parent session").
