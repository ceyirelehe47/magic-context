/**
 * Count-based protection window for the DSH adapter.
 *
 * Magic Context core ≥0.49 replaced the "protect the newest N tags" integer
 * with a token-floor protection window (`protectedTagNumbers` set + tag-number
 * `protectedCutoff`; see core `features/magic-context/protection-window.ts`).
 * The DSH adapter's config still speaks the count form (`protected_tags`), so
 * this converts "newest N tags" into the window shape the core cleanup and
 * pending-op stages now require.
 *
 * Semantics: the newest `count` tags by tag number (any type) are the
 * protected suffix. Only TOOL tags are reclaimable through any window form,
 * so the member set holds the tool tag numbers inside that suffix and the
 * cutoff is the lowest tag number of the suffix. `cutoff` is null when the
 * session has no tool tags at all (core: "empty persisted tool population").
 */
import type { TagEntry } from "@magic-context/core/features/magic-context/types";

export interface CountProtectionWindow {
  readonly protectedTagNumbers: ReadonlySet<number>;
  readonly protectedCutoff: number | null;
}

export function countProtectionWindow(
  tags: readonly Pick<TagEntry, "tagNumber" | "type">[],
  count: number,
): CountProtectionWindow {
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  const hasTool = tags.some((tag) => tag.type === "tool");
  if (!hasTool) return { protectedTagNumbers: new Set(), protectedCutoff: null };
  const numbers = [...new Set(tags.map((tag) => tag.tagNumber))].sort((a, b) => b - a);
  if (n === 0 || numbers.length === 0) {
    // Nothing protected: cutoff above the newest tag.
    return { protectedTagNumbers: new Set(), protectedCutoff: (numbers[0] ?? 0) + 1 };
  }
  const suffix = numbers.slice(0, n);
  const cutoff = suffix[suffix.length - 1] as number;
  const protectedTagNumbers = new Set(
    tags.filter((tag) => tag.type === "tool" && tag.tagNumber >= cutoff).map((tag) => tag.tagNumber),
  );
  return { protectedTagNumbers, protectedCutoff: cutoff };
}
