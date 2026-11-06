# Call-path and environment audit (2026-11-06)

Source HEAD: `87434df011fe351ac8f6353d5cf8aa12f6634d5d`.
Installed DSH: `0.2.1-rc.5`; Node: `v24.22.1`; Bun: `1.4.2`.
This is an engineering audit, not a live benchmark result.

## Paths that must be inside the same experiment budget

1. Main agent: DSH `dsh-llm-pi-ai/lib/index.js` resolves the selected provider,
   credential and model, then calls pi-ai `streamSimple`. Provider/model overrides
   can change the endpoint. A main-provider URL override alone is insufficient.
2. Native summarizer: `@deepseek-ai/dsh-compaction-basic` invokes the DSH LLM for
   compaction. Count actual downstream attempts, not just `compaction/start`.
3. Historian and repair: `src/agent/historian-wiring.ts:226` calls `llm.stream` with
   the current route or `historian.model`. Repair calls use the same entry with
   another prompt, so a successful historian run may cost multiple requests.
4. Recompaction: `src/agent/recomp.ts:300` independently calls `llm.stream` with
   `purpose=compaction`. It cannot be omitted merely because it is not historian.
5. Dreamer: `src/agent/dreamer.ts:279` calls `llm.stream`; the per-task model may
   override the current selection. Classifier/reviewer/retrospective work can
   run on separate schedules.
6. Child workers: `src/agent/worker.ts:154` calls `subagents.startActivation`.
   Every spawned Node/worker process must inherit the isolated environment and
   cannot receive a usable provider credential or an alternate network route.
7. Embeddings: `embedding-wiring.ts` registers the project's shared core provider
   and auto-backfill. `packages/plugin/src/plugin/embedding-bootstrap.ts` reads
   primary and shadow routes. `memory/embedding-openai.ts:476` directly fetches
   `${endpoint}/embeddings`, outside `ctx.llm.stream`; Synapse can retry (its
   `embedding-synapse.ts:1119` loop has up to three retries). Local providers can
   download model assets. A main/historian proxy does not cover these paths.
8. Titles: installed `dsh-session-title-llm` is a separate model-calling policy.
9. Retries: installed `dsh-llm-retry` persists `llm/retry` events and can schedule
   provider-routed retries. The installed pi-ai/SDK may have further transport
   retry behavior. One reservation is required per actual HTTP attempt.
10. Provider model discovery/auth endpoints also use HTTP. Only explicitly
    required inference routes should be allowed during the benchmark; reject
    other URLs before dispatch and do not add account access or permissions.

A gateway must deny missing/unknown routes. Merely finding no hidden request in a
short run does not prove complete interception. A clean HOME/DSH_HOME/XDG setup
and no inherited real credentials are necessary, but not enough without isolation.

## Verified preparation

- Full repository clone retrieved at the pinned SHA. No remote writes.
- DSH installation with npm `--ignore-scripts`; `dsh --version` returned
  `0.2.1-rc.5`.
- A new clean headless profile initialized with an explicit, minimal environment;
  no real provider credentials were supplied.
- The existing filtered workspace dependency installation completed, and the
  unmodified DSH plugin `bun run build` succeeded. This is not the full test suite.
- Temporary user/network/PID namespaces were available. Reading `/proc/net/route`
  returned empty routes; a native socket connect to `1.1.1.1:443` returned
  `ENETUNREACH` (errno 101). The child proc view contained only PID 1.
- `ip link` could not create a netlink socket (EPERM), so no loopback reconfiguration
  was attempted through another interface.

## Attempted real-DSH/local-mock integration and exact blocker

Added a **mock-only prototype**:

- `dsh_adapter.py` parses actual DSH CLI/session event schemas, validates final
  completion/session continuity, joins tool results, and distinguishes successful
  native summary events from starts/errors. It does not yet correlate MC durable
  drops with served-token decreases, so it cannot certify multicycle recovery.
- `unix-fetch-bridge.mjs` permits only two `http://longrun.invalid` mock routes via
  a Unix socket, with no arbitrary fetch fallback or credentials.
- `mock_gateway.py` exposes only those routes and forwards only to a local mock
  at fixed `127.0.0.1`; it reserves against the shared ledger and parses JSON/SSE
  usage. Its USD-looking rates are explicitly synthetic unit-test inputs. It
  currently buffers responses, so it must not be substituted for a timing-neutral
  live gateway. There is no vendor upstream, key option or live mode.
- `smoke_dsh.py` prepares two actual DSH process turns in empty-network/PID
  namespaces and checks session resume and completed read calls. It accepts an
  existing checkout/DSH install only, never a credential or paid model.

The attempted smoke stopped **before any DSH inference request** at
`socket.socket(AF_UNIX, SOCK_STREAM)`: the execution environment returned
`PermissionError: [Errno 1] Operation not permitted`. No Unix socket was created,
no model response was obtained, and no real-model charge occurred. The source
profile/build checks above completed before this blocker. No claim that the
mock gateway, bridge, or actual DSH turn passed integration is made.

## Minimal next step, without claiming USD 10 safety

1. The user explicitly requested GitHub Actions. The independent workflow now
   offers `mock-smoke` on a standard Linux runner, with Unix-socket and unshare
   capability checks BEFORE dependency installation. This targets the requested
   environment, not a bypass of this workspace restriction. It has NOT been
   dispatched or independently verified. If the capability test fails there,
   the job stops: no sudo fallback, sysctl change, or security-setting changes.
   It uses no model secrets or live endpoint. Actions minutes may still be billed
   depending on the repository plan/remaining allowance.
2. Add session-scoped MC SQLite evidence and actual served-context measurements,
   then run the entire no-charge multicycle workload through the isolated gateway.
3. For paid work, independently obtain either an enforceable isolated provider
   spending limit or verified actual OpenCode Go rates **and** per-request billed
   token/fee ceilings (including failures/reasoning). Include possible Actions
   incremental charges. A direct-DeepSeek price estimate is not enough.

The root `driver.py live` remains unconditionally fail-closed. Current results
are preparation, unit tests and a blocked integration attempt, not a long-run
DSH-vs-Magic conclusion.
