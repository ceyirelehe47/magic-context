/**
 * Harness identity boundary for the DSH adapter.
 *
 * Core's `HarnessId` (packages/plugin/src/shared/harness.ts) includes `"dsh"`
 * since round 10 (type-only: the runtime value was already `"dsh"` through a
 * cast here, so every row the DSH adapter ever wrote already carries
 * `harness = 'dsh'` — no migration). This module:
 *  1. declares the DSH harness identity as the runtime string "dsh";
 *  2. locks it with core `setHarness` (no cast any more);
 *  3. derives the canonical Magic session key for a DSH session:
 *     `dsh:<home-hash>:<dsh-session-id>` (PLAN §2 SQLite row note), which is
 *     INVERTIBLE — the DSH-native session id is recoverable by parsing, so no
 *     separate external identity map table is required (recorded deviation).
 *
 * Call sites must invoke `setDshHarness()` before the first database write,
 * exactly like the Pi adapter calls `setHarness("pi")`.
 */
import { setHarness, getHarness, type HarnessId } from "@magic-context/core/shared/harness";

/** DSH harness identity as persisted into the shared SQLite `harness` column. */
export const DSH_HARNESS = "dsh" as const;

/** The DSH member of core's `HarnessId` union. */
export type DshHarnessId = Extract<HarnessId, "dsh">;

/** Lock the harness identity to "dsh" (idempotent; throws on a different value). */
export function setDshHarness(): void {
  setHarness(DSH_HARNESS);
}

/** Current harness identity (runtime string). */
export function currentHarness(): string {
  return getHarness();
}

/** Canonical Magic session key namespace prefix (compatibility.json database.sessionKeyNamespace). */
export const DSH_SESSION_KEY_PREFIX = "dsh";

/** Separator between canonical-key segments. */
const SEP = ":";

/**
 * Derive the canonical Magic session key for a DSH session.
 * @param homeHash - stable short hash of the DSH home (e.g. first 8 hex chars of sha256).
 * @param dshSessionId - the DSH-native session id (header.id).
 * @returns `dsh:<homeHash>:<dshSessionId>`.
 */
export function canonicalSessionKey(homeHash: string, dshSessionId: string): string {
  if (homeHash.length === 0) throw new Error("canonicalSessionKey: homeHash must be non-empty");
  if (dshSessionId.length === 0) throw new Error("canonicalSessionKey: dshSessionId must be non-empty");
  if (dshSessionId.includes(SEP)) {
    throw new Error(`canonicalSessionKey: dshSessionId must not contain "${SEP}"`);
  }
  return `${DSH_SESSION_KEY_PREFIX}${SEP}${homeHash}${SEP}${dshSessionId}`;
}

/** Parsed canonical DSH session key. */
export interface ParsedDshSessionKey {
  readonly homeHash: string;
  readonly dshSessionId: string;
}

/**
 * Invert {@link canonicalSessionKey}. Returns undefined for keys that are not
 * in the canonical DSH form (e.g. an OpenCode or Pi session id, or a key from
 * a different home hash).
 */
export function parseDshSessionKey(key: string): ParsedDshSessionKey | undefined {
  if (typeof key !== "string") return undefined;
  const first = key.indexOf(SEP);
  if (first <= 0) return undefined;
  if (key.slice(0, first) !== DSH_SESSION_KEY_PREFIX) return undefined;
  const second = key.indexOf(SEP, first + 1);
  if (second <= first + 1 || second === key.length - 1) return undefined;
  const homeHash = key.slice(first + 1, second);
  const dshSessionId = key.slice(second + 1);
  if (homeHash.length === 0 || dshSessionId.length === 0) return undefined;
  return { homeHash, dshSessionId };
}
