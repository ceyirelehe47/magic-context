/**
 * compat/dsh-0.1/child-session — the single "is this a DSH child session"
 * predicate, dependency-free so both the agent plane (`isMagicChildSession`)
 * and the compaction entry bundle (`MagicCompactionEngine`) share ONE
 * judgement without the compaction bundle importing the agent plane.
 *
 * A child is a session whose header says `origin === 'subagent'` or whose
 * persisted delegation depth is ≥ 1 (dsh 0.2.1-rc.5 session header fields).
 */
export function isDshChildSession(agent: unknown): boolean {
  const header = (agent as { session?: { header?: unknown } } | null | undefined)?.session
    ?.header as { origin?: string; delegationDepth?: number } | undefined;
  if (header?.origin === "subagent") return true;
  return typeof header?.delegationDepth === "number" && header.delegationDepth >= 1;
}
