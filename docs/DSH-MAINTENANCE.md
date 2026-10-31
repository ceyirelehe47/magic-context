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
peers), `@deepseek-ai/cordis ~4.0.5`, core = the upstream tag the branch is
based on (currently **v0.49.34**). `doctor` checks the installed DSH against
`DSH_COMPAT_EXPECTED_VERSION` in `src/doctor/env.ts`.

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

Without `@huggingface/transformers` installed (e.g. a slimmed local install)
`typecheck:dsh` reports exactly one environmental error in core
`features/magic-context/memory/embedding-local.ts` (dynamic import). The CI
install includes it.

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
# conflicts can only be in root package.json / bun.lock (the DSH layer touches
# nothing else outside packages/adapter-api, packages/dsh-plugin, docs/, .github/)
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
4. `bun run test:dsh`, then a real-DSH smoke (see `docs/dsh/e2e/README.md`).

## DSH-specific layer inventory (what cannot live in core, and why)

| module | why it is DSH-only |
|---|---|
| `compat/dsh-0.1/session.ts` | DSH event-log access (`snapshotEvents`/`eventAt` — `Session.events` was removed in 0.2), branded surface-replace CAS, `MessageSourceMap["magic-context"]` augmentation + legacy `kind:"plugin"` recognition, exclusive `TokenUsage` → prompt pressure |
| `compat/dsh-0.1/{compaction,prestep,tools,commands,typert,preset,liveness}.ts` | DSH service seams: compaction engine hook, pre-step chain, tool/command registries, Typert remote registry, cordis preset patching, liveness marker for core's migration guard |
| `compat/dsh-0.1/subagent.ts` + `agent/worker.ts` | DSH subagent activation (`startActivation`, caller delivery), delegated-policy pinning, tool allowlist on the child scope |
| `agent/transcript.ts` | maps the DSH event log/surface to core `RawMessage[]` + a recording transcript so core tagging/drops become surface-replace ops (DSH never lets a plugin rewrite messages in place) |
| `agent/coordinator.ts`, `agent/outbox.ts` | CAS + saga that applies those ops through DSH's surface transaction with crash-safe SQLite outbox; no core equivalent (OpenCode/Pi mutate the request array) |
| `agent/context-plane.ts`, `agent/knowledge-gate.ts`, `agent/system-guidance.ts`, `agent/auto-search.ts` | DSH "inject, don't rewrite" delivery of m0/m1 knowledge, guidance and hints through `agent.inject` + watermark de-dup |
| `agent/historian*.ts`, `agent/recomp.ts`, `agent/dreamer.ts` | drive core historian/recomp/wrapup/dreamer with a DSH LLM client facade (OpenCode-SDK-shaped) and a transcript-backed raw-message provider |
| `agent/nudge.ts`, `agent/protection.ts` | ctx_reduce nudges and protection window adapted to the data DSH has (see open points) |
| `agent/tools.ts`, `agent/commands.ts` | register core `ctx_*` tools and `/ctx-*` commands in DSH registries |
| `host/*`, `entries/*`, `client/client.js`, `cordis.patch.yml` | cordis plugin entry points, storage bootstrap (shared SQLite, `harness='dsh'`), Typert remote + web client panel |
| `doctor/*` | `dsh-magic-context setup|doctor` CLI (preset generation, install/version/profile/DB checks) |

## Open compatibility points (as of DSH 0.2.1-rc.5 / core v0.49.34)

1. **Nudge baseline is approximated.** Core 0.49 decides Channel 1/2 from a
   tail-hygiene baseline (U undropped reclaimable, T live tail) produced by
   the OpenCode/Pi transform's tail walk. DSH has no such walk; the adapter
   uses the persisted tag aggregate (U = active tool output below the
   protection cutoff, T = active conversation + tool tokens, zero turn
   deltas). `hasRecentReduce` is always false and the post-reduce grace is
   never armed (`markChannel1PostReduceGracePending` is not called from the
   DSH `ctx_reduce`). Expect different cadence from OpenCode/Pi.
2. **Protection window is count-based.** Core moved to a token-floor window
   (`getProtectionWindowForSession`) and treats `protected_tags` as a
   deprecated inert key. DSH still converts "newest N tags" via
   `countProtectionWindow()`. Porting to the token floor needs DSH-side
   pricing of the floor (`protected_tokens_effective` snapshot).
3. **Model harness.** Core's `ModelHarness` is `opencode | pi | omp`. DSH
   reads the `opencode` blocks (`dreamer.opencode`, `historian.opencode`)
   because DSH model refs are `provider/model`. A first-class `dsh` harness
   block would need a core change.
4. **Worker tool allowlist.** DSH 0.2 dropped `toolFilter`/`persona` from
   `SubagentStartRequest`. The worker restricts tools from an `agent/created`
   listener matched on `header.origin === "subagent"` and
   `header.parentSession === parent`, and fails closed if it cannot. Not
   exercised against a real DSH runtime; the worker is not used by any
   production path yet. DSH's own `ChildComposition.toolFilter`
   (`applyChildComposition`) may be the cleaner route.
5. **Context pressure source.** The historian trigger first reads
   `sessionProjections.snapshot(session).values.contextPressure` (token-meter
   projection); the key was not re-verified for 0.2. The event-log fallback
   (last call `input + cacheRead + cacheWrite` / `request/context`
   window) is what the tests cover.
6. **Client panel.** `client/client.js` requires
   `@deepseek-ai/dsh-client-runtime/client`, which is not published at
   0.2.1-rc.5 (the peer was dropped); the web panel may not load on 0.2.
7. **Removed upstream, removed here:** `/ctx-aug` (sidekick),
   `/ctx-session-upgrade`, `runManagedUpgrade`, `runMigration`. `/ctx-recomp
   --upgrade` answers with the core deprecation text.
8. **Dreamer facade is "hidden".** The DSH dream client sets
   `backgroundSessionsAreHidden: true`; without it core 0.49 skips every
   non-host-only scheduled task ("no ordinary parent session").
