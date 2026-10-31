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

Use **bun 1.4.4** (`packageManager` says 1.4.2; 1.4.4 is what the e2e
bootstrap and the last full verification used). Do not use npm: it is
OOM-killed on small (8 GB) sandboxes. On sandboxes whose root/home overlay is
RAM-backed, a full unfiltered `bun install` is also OOM-killed because the bun
cache (~3 GB) lands in `~/.bun/install/cache`; use the filtered install above
and point `BUN_INSTALL_CACHE_DIR` at a disk-backed directory.

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

## `setup` / `doctor` (0.2 profile layer)

`dsh-magic-context setup|doctor` is the package bin (`dist/cli.js`, built
from `src/doctor/cli.ts`; `@deepseek-ai/cordis` is inlined so it runs outside
a DSH tree). It is **not** a `dsh` sub-command.

```bash
dsh-magic-context setup  [--dsh-home <dir>] [--dsh-install <dir>] [--stock-preset <file>] [--profile <name>] [--dry-run]
dsh-magic-context doctor [--dsh-home <dir>] [--dsh-install <dir>] [--stock-preset <file>] [--profile <name>] [--directory <dir>]
```

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
   - id: compaction-basic
     disabled: true
   - insert:
       - id: magic-compaction
         name: dsh-magic-context/compaction
         config:
           auto: true
       - id: magic-agent
         name: dsh-magic-context/agent
   # <<< dsh-magic-context <<<
   ```

   (flat layout; the web layout instead gets a `magic-standard` agent preset
   with the guarded compaction patch). Re-running replaces the block in place
   (`mergeManagedBlock`) and keeps every user row outside it; a flow-style
   non-empty list is refused. `--dry-run` prints the block and writes
   nothing. Put your own overrides (e.g. `magic-agent` `historian.model`)
   **outside** the block, as separate `- id: magic-agent` rows.
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
2. **Nudge U/T are approximations; `hasRecentReduce` is always `false`**
   (no post-reduce grace). See open point 1 below.
3. **Protection window counts tags, not a token floor**
   (`countProtectionWindow`). See open point 2.
4. **Core borrows the `opencode` model harness** (`historian.opencode`,
   `dreamer.opencode`); there is no first-class `dsh` harness in core. See
   open point 3.
5. **Unpublished rc.5 client packages.** `@deepseek-ai/dsh-client-runtime`
   (and the other `dsh-client-*` inject targets in `package.json` `dsh.client`)
   are not published at 0.2.1-rc.5, so the Web panel (`client/client.js`) may
   fail to load. Server-side features are unaffected.
6. **Worker tool allowlist not verified against a real DSH runtime** (unit
   tests only; no production path uses the worker yet). See open point 4.
7. **No bubblewrap on the verification machine.** The Linux sandbox used for
   the e2e runs has no `bwrap`, so DSH's sandboxed shell/tool execution was
   not exercised there; tool calls that depend on the DSH sandbox are
   unverified on Linux.

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
