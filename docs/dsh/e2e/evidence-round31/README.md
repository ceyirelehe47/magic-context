# Round 31 evidence (2026-11-05) — dsh.6 released, scan + fix

No keys, tokens or account data in this directory (npm logs: paths replaced by `<npm-log>`).

## dsh.6

- Release commit `3988121a92e42c9b546c257d4134930f9768f2d4` (code = round 30 `d2d7c196c`
  + version `0.49.35-dsh.6` in `packages/dsh-plugin/package.json` and the `bun.lock`
  workspace line + RELEASE-NOTES section). Push CI 42004476390 green (633 / 15 / 105).
- Annotated tag `dsh/0.49.35-dsh.6`: object `521e38d5e2f504e7450ecba7fff17d3fe1416d91` →
  `3988121a9`. No GitHub release, no npm, no `v*` tag.
- The tag's own `dsh-install.yml` has the node 24 lane (`node-version: DSH_VERSION ==
  '0.2.1-rc.5' && '22' || '24'`). Install acceptance dispatched on ref `dsh/0.49.35-dsh.6`:
  rc.5 42004888402 A0–A4 PASS (node 22.23.4); alpha.3 42004900457 A0 WARN (old dsh.2
  steps a/d only) A1–A4 PASS (node 24.22.1); rc.1 42004912274 A0 WARN (same) A1–A4 PASS
  (node 24.22.2).

## Run table

| run id | kind | DSH | node | exemption | PASS / FAIL / WARN | FAIL classification | I1 | I2 | R10 (P / backstop) |
|---|---|---|---|---|---|---|---|---|---|
| 42004476390 | push checks @ `3988121a9` (dsh.6) | lockfile rc.5 | — | — | success 633/15/105 | — | | | |
| 42004888402 | install @ tag dsh.6 | rc.5 | 22.23.4 | none | A0–A4 PASS | — | | | |
| 42004900457 | install @ tag dsh.6 | alpha.3 | 24.22.1 | old dsh.2 a/d only | A0 WARN, A1–A4 PASS | — | | | |
| 42004912274 | install @ tag dsh.6 | rc.1 | 24.22.2 | old dsh.2 a/d only | A0 WARN, A1–A4 PASS | — | | | |
| 42006327584 | push @ `a587b6890` (cancelled by next push) | rc.5 + overlay alpha.3 / rc.1 | 24 | — | contracts-dsh failure (typecheck PASS) | overlay skipped DSH peers (dsh-scope); fixed `b26aa4aad` | | | |
| 42006585357 | push @ `e443057d6` | same | 24 | — | checks success 636/15/105; contracts-dsh failure (same) | same | | | |
| 42007145308 | push @ `b26aa4aad` | rc.5; alpha.3; rc.1 | — / 24 | — | success 639/15/105; contracts-dsh 105 + 105 | — | | | |
| 42007570885 | e2e r31r5a @ `b26aa4aad` | rc.5 | 22 | none | **133 / 0 / 2** (E2, R10-P) | — (C3 PASS) | PASS | PASS | WARN / PASS |
| 42007576307 | e2e r31rc1 @ `b26aa4aad` | rc.1 | 24 | none | 132 / 1 / 2 (E2, I1) | U14: ctx_expand carried m0 injected text (adapter, fixed `4a29a6bf5`); I1 WARN model behaviour | WARN | PASS | PASS / PASS |
| 42010507314 | push @ `4a29a6bf5` | rc.5; alpha.3; rc.1 | — / 24 | — | success **640/15/105**; contracts-dsh 105 + 105 | — | | | |
| 42010611777 | e2e r31r5b @ `4a29a6bf5` | rc.5 | 22 | none | **132 / 0 / 3** (E2, R10-P, T3) | — (C3 PASS, U14 PASS) | PASS | PASS | WARN / PASS |
| 42010617157 | e2e r31rc1b @ `4a29a6bf5` | rc.1 | 24 | none | **134 / 0 / 1** (E2) | — (C3, U14, Y1, Y2 PASS) | PASS | PASS | PASS / PASS |

rc.5 e2e ran one after the other (42007570885, then 42010611777); each rc.1 run in its own
slot in parallel. R10-P WARN = the model did not call ctx_reduce in scenario P (model
behaviour, WARN-only). U14 PASS on both runs at `4a29a6bf5`; whether the model's expand range
in those runs included the m0 ordinal was not checked (待验证 — the unit test covers it).

## B1 — rc.5 C3 (定性: scenario; the trigger figure is DSH's projection, not an adapter estimate error)

Artifacts of the four rc.5 runs since 28c (41842386831 FAIL, 41845836776 PASS,
41859559537 PASS, 41971926453 FAIL), `cmp-*.log` / `cmp-session.jsonl`.

Failing run 41971926453, turn cmp-03:

    step 1 end   usage prompt 19094 (47.7 %)   → two full `read` results join the surface
    pre-step 2   historian trigger pct=71 fires=true   (native pressure check pct=46.7)
                 Magic's pressure-truncation tier rewrites both reads in the same pre-step
                 ("truncated by Magic Context under context pressure: 13750 of 16884 characters
                 omitted …", surface seq 58–60)
    step 2 sent  prompt 18974 (47.4 %)
    pre-step 3   trigger pct=49

- The 71 % is `contextPressure.projectedTokens` from DSH's token-meter
  (`pressureTokens + surfaceTokens − sampledSurfaceTokens`, 4 chars/token): 19094 + the two
  untruncated reads ≈ 28 400. It is computed correctly from the surface as it was before
  the rewrite.
- The trigger runs AFTER the plan applied the truncation (`runContextPlaneStep`: plan →
  … → `maybeFireHistorian`), yet still read 71: DSH's meter does not reprice a surface
  `replace` that has no adjacent `compaction/summary|prune` shadow-price claim
  (`foldSurfaceProjection`: "A replacement without a claim preserves the previous total").
  Magic's replace is a plugin surface rewrite and carries no such claim, so until the next
  provider usage sample the projection still counts the untruncated reads. 归属: DSH 原生
  (token-meter pricing of claim-less replaces), surfacing through the adapter's choice to
  trigger on `projectedTokens`. 静态 (code) + 已复现 from the artifacts.
- The same spike happens in all four runs (cmp-03 pct 71 / 73 / 66 / 73, sent prompts
  stay ≈ 48–66 %). Whether C3 passes then depends on the model's later output: in
  41859559537 / 41845836776 the context really re-crossed 65 % and the historian fired
  again (drop after the peak); in 41971926453 it never re-crossed (trigger 49–61 to the
  end, peak at the last step). 41842386831 re-crossed but the run predates round 28c
  fixes. So C3 FAIL is a scenario property (the check assumes a drop after the peak).
- No code change and no assertion change. Options (user decision): (a) leave it — the
  early fire only costs one small historian pass; (b) have the adapter's trigger re-derive
  pressure after its own rewrite in the same pre-step (last usage + adapter-priced
  surface movement) — this changes when the historian fires and C1 would then depend on
  later turns; (c) give scenario C enough later turns to always re-cross 65 %.

## B2 — cordis peer vs alpha.3 / rc.1 (已复现, adapter manifest, fixed `8d8a513e2`)

`npm install` (npm 10.9.9) of the plugin's cordis peers next to the cordis that each
declared DSH depends on (`npm view @deepseek-ai/dsh@<v> dependencies`):

| DSH | cordis / plugin-include | peers `~4.0.5` / `~1.0.10` (dsh.6 and older) | peers after `8d8a513e2` |
|---|---|---|---|
| 0.2.1-rc.5 | 4.0.5 / 1.0.10 | resolves | resolves |
| 0.2.2-alpha.3 | 4.0.6-alpha.2 / 1.0.11-alpha.2 | **ERESOLVE** | resolves |
| 0.2.2-rc.1 | 4.1.0 / 1.1.0 | **ERESOLVE** (`npm-eresolve-before-rc1-cordis.txt`) | resolves (`npm-after-rc1-cordis.txt`) |

pnpm (what `dsh-install.yml` and DSH's plugin manager path use) only prints a peer
warning, which is why install acceptance stayed green. New peers:
`@deepseek-ai/cordis` `~4.0.5 || 4.0.6-alpha.2 || ~4.1.0`,
`@deepseek-ai/cordis-plugin-include` `~1.0.10 || 1.0.11-alpha.2 || ~1.1.0`.
RED `f566dcc5a` (dsh-cordis-peer 2/3) → GREEN 3/3. Not covered: a full `npm install`
of the whole DSH tree + plugin (only the cordis pair was exercised; the dsh-* peers are
exact versions and were not the failing part).

## B3 — type-level / runtime contracts on alpha.3 and rc.1 (new CI job, `a587b6890`, `b26aa4aad`)

New push-CI job `contracts-dsh` (matrix 0.2.2-alpha.3, 0.2.2-rc.1, node 24):
`overlay-dsh-types.sh` npm-installs `@deepseek-ai/dsh@<V>` + the dsh-* packages the adapter
imports into a scratch tree and symlinks the checkout's `node_modules/@deepseek-ai/*` to
it (12 entries, cordis 4.0.6-alpha.2 / 4.1.0), then runs `typecheck:dsh` and
`contracts:dsh`. First run 42006327584: typecheck PASS on both, contracts could not load
`@deepseek-ai/dsh-scope` (overlay used `--legacy-peer-deps`, skipping DSH's peers) —
fixed in `b26aa4aad`. Run 42007145308: typecheck:dsh 0 errors and contracts:dsh 105/105 on
alpha.3 and on rc.1. No type drift found.

## B4 — bin through a symlink (已复现, adapter, fixed `e443057d6`)

npm and bun install a bin on POSIX as a symlink (`node_modules/.bin/dsh-magic-context`,
global bin dir). Under node, `process.argv[1]` keeps the link path while
`import.meta.url` is the real `dist/cli.js`; `cli.ts` compared only the path / basename
tail, so `dsh-magic-context doctor|setup|--version` through the symlink exited 0 and
printed nothing (`bin-symlink-node.txt`). pnpm's `.bin` shell shims call the real path,
and bun resolves the link itself, so CI never saw it. Fix: `isDirectEntryFor()` compares
`realpath(argv[1])` with `realpath(fileURLToPath(import.meta.url))` first, tail comparison
kept as the fallback. RED `702a4fd1e` cli-entry-symlink 2/3 → 3/3; node
before: empty / rc 0, after: `0.49.35-dsh.6`. Windows not exercised (npm uses `.cmd`
shims there that call the real path — 静态推断).

## B5 — ctx_expand showed Magic's own injected text (已复现 in real rc.1 e2e, adapter, fixed `4a29a6bf5`)

rc.1 e2e 42007576307 (`@b26aa4aad`) U14 FAIL: the history view and the FTS rows disagreed at
ordinal 39. Ordinal 39 is a synthetic user message (Magic's merged tool record) holding the
model's `ctx_expand(1, 17)` result, which began `[1-4] U: <session-history></session-history>
<project-memory> <PROJECT_RULES> #2: …` — the m0 knowledge baseline (a `magic-context`-sourced
message) rendered as if the user had typed the project memory. The harness therefore marked
row 39 as injected and dropped it from the comparison. OpenCode / Pi add those blocks at
transform time only, so their ctx_expand never shows them; on DSH the historian and FTS input
already strip them (`withoutInjectedText`, round 24c), ctx_expand's `readRawMessagesFromAgent`
did not. User impact: expand output repeats the project memory (tokens) and presents memory
text — including memory entries that read like instructions — as a user turn.
RED `5adba5c21` (ctx-expand-injected 0/1: `<project-memory>` present) → `4a29a6bf5` 1/1;
injected-history, native-compaction-ordinals, tools unchanged green. Ordinals and ids are
unchanged (knowledge messages stay in the view with their own text removed). The U14 check
was not changed. After-fix e2e: see the run table.

I1 WARN on the same run: in cmp-03 the model wrote a `<path>…<type>content</type>` block into
its own text (imitating a read result) — model behaviour, limitation 21, WARN-only.
