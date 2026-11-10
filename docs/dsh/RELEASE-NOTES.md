# dsh-magic-context release notes

Downstream releases of `ceyirelehe47/magic-context` branch `dsh-integration`
(Magic Context core unchanged from the upstream tag + the DeepSeek Harness
adapter layer). Version `<upstream>-dsh.N`, git tag `dsh/<upstream>-dsh.N`
(never `v*`). Not published to npm; install from a tarball built at the tag
(`bun pm pack` in `packages/dsh-plugin`, as `dsh-install.yml` does).
Full detail per round: `docs/DSH-MAINTENANCE.md` and `docs/dsh/e2e/evidence-round*`.

## 0.49.35-dsh.8 — 待发 (pending, rounds 34–36; no tag)

Not tagged, not released. Core: upstream v0.49.35, unchanged. DSH declared (unchanged):
`0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1`.

- **B6 fixed (option a, user-approved 2026-11-06 00:09 CST):** the four OPTIONAL peers
  `@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-ui-slots` and `react` (and their `peerDependenciesMeta` entries) are no
  longer declared. npm resolved the absent `dsh-client-ui-primitives` to 0.2.2-rc.1, whose cordis peer
  conflicted with the tree next to DSH rc.5 / alpha.3 (ERESOLVE). This narrows the declaration only:
  every required DSH / cordis peer is unchanged, no DSH version is added. The client bundle does not
  resolve them through Node (`react` comes from DSH's `__ModuleLoader__`, the connection service through
  `dsh.client.inject`). Acceptance: `dsh-install.yml` from `dsh/0.49.35-dsh.7`, A0–A8 PASS on rc.5
  42066064277 / alpha.3 42066083404 / rc.1 42066100857 — `npm install` of the tarball next to the
  npm-installed DSH now resolves on all three (A5). `react` 19.2.7 is a devDependency (tests only).
- **Round 35 fixes (adapter only, core unchanged):** DSH no longer hangs at boot when the shared
  DB's open-lock path exists but cannot be read (a directory, a file without read permission, an I/O
  error) — it logs, waits at most the usual 120 s and opens without the lock; a stale open lock whose
  takeover mutex can never be taken is bounded the same way. `dsh-magic-context setup` keeps a
  symlinked profile `package.json` / `cordis.patch.yml` a symlink and updates the file it points to
  (it used to replace the link with a regular file). `migrate-legacy` rejects `--db` /
  `--storage-dir` / `--restore` without a value (exit 2) instead of falling back to the default
  storage DB. Acceptance at `7f3e6d451`: `dsh-install.yml` from `dsh/0.49.35-dsh.7`, A0–A8 PASS on
  rc.5 42070371822 / alpha.3 42070380440 / rc.1 42070387621; push CI 42069775942 (660 / 15 / 105).
- **Round 36 fix — fewer DeepSeek prompt-cache breaks after `ctx_reduce` (adapter only, core
  unchanged; user-approved 2026-11-06 12:07 CST):** drops the model queues with `ctx_reduce` (and the
  historian's compartment drops) used to be applied on every pre-step, so they landed one step at a time
  and each landing rewrote an already-sent message. They now wait for the same "reclaim ride" core uses
  (`reclaimRidePermitted`: historian publication, a DSH compaction / `/compact` / rewritten prefix, idle
  longer than `cache_ttl`, the force band, execute-band reclaim when no summary is coming) and land
  together in that one pass; `/ctx-flush` still applies at once, landed drops still replay every pass,
  and every queued drop lands at the latest on the force band (below DSH's 90 % backstop). Real rc.5
  cache-bench: plugin hit rate before the first compaction 94.4 % / 94.1 % with 0 prefix divergences
  (42164389768 / 42166613496) vs 90.0 % and 75 drop divergences before (42142782133); about $0.04 per
  bench run vs $0.16. Commits `d8c571377` (RED) / `8cc2c4220`; push CI 42163961834 (673 / 15 / 107);
  e2e 42164393979 132 / 2 / 1 (R0 / R7 provider 429 overload, E2 WARN). Detail:
  `docs/dsh/e2e/evidence-round36/c-drop-gate.md`.
- **Round 36 line G — experimental native roles, default OFF (adapter only, core unchanged):** setting
  `context.nativeRoles: true` (or env `MAGIC_CONTEXT_DSH_NATIVE_ROLES=1`) makes new sessions keep DSH's
  own message roles instead of folding tool calls into a Magic user message: only the single tool-result
  or user node is rewritten, assistant messages are never replaced, and each rewrite carries a token-meter
  price (the C3 meter drift is fixed for these sessions only). Existing sessions keep the fold view. With
  the switch off nothing changes. Real rc.5 cache-bench with the switch on (42214443375, 42215740858):
  94.3 % prompt-cache hit, 0 prefix breaks, about $0.027 per bench run vs $0.041 with the fold view
  (far fewer reasoning tokens). Not covered by e2e / soak yet. Commits `16e6fe2e8` / `8e095e315` /
  `5d19db4aa`; push CI 42215396157. Detail: `docs/dsh/e2e/evidence-round36/g-native-roles.md`.
- **Round 37 — native roles are the default for NEW sessions (I3 fix; adapter only, core unchanged):**
  the fold view rewrote every finished tool step (including the one just completed) into a user message
  without the assistant tool calls, tool results and reasoning; on the real 1M opencode-go route the model
  then re-derived its state at every step (reasoning median 10 704 vs 120 tokens per request, every fold
  turn timed out). A session Magic has not worked on yet now keeps DSH's roles, tool-call pairing and
  reasoning by default. Sessions Magic already processed stay on the fold view (no migration, no mixing)
  and keep the old behaviour; start a new session to get the fix. Opt-out for new sessions:
  `context.nativeRoles: false` / `MAGIC_CONTEXT_DSH_NATIVE_ROLES=0`. Not covered by e2e / soak yet.
  Commits `81a441e96` (RED) / `b3310120c`. Detail: `docs/dsh/e2e/evidence-round37/i3-native-default.md`.
- **Round 37 phase 2 (adapter + bench only, core unchanged; user request 2026-11-07 16:53 CST):**
  (1) **I4** — after a historian publication the new `<session-history>` baseline now replaces the live one
  in place (m0 and m1 stay two messages, cache split kept; resume and repeated pre-steps write nothing; a
  crash between publication and baseline update keeps the raw history visible); before, every publication
  appended another full baseline to the request. Verified offline (K1–K7, CI 42358893700); **not yet seen in a
  real publication** (the 200k test route returned 429 twice). (2) `ctx_expand` after a real native drop now
  returns the original stored output instead of the drop marker. (3) The native backstop logs what it did on
  every step (executed / skipped with reason / deferred / failed, plus predicted vs measured size); real runs
  so far only show the skipped classes. (4) Cold-process resume of an unfinished tool call checked for native
  sessions; legacy fold sessions keep their known behaviour (limitation 1, not changed by decision).
  (5) Bench only: evo-bench now runs DSH in an isolated namespace with an environment allowlist and checks
  the boundary with an access probe before every paid run; pre-isolation results keep their caveat and are
  not directly comparable. Commits `edb79efbf`…`b36e0d104`. Detail:
  `docs/dsh/e2e/evidence-round37/phase2-i4-isolation-integration.md`.
- **Round 37 phase 2 follow-up — native compaction summary no longer sent twice (adapter only, core
  unchanged; user-approved 2026-11-09 19:37 CST):** after DSH's native backstop compaction, the compaction
  summary used to stay in every later request next to Magic's `<session-history>` baseline that already
  contains the same summaries (a real 200k run: 182 of 419 requests, about 30 KB each). In new (native-roles)
  sessions the compaction summary is now retired in the same step once the live baseline covers its whole
  range; a summary that still carries history not yet summarized by Magic stays until it is covered. Older
  fold sessions keep the previous behaviour. Covered by offline tests and confirmed in a real 10-turn run
  (42729564554): the compaction summary was retired at the first publication that covered it, and requests
  carrying both fell from 182 of 419 to 95 of 306. Also found, not fixed: Magic writes tool results that DSH's
  tool-result pruner shortened back to full length, which can make the DSH model adapter send a tiny
  output limit (one request in that run got `max_completion_tokens: 1`; fixed in segment 11, below). Commits `f7f3fb4c3` (RED),
  `e67beb9a0` (fix), `06c802d28` (RED for the open issue). Detail:
  `docs/dsh/e2e/evidence-round37/phase2-i4-isolation-integration.md` §7.
- **Round 37 phase 2 segment 9 — nothing hidden after a compaction, and the historian keeps up inside long
  turns (adapter only, core unchanged; user instruction 2026-11-10 10:35 CST):** (1) when DSH's native
  compaction folded away messages that Magic had not summarized yet, the compaction summary listed only those
  with text; tool steps without text (a file read, a command) vanished from the model's view until the next
  Magic summary (a real 10-turn run: four messages, for 89 requests). Every such message is now listed in the
  summary's "not yet summarized" section (tool name, arguments, result size; the full output stays available
  through `ctx_expand`). (2) Inside a long task without new user messages the background historian often ran but
  did nothing, silently: it waited for five user messages of distance. It now uses the same size-based boundary
  as the Pi integration (it summarizes up to the message being answered) and logs why when a run has nothing to
  do. Expect Magic summaries to update more often during long tasks. Real 10-turn run 42805322951: the
  historian now runs inside long tasks (24 requests vs 12) and Magic summaries update more often (22 vs 12; each
  update is one prompt-cache break, historian cost $0.21 vs $0.06); after each of 3 compactions nothing was
  hidden and the compaction summary left the request at once. The new listing of tool steps was not needed in
  that run (verified offline only). Commits `3e9271ab1` (RED), `f73973a2a`. Detail:
  `docs/dsh/e2e/evidence-round37/phase2-i4-isolation-integration.md` §7.6–§7.7.
- **Round 37 segment 11 — Magic no longer undoes DSH's tool-result pruning (adapter only, core unchanged;
  user instruction 2026-11-10 20:37 CST):** near a full context window DSH shortens very long tool outputs
  (keeps the start and the end); in new (native-roles) sessions Magic used to write the full output back on the
  next step, so the request grew again, the pruning was wasted and old parts of the prompt were rewritten every
  step. With the DSH model adapter's size estimate, that is what made one request in a real run go out with an
  output limit of 1 token. Magic now keeps DSH's shortened version (it still numbers it and can still drop it);
  the full output stays available to Magic's summaries and through `ctx_expand`. Older fold sessions are
  unchanged. Not fixed here: the DSH model adapter estimates the prompt about 7 % too large near a full window
  (it never uses the real token counts of earlier responses), so long sessions can still get an output limit
  below the configured one (in the same runs, re-estimated: lowest about 8–10k instead of 1). Also: the
  debug-only "historian noop" line now prints once per reason instead of on every step. Verified offline only
  (a real run is still to do). Commits `a1f1f55e4` (RED), `51d0e90bb`. Detail:
  `docs/dsh/e2e/evidence-round37/phase2-i4-isolation-integration.md` §7.8.
- **Round 36 line H — `ctx_reduce` reminder in native-roles sessions (adapter only, core unchanged;
  user-approved 2026-11-06 20:43 CST):** with the switch on, the reminder that asks the model to drop
  spent tool outputs never fired, because the measurement only counted the tool-call arguments, not the
  outputs. It now counts them (paired with their call, as in Pi), so the reminder fires at the same point
  as with the fold view; sessions with the switch off are unchanged. Real rc.5 cache-bench with the switch
  on (42221195453): reminder and `ctx_reduce` in every run, 94.5 % prompt-cache hit, 0 prefix breaks before
  the first compaction, and after it the dropped outputs leave together with the historian's rewrite
  (prompt about ⅓ the size). Commits `efa9c4aab` / `3f1d66f68` / `b65acb3f9`; push CI 42221751881
  (692 / 15 / 109). Detail: `docs/dsh/e2e/evidence-round36/h-native-nudge.md`.
- Known (unchanged by dsh.8): `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-subagent` are loaded
  from DSH's own tree without being declared (works with npm and pnpm's default hoisting; not with a
  strict non-hoisting layout).
- CI / test layer only: duplicate ci-check ids renamed (judgement unchanged; old→new table in
  `docs/DSH-MAINTENANCE.md`); `dsh-soak.yml` unfrozen with `dsh_version` / `node_version` inputs
  (defaults unchanged; running it still needs the user's approval).

## 0.49.35-dsh.7 (tag `dsh/0.49.35-dsh.7`, rounds 31–33, 2026-11-06)

Version prepared in `packages/dsh-plugin/package.json` (commit `e80118969`, revert it alone to drop
the bump). Product code = `c096b8a68` (no adapter / core source change after it). Core: upstream
v0.49.35, unchanged. DSH declared (unchanged since dsh.6): `0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1`.
Release-candidate acceptance: `docs/dsh/e2e/evidence-round33/a-release-candidate.md` (packed tarball,
dsh.6 ⇄ dsh.7 install / upgrade / disable / rollback A0–A4 PASS on rc.5 · alpha.3 · rc.1; real e2e on
this code: rc.5 133/0/2, alpha.3 134/0/1, rc.1 134/0/1).

- **cordis peers** follow the declared DSH (`~4.0.5 || 4.0.6-alpha.2 || ~4.1.0`,
  `~1.0.10 || 1.0.11-alpha.2 || ~1.1.0`): `npm install` of the tarball next to DSH **0.2.2-rc.1**
  resolves (dsh.6: ERESOLVE). **Not fixed for rc.5 / alpha.3** (round 33): npm still fails ERESOLVE
  there because it resolves the plugin's ABSENT optional peer `@deepseek-ai/dsh-client-ui-primitives`
  to 0.2.2-rc.1, whose cordis peer `~4.1.0` conflicts (same for dsh.6). The documented install
  path (`dsh plugin add`, pnpm) is unaffected on all three DSH versions. **Known issue in dsh.7**
  (user released dsh.7 with B6 open, 2026-11-06): install with `dsh plugin add`; a plain `npm install`
  next to rc.5 / alpha.3 is not supported in this release.
- **`dsh-magic-context` bin through a symlink** (npm / bun `.bin`, global bin) runs under node
  instead of exiting silently.
- **ctx_expand** no longer shows Magic's own injected `<session-history>` / `<project-memory>` / `<project-docs>` /
  `<ctx-search-hint>` text as user messages (ordinals unchanged).
- CI: push job `contracts-dsh` checks typecheck:dsh + contracts:dsh against alpha.3 and rc.1.
- **Forward compatibility with DSH master (round 32, no new DSH declared):** the Magic worker's
  subagent activation spec carries its task both nested (`request`, what every declared DSH reads)
  and flattened (`parent` / `prompt` / `maxDepth`, what deepseek-harness master after 0.2.2-rc.1
  reads); with the old spec master's `startActivation` threw. The worker has no production
  caller yet (env-gated self-test only), so no released path changes behaviour.
- CI: manual evaluation lane `dsh-ref-eval.yml` (released DSH + selected packages built from a
  deepseek-harness git ref; evaluation only, not a support claim).
- CI (round 33): `dsh-install.yml` packs the dispatched ref's HEAD, upgrades from / rolls back to
  input `old_ref`, inspects the tarball (`npm pack` + `bun pm pack`), and adds the npm path (B2 /
  bin symlink) and a ctx_expand probe, each with the old tarball as control; CI false positives
  closed (contracts-dsh overlay without pipefail, A4 schema WARN, vacuous checks; `wf-lint.py`
  gates the dsh-*.yml); summaries name the installed DSH, node and SHA. CI audit: 15 findings
  (`evidence-round33/a-ci-audit.md`) — 已修复: contracts-dsh overlay pipefail, installed-DSH asserts
  and report fields, stale local bootstrap, overlay-dsh-ref skip, A4 schema WARN, vacuous A0 / A8, and
  (integration) ci-check.py's 10 vacuous PASS rows on empty input; dsh-soak.yml findings left as is
  (frozen). **Test / CI layer only — no change to the shipped plugin.**
- e2e checker (round 33, **test / CI layer only — no change to the shipped plugin**):
  - **R14** judges the second native compaction's fold structurally (`shadowedSeqs` of a
    `compaction/summary` + text not on the raw surface outside summary nodes) instead of "text absent
    from the surface"; a checkpoint that restates a checksum no longer fails the non-vacuity guard,
    and four sub-conditions are stricter (`evidence-round33/b-r14.md`).
  - **Y2** accepts a busy first-step probe only for the restarted process's own fresh lease (pid,
    holder, write time after the kill, recorded y-2 run); any lease attributable to the killed process
    still fails (`evidence-round33/b-p2a.md`).
  - **ci-check.py on missing data**: S3, S5, R5, R8, R10 (scenario P), R15, DN1, I1, I2 and P1 FAIL
    when the data they judge is missing instead of passing vacuously; no other assertion changed, WARN
    stays WARN.
  - The three checker unit suites (R14, Y2, empty input; 30 cases) gate the push `checks` job.

## 0.49.35-dsh.6 (tag `dsh/0.49.35-dsh.6`, round 31, 2026-11-05)

- Core: upstream **v0.49.35**, unchanged.
- DSH: declared (peers, exact alternatives) **`0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1`**.
  Default / lockfile / devDependencies: 0.2.1-rc.5. Anything else (0.2.2-rc.2, alpha.2,
  alpha.4, 0.2.2) is refused by DSH's plugin manager and by `doctor` / `setup`.
  DSH 0.2.2-alpha.3 and 0.2.2-rc.1 require node ≥ 24.9.0.
- Contains every change after dsh.5 (`9206770c3`) through round 30 (`d2d7c196c`);
  the release commit only bumps the version and moves these notes.

Changes since dsh.5 (round 30, adapter / CI / test / docs only, no core change):

- **DSH 0.2.2-rc.1 declared** (npm `next`; byte-identical to alpha.3 in all 89
  `@deepseek-ai/dsh-*` packages apart from version strings). Real app-boot on rc.5,
  alpha.3 and rc.1 accepts the manifest. Verified with no exemption on node 24:
  install A0 WARN (old dsh.2 only) A1–A4 PASS, e2e 133/0/2 and 134/0/1.
- **CI node 24 lane**: every DSH other than 0.2.1-rc.5 runs on node 24 (install and
  e2e); rc.5 stays on node 22.
- **e2e scenario Y on node ≥ 24**: the harness finds the DSH process by
  `/proc/<pid>/exe` (node 24 names its main thread `MainThread`), so Y1 really kills
  it again. Assertions unchanged.
- **doctor** closes its shared-DB check through core `closeDatabase()` instead of
  `db.close()`, so no closed handle stays in core's per-path cache (test isolation;
  doctor is CLI-only).

Known open items: Y2 on alpha.3 (check timing, pending the user), T3 WARN wording
(pending the user), C3 on rc.5 (intermittent, see round 31), /compact queueing not
implemented, cordis peer range vs rc.1's cordis 4.1.0 (see round 31).

## 0.49.35-dsh.5 (tag `dsh/0.49.35-dsh.5`, round 30, 2026-11-05)

- Core: upstream **v0.49.35**, unchanged.
- DSH: declared (peers, exact alternatives) **`0.2.1-rc.5 || 0.2.2-alpha.3`**.
  Default / lockfile / devDependencies: 0.2.1-rc.5. Any other DSH (e.g.
  0.2.2-rc.1) is refused by DSH's plugin manager and by `doctor`. DSH 0.2.2-alpha.3
  itself requires node ≥ 24.9.0.
- Contains every change after dsh.4 (`16c1d48e4`) through round 29 (`2d7130339`);
  the release commit only bumps the version and adds these notes.

Fixes and features since dsh.4 (rounds 26–29, adapter / CI / docs only, no core change):

- **`dsh-magic-context migrate-legacy`** (round 26/27): read-only scan + `--apply`
  / `--restore` for legacy data (raw-path orphan memories, injected FTS rows,
  polluted compartments); backups never collide; bun 1.4.2 open-flags fix; a stale
  plan (concurrent `--apply`) is refused.
- **/compact unsummarized tail** (round 26): when the mini-historian leaves
  `<unprocessed_from>` inside the region, the checkpoint summary carries the
  uncovered tail; one `historian_runs` row per /compact attempt.
- **Y4 tool-tag drift** (round 26/27b): tool tags of an unreplaced session-tail fold
  keep their number when the next user message absorbs them, including re-own to a
  synthetic owner of the current turn and ≥ 2 stale synthetic owners (round 28).
- **Open lock** (rounds 27/28): two takeover races fixed (only one process can hold
  the first-open lock); crash residues (`createExclusive` temps, `.take` files) are
  swept at acquire.
- **Folded tool activity v2** (rounds 27/28): folded tool arcs render as one
  past-tense prose note naming each call and its target (no callable syntax); the
  real model did not imitate it in the e2e I1 check (0 of 5 round-28 runs; I1 PASS on every round-28c/29 run).
- **doctor** warns when Magic is disabled in every preset (round 27).
- **Diagnostics**: auto-embed deferral is reported after 10 deferred pre-steps
  (round 27b); context-plane historian trigger / pressure persistence log once per
  distinct error instead of failing silently (round 28); unsummarized tail is linear
  (30 000 messages 4.1 s → 0.16 s).
- **DSH 0.2.2-alpha.3** (rounds 28b/29): thin preset include also overrides
  `commit()` (cordis-plugin-loader 1.0.7); peers declare `0.2.1-rc.5 || 0.2.2-alpha.3`
  (user-approved 2026-11-04 23:25 CST); `doctor` / `setup` accept exactly those.
- CI: `dsh-install.yml` (pack → install → upgrade → disable → roll back), `dsh-soak.yml`,
  `dsh_version` / `slot` inputs, `dsh-declared.py` (no exemption on a declared DSH).

Known open items (unchanged by this release): Y2 on alpha.3 (check timing, pending
the user), T3 WARN wording (pending the user), C3 on rc.5 (待验证), /compact
queueing not implemented, node ≥ 24.9 on alpha.3 not yet exercised in CI.

## 0.49.35-dsh.4 (tag `dsh/0.49.35-dsh.4` → `16c1d48e4`, round 25)

Same code as dsh.3 (`40c5013a5`) with the package version bumped (dsh.3 shipped
with `0.49.35-dsh.2` in package.json). Rounds 21–25 fixes. DSH 0.2.1-rc.5 only.

## 0.49.35-dsh.2 (tag `dsh/0.49.35-dsh.2` → `7848c0430`, round 21) and 0.49.35-dsh.1 (`270629e75`, round 19)

See `docs/DSH-MAINTENANCE.md` rounds 19–21.
