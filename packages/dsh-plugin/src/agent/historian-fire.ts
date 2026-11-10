/**
 * The production historian FIRE of the DSH context plane (round 37 phase 2,
 * segment 9): what `ContextPlaneDeps.historian.fire` does when the
 * context-pressure trigger fires — one fire-and-forget background
 * `runDshHistorian` pass, tracked by the in-flight drain.
 *
 * Extracted verbatim from the inline closure in `agent/index.ts` so tests can
 * drive the production wiring (context plane → fire → pass) instead of a copy.
 */
import type { ContextPlaneDeps } from "./context-plane";
import type { HistorianDrain } from "./historian-drain";
import {
  runDshHistorian,
  signalDshDeferredHistoryRefresh,
  signalDshDeferredMaterialization,
  type DshSummarizeCall,
  type HistorianDeps,
} from "./historian";

export type DshHistorianFireArgs = Parameters<NonNullable<ContextPlaneDeps["historian"]>["fire"]>[0];

export interface DshHistorianFireDeps {
  /** The historian LLM call for one pass (production: `createLlmSummarizeCall`). */
  readonly summarizeFor: (routeSessionId: string | undefined) => DshSummarizeCall;
  /** Historian model id for the chunk budget (production: the session route). */
  readonly model: () => string | undefined;
  /** E2E-only hold (`e2eHistorianHold`); production passes none. */
  readonly beforePublish?: HistorianDeps["beforePublish"];
  readonly drain?: HistorianDrain;
  readonly log: (message: string) => void;
}

export function createDshHistorianFire(deps: DshHistorianFireDeps): (args: DshHistorianFireArgs) => void {
  const log = deps.log;
  return ({ db, sessionId, directory, provider, contextWindow, routeSessionId }) => {
    // Fire-and-forget: the pass publishes atomically and only signals
    // deferred work; it must never block the pre-step chain.
    const pass = runDshHistorian({
      db,
      sessionId,
      directory,
      provider,
      summarize: deps.summarizeFor(routeSessionId),
      model: deps.model(),
      currentContextLimit: contextWindow,
      onPublished: () => {
        signalDshDeferredHistoryRefresh(sessionId);
        signalDshDeferredMaterialization(sessionId);
      },
      ...(deps.beforePublish !== undefined ? { beforePublish: deps.beforePublish } : {}),
      log,
    }).catch((error: unknown) => {
      log(`[magic-context] historian pass failed (background): ${error instanceof Error ? error.message : String(error)}`);
    });
    deps.drain?.track(sessionId, pass);
  };
}
