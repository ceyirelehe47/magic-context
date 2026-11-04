/**
 * Round 27b (C6) — edge cases of the round 26 unsummarized-tail block
 * (`renderUnsummarizedTail`, historian.ts):
 *  1. a huge tail: the cap loop recomputed the block size from scratch for
 *     every dropped line (O(n²)); 40 000 messages took 11.5 s of synchronous
 *     work on the /compact path (10 000: 0.5 s). Must be linear.
 *  2. multilingual text: `clip` cut by UTF-16 code units, so an emoji (or any
 *     astral character) at a clip boundary left a lone surrogate in the
 *     summary text (not well-formed Unicode; sent to the provider as `\ud83d`).
 *  3. CJK text is kept, bounded by the same cap, ordinals intact.
 * Output for plain text is unchanged (same lines, same order, same cap).
 */
import { describe, expect, it } from "bun:test";
import { renderUnsummarizedTail, UNSUMMARIZED_TAIL_MAX_CHARS } from "./historian";

const provider = (n: number, text: (i: number) => string) =>
  ({
    readMessages: () =>
      Array.from({ length: n }, (_, i) => ({ ordinal: i + 1, id: `m${i + 1}`, role: i % 2 ? "assistant" : "user", parts: [{ type: "text", text: text(i) }] })),
  }) as never;

const wellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("unsummarized tail edge cases (round 27b C6)", () => {
  it("a huge tail renders in linear time and stays under the cap, newest user line kept", () => {
    const n = 30_000;
    const started = performance.now();
    const out = renderUnsummarizedTail(provider(n, (i) => `msg ${i} ${"x".repeat(200)}`), 1, n);
    const ms = performance.now() - started;
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(UNSUMMARIZED_TAIL_MAX_CHARS);
    expect(out).toContain(`[${n - 1}] user: msg ${n - 2} `); // newest user line (ordinal n-1)
    expect(out).not.toContain("] assistant:"); // assistants dropped first
    expect(ms).toBeLessThan(1_500); // before: ≈ 6 s (O(n²)); after: tens of ms
  });

  it("clipping never splits a surrogate pair (emoji at the 2000 / 600 / 400 boundaries)", () => {
    const user = `${"a".repeat(1998)}${"😀".repeat(10)}`; // 2000-char clip lands inside an emoji
    const assistant = `${"b".repeat(598)}${"🚀".repeat(10)}`; // 600-char clip
    const one = renderUnsummarizedTail(provider(2, (i) => (i === 0 ? user : assistant)), 1, 2);
    expect(one).toContain("[1] user:");
    expect(one).toContain("[2] assistant:");
    expect(wellFormed(one)).toBe(true);
    // over the cap → user lines re-clipped to 400 (boundary inside an emoji)
    const many = renderUnsummarizedTail(provider(40, () => `${"c".repeat(398)}${"🎉".repeat(900)}`), 1, 40);
    expect(many.length).toBeGreaterThan(0);
    expect(wellFormed(many)).toBe(true);
  });

  it("CJK tail is kept verbatim at the start of each line and bounded", () => {
    const zh = "用户约束：所有数据库迁移必须在前台执行。";
    const out = renderUnsummarizedTail(provider(40, () => zh.repeat(100)), 1, 40);
    expect(out.length).toBeLessThanOrEqual(UNSUMMARIZED_TAIL_MAX_CHARS);
    expect(out).toContain(`[39] user: ${zh}`);
    expect(wellFormed(out)).toBe(true);
  });

  it("plain text output is unchanged by the rewrite (golden: small tail, no cap)", () => {
    const out = renderUnsummarizedTail(provider(4, (i) => `line ${i}`), 1, 4);
    expect(out.split("\n").slice(2)).toEqual(["[1] user: line 0", "[2] assistant: line 1", "[3] user: line 2", "[4] assistant: line 3", "</unsummarized_tail>"]);
  });
});
