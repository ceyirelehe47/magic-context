# dsh-magic-context release notes

Downstream releases of `ceyirelehe47/magic-context` branch `dsh-integration`
(Magic Context core unchanged from the upstream tag + the DeepSeek Harness
adapter layer). Version `<upstream>-dsh.N`, git tag `dsh/<upstream>-dsh.N`
(never `v*`). Not published to npm; install from a tarball built at the tag
(`bun pm pack` in `packages/dsh-plugin`, as `dsh-install.yml` does).
Full detail per round: `docs/DSH-MAINTENANCE.md` and `docs/dsh/e2e/evidence-round*`.

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
