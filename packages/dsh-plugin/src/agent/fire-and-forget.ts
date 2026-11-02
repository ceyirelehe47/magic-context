/**
 * agent/fire-and-forget — detach a promise without leaving its rejection
 * unhandled (Node ≥15 terminates the process on an unhandled rejection).
 * The failure is logged once and otherwise ignored (fail-open).
 */
export function fireAndForget(
  work: unknown,
  log: ((message: string) => void) | undefined,
  label: string,
): void {
  if (work === null || typeof work !== "object" || typeof (work as { then?: unknown }).then !== "function") return;
  (work as PromiseLike<unknown>).then(undefined, (error: unknown) => {
    try {
      log?.(`[magic-context] ${label} failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // a broken logger must not re-raise the rejection
    }
  });
}
