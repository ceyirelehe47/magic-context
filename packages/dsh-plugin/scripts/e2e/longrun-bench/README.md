# DSH native vs. Magic Context: long-run preparation

## Authorized observational live follow-up

The separate `dsh-longrun-pair.yml` / `live_pair.py` lane runs the user-requested
real-model pair without requiring namespace isolation or a hard-dollar guarantee.
It uses the existing OpenCode Go secret only inside Actions, the existing model
patches and a bounded copy of the existing recording proxy. Core is unchanged.
Each arm has the same 24 batches, 192 files and 3 recovery checkpoints, fresh
state/nonce, at most 300 proxy forwards, 40 minutes and no driver-level retries.
The proxy stops new requests after its direct-price estimate reaches USD 4 per
arm. This is observational stop-loss, not an OpenCode bill or all-call guarantee.
One arm of each type runs serially; it is not a statistically powered AB/BA
experiment. Persisted compactions/compartments and exact recovery scores are
reported separately. A failed or incomplete task is retained, never called a win.
Push is limited to `bench/longrun-real-20261106`; it is a paid live workflow.
The older mock/preparation lane and its `driver.py live` guard remain unchanged.


**Status: local implementation and offline tests only. Paid/live execution is blocked.**
This directory does not run a real model, implement a live billing proxy, or establish
an enforceable USD 10 ceiling. `driver.py live` always exits 2 before reading any
credential or making a network request. Editing a manifest flag cannot enable it.
The independent workflow has no secrets and preserves that restriction.
Pushes to the isolated `bench/longrun-mock-20261106` branch run only `mock-smoke`.
Other branches do not trigger it on push. Manual dispatch supports the listed modes,
with `live` always blocked. The smoke targets a standard Actions Linux runner;
capability failures stop without changing security settings. Local checks are not
proof of an Actions runtime result; verify the exact run and commit separately.

Reviewed source: `ceyirelehe47/magic-context`, `dsh-integration`, commit
`87434df011fe351ac8f6353d5cf8aa12f6634d5d` (2026-11-06). These additions do not
change the adapter, existing CI, cache benchmark, soak lane, or product defaults.
A complete pinned checkout and dependency installation were subsequently prepared,
and the existing DSH plugin build passed. No repository-wide test pass is claimed.
See `ROUTING-AUDIT.md` for the exact blocked mock-integration attempt.

## Why a separate lane

- `cache-bench/bench.sh` stops at the first historian/other request or native
  compaction start. It cannot answer long-run task completion/recovery questions.
- `soak.sh` primarily uses a deterministic mock and occasional one-turn real-model
  samples. Its stability result is not a sustained live paired comparison.
- `cache-bench/proxy.mjs` forwards client credentials and records calls after the
  fact; it does not pre-reserve a budget or enforce sole network egress.
- `cache-bench/analyze.py` labels a DeepSeek direct-price estimate for an OpenCode
  Go route. It is not verified intermediary billing and not a spending limiter.

## Implemented deliverables

- `driver.py`: deterministic corpus and identical ordered task plan; private answer
  keys; two counterbalanced pairs; strict quality/recovery evidence evaluator;
  clearly labelled offline simulation; fail-closed live capability report.
- `budget.py`: thread-safe, durable, global reservation-ledger component. Every
  admitted request, retry and background role consumes the shared experiment cap.
  Unknown usage keeps its reservation and halts. This is **not wired to HTTP**.
- `test_longrun.py`: offline regression tests for fairness, exact answer scoring,
  post-reduction recovery, failure/incomplete evidence, and budget admission.
- `.github/workflows/dsh-longrun-bench.yml`: manual checks and branch-limited mock smoke;
  requesting live mode deliberately fails instead of obtaining secrets.
- `dsh_adapter.py`, `unix-fetch-bridge.mjs`, `mock_gateway.py`, `smoke_dsh.py`: a
  mock-only real-DSH integration prototype. Actual socket creation was blocked by
  this environment; integration is NOT verified. See `ROUTING-AUDIT.md`.

## Run locally (no dependencies, credentials, DSH or network)

```sh
python3 -m unittest discover \
  -s packages/dsh-plugin/scripts/e2e/longrun-bench -p 'test_*.py' -v
python3 packages/dsh-plugin/scripts/e2e/longrun-bench/driver.py \
  offline --out /tmp/dsh-longrun-offline-unique
python3 packages/dsh-plugin/scripts/e2e/longrun-bench/driver.py live
# Last command must exit 2, with paid_requests_sent=0 and precise blockers.
```

Use `plan --out <new-dir>` for plan/corpus only. Output directories and ledgers
must be new: reusing them fails rather than corrupting or replaying evidence.
`evaluate` accepts `--plan`, `--answers`, `--evidence`, `--out`. Simulator success
is always `real_benchmark_pass=false`, `origin=simulated`, and `cost_usd=null`.
Live evidence is not certified while the integration requirements below are open.

## Proposed real comparison, not yet executed

The question is total cost and quality for the **same completed task**, including
all maintenance work, not cost for a fixed time or before the first compression.

1. Pin the repository SHA and DSH `0.2.1-rc.5`, node/Bun/dependencies. Build one
   plugin artifact. Bootstrap from the existing `bootstrap.sh`; use the same
   clean shipped headless template for both arms. Baseline has no plugin. Plugin
   uses the ordinary `setup` path, without the round-36 diagnostic ablations.
2. Keep the existing model configuration equivalent: `deepseek-v4.1-flash`, 100k
   main route, 200k historian route; 4096/16384 output limits subject to verified
   provider billing ceilings. Preserve shipped compaction thresholds, not an
   artificially favorable equal threshold. Report them explicitly.
3. Prepare 24 batches of 8 approximately 7.5 KB reports, with deterministic noise,
   revision updates, cancellations, owners, ticket identifiers and units. Both
   arms consume byte-identical fixtures and exactly the same 28 user turns.
4. Use two pairs in AB then BA order. Each arm has fresh isolated DSH and XDG
   state, provider session ID and independent random cache nonce, drawn by the
   same rule. The seed/corpus is identical within pairs. Never share Magic DB or
   native sessions between arms. Do not infer statistical significance from n=2.
5. Launch a fresh DSH process for **each** turn while resuming the same arm's
   session ID. Drain and meter background work before closing an arm; historian
   await-at-turn-end is an explicit identical run policy where applicable, not
   evidence that all workers drained. Record actual process exits and persistence.
6. All 24 batch turns must read the eight files in order, one call per step, and
   return all checksums. No shell/web/subagents, scratch files, unrelated sources,
   or rereading old reports. MC `ctx_search`/`ctx_expand` retrieval is allowed and
   counted. At three checkpoints, reconstruct all latest inventory records, the
   original codeword/region/currency and the active-units total from memory.
7. Keep the verifier and answer file outside the model's filesystem. Mount only
   `corpus/` plus the runner's current prompt. A runner with access to the golden
   answers cannot be used to make a trusted live quality claim.
8. Completion requires exact answers, all turns, three proven completed context
   reductions, and a new successful process restart/recovery after each cycle.
   An arm with too few reductions is **inconclusive**, not a win. Do not extend
   only the favorable arm or stop at its first compression. Failed, timed-out,
   budget-limited or incomplete runs remain in the report and paired denominator.

This is a controlled long-context retention/inventory workload. It is not an
end-to-end software-engineering benchmark or proof of performance on every task.

## Real evidence adapter still required

The driver defines, but does not fabricate, the live evidence contract:

- Record actual version/SHA, corpus hashes, arm/session ID, full prompt order,
  process starts/exits, assistant answer, all executed tools and timings.
- Native reductions: join `compaction/start`, `compaction/summary`, and successful
  `compaction/end` by compaction ID. Reject `summary-error`, error-bearing ends,
  start-only and prune-only events. Compare served context before/after.
- MC reductions: correlate successful durable `historian_runs` and covering
  compartment/drop records with the actually reduced served context. A historian
  HTTP request alone is not completion, and a native 90% backstop need not occur
  when Magic is working. Report historian, MC reduction and native backstop counts
  separately. Verify session-scoped durable source identifiers, not booleans.
- Capture per-attempt upstream provider usage, status/abort/retry, role/route,
  prompt/cache hit/cache miss/output/reasoning tokens and cost. Unknown roles are
  included. Native summaries, historian, dreamer, title generation, embeddings,
  retries and failures must all be measured. Classify unknown roles separately.
- Compare totals for each full completed pair, quality per checkpoint and the
  paired cost ratio; also show completion rate, wall latency, recovery latency,
  context reduction count and unknown/incomplete charges. A quality failure must
  not be presented as cost savings.

The evaluator accepts normalized JSON evidence for offline tests. It is not a
source-authentication mechanism, and deliberately cannot certify `origin=live`.

## Required before enabling USD 10 paid execution

User authorization is **USD 10 total incremental cost for this experiment**, not
USD 10 per arm, retry, pair, workflow job or provider. There is no verified price
or credential in this implementation. Do not copy direct DeepSeek rates into
OpenCode Go as if that creates a hard ceiling.

1. Verify the actual seller's billing terms, rates, cached/miss semantics, taxes,
   fees and failure charges; or use an enforceable isolated prepaid/provider
   spending limit. Include any incremental Actions charges, or establish that
   the run consumes no billable Actions allowance. Separate estimates from bills.
2. Implement and verify a credential-isolated sole-egress proxy. DSH/plugin
   processes must receive no usable vendor credential and have no route to the
   internet except that proxy. Use an isolated runner/container network, not an
   environment-variable convention. Deny unapproved routes/models/APIs. Resolve
   embeddings and all background providers explicitly. Prove a direct outbound
   attempt is denied before introducing the credential. Do not alter production
   credentials, permissions, account settings or persistent access for this test.
3. Establish hard per-request input/output billing ceilings, including hidden
   reasoning, provider-added tokens and retries. `max_tokens` is useful only if
   the provider's billing contract proves what it bounds. Unknown models or costs
   are denied **before** dispatch. Cache discounts are not used for reservation.
4. Wire **every** upstream attempt through one `Ledger` shared across all pairs.
   Atomically reserve the worst-case maximum charge before sending. Retain it on
   disconnect/timeout/no usage. No automatic replay after a process failure. Audit
   provider usage and release only proven surplus. A provider exceeding a verified
   bound is a guarantee violation, not evidence the ledger protected the spend.
5. Add actual gateway/runner watchdogs: global 1000 attempted calls, 7200 seconds
   total, 300 seconds per turn, stop on the first failed turn or uncertain charge.
   Block new requests at the deadline, terminate the entire process group, drain
   or conservatively charge in-flight requests, then preserve partial evidence.
   The ledger's admission clock alone does not terminate an in-flight model call.
6. Implement the DSH evidence adapter above and exercise actual DSH locally with a
   mock provider before the paid trial. Existing unit tests do not validate the
   DSH CLI, streaming parser, gateway/network isolation, or installed dependency
   compatibility. No paid canary should run until all charge paths are bounded.

Only then can a live workflow be enabled and reviewed. The current `live` guard
is intentionally code-level, not a `--i-understand` switch or unverified JSON
attestation that could be mistaken for implemented enforcement.

## Review hardening

The evaluator now requires each tool's successful completion, matching call ID,
valid call/result event sequence and turn/step metadata. Reads must occur in
strictly increasing steps, with each preceding result before the next read.
Correct checksum text alone does not prove execution. The simulator supplies
explicitly synthetic event evidence for its tests.

The smoke freezes gateway admission and checks ledger/log agreement, complete
usage and zero unsettled calls before reporting success. Plugin mode also needs
Magic Context runtime-source events in that exact DSH session; successful setup
or configuration alone is insufficient. Actual integration remains unverified.

The mock workflow checks node/unshare/zstd/python availability, avoids the stock
bootstrap's lifecycle-enabled DSH installation, and uses npm/bun --ignore-scripts.
Both arms share one install. Initial transitive resolution is not frozen and is
not asserted identical to local preparation; generated DSH/workspace locks and
versions are uploaded with isolation/session/mock-request evidence. Reproducing
that exact installation later requires those locks, not merely the DSH version.
