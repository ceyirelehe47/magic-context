/**
 * Round 24 (P1-1) — feed core's message-history FTS index from the DSH log.
 *
 * `ctx_search`'s message lane (core `unifiedSearch` → `searchMessageHistory`)
 * only SELECTs from the FTS index; writes are event-driven and the host must
 * trigger them. OpenCode (transform) and Pi (context handler) call core
 * `scheduleReconciliation(db, sessionId, source)` on every context pass; the
 * DSH adapter never did, so on DSH the index stayed empty and every history
 * search answered "No results found" (round 21 U1).
 *
 * The source is the same history view the historian, compartments and
 * ctx_expand number by (`transcriptRawMessageProvider`, round 23: native
 * compaction checkpoints expanded back), so a hit's ordinal is directly
 * `ctx_expand`-able and matches the compartment ranges. `getRevision` is the
 * DSH log's append-only seq, so core re-reconciles only after new events.
 * Round 24c: through `historyContentProvider`, i.e. without Magic's own
 * injected text (m0 baseline, `<ctx-search-hint>`) — never history.
 * Reconciliation runs off the step (core defers it); fail-open.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import { scheduleReconciliation } from "@magic-context/core/features/magic-context/message-index-async";
import type { Database } from "@magic-context/core/shared/sqlite";
import { historyContentProvider } from "./historian-wiring";

export function scheduleDshMessageHistoryIndex(
  db: Database,
  sessionKey: string,
  agent: Agent,
  log?: (message: string) => void,
): void {
  try {
    const source = Object.assign(
      (sessionId: string) => historyContentProvider(agent, sessionId).readMessages(),
      { getRevision: () => Number((agent.session as unknown as { seq?: unknown }).seq ?? 0) },
    );
    scheduleReconciliation(db, sessionKey, source as never);
  } catch (error) {
    log?.(`[magic-context] message-history index scheduling failed (fail-open): ${error instanceof Error ? error.message : String(error)}`);
  }
}
