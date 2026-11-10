/**
 * The production historian FIRE of the DSH context plane (round 37 phase 2,
 * segment 9): what `ContextPlaneDeps.historian.fire` does when the
 * context-pressure trigger fires — one fire-and-forget background
 * `runDshHistorian` pass, tracked by the in-flight drain.
 *
 * Extracted verbatim from the inline closure in `agent/index.ts` so tests can
 * drive the production wiring (context plane → fire → pass) instead of a copy.
 */
import {
  hasRunnableCompartmentWindow,
  resolveBoundaryContext,
  resolveProtectedTailBoundary,
  type ProtectedTailBoundarySnapshot,
} from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import { escalationBands } from "@magic-context/core/shared/escalation-bands";
import type { Database } from "@magic-context/core/shared/sqlite";
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
  return ({ db, sessionId, directory, provider, contextWindow, routeSessionId, usage, executeThresholdPercentage, contextLimit }) => {
    const limit = contextLimit ?? contextWindow;
    const resolveBoundarySnapshot =
      usage !== undefined && typeof limit === "number" && limit > 0
        ? () => resolveDshProtectedTailBoundary(db, sessionId, { contextLimit: limit, executeThresholdPercentage: executeThresholdPercentage ?? 65, usage })
        : undefined;
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
      ...(resolveBoundarySnapshot !== undefined ? { resolveBoundarySnapshot } : {}),
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

/**
 * Round 37 phase 2 seg 9 (limitation 37): the DSH trigger's protected-tail
 * boundary — core `resolveProtectedTailBoundary` over `resolveBoundaryContext`
 * with the trigger's live usage (token-sized tail, tool-arc fences, live-prompt
 * floor below the force band), the same resolver the Pi trigger uses. At or
 * above the force band a head that is still not runnable is re-resolved with
 * the emergency tail scale (Pi `resolveRunnablePiBoundarySnapshot` parity).
 * Must run under the pass's raw-message provider (`runDshHistorian` calls it
 * inside its provider scope, after taking the lease).
 */
export function resolveDshProtectedTailBoundary(
  db: Database,
  sessionId: string,
  inputs: { contextLimit: number; executeThresholdPercentage: number; usage: { percentage: number; inputTokens: number } },
): ProtectedTailBoundarySnapshot {
  const resolve = (emergencyTailScale?: 0.5 | 0.25) =>
    resolveProtectedTailBoundary(
      resolveBoundaryContext({
        db,
        sessionId,
        mode: "trigger",
        contextLimit: inputs.contextLimit,
        executeThresholdPercentage: inputs.executeThresholdPercentage,
        usage: inputs.usage,
        usageSource: "live",
        providerShapeVersion: "opencode-v1",
        cacheNamespace: `dsh:${sessionId}`,
        ...(emergencyTailScale !== undefined ? { emergencyTailScale } : {}),
      }),
    );
  let snapshot = resolve();
  const force = escalationBands(inputs.executeThresholdPercentage).forceMaterializationPercentage;
  if (!hasRunnableCompartmentWindow(snapshot) && inputs.usage.percentage >= force) {
    snapshot = resolve(inputs.usage.percentage >= 95 ? 0.25 : 0.5);
  }
  return snapshot;
}
