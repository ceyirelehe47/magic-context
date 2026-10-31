/**
 * agent/historian-drain — keeps background historian passes alive long enough
 * to publish in short-lived DSH processes.
 *
 * DSH headless (`dsh headless "<task>"`) is one-shot: the process answers the
 * task, unloads the plugin tree and exits, granting roughly 5 s for shutdown.
 * The historian pass is fire-and-forget from the pre-step chain, so without a
 * drain it is killed mid-flight and the next process logs
 * `reclaimed compartment lease from dead owner` — no compartment is ever
 * written.
 *
 * Two bounded waits close that gap:
 *   1. on plugin unload (fiber dispose) the plugin awaits in-flight passes
 *      for at most `UNLOAD_DRAIN_MS` (4 s, under DSH's 5 s budget);
 *   2. optionally at the turn boundary (`agent/turn-stopping`, which DSH
 *      awaits before committing the turn end) for at most
 *      `historian.awaitAtTurnEndMs` /
 *      `MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS`. Off by default:
 *      interactive surfaces (web / tui) must not stall the turn end.
 *
 * Neither wait cancels the pass; a timeout only stops waiting.
 */

/** Unload drain budget (DSH grants ~5 s for the whole shutdown). */
export const UNLOAD_DRAIN_MS = 4_000;

export const AWAIT_TURN_END_ENV = "MAGIC_CONTEXT_DSH_HISTORIAN_AWAIT_TURN_END_MS";

export interface DrainResult {
  /** True when every tracked pass settled before the deadline. */
  readonly settled: boolean;
  /** Passes still running when the wait ended. */
  readonly pending: number;
  readonly waitedMs: number;
}

export interface HistorianDrain {
  /** Track one background pass (rejections are swallowed by the tracker). */
  track(sessionId: string, pass: Promise<unknown>): void;
  /** Number of in-flight passes (all sessions, or one). */
  pending(sessionId?: string): number;
  /** Wait for in-flight passes (all sessions, or one), bounded by `timeoutMs`. */
  drain(timeoutMs: number, sessionId?: string): Promise<DrainResult>;
}

export function createHistorianDrain(now: () => number = Date.now): HistorianDrain {
  const inflight = new Map<Promise<unknown>, string>();
  const select = (sessionId?: string): Promise<unknown>[] =>
    [...inflight.entries()]
      .filter(([, sid]) => sessionId === undefined || sid === sessionId)
      .map(([pass]) => pass);
  return {
    track(sessionId, pass) {
      const guarded: Promise<unknown> = pass.then(
        () => {
          inflight.delete(guarded);
        },
        () => {
          inflight.delete(guarded);
        },
      );
      inflight.set(guarded, sessionId);
    },
    pending(sessionId) {
      return select(sessionId).length;
    },
    async drain(timeoutMs, sessionId) {
      const started = now();
      const passes = select(sessionId);
      if (passes.length === 0) return { settled: true, pending: 0, waitedMs: 0 };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
      });
      const outcome = await Promise.race([
        Promise.all(passes).then(() => "settled" as const),
        timeout,
      ]);
      if (timer !== undefined) clearTimeout(timer);
      return {
        settled: outcome === "settled",
        pending: select(sessionId).length,
        waitedMs: now() - started,
      };
    },
  };
}

/**
 * Resolve the turn-end await budget: the plugin config wins, then the env
 * var; anything non-positive / unparsable disables the wait (0).
 */
export function resolveAwaitAtTurnEndMs(
  configured: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return configured > 0 ? Math.floor(configured) : 0;
  }
  const raw = env[AWAIT_TURN_END_ENV];
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}
