# Round 33 A — P0: dsh.7 release-candidate verification

No tag, no GitHub release, no npm publish. No keys in this directory (npm logs: runner paths
replaced by `<path>`). Times CST, 2026-11-05.

## What is being released

- Product code = **`c096b8a68`** (round 32). `git diff c096b8a68..HEAD -- packages/dsh-plugin/src
  packages/plugin/src packages/adapter-api/src` is empty: rounds 32 docs / 33 changed CI, scripts,
  checker and docs only.
- The three tag-after fixes are ancestors of HEAD: B2 `8d8a513e2` (cordis peers), B4 `e443057d6`
  (bin realpath), B5 `4a29a6bf5` (ctx_expand without injected text); also `c096b8a68` (worker spec).
- Version **`0.49.35-dsh.7`** prepared in its own commit **`e80118969`** (`packages/dsh-plugin/package.json`
  + the `bun.lock` workspace line; nothing else). RELEASE-NOTES: section "0.49.35-dsh.7 — 待发 /
  pending" (docs commit of this round).

## How it was verified (CI, `dsh-install.yml` extended this round)

`dsh-install.yml` now packs the **dispatched ref's HEAD** (never a tag) and, with `old_ref`, the
release it upgrades from / rolls back to. Dispatched with `old_ref=dsh/0.49.35-dsh.6`, i.e. the
real dsh.6 → dsh.7 upgrade and the dsh.7 → dsh.6 rollback. No `--force`, no `--legacy-peer-deps`,
no skipped step; the mock model only (no secrets).

1. **pack** (clean runner, node 22, bun 1.4.2): filtered workspace install → `bun run build` →
   `bun pm pack` (the release artifact) **and** `npm pack`, then `scripts/ci/tarball-inspect.py`
   judges the HEAD tarball against `packages/dsh-plugin/package.json` (gating).
2. **accept** (clean runner, DSH from npm only, node 22 for rc.5 / node 24 for alpha.3 and rc.1;
   installed DSH asserted equal to the input):
   - `install-accept.sh` — documented path `dsh plugin --profile headless add <tgz>` (pnpm):
     a install dsh.6 → setup → doctor → real `dsh` headless turn (ctx_memory write) ·
     b upgrade to HEAD in place → setup → doctor → `--version` (direct `node dist/cli.js` and the
     profile's pnpm `.bin` shim) → same session turn with **ctx_expand(1, 60)** ·
     c `setup --disable-preset root` → turn · d roll back to dsh.6 → turn with ctx_expand (control).
   - `npm-bin-accept.sh` — `npm install <tgz>` next to the npm-installed DSH (B2) and in an empty
     project; the CLI through **npm's `.bin` symlink** four ways (exec the link, `node <link>`,
     `node dist/cli.js`, `npx`) + doctor output (B4). Same for dsh.6 as control.
   - `install-accept-check.py` — A0–A4 (install / upgrade / disable / rollback), A5 (B2), A6 (B4),
     A7 (B5), A8 (pnpm shim); C5–C7 controls on dsh.6.

## Tarball (HEAD `89dbfe543`, `a-tarball-head-inspect.md`; dsh.6 `3988121a9`, `a-tarball-old-dsh6-inspect.md`)

| field | HEAD (dsh.7 candidate) |
|---|---|
| files | 381 (dsh.6: 377); top level `LICENSE NOTICE README.md README.zh.md cordis.patch.yml dist package.json src types`; 95 `*.test.ts` under `src/` ship because `files` lists `src` (unchanged since dsh.1) |
| name / version | `dsh-magic-context` / `0.49.35-dsh.7` |
| bin | `{"dsh-magic-context": "dist/cli.js"}`; `dist/cli.js` 1 261 059 B, mode 0755, first line `#!/usr/bin/env node` |
| dependencies | `ai-tokenizer ^1.0.6` |
| peerDependencies | dsh-session / agent / compaction / compaction-basic / llm / token-meter `0.2.1-rc.5 \|\| 0.2.2-alpha.3 \|\| 0.2.2-rc.1`; cordis `~4.0.5 \|\| 4.0.6-alpha.2 \|\| ~4.1.0`; cordis-plugin-include `~1.0.10 \|\| 1.0.11-alpha.2 \|\| ~1.1.0`; optional: client-connection / client-ui-primitives / client-ui-slots (same three DSH versions), react `^18.2.0` |
| manifest vs source | name, version, main, types, bin, dependencies, peers, peerDependenciesMeta, exports identical to the source package.json; no `workspace:` spec in shipped deps (bun rewrites the devDependency; `npm pack` keeps `workspace:*` in devDependencies only) |
| entry files | all 14 files named by main / types / bin / exports / `dsh.bundle.patch` present |
| bun pm pack vs npm pack | identical file lists (381 / 381) |
| static B4 / B5 probes | presence only — dsh.6 matches them too, so they decide nothing (runtime A6 / A7 do) |

## Runs

| run id | DSH | node | OLD | result | notes |
|---|---|---|---|---|---|
| 42050286656 | 0.2.1-rc.5 | 22.23.4 | dsh.6 | failure: A0–A4 PASS, A5 / A6 FAIL | first pass of the new lane; A6 was masked by A5 (fixed by the empty-project probe) |
| 42050293048 | 0.2.2-alpha.3 | 24.22.1 | dsh.6 | failure: A0–A4 PASS, A5 / A6 FAIL | same |
| 42050299481 | 0.2.2-rc.1 | 24.22.1 | dsh.6 | failure: checker crash (`doctorLines '23\n0'`, harness bug), all A rows otherwise green | harness fixed `89dbfe543`; this run also exposed audit finding 9 (A4 schema) |
| **42051595084** | **0.2.1-rc.5** | **22.23.4** | dsh.6 | **failure: A0–A4, A6, A7, A8 PASS; A5 FAIL**; C5 PASS, C6 WARN, C7 PASS | `a-install-rc5-42051595084.md` |
| **42051600910** | **0.2.2-alpha.3** | **24.22.2** | dsh.6 | **failure: A0–A4, A6, A7, A8 PASS; A5 FAIL**; C5 PASS, C6 WARN, C7 PASS | `a-install-alpha3-42051600910.md` |
| **42051607781** | **0.2.2-rc.1** | **24.22.1** | dsh.6 | **success: A0–A8 PASS**; C5 PASS, C6 WARN, C7 PASS | `a-install-rc1-42051607781.md` |

All at `89dbfe543` (product code `c096b8a68`, version dsh.7). Every run's summary names `DSH version
(installed)` = the requested version, node, npm (10.9.9 / 11.19.1), pnpm 12.16.1 and both tarball SHAs.

## The three fixes

| fix | rc.5 (node 22) | alpha.3 (node 24) | rc.1 (node 24) | control (dsh.6) | status |
|---|---|---|---|---|---|
| **B2** cordis peer — `npm install <tgz>` next to the npm-installed DSH | **FAIL** (ERESOLVE) | **FAIL** (ERESOLVE) | PASS | dsh.6 ERESOLVE on all three (C5 PASS) | cordis part fixed (rc.1 now resolves where dsh.6 did not); **npm path still broken on rc.5 / alpha.3 by a different peer → new finding B6** |
| **B4** bin through npm's `.bin` symlink (exec / `node <link>` / `node dist/cli.js` / npx, doctor prints) | PASS | PASS | PASS | npm cannot install dsh.6 at all (C6 WARN); control done locally on the same CI tarballs: dsh.6 `node <link> --version` prints **nothing** (rc 0), dsh.7 prints `0.49.35-dsh.7` (`a-b4-symlink-control-local.txt`, node 22.23.3) | 已复现 (round 31) → fix confirmed in the packed tarball |
| **B5** ctx_expand in the packed tarball: the user's text shown, no Magic-injected text | PASS (expandUser 1, injected 0) | PASS | PASS | dsh.6 at step d, same session: `[1-4] U: <project-docs> <file name="ARCHITECTURE.md"> …` (injected 1, C7 PASS) | 已复现 → fix confirmed in the packed tarball |
| pnpm `.bin` shim (A8) and direct `node dist/cli.js` (A2) | PASS | PASS | PASS | — | — |
| install → upgrade → disable → rollback (A0–A4), dsh.6 ⇄ dsh.7 | PASS | PASS | PASS | — | rollback reads the upgraded DB (integrity ok, rows kept); no exemption anywhere (A0) |

### B6 (new, 已复现, adapter manifest; not fixed): npm ERESOLVE through an absent optional peer

`a-npm-eresolve-rc5-head.txt`, `a-npm-eresolve-alpha3-head.txt` (npm 10.9.9 / 11.19.1):

    Could not resolve dependency: dsh-magic-context@"file:../tgz/head.tgz" from the root project
    Conflicting peer dependency: @deepseek-ai/cordis@4.1.0
      peer @deepseek-ai/cordis@"~4.1.0" from @deepseek-ai/dsh-client-ui-primitives@0.2.2-rc.1
        peerOptional @deepseek-ai/dsh-client-ui-primitives@"0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1" from dsh-magic-context@0.49.35-dsh.7

- `@deepseek-ai/dsh-client-ui-primitives` is not in the DSH tree (not a dependency of
  `@deepseek-ai/dsh@0.2.2-alpha.3`, `npm view`). npm still resolves the plugin's optional peer range to
  its highest version, 0.2.2-rc.1, and that package's peer `cordis ~4.1.0` conflicts with the tree's
  cordis 4.0.5 (rc.5) / 4.0.6-alpha.2 (alpha.3). On rc.1 the highest version is the installed one, so
  it resolves. dsh.6 fails the same way (C5); since the optional client peers gained a newer
  alternative (alpha.3 in dsh.5, rc.1 in dsh.6) the npm path next to an older DSH is likely broken
  (dsh.5 on rc.5 not tested — 静态推断).
- **Experiment X5** (in the same runs, informational, not shipped): the HEAD tarball with its four
  optional peers (client-connection, client-ui-primitives, client-ui-slots, react) removed installs
  with npm next to rc.5 **and** alpha.3 (npmRc 0, no ERESOLVE) and its bin prints the version.
- Reach: the documented install path (`dsh plugin add`, pnpm, what DSH's plugin manager uses) is
  unaffected (A0–A4 PASS everywhere). Users who `npm install` the tarball next to DSH rc.5 / alpha.3
  get ERESOLVE; the round-31 release-note claim "npm install next to alpha.3 no longer fails" was
  too broad and is corrected in RELEASE-NOTES.
- Not fixed here: changing the peer list is a manifest / support-contract decision (round
  constraints: no peer change without the user). Options: (a) drop the optional client peers (they
  serve the web client entry, which DSH's client already provides; X5 shows npm then resolves);
  (b) keep them and document `dsh plugin add` / pnpm as the only supported install path;
  (c) leave the release note as corrected and fix after dsh.7.

## Real e2e on the same product code (`c096b8a68`)

rc.5 42037652492 (node 22) **133 / 0 / 2**, rc.1 42034156577 (node 24) **134 / 0 / 1**, alpha.3
42051660209 (node 24.22.2, this round, slot a) **134 / 0 / 1** — WARNs: E2 (core RRF ranking with a
real embedding model, upstream) on all three, T3 on rc.5 (model restated the constraint). Details:
`a-compat-matrix.md`.

## dsh.7 candidate verdict

- **No blocker on the documented install path**: on rc.5 (node 22), alpha.3 and rc.1 (node 24) the
  packed dsh.7 tarball installs, upgrades from dsh.6 with data kept, disables, rolls back to dsh.6
  reading the same DB, and its CLI works directly, through pnpm's shim and through npm's symlink.
  B4 and B5 are confirmed in the packed artifact with working controls.
- **Open, needs a user decision before tagging:** B6 — `npm install` of the tarball next to DSH
  rc.5 / alpha.3 fails ERESOLVE (B2 therefore only fully holds on rc.1). If the npm path is part of
  what dsh.7 promises, it is a blocker for that promise (fix option (a) is proven by X5); if only
  `dsh plugin add` is promised, it is a documented known issue.

## Commits (A line, P0)

| SHA | what | why | risk |
|---|---|---|---|
| `093bf7b79` | dsh-install: HEAD pack from the dispatched ref, `old_ref`, npm pack + tarball-inspect, npm-bin lane, ctx_expand probe, A5–A8 / C5–C7, A1/A2/A4 compare with tarball versions | P0 acceptance at HEAD instead of a tag | new gating rows can turn the lane red (A5 does on rc.5 / alpha.3 — a real finding) |
| `e80118969` | version `0.49.35-dsh.7` (package.json + bun.lock line) | prepare the release; separate for easy revert | none functional; no tag |
| `89dbfe543` | harness fixes after the first runs (empty-project B4 probe, `<project-docs>` marker, doctor line count, A4 schema line, inspect tools for an old tag) + X5 experiment | first runs: A6 masked by A5, C7 blind to `<project-docs>`, checker crash | none (X5 never judged, never shipped) |
| `dfc649e0f` | A0 / A8 non-vacuous | an empty accept.jsonl read PASS on two rows | none |
