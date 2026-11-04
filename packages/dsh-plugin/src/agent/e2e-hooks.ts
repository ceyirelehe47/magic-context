/**
 * agent/e2e-hooks — E2E-ONLY switches for the real-DSH CI scenarios (round 22).
 *
 * Every switch is inert unless BOTH the master gate `MAGIC_CONTEXT_DSH_E2E=1`
 * and the switch's own variable are set. Production never sets either (no
 * config key, no settings field, no CLI flag reaches them); `ci-e2e.sh` sets
 * them for single runs only. When the gate is off nothing is registered.
 *
 *   MAGIC_CONTEXT_DSH_E2E_HISTORIAN_HOLD_MS=<ms>
 *       a BACKGROUND historian pass keeps the compartment lease until at least
 *       <ms> after it acquired it, i.e. sleeps before publishing (never longer
 *       than the remainder). Makes the lease overlap a native compaction on
 *       demand (scenario L: lock collision).
 *   MAGIC_CONTEXT_DSH_E2E_COMPACT_AT_IDLE=1
 *       when the main session's agent goes idle after its first turn of this
 *       process, run `/compact` through the DSH command registry
 *       (`ctx.commands.execute(agent, "/compact")` — the same registry entry
 *       and `compaction.compactNow` call a user's `/compact` takes). Headless
 *       has no slash-command step; the call starts synchronously inside the
 *       `agent/status` idle emission, so `agent.runMaintenance` is entered
 *       before `dsh headless` re-checks `whenIdle()` and the process waits for
 *       it. Once per process.
 *   MAGIC_CONTEXT_DSH_E2E_FAKE_LEASE_MS=<ms>
 *       with COMPACT_AT_IDLE: just before `/compact`, hold the session's
 *       compartment lease under a fake holder for <ms> (a stuck historian
 *       stand-in) — the cheap timeout branch of the `/compact` lease wait.
 *   MAGIC_CONTEXT_DSH_E2E_SUMMARIZE_LEASE_WAIT_MS=<ms>
 *       overrides the summarize hook's lease wait (default 45 s) so the
 *       timeout branch completes in seconds.
 *   MAGIC_CONTEXT_DSH_E2E_STATUS_DUMP=<absolute path>
 *       appends one JSON line per main-session pre-step (hot values, the
 *       persisted protection floor, pending-restart keys) and one per turn end
 *       with the live readouts the user sees: the settings page view
 *       (`magicContextRemote.settings()`), the composer popover
 *       (`magicContextRemote.context()`), and `/ctx-status` executed through
 *       the DSH command registry (scenario K: pending restart vs hot keys in
 *       one long process).
 *
 *   MAGIC_CONTEXT_DSH_E2E_CRASH_AT=<point>
 *       (round 23b, P0-2) SIGKILL this process at the named point — the
 *       crash-recovery tests' fault injection. Points: outbox-pending (saga
 *       row written, surface not replaced), surface-applied (surface replaced,
 *       saga not acknowledged), historian-leased (lease taken, nothing
 *       published), historian-publish (inside the publish transaction, before
 *       COMMIT), historian-published (after COMMIT, before the lease release),
 *       tail-fold-pending (round 27: the view ends in an unreplaced tail fold —
 *       a tool result with no reply — and its tags are written, the surface
 *       replace not yet enqueued: the round 26 Y4 window, deterministic).
 *
 * All output also goes to stderr as `[magic-context] e2e: …` lines (headless
 * prints console.error, not ctx.logger).
 */
import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const E2E_GATE_ENV = "MAGIC_CONTEXT_DSH_E2E";
export const E2E_HISTORIAN_HOLD_ENV = "MAGIC_CONTEXT_DSH_E2E_HISTORIAN_HOLD_MS";
export const E2E_COMPACT_AT_IDLE_ENV = "MAGIC_CONTEXT_DSH_E2E_COMPACT_AT_IDLE";
export const E2E_FAKE_LEASE_ENV = "MAGIC_CONTEXT_DSH_E2E_FAKE_LEASE_MS";
export const E2E_SUMMARIZE_LEASE_WAIT_ENV = "MAGIC_CONTEXT_DSH_E2E_SUMMARIZE_LEASE_WAIT_MS";
export const E2E_STATUS_DUMP_ENV = "MAGIC_CONTEXT_DSH_E2E_STATUS_DUMP";
export const E2E_CRASH_AT_ENV = "MAGIC_CONTEXT_DSH_E2E_CRASH_AT";
export const E2E_WORKER_PROMPT_SUFFIX_ENV = "MAGIC_CONTEXT_DSH_E2E_WORKER_PROMPT_SUFFIX";

/**
 * Round 25 (P1-3, scenario W): a mock-plan marker (`[[MOCK:<plan>]]`, nothing
 * else accepted) appended to the worker self-test's prompt, so the
 * deterministic mock model can make the worker's CHILD force calls to tools
 * outside its allowlist (bash / write). Inert unless the master gate is open;
 * the self-test tool itself is registered only with
 * MAGIC_CONTEXT_DSH_WORKER_SELFTEST=1.
 */
export function e2eWorkerPromptSuffix(env: Env = process.env): string | undefined {
  if (!e2eGateOpen(env)) return undefined;
  const raw = env[E2E_WORKER_PROMPT_SUFFIX_ENV];
  return typeof raw === "string" && /^\[\[MOCK:[a-z0-9_-]{1,32}\]\]$/i.test(raw) ? raw : undefined;
}

export type E2eCrashPoint =
  | "outbox-pending"
  | "surface-applied"
  | "historian-leased"
  | "historian-publish"
  | "historian-published"
  | "tail-fold-pending";

/**
 * Round 23b (P0-2) fault injection: SIGKILL the process at `point` when the
 * master gate and `MAGIC_CONTEXT_DSH_E2E_CRASH_AT=<point>` are set. Inert in
 * production (one env read, returns).
 */
export function e2eCrashPoint(point: E2eCrashPoint, env: Env = process.env): void {
  if (env[E2E_CRASH_AT_ENV] !== point || !e2eGateOpen(env)) return;
  e2eSay(`crash point ${point}: SIGKILL pid ${process.pid}`);
  process.kill(process.pid, "SIGKILL");
}

type Env = Record<string, string | undefined>;

/** Master gate: every e2e switch is inert unless `MAGIC_CONTEXT_DSH_E2E=1`. */
export function e2eGateOpen(env: Env = process.env): boolean {
  return env[E2E_GATE_ENV] === "1";
}

/** A positive integer ms switch (≤ `max`), or undefined when the gate/switch is off or invalid. */
export function e2eMs(name: string, env: Env = process.env, max = 300_000): number | undefined {
  if (!e2eGateOpen(env)) return undefined;
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > max) return undefined;
  return n;
}

export function e2eFlag(name: string, env: Env = process.env): boolean {
  return e2eGateOpen(env) && env[name] === "1";
}

/** An absolute path switch, or undefined. */
export function e2ePath(name: string, env: Env = process.env): string | undefined {
  if (!e2eGateOpen(env)) return undefined;
  const raw = env[name];
  return typeof raw === "string" && raw.length > 0 && isAbsolute(raw) ? raw : undefined;
}

export function e2eSay(line: string): void {
  try {
    // eslint-disable-next-line no-console
    console.error(`[magic-context] e2e: ${line}`);
  } catch {
    // diagnostics only
  }
}

/**
 * Background historian hold (scenario L): returns a `beforePublish` hook for
 * `runDshHistorian` that sleeps until `holdMs` after `acquiredAt`, or
 * undefined (production: no hook at all).
 */
/** Round 23b: active e2e holds (sessionId → hold end), read by the /compact-at-idle line. */
const activeHolds = new Map<string, number>();

/** Remaining ms of an active e2e historian hold on `sessionId` (0 when none). */
export function e2eHoldRemainingMs(sessionId: string, now = Date.now()): number {
  const until = activeHolds.get(sessionId);
  return until === undefined ? 0 : Math.max(0, until - now);
}

export function e2eHistorianHold(
  env: Env = process.env,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): ((info: { sessionId: string; acquiredAt: number }) => Promise<void>) | undefined {
  const holdMs = e2eMs(E2E_HISTORIAN_HOLD_ENV, env, 120_000);
  if (holdMs === undefined) return undefined;
  return async ({ sessionId, acquiredAt }) => {
    const remaining = acquiredAt + holdMs - Date.now();
    activeHolds.set(sessionId, acquiredAt + holdMs);
    e2eSay(`historian holding the compartment lease of ${sessionId} before publish (hold ${holdMs}ms, sleeping ${Math.max(0, remaining)}ms)`);
    try {
      if (remaining > 0) await sleep(remaining);
    } finally {
      activeHolds.delete(sessionId);
    }
  };
}

/** Summarize-hook lease wait override (scenario L timeout branch). */
export function e2eSummarizeLeaseWaitMs(env: Env = process.env): number | undefined {
  return e2eMs(E2E_SUMMARIZE_LEASE_WAIT_ENV, env, 120_000);
}

/* ─────────────────────────────── /compact at idle ─────────────────────────── */

interface CommandsLike {
  execute(agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<
    { commandId: unknown; result: { kind: string; text?: string } } | undefined
  >;
}

export interface CompactAtIdleDeps {
  /** `ctx.on` (agent/status listener). */
  on(event: "agent/status", listener: (payload: { agent: unknown; status: string }) => void): (() => unknown) | void;
  /** DSH command registry (`ctx.commands`), read lazily. */
  commands(): CommandsLike | undefined;
  isChild(agent: unknown): boolean;
  /** Is a historian pass holding this agent's compartment lease? */
  historianBusy(agent: unknown): boolean;
  /**
   * Hold the lease under a fake holder for at most `ms` (timeout branch).
   * Returns the release function, or undefined when it could not acquire.
   */
  fakeLease?(agent: unknown, ms: number): (() => void) | undefined;
  /** Round 23b: remaining ms of the e2e historian hold on this agent's session (0 = none). */
  holdRemainingMs?(agent: unknown): number;
  env?: Env;
  say?: (line: string) => void;
}

/**
 * Register the `/compact`-at-idle trigger. Returns undefined (nothing
 * registered) unless the gate and `MAGIC_CONTEXT_DSH_E2E_COMPACT_AT_IDLE=1`
 * are set.
 */
export function registerE2eCompactAtIdle(deps: CompactAtIdleDeps): (() => unknown) | undefined {
  const env = deps.env ?? process.env;
  if (!e2eFlag(E2E_COMPACT_AT_IDLE_ENV, env)) return undefined;
  const say = deps.say ?? e2eSay;
  const fakeMs = e2eMs(E2E_FAKE_LEASE_ENV, env, 120_000);
  let fired = false;
  const off = deps.on("agent/status", ({ agent, status }) => {
    if (fired || status !== "idle" || deps.isChild(agent)) return;
    const commands = deps.commands();
    if (commands === undefined || typeof commands.execute !== "function") {
      fired = true;
      say("/compact at idle skipped: ctx.commands unavailable");
      return;
    }
    fired = true;
    let release: (() => void) | undefined;
    if (fakeMs !== undefined && deps.fakeLease !== undefined) release = deps.fakeLease(agent, fakeMs);
    const fake = release !== undefined;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const releaseOnce = () => {
      if (releaseTimer !== undefined) clearTimeout(releaseTimer);
      const r = release;
      release = undefined;
      if (r !== undefined) {
        try {
          r();
          say("/compact at idle: fake lease released");
        } catch {
          // best effort; the lease TTL reclaims it
        }
      }
    };
    if (fake && fakeMs !== undefined) releaseTimer = setTimeout(releaseOnce, fakeMs);
    const busy = deps.historianBusy(agent);
    const started = Date.now();
    const holdLeft = deps.holdRemainingMs?.(agent) ?? 0;
    say(`/compact at idle: start historianBusy=${busy} fakeLease=${fake ? `${fakeMs}ms` : "no"} holdRemainingMs=${holdLeft}`);
    // Synchronous up to compactNow → agent.runMaintenance (see module doc).
    let pending: Promise<unknown>;
    try {
      pending = commands.execute(agent, "/compact", [], new AbortController().signal);
    } catch (error) {
      releaseOnce();
      say(`/compact at idle: threw ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    void Promise.resolve(pending).then(
      (out) => {
        releaseOnce();
        const r = (out as { result?: { kind?: string; text?: string } } | undefined)?.result;
        say(`/compact at idle: done kind=${r?.kind ?? "unresolved"} elapsedMs=${Date.now() - started} text=${JSON.stringify((r?.text ?? "").slice(0, 200))}`);
      },
      (error: unknown) => {
        releaseOnce();
        say(`/compact at idle: error elapsedMs=${Date.now() - started} ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  });
  return typeof off === "function" ? off : undefined;
}

/* ──────────────────────────────── status dump ─────────────────────────────── */

export interface StatusDumpDeps {
  env?: Env;
  /** `ctx.on` for agent/pre-step (observer, calls next) and agent/turn-stopping. */
  on(event: string, listener: (payload: any, next?: () => Promise<unknown>) => unknown): (() => unknown) | void;
  isChild(agent: unknown): boolean;
  /** Per-step snapshot (hot values, floor, pending keys) — must not throw. */
  stepSnapshot(agent: unknown): Record<string, unknown>;
  /** Turn-end readouts (settings view, popover, /ctx-status) — may be async. */
  turnSnapshot(agent: unknown): Promise<Record<string, unknown>>;
  write?: (path: string, line: string) => void;
}

export function registerE2eStatusDump(deps: StatusDumpDeps): Array<() => unknown> {
  const path = e2ePath(E2E_STATUS_DUMP_ENV, deps.env ?? process.env);
  if (path === undefined) return [];
  const write = deps.write ?? ((p: string, line: string) => appendFileSync(p, line));
  const emit = (row: Record<string, unknown>) => {
    try {
      write(path, `${JSON.stringify({ at: Date.now(), ...row })}\n`);
    } catch (error) {
      e2eSay(`status dump write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const offs: Array<() => unknown> = [];
  const a = deps.on("agent/pre-step", async (payload: { agent: unknown; turn?: number; step?: number }, next?: () => Promise<unknown>) => {
    try {
      if (!deps.isChild(payload.agent)) {
        emit({ kind: "step", turn: payload.turn, step: payload.step, ...deps.stepSnapshot(payload.agent) });
      }
    } catch (error) {
      emit({ kind: "step-error", error: error instanceof Error ? error.message : String(error) });
    }
    return next?.();
  });
  if (typeof a === "function") offs.push(a);
  const b = deps.on("agent/turn-stopping", async (payload: { agent: unknown; turn?: number }) => {
    if (deps.isChild(payload.agent)) return;
    try {
      emit({ kind: "turn", turn: payload.turn, ...(await deps.turnSnapshot(payload.agent)) });
    } catch (error) {
      emit({ kind: "turn-error", error: error instanceof Error ? error.message : String(error) });
    }
  });
  if (typeof b === "function") offs.push(b);
  e2eSay(`status dump enabled → ${path}`);
  return offs;
}
