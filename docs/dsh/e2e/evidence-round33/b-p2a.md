# Round 33 B · P2-A — remaining WARN / FAIL items: E2, T3, Y2, C3

No keys here. Artifacts are the redacted `dsh-e2e-<run>` uploads.

| item | status | class | changed this round |
|---|---|---|---|
| E2 | 上游问题 (core) | upstream limitation (core ranking) | no — issue draft in `b-upstream-issue-drafts.md` §1 |
| T3 | 非缺陷 (WARN is accurate) | test judgement, acceptable | no — user decision stays open |
| Y2 | 已复现并修复 (checker) | test judgement (timing assumption) | checker: `e0c8a7bbf` RED → `80f52b940` |
| C3 | 上游问题 (DSH token-meter) + scenario assumption | upstream limitation surfacing through the scenario | no — repro + issue draft §2; option (c) evaluated, not applied |

---

## E2 — exact identifier not ranked first with real embeddings

**Minimal repro (observation, e2e scenario E):** session A holds four facts each tagged
with a code (`ARCH-KESTREL-4127`, `RULE-MARMOT-5830`, `FILE-HERON-2261`,
`TODO-BISON-9074`); `ctx_search(<code>)` with core's default local embedding model
(`Xenova/all-MiniLM-L6-v2`). Rank of the hit that contains the code, real MiniLM:

| run | ARCH | RULE | FILE | TODO |
|---|---|---|---|---|
| 42034146821 (rc.5) | 4/6 | 5/6 | 1/6 | 1/6 |
| 42037652492 (rc.5) | 5/7 | 6/7 | 1/7 | 1/7 |
| 42034156577 (rc.1) | 1/7 | 5/7 | 1/7 | 1/7 |

(earlier rounds in DSH-MAINTENANCE limitations 21/22.) WARN in every run.

**Mechanism (静态, core `packages/plugin/src/features/magic-context/search.ts`):**
`mergeMessageAndCompartmentResults` fuses the message-FTS list and the compartment
vector list with plain RRF (`1/(RRF_K + rank)`, `RRF_K = 60`) and *"Fusion decides
ordering, not relevance"* — exact containment of the query earns nothing at this
layer (the `VERBATIM_RANK_BONUS` only exists inside the message probe lists). A
compartment that is vector-rank 0 and also holds any weak FTS hit scores
`1/60 + 1/61 ≈ 0.0331`; the compartment holding the exact identifier at FTS rank 0
but vector rank ≥ 2 scores `1/62 + 1/60 ≈ 0.0328` and loses. MiniLM embeds codes like
`ARCH-KESTREL-4127` as near-noise, so the vector rank of the right compartment is
essentially random — which is why the ranks vary per run. Same code path in OpenCode
and Pi (core), not DSH-specific.

**Damage:** the right fact is still in the result list (always within the top 7 here),
so an agent that reads past the first hit finds it; one that trusts hit #1 can act on
a neighbour. No data loss.

**Classification / worth fixing here:** upstream core; user rule (2026-11-04):
core-original issues are not patched in this fork. **Not changed.** Side effects of a
core fix (an exact-token boost in the fusion) would touch every harness's ranking
and the core search goldens — exactly why it belongs upstream. Draft:
`b-upstream-issue-drafts.md` §1 (not filed).

---

## T3 — WARN when the model restates the constraint itself

**What T3 judges:** after `/compact` with a historian `<unprocessed_from>` inside the
region, the constraint is shadowed by the checkpoint and carried in
`<unsummarized_tail>`; no other Magic or user copy may be on the surface. A copy in
an **assistant** message on the live tail → WARN (round 27b), because T4 (restart,
"name a colour", tools forbidden) can then no longer be attributed to the summary
alone.

**Minimal repro:** 42037652492 `t-session-4.jsonl` — the real model wrote the codeword
into its own `reasoning` while doing unrelated reads (seq 60 "there's a previous
standing rule about colour codeword OTTER-LANTERN-6152 …", 67, 81), all after the
constraint turn and inside the live tail. No Magic text and no user copy on the
surface (`otherSurfaceHits: []`); T4 PASS.

**Rate:** T3 is listed as WARN in 11 of the 30 e2e rows tabulated in DSH-MAINTENANCE
(rounds 27–31) plus 42037652492 in round 32; it is model-driven and appears on rc.5,
alpha.3 and rc.1 alike.

**Damage:** none to the user — the model is obeying the rule. The cost is only test
attribution: if DSH replays reasoning blocks to the provider, T4's correct answer may
come from the model's own restatement rather than from Magic's tail block. Whether
reasoning is replayed on this route (pi-ai `openai-completions`, DeepSeek model,
`requiresReasoningContentOnAssistantMessages` compat) is **待验证** (static reading of
`dsh-llm-pi-ai` replay: reasoning blocks are kept in the harness content and handed to
pi-ai; what reaches the wire depends on pi-ai's per-provider compat).

**Classification:** test judgement — the WARN is accurate (attribution really is
weakened), not a product defect. **Worth changing? No**, not in this lane: the only
ways to make it PASS more often are (a) ignore reasoning parts (would be WARN→PASS,
forbidden without the user, and unsafe until the wire question above is answered) or
(b) change scenario T so the model has nothing to restate (e.g. no turns between the
constraint and `/compact`) — that weakens T2/T3, whose point is a constraint inside a
busy tail. Kept as is; decision stays with the user.

---

## Y2 — first-step busy probe sees the new process's own fresh lease

**Minimal repro:** DSH 0.2.2-alpha.3 on node 22, 4/4 runs (41842392546, 41842397847,
41859567651, 41859577345): y-2's first `step` status shows `historianBusy: true` with
ONE lease whose `owner_pid` is the new y-2 process (e.g. 4933, killed pid 4875),
written 4 ms before the probe (`expires_at − 5 min` = probe − 4 ms, after `y-kill.at`);
both y-2 passes `noop`; no lease and no in-progress flag after the turn. On rc.5 and on
node 24 the pass has already released by the probe → `historianBusy: false`.

**Damage:** none — takeover of the dead holder's lease without waiting out the TTL is
exactly what Y2 protects, and it happened.

**Classification:** test judgement (timing assumption: "busy must be false" also
rejected the process's own pass).

**Fix (checker only, `80f52b940`; RED `e0c8a7bbf`):** the probe may read busy only if
EVERY lease it saw (a) has one common owner, (b) that owner is not the killed pid,
(c) `holder_id` names that same pid, (d) was written (`expires_at − 5 min TTL`) after
the kill and not after the probe, (e) a y-2 historian run was recorded at/after that
write. Everything else in Y2 is unchanged: passes `noop`/`success`, no lease of the
killed pid at the probe (`still_dead`), no live lease and no in-progress flag after
the turn, rc 0, elapsed < 120 s (no TTL wait). The detail now carries `busyProbe`
(`false` / `own fresh lease of the new process` / `busy (not explained …)`).

**Why this is not a relaxation:** the property under test — the dead holder's lease
neither blocks nor is waited out — is checked as before and more precisely (a lease
attributable to the killed process in any way still fails: its pid, a write before the
kill, a mismatched holder, a second unexplained owner, an empty lease list while busy,
a lease still live after the turn — 10 negative unit cases). The only newly accepted
state is "busy because the new process's own pass holds a lease it wrote after the
kill", which is the correct behaviour of the busy probe.

**Side effect:** relies on core's `COMPARTMENT_LEASE_TTL_MS = 5 min` (constant copied
into ci-check with a pointer); if core changes the TTL, (d) mis-derives the write time
— with the pid conditions still in force this can only make Y2 FAIL, not pass
wrongly, except if the TTL shrinks enough that a pre-kill write looks post-kill AND
the pid differs from the killed one (then it is not the dead holder's lease anyway).

**Evidence:** `b-y2-red.txt`, `b-y2-green.txt` (12/12), `b-y2-replay.txt` (alpha.3
×4 FAIL→PASS on basis "own fresh lease"; rc.5 ×2 and rc.1 ×1 PASS on basis "false").

---

## C3 — DSH token-meter does not reprice a plugin surface replace

**Minimal repro (`b-c3-meter-repro.ts.txt`, output `b-c3-meter-repro-output.txt`):**
DSH's own `foldSurfaceProjection` (dsh-token-meter 0.2.1-rc.5): append a 16 884-char
node (+4 229 tokens), then `replace` it with the 3 134-char truncated copy:

- without an adjacent `compaction/summary|prune` claim (what a plugin surface
  transaction produces): delta **0**, projection stays 4 229;
- with the claim (DSH-native compaction path): delta −3 429, projection 800.

DSH documents this ("A replacement without an armed claim folds with zero delta …
this preserves replay at the cost of possible drift"); 0.2.2-rc.1 has the same branch
(static). In e2e (evidence-round31 B1) this is why the historian fires at cmp-03 on a
projected 66–73 % while the next request is sent at ≈ 48 %.

**Damage:** the historian can fire earlier than the configured threshold right after
Magic's pressure truncation (one small extra historian pass — model tokens and a
slightly earlier compartment); the MC meter / native pressure check can over-report
until the next provider usage sample. No content loss, no wrong compaction.

**Classification:** upstream limitation (DSH token-meter pricing of claim-less
replaces) surfacing through the adapter's choice to trigger on `projectedTokens`;
plus a scenario assumption in C3 (the global peak must precede a drop).

**Option (c) — more turns in scenario C — evaluated, not applied:**

- The read loop already continues until compartments appeared in two turns (max 6
  pairs). In the failing runs the global peak is in the **U phase** (cmp-q,
  use-search, use-memory, use-expand) that follows the loop: 41842386831 peak
  28 638 at use-expand (last step); 41971926453 trigger 49–61 % to the end, peak at
  the last step. More read pairs before cmp-q do not stop the U turns from growing the
  context afterwards, so (c) alone does not remove the failure mode; it only raises
  the chance that a second fire lands before the U phase.
- A loop condition "keep reading until a drop after the running peak is seen" would
  make C3 hold by construction for the read phase and still leave the U-phase peak —
  it changes what the scenario exercises (more model turns, ≈ +2–4 min and tokens per
  e2e) without making C3 a stronger statement. Judged **not worth it**; changing C3's
  scope to the read phase only (would flip 41842386831: read-phase peak 27 777 at
  cmp-06, then 26 262) is a narrowing of the check and is listed for the user, not done.
- Option (b) (re-derive pressure after Magic's own rewrite) was not implemented, as
  instructed.

**Worth fixing here?** Not in the adapter: the clean fix is in DSH (let a plugin
surface transaction carry a shadow-price claim / repricing for its replaced range, or
reprice claim-less replaces from the retained surface). Draft:
`b-upstream-issue-drafts.md` §2 (not filed). C3 stays as is (2 FAIL in 8 rc.5 runs
since 28c; PASS in all three round-32/33 reference runs).

---

## e2e budget

P2-A used **no** dedicated e2e run (Y2's case does not occur on the current CI lanes:
alpha.3/rc.1 run on node 24, where the probe already reads false; it was validated on
the four real failing artifacts). The single round-33 B e2e run is the P1-A one
(`b-runs.md`).
