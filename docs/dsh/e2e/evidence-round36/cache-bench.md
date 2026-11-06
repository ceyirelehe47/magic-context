# Round 36 line B — prompt-cache hit rate before the first compaction (plugin vs. baseline)

User-approved plan 2026-11-06 09:00 CST. Analysis only: **no product code, no assertion, no existing
workflow changed**. Workflow `.github/workflows/dsh-cache-bench.yml` (new, manual), scripts in
`packages/dsh-plugin/scripts/e2e/cache-bench/` (proxy.mjs, bench.sh, bench-model.yml,
bench-plugin.yml, analyze.py).

| run | what | result |
|---|---|---|
| [42142063630](https://github.com/ceyirelehe47/magic-context/actions/runs/42142063630) | pilot, 1 + 1 runs, slot `cache-pilot` | flow works end to end (baseline 14 steps / plugin 32 steps, both 0 divergences) |
| [42142782133](https://github.com/ceyirelehe47/magic-context/actions/runs/42142782133) | formal, 3 + 3 runs, slot `cache-1`, @ 5fced3818 | below; full per-step tables in [cache-bench-results.md](cache-bench-results.md), per-request summary in [cache-bench-requests.jsonl](cache-bench-requests.jsonl) |

DSH `0.2.1-rc.5` (node 22), plugin `dsh-magic-context` 0.49.35-dsh.8 candidate (branch HEAD; product
code = round 35, 2e96be4c1 tree). Runs on 2026-11-06 01:10–02:00 UTC, i.e. inside DeepSeek's peak
window (01:00–04:00 UTC).

## Method

* **Same everything except the treatment.** Both groups: the same DSH install, model
  `deepseek-v4.1-flash` via OpenCode Go (`opencode.ai/zen/go/v1`, key from secret
  `OPENCODE_API_KEY`), the same 100k main route (`bench-model.yml`), the same task and fixtures, the
  same nonce rule.
  * `plugin`: profile `test` = the plugin from this checkout + `setup` (shipped defaults: MC execute
    threshold 65 %, native backstop 90 %); only addition `bench-plugin.yml` routes the historian to a
    200k route so its first request is tagged.
  * `baseline`: profile `base` = the shipped DSH `headless` template, no plugin (checked: nothing in
    the profile mentions magic-context). DSH's own compaction-basic defaults: on 100k it fires at
    min(0.8·w, w − 4096 − 65536) = 30 368 tokens.
  * What differs is the plugin itself: its system-prompt section (system message 8 426 vs 2 598 chars),
    its 6 extra tools (31 vs 25: ctx_expand/memory/note/reduce/search, todowrite) and its message
    shaping. That is the treatment, not a confound.
* **Task** (`bench.sh`, deterministic): turn 1 "Reply with the single word: ready.", then turns of
  eight ~7.6 KB generated fixtures each (byte-identical scenario P generator, 64 files) with "ONE read
  call per step … Do not call any tool other than read. Then reply with one line per file". Every turn
  is a fresh `dsh` headless process on the same session (as ci-e2e.sh does). Up to 9 turns.
* **Measurement.** A recording reverse proxy (`proxy.mjs`) sits between DSH and OpenCode Go and logs
  every request (body to `bodies/<n>.json`, timing and the provider's raw `usage`); headers are never
  written (the key is in `Authorization`; the redact pass found 0 key occurrences). OpenCode Go
  returns OpenAI-style usage: `prompt_tokens`, `prompt_tokens_details.cached_tokens` (= hit;
  miss = prompt − hit) — there is no `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` on this
  route. Its `usage.opencode` block repeats the split (`input` = miss, `cache_read` = hit,
  `cache_write_* = 0`) and a `list_cost` that equals the DeepSeek peak prices below to 4 decimals in
  every run (cross-check of the price table).
* **Step** = one main-agent request (system "You are an AI agent powered by DeepSeek Harness" + tools).
  Session-title requests are excluded.
* **Cutoff = the first compaction**: plugin = the first historian request (200k route tag);
  baseline = the session's first `compaction/start` (earlier than its summarizer request). Steps
  whose request started at/after the cutoff are not counted. The driver stops after the turn in which
  the cutoff happened.
* **Isolation between runs.** Each run: fresh random 16-hex nonce, prepended by the proxy as
  `[bench-nonce <hex>]\n` to the first system message of *every* request (identical rule in both
  groups); fresh `x-opencode-session` header; fresh XDG data dir (Magic DB); fresh DSH session.
  Verified: step-1 cache hit = **0** in all 6 runs (and in both pilot runs).
* **Prefix divergence.** For consecutive steps the analysis compares the forwarded bodies: tools,
  then messages, by canonical JSON; "append-only" = tools equal and the previous request's messages
  are an exact prefix of the current one; otherwise it records the first differing message.
* **Price** — <https://api-docs.deepseek.com/quick_start/pricing> (fetched 2026-11-06; `deepseek-flash`
  = DeepSeek-V4.1-Flash-1017): per 1M tokens, cache hit **$0.006**, cache miss **$0.30**, output
  **$1.20** (peak; off-peak is exactly half, so every ratio below holds off-peak too).

## Results (run 42142782133)

### Hit rate Σhit / Σ(hit + miss), steps before the first compaction

| group | runs | hit rate mean (min–max) | after step 1 | steps to 1st compaction | prompt tokens at last counted step | cost / run USD (peak) |
|---|---|---|---|---|---|---|
| baseline | 3 | **87.6 %** (87.5–87.8) | **89.9 %** (89.8–90.1) | 14 (14–14) | 26 975 (26 921–27 042) | 0.0104 (0.0103–0.0105) |
| plugin | 3 | **90.0 %** (87.1–94.7) | **90.4 %** (87.3–95.5) | 97.3 (36–143) | 61 357 (60 451–62 022) | 0.158 (0.042–0.236) |
| difference (plugin − baseline) | | +2.4 pp (−0.7 … +7.2) | +0.5 pp (−2.6 … +5.6) | +83 steps | +34.4k tokens | ×15 |

Per run:

| run | steps | hit rate | after step 1 | prefix divergences | first divergence | ctx_reduce calls (whole run) | cost USD |
|---|---|---|---|---|---|---|---|
| baseline 1 | 14 | 87.5 % | 89.8 % | 0 | — | — | 0.0105 |
| baseline 2 | 14 | 87.5 % | 89.8 % | 0 | — | — | 0.0104 |
| baseline 3 | 14 | 87.8 % | 90.1 % | 0 | — | — | 0.0103 |
| plugin 1 | 143 | 87.1 % | 87.3 % | 45 | step 11 | 11 | 0.2362 |
| plugin 2 | 113 | 88.2 % | 88.4 % | 30 | step 11 | 7 | 0.1957 |
| plugin 3 | 36 | 94.7 % | 95.5 % | 0 | — | 2 (both after the cutoff) | 0.0424 |

The averages hide two different regimes, so the comparison that answers "does the plugin break the
cache" is the next two tables, not the mean.

### Same work, same window: the first 14 steps of every run

| group | hit rate mean (min–max) | after step 1 | cost / run USD (peak) | of which hit / miss / output |
|---|---|---|---|---|
| baseline | 87.6 % (87.5–87.8) | 89.9 % (89.8–90.1) | 0.0104 | 0.0012 / 0.0083 / 0.0009 |
| plugin | 85.8 % (83.1–88.6) | 89.4 % (86.7–91.9) | 0.0180 (0.0158–0.0219) | 0.0013 / 0.0109 / 0.0058 |

### Where the misses come from

* **Baseline: 39 / 39 step transitions append-only**, hit / previous prompt = 0.98–1.01 every step:
  each step misses only what it appended (≈ 1.9–2.0k tokens per fixture read, ≈ 200–300 for a
  reply / new user turn). DeepSeek caches in 128-token units on this route (every hit is a multiple of
  128), so the theoretical ceiling for an append-only session is reached.
* **Plugin without drops is just as stable**: in plugin run 3 (and the pilot) every transition is
  append-only, including every turn boundary (fresh process) — MC's §N§ tags, the
  `<session-history>` / `<session-history-since>` blocks, the runtime-context snapshot, the
  ctx-search hint and the "Magic Context note: these tool calls already ran …" fold are all emitted
  once and never re-rendered before the first compaction. The hypothesis "the plugin rebuilds the
  folded text every step" is **refuted** by the bodies.
* **Plugin with drops: all 75 divergences (45 in run 1, 30 in run 2) are a newly materialized
  `[dropped §N§]` placeholder** replacing an earlier tool-result fold (checked on every diverged body
  pair: the first differing message gains a `[dropped` marker in 75 / 75, nothing else ever differs).
  Each such step re-prefills everything after the dropped message: hit falls to the
  system + tools + messages-before-the-drop prefix (10.2–24.8k), the step misses ≈ 7.8–9.2k tokens
  instead of ≈ 2k.
  * Excess miss attributable to divergences: run 1 **365 529** tokens (of 520 732 misses), run 2
    **264 372** (of 412 801). Without them those runs would have had **96.2 % / 95.7 %** instead of
    87.1 % / 88.2 % — i.e. above the baseline. Excess cost: $0.108 (46 % of run 1) and $0.078 (40 % of
    run 2).
  * The drops come from the model calling `ctx_reduce` although the task says "Do not call any tool
    other than read" (known limitation 21 / scenario P R10, model behaviour). After dropping it re-reads
    files or calls `ctx_expand` (run 1: 121 reads of 70 distinct files, up to 4 reads of one file;
    run 2: 94 reads of 68), which is why runs 1/2 need 143 / 113 steps to reach MC's 65 % instead of
    36, and why the prompt keeps falling back to ≈ 18–33k and climbing again.
  * One `ctx_reduce` costs **several** cache breaks, not one: the tool answers "Queued: drop §5§, §6§,
    §8§, deferred drop §10§, §12§, …"; the immediate ones land on the next step, and every deferred
    (protected-tail) tag lands on its own later step as it leaves the protection window (run 1 steps
    11, 14, 16, 18, 20: one new placeholder each, at msg[7], [10], [11], [12], [13]). 11 calls → 45
    breaks in run 1, 7 → 30 in run 2.

### Cost

* Per run up to the first compaction (not like for like — the plugin does 2.6–10× more steps and
  reaches 61k instead of 27k): baseline $0.0104, plugin $0.158 mean.
* Per step: baseline $0.00074, plugin $0.00152 (run 3, no drops: $0.00118).
* Same 14 steps: baseline $0.0104 vs plugin $0.0180 (**+73 %**). Split: misses +$0.0026 — of which
  the larger static prefix is +4.5k tokens on step 1 (≈ +$0.0014 per session start; afterwards it is
  a cache hit) and the step-11 drop break in runs 1/2 the rest; **output +$0.0049** — the plugin
  model emits 361 output tokens per step on average (291 of them reasoning) vs 55 (7 reasoning) in
  the baseline. That output difference is the largest per-step cost term and is not a cache effect
  (待验证 cause: it correlates with the MC prompt section / fold notes, not measured separately).

## Findings

1. **No prefix instability from the plugin's own rendering** (已复现, 6 runs + pilot): before the
   first compaction, without drops, the plugin is append-only like the baseline and its hit rate is
   *higher* (94.7–95.5 %) because its larger static prefix is cached and the run is longer.
2. **Every drop that materializes breaks the DeepSeek prefix cache at the dropped message**
   (已复现, 75 / 75). That is inherent to a drop (the bytes at that position change), so the question
   is only how often it happens.
3. **The DSH adapter materializes queued drops on every step, one by one** (cadence 已复现; cause
   静态推断): `packages/dsh-plugin/src/agent/transcript.ts` (≈ line 2063) calls core's
   `applyPendingOperations` on every pre-step pass with only the protection window as a filter. Core's
   OpenCode path applies pending ops only when a "reclaim ride" is permitted
   (`transform-postprocess-phase.ts` `shouldApplyPendingOps = !compactionOff && publishedWorkDrainAllowed`,
   `reclaimRidePermitted` in `cache-busting-signals.ts`: hardFold / force / explicitFlush /
   publishedHistory / executeReclaim / …, plus the `cache_ttl` idle-expiry heuristic), i.e. it holds
   drops until the prefix is going to be rebuilt anyway. MC's own system prompt promises that
   behaviour ("Stamping does not remove anything … Magic Context clears them all in one sweep"), and on
   DSH it does not happen: 11 ctx_reduce calls became 45 separate cache breaks.
4. **The model ignores "only read" and calls ctx_reduce** (2 of 3 runs before the cutoff, 3 of 3 in
   the whole run; the third run's two calls came after the cutoff, following MC's own
   `<system-reminder>` nudge "27 spent tool outputs (~52k tokens) are still unstamped. Call ctx_reduce
   now", which first appears in request 40, after the historian request 38; in runs 1/2 the first call came at the end of turn 2, ≈ 24k tokens,
   with no nudge in any earlier request — only the system-prompt guidance "When an item no longer needs
   to stay on the desk … stamp it: `ctx_reduce`"). Model behaviour, already known (limitation 21 / R10); here it is what turns finding 3 into
   real cost.
5. **Plugin output tokens ≈ 6.6× baseline per step** (已复现 as a measurement; cause 待验证).

Not fixed — any change to drop materialization timing is product code and needs the user's approval.
Options for that decision (not implemented): (a) gate `applyPendingOperations` on the same
reclaim-ride / cache-TTL signals as core (drops then land in one sweep with the next unavoidable
bust: historian publication, force band, TTL expiry, /compact); (b) at least land all deferred drops
of one ctx_reduce call together instead of one per step.

## What the nonce does, and what happens without it (analysis, not measured)

DeepSeek's context cache is shared across requests of the same account by prompt prefix; OpenCode Go
forwards every user's requests through its own upstream account(s), so the prefix pool may also be
shared with other OpenCode Go traffic (not verifiable from here).

* With the nonce (what was measured): the very first bytes differ per run, so step 1 hits 0 in every
  run, and nothing from an earlier run (or from anyone else using the same DSH system prompt) can be
  reused. Both groups pay their full static prefix once per run.
* Without the nonce, run 1's request bodies would warm runs 2/3 in the same group: the system prompt,
  the tool list and the first user turn are byte-identical across runs (fixtures, prompts and paths
  are deterministic; the runtime-context snapshot has the same cwd), so step 1 of runs 2/3 would hit
  up to the first byte that depends on the model's own output (its first reply / tool-call ids) —
  ≈ 5.6k tokens baseline, ≈ 10.1k plugin. Effect on the run's rate: baseline +5.7k / 223k Σprompt ≈
  **+2.6 pp**, plugin (36-step run) +10.1k / 1.28M ≈ **+0.8 pp** — the baseline would be inflated more,
  biasing the comparison towards the baseline, and run 1 would differ from runs 2/3 systematically.
  Even run 1 could hit if another DSH user on the same upstream account had sent the same
  `DeepSeek Harness` system prompt recently. Steps 2+ are unaffected either way (their prefix contains
  the run's own model output).
* Running the two groups in parallel jobs does not cross-warm: their system prompts differ from the
  first Magic Context section on (and with the nonce, from byte 16).

## Limitations

* n = 3 per group; the plugin group is bimodal because of model behaviour (ctx_reduce), so its mean
  and range describe this sample, not a stable property. The baseline is very stable (±0.15 pp).
* Provider is OpenCode Go → DeepSeek-V4.1-Flash, not DeepSeek's own API: the hit/miss split comes from
  `prompt_tokens_details.cached_tokens` (128-token granularity), not from `prompt_cache_hit_tokens`;
  costs are DeepSeek list prices applied to these counts (OpenCode's own `list_cost` agrees).
* The two groups reach their first compaction at different points (native 30.4 % vs MC 65 %), so the
  "to first compaction" columns compare different amounts of work; the 14-step table is the like-for-like
  view.
* The historian / summarizer request itself and everything after the cutoff are excluded; so are
  session-title requests.
* Only rc.5, one model, one task shape (sequential file reads). A task with larger tool outputs per
  step lowers both groups' rate; a task where the model drops more often widens the gap.
