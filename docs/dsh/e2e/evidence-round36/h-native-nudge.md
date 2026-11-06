# Round 36 line H — ctx_reduce nudge in native-roles sessions (limitation 31, fixed)

User-approved 2026-11-06 20:43 CST ("修吧"). Adapter only (`packages/dsh-plugin`); core, pi-plugin,
node_modules and upstream workflows untouched. The switch (`context.nativeRoles` /
`MAGIC_CONTEXT_DSH_NATIVE_ROLES`) stays **default off**; no tag, no release, no e2e / soak.

## Root cause

The DSH nudge (`agent/nudge.ts` `maybeNudgeChannels`) feeds core's tail-hygiene walk
(`refreshTailHygieneBaseline` → `measureTailHygiene`, `packages/plugin/src/hooks/magic-context/tail-hygiene-walk.ts`)
with the DSH transcript view (`nudgeMeasurementMessages`). U (undropped reclaimable tokens) is **not** read from
the tag rows' `token_count`: the walk re-measures every transcript part and adds a part's tokens to U only when
the part is attributed to an active, unprotected tag. Attribution (`collectToolPartIdentities` +
`buildTagAttribution`) keys a tool part by `(owner message id, call id)`:

* `{type:"tool"}` (OpenCode, one part holding input + output) → owner = the message the part sits in;
* `tool_use` / `tool-invocation` → owner = its message; a later `tool_result` with the same call id takes the
  **owner of that `tool_use`** (Anthropic / Pi pairing).

Fold view: call and output are one `{type:"tool"}` part per call inside one message, the tag row's
`toolOwnerMessageId` is that message → attributed. Native view: the assistant keeps the call part
(`state.input` only) and the output sits on a separate tool-result (synthetic user) message, both
`{type:"tool"}`; the tag row is owned by the assistant call. The output part's key
`(synthetic id, callID)` matched no tag, so U counted only call arguments (32 → 280 tokens for 30 reads of
~4.5k, `g-nudge-diag.txt`) and channel 1 / 2 never fired. Tag rows, drops and pressure truncation were right
(they go by tag number).

## Fix (where and why this shape)

`packages/dsh-plugin/src/agent/nudge.ts`:

* `nudgeMeasurementMessages` — in the native view only (`isNativeView(view)`), every part goes through
  `pairedNativeToolPart`: an input-only `{type:"tool"}` call part becomes
  `{type:"tool_use", id, callID, name, tool, input}`, an output-only one becomes
  `{type:"tool_result", tool_use_id, tool, content}`. Serialised content is identical (same tokens); core's
  existing pairing then gives the result the call's owner = the tag row's `toolOwnerMessageId`.
* `ctxReduceCallIds` also accepts `tool_use` (the native shape of a `ctx_reduce` call), so
  `hasRecentReduce` keeps working.

Why this option (vs. writing token counts on the tag row): core never reads U from the tag row, so changing
`token_count` would not move U (and would touch rows drops / protection / the dashboard share). Re-labelling
the measurement copy is exactly Pi's semantics — `tail-hygiene-walk-pi.ts` builds an arc per `toolCall` and
pops the matching `toolResult` into it (owner = the call's message), and `transcript-pi.ts` keeps toolResult
entries separate and binds them to their call. Scope: only the nudge's measurement copy; the surface, tags,
drop / truncation paths and the fold view never see it.

## Commits

| commit | what |
|---|---|
| `efa9c4aab` | RED H1 / H2 (`src/agent/native-nudge.test.ts`): real rc.5 `Session` through `runContextPlaneStep`, 5 turns × 6 reads × ~4.5k tokens; H1 native U same order as fold + channel 1 / 2 fire; H2 pins fold U / T / channel-2 band / nudge log |
| `3f1d66f68` | FIX `nudge.ts` `pairedNativeToolPart` + `ctxReduceCallIds` |
| `b65acb3f9` | test-only: own session ids `sess-h-nudge-N` (the tag-scheme registry is process-global; `native-roles.test.ts`'s `sess-native-N` made H2's fold leg native in the one-process CI run, push CI 42221080427 691 / 1); log filter matches nudge lines only |

## RED → GREEN (`h-red-green.txt`)

| | fold U turn 1…5 | native U turn 1…5 | native channel 1 | native channel 2 |
|---|---|---|---|---|
| before (aa4c00b93 + RED) | 18042 … 126298 | **32 … 280** | — | — |
| after (3f1d66f68) | 18042 … 126298 (unchanged, H2) | **13532 … 121780** | urgent, U=49616 | delivered at turn 3 (~54k) |

T is identical in both views (27062 … 135318). Native U is one read (≈4.5k) below fold: in the native view
the newest read is inside the 4000-token protection floor on its own, in the fold view it is not (static
reading of the protection window; does not affect when the channels fire — channel 2 at turn 3 in both).
Re-run of the G diagnostic after the fix: `h-nudge-diag-after.txt`.

## Tests (local single-file and push CI)

| suite | G baseline | H |
|---|---|---|
| dsh-plugin | 690 | **692** / 0 (+H1, H2) |
| adapter-api | 15 | 15 |
| contracts:dsh | 109 × 3 | 109 × 3 (rc.5 / alpha.3 / rc.1) |
| ci-check.py | 33 | 33 |
| typecheck:dsh, test-file typecheck, core typecheck | 0 | 0 |

Switch on (`MAGIC_CONTEXT_DSH_NATIVE_ROLES=1`, every file): the same 8 files / same test names fail as in G
(fold-view expectations), `native-nudge.test.ts` 2 / 0. No old assertion changed.
Push CI: 42221080427 @ `3f1d66f68` failed (691 / 1, the H2 id collision above); **42221751881 @ `b65acb3f9`
green** 692 / 15 / 109 ×3 / 33.

## Real model: cache-bench 42221195453 (cache-9, plugin, native on, @ `3f1d66f68`, 3 runs)

Window = up to the first historian request (as in G). Summary `h-bench-42221195453-summary.md`, per-run
counts `h-bench-stats.txt` (`g-scripts/g-bench-stats.py`, `h-scripts/h-post-cutoff.py`).

| run | hit rate (min–max) | after step 1 | steps to 1st compaction | cost / run (peak) | reasoning / step | append-only / diverged | first reminder (body) | first historian | ctx_reduce |
|---|---|---|---|---|---|---|---|---|---|
| G 42215740858 (before) | 94.3 % (94.3–94.4) | 95.2 % | 31.3 | $0.0274 | 9 | 91 / 0 | none | 33 / 33 / 34 | 0 |
| **H 42221195453** | **94.5 % (94.4–94.8)** | 95.4 % | 32.0 | **$0.0279** | **11** | **93 / 0** | **33 / 34 / 33** | 35 / 33 / 34 | **1 / 5 / 1** |

* The reminder now fires: one channel-1 urgent + one channel-2 block per run ("22 spent tool outputs
  (~51k tokens) are still unstamped", run 2), in runs 1 and 3 **inside** the window (body 33, historian 35 / 34).
* The model answers it: ctx_reduce right after the reminder (run 1 `3-10,12-19,21-28,30-32`, run 3 `3-28`,
  run 2 `3-31` then 4 more small self-initiated drops with no new reminder).
* In-window cost: the queued drop does not land in the window (line C gate: next reclaim ride), the next
  request is still a 1.00 prefix hit; +$0.0005 / run vs G (the reasoning of the reduce step, 114–257 tokens).

After the cutoff (main requests only, `h-post-cutoff.py`):

| | post-cutoff requests | hit | cost / request | the one rewrite |
|---|---|---|---|---|
| G 42215740858 (no reduce) | 6 / 6 / 5 | 0.80–0.84 | $0.0038–0.0045 | historian publication, prompt 64–68k → 66–70k (no shrink) |
| H 42221195453 | 5 / 19 / 6 | 0.92–0.97 | **$0.0010–0.0015** | publication + queued drops together, prompt 63k → 21k / 67k → 24k (run 1: not reached by request 40) |

So the reduce costs one prefix rewrite that core would make anyway (the drops ride the publication), and the
prompt after it is ~⅓ the size — post-cutoff cost / request about −65 % against G. Small sample (3 runs, 5–19
post-cutoff requests); run 2's extra self-initiated drops raised its output (175 tokens / request, one
826-token reasoning step).

## Evidence level

* **Reproduced:** root cause (diagnostic + H1 RED on a real rc.5 Session), fix (H1 GREEN, H2 fold pinned,
  push CI green), real-model reminder + ctx_reduce in native sessions (cache-bench 42221195453).
* **To verify:** e2e / soak with the switch on (not run, needs approval); the post-cutoff cost effect on more
  runs; repeated self-initiated reduces (run 2) over longer sessions.
* **Static inference:** the one-read U gap vs fold comes from the protection floor.

## Remaining risks

* The re-labelled parts exist only in the measurement copy; if core later starts reading DSH part types
  elsewhere from this copy (it does not today), `tool_use` / `tool_result` would need the same handling.
* A native tool result without a preceding call in the view (call compacted away) keeps its own owner, as
  before — not attributed, as in Pi when the arc has no call (same behaviour as pre-fix for that case).
* Fold sessions: no code path change (`isNativeView` false → parts passed through), pinned by H2.
