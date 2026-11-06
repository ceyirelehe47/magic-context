# Round 36 line G — plan N native roles behind a switch (experimental, default off)

User-approved 2026-11-06 (plan N, `docs/dsh/design/native-roles-plan.md` §7). Adapter only
(`packages/dsh-plugin`); core, pi-plugin, node_modules and upstream workflows untouched. No tag, no
release, no npm, no e2e / soak.

Switch: `context.nativeRoles` (settings) or env `MAGIC_CONTEXT_DSH_NATIVE_ROLES=1`; **default off**. The
tag scheme is frozen per session the first time Magic sees it (`agent/tag-scheme.ts`): a fresh session
with the switch on is "native", a session Magic already worked on stays "fold" even if the switch is
turned on later, and a native session stays native if it is turned off.

## Method

1. RED first on a real DSH rc.5 `Session` through the real pre-step body (`runContextPlaneStep`),
   `src/agent/native-roles.test.ts`.
2. Implementation in the adapter (walkDshLog without the pending-assistant fold, per-source-seq op
   grouping, content-only `tool/result` / single-node `user/message` replaces each preceded by a
   `compaction/prune` priced with token-meter `estimateMessage`, assistant parts read-only → core
   `skeleton_real`, no assistant-text tags, no fold offset in the preview).
3. Old tests: run unmodified with the switch off (default) — all pass; run once more with the env set
   (`MAGIC_CONTEXT_DSH_NATIVE_ROLES=1`) to see what the native scheme changes (below).
4. Real model: `dsh-cache-bench.yml` with input `native_roles=on` (plugin group only gets the env).

## Commits (branch `dsh-integration`)

| commit | what |
|---|---|
| `16e6fe2e8` | RED — `native-roles.test.ts` N1–N10 + S1–S3 (13 tests); **9 / 13 FAIL** before the fix |
| `8e095e315` | FEAT — switch + native view / ops (`tag-scheme.ts` new, `transcript.ts`, `context-plane.ts`, `coordinator.ts`, `compat/dsh-0.1/session.ts`); contract `native-rewrite.contract.test.ts` pins the DSH rules on every declared version |
| `bc74ce513` | CI — `dsh-cache-bench.yml` input `native_roles` (off \| on), recorded in `meta.json` |
| `73cf540e6` | RED N11 — a native tool/result tag rewrite of a just-served node was read by the drop gate as a "rewritten served prefix" ride, so queued drops landed without a real ride (when the log has no request header) |
| `5d19db4aa` | FIX N11 — drop gate treats Magic's native rewrites (text starting `§N§` / `[dropped §N§]` / `[truncated §N§]`) like the fold view's `mc-op:` copies |
| `b1e5f96fc` / `ae60fe811` | TEST N12 pin (below) + docs — this file, `g-*.txt`, `g-scripts/`, DSH-MAINTENANCE, RELEASE-NOTES; `ae60fe811` = N12 test-file typecheck |

Push CI 42215396157 @ `5d19db4aa`: green — `dsh-plugin` **689**, `adapter-api` **15**, `contracts:dsh`
**109** × 3 (rc.5 / alpha.3 / rc.1), ci-check unit **33**. After this commit `dsh-plugin` is **690**
(+1 N12): push CI 42218759538 @ `ae60fe811` green — `dsh-plugin` **690**, `adapter-api` 15, `contracts:dsh`
109 × 3, test-file typecheck 0, ci-check 33. (The docs push 42218348760 @ `b1e5f96fc` failed only on the N12
test-file typecheck, TS2352; fixed in `ae60fe811`.)

## preview-tags observation (switch on via env, old test) — expected, not a defect

`context-plane-preview-tags.test.ts` "never allocates a bare-id tag…" with the env set prints
`Received: [ "§1§ hello", "let me check", "file contents", "§3§ thanks", "done", "§4§ turn three question" ]`:
the tool result `file contents` has no `§N§` in the **preview payload**.

Diagnosis (local dump of the same scenario with `nativeRoles: true`):

* The plan did tag it: tag row `{message_id: "call-1", type: "tool", tag_number: 2}`, and the surface
  written in the same pass shows `[tool] "§2§ file contents"`; the second pass's payload (built from the
  surface) shows `§2§ file contents` and allocates nothing new.
* `previewTagPayloadMessages` only rewrites text under core's `message` keys (`${id}:pN`) and only
  pre-assigns a plain user message that is not in the view yet. A tool tag is a `tool` row keyed by the
  call id, so the preview leaves `tool` entries untouched — in both schemes (the fold-view expectation
  in the same test does not list `file contents` either).
* In DSH the pre-step payload is `UserMessage[]` (`compat/dsh-0.1/prestep.ts` `PreStepPayload.messages`):
  only the step's new user input. Tool results are already on the log/surface; the request is built from
  the session, so the surface copy is what the model gets. The legacy test feeds the whole conversation
  as a payload, a shape DSH never produces.
* Real model confirmation: in both native bench rounds every tool result is `§N§`-tagged the **first**
  time it is served (32 / 32 per run, 6 runs) and every step is append-only.

The other env-on failures are the old tests' fold-view expectations, which plan N changes on purpose
(the switch is off by default, so their assertions stay byte-for-byte as they are):
preview-tags 3 (tool-call text absorbed under the next user `:p0` / `:p1` fold ordinals), fold-format 1,
identity-regression 1, crash-recovery 2, legacy-tag-cleanup 1, new-input-fold-tags 3,
runtime-context-tags 2 (all fold record / fold-offset ordinals), native-roles S1 / S3 (the env forces
"on", so "stays fold" and "default off" cannot hold). 103 test files run with the env: 95 pass unchanged, these 8 differ.

**N12 (pin, not RED — passes before and after):** `native-roles.test.ts` "preview only rewrites user
input; a new tool result gets its §N§ on the surface in the same pass": with the whole conversation as
payload, non-user entries are left byte-identical, the newest tool node on the surface carries its
`tool` tag number in that pass, and every number the preview shows is the surface's number.

## Real model: cache bench (DeepSeek V4.1 Flash via the proxy, cutoff = first historian request)

| run | commit / slot | group | runs | hit rate (min–max) | after step 1 | steps to 1st compaction | cost / run USD (peak) | cost / step | out tok / step | reasoning / step | append-only / diverged | ctx_reduce | reads (repeats) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 42164389768 | `8cc2c4220` (line C, fold) | plugin | 3 | 94.3 % (94.3–94.5) | 95.2 % | 34.3 | 0.0410 | 0.00126 | 386 | 325 | 100 / 0 | 0 † | — † |
| 42166613496 | `8cc2c4220` rerun (fold) | plugin | 3 | 94.1 % (93.7–94.7) | 95.0 % | 37.0 | 0.0401 | 0.00126 | 351 | 290 | 108 / 0 | 2 (run2) † | — † |
| 42214443375 | `bc74ce513` cache-7, native on | plugin | 3 | 94.3 % (94.2–94.4) | 95.2 % | 31.0 | 0.0274 | 0.00089 | 69 | 18 | 90 / 0 | 0 | 32 × 3 (0) |
| 42214443375 | same | baseline | 3 | 87.6 % (87.5–87.6) | 89.9 % | 14.0 | 0.0103 | 0.00074 | 51 | 4 | 39 / 0 | — | — |
| **42215740858** | **`5d19db4aa` cache-8, native on** | plugin | 3 | **94.3 % (94.3–94.4)** | 95.2 % (95.1–95.3) | **31.3 (31–32)** | **0.0274 (0.0270–0.0277)** | 0.00088 | 60 | **9** | **91 / 0** | **0** | 32 × 3 (0) |

† line C artifacts have no `resp/` (recorded from line D on); ctx_reduce from `c-drop-gate.md`.
Round 2 summary: `g-bench-42215740858-summary.md`; per-run counts `g-bench-stats.txt`
(`g-scripts/g-bench-stats.py`).

Reading:

* Round 2 reproduces round 1 within noise (hit 94.3 %, $0.0274 / run, 0 divergences); N11 changes
  nothing here because no drop was queued before the cutoff.
* Against line C (fold view, same gate): same hit rate; **cost / run −32 %** ($0.041 → $0.027), driven
  by output: reasoning 290–325 → 9–18 tokens / step, output 351–386 → 60–69 / step — line D's finding
  (the fold record makes the model reason about its own transcript) disappears when roles are native.
  Steps to the first compaction 34–37 → 31 (fewer, larger steps; same 8 reads × 4 turns, no re-read).
* Against the baseline (no Magic): +6.7 pt hit rate; cost / step 0.00088 vs 0.00074 (plugin carries the
  historian / tool schema overhead); the baseline compacts after 14 steps, the plugin after ~31.

## ctx_reduce = 0 — why (static + local diagnostic)

Two independent reasons:

1. **The bench window ends before any nudge would fire, in both schemes.** In line C (fold) the first
   reduction reminder appears in the request right **after** the first historian request (bodies 36 / 41 /
   35 / 44 / 37 vs historian 35 / 40 / 34 / 43 / 36), i.e. after the cutoff; the one pre-cutoff
   ctx_reduce (42166613496 run2) came without a reminder. So a 0 inside the window is not by itself a
   change.
2. **In native sessions the nudge measurement is blind to tool output (defect, not fixed this line; fixed in line H, `h-native-nudge.md`).**
   After the cutoff the native runs (requests 34–39) never get a reminder, where fold runs do. Local
   diagnostic (`g-nudge-diag.txt`, script `g-scripts/diag-nudge-native.test.ts.txt`): with 30 reads of
   ~4.5k tokens, fold measures U = 18k → 126k undropped tokens and fires channel 1 (urgent) and
   channel 2; native measures U = 32 → 280 tokens and fires nothing (`reclaimable-below-floor`). Cause:
   core tail hygiene attributes a tool tag to the part `(toolOwnerMessageId, callID)`; in the native view
   the owner is the assistant's call part (arguments only), while the output sits on the separate
   synthetic tool-result message. The tag row itself is right (byteSize 9000, tokenCount 4500), and drops
   / pressure truncation by tag number work (N3, N8) — only the nudge's U (and the reclaimable count in
   its text) is wrong. Not a gate change and not "the model no longer needs it": the model is simply
   never reminded. Fix options (adapter: give the result part the call's owner id in the native
   measurement view, or measure from tag rows) need a RED test and the user's go-ahead.

## Evidence level

* Unit / contract (real rc.5 `Session`, real token-meter): N1–N12, S1–S3, contract × 3 DSH versions.
* Real model, cache bench only (rc.5, 2 × 3 runs): cache hit, cost, divergences, first-serve tags.
* **Not run:** e2e, soak, install acceptance with the switch on; alpha.3 / rc.1 only via contracts.

## Remaining risks

* Nudge blind in native sessions (above) — on a long native session the model gets no ctx_reduce
  reminder; reclaim then depends on the historian and pressure truncation only.
* Assistant text is never tagged / dropped (by design, skeleton-only via core `skeleton_real`); long
  assistant prose stays until compaction.
* Native and fold sessions coexist on one DB (scheme frozen per session); mixed-scheme behaviour is
  covered by S1–S3 only.
* C3 (token-meter drift after a plugin replace) is fixed **only for native sessions** (each replace has a
  `compaction/prune` shadow price); fold sessions keep the old drift.
* Real-model coverage is one scenario (sequential reads); scenario L / K / P behaviour with the switch on
  is unknown until an e2e is approved.
