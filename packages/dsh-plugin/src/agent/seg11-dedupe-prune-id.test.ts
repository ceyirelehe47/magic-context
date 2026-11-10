/**
 * Round 37 seg 11 — small pins next to the limitation 35 fix:
 *   N1-N3 historian noop stderr dedupe keys on the reason without `messages=N`
 *         (evo-22 42805322951 printed all 18 identical noops);
 *   I1-I3 the structural DSH tool-result-pruner identification the native view
 *         uses (transcript.ts isDshPrunerRewrite).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { historianNoopDedupeKey, noopConsoleOnce } from "./historian";
import { DSH_TOOL_RESULT_PRUNE_MARKER, isDshPrunerRewrite } from "./transcript";

const line = (messages: number, offset = 569) =>
  `[magic-context] historian noop: nothing to compact (eligibleEnd=${offset} <= offset=${offset}; boundary=size-walk protectedTailStart=${offset} messages=${messages})`;

describe("round 37 seg 11: historian noop stderr dedupe", () => {
  let saved: string | undefined;
  let printed: string[];
  let original: typeof console.error;
  beforeEach(() => {
    saved = process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN;
    process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN = "1";
    printed = [];
    original = console.error;
    console.error = (...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    };
  });
  afterEach(() => {
    console.error = original;
    if (saved === undefined) delete process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN;
    else process.env.MAGIC_CONTEXT_DEBUG_HISTORIAN = saved;
  });

  it("N1 the dedupe key drops only the volatile messages=N field", () => {
    expect(historianNoopDedupeKey(line(625))).toBe(historianNoopDedupeKey(line(656)));
    expect(historianNoopDedupeKey(line(625))).not.toContain("messages=");
    expect(historianNoopDedupeKey(line(625))).toContain("protectedTailStart=569");
    expect(historianNoopDedupeKey(line(625, 569))).not.toBe(historianNoopDedupeKey(line(625, 600)));
  });

  it("N2 the evo-22 sequence (same reason, messages 625..656) prints once; a changed reason prints again", () => {
    const sid = `noop-dedupe-${Date.now()}`;
    for (let m = 625; m <= 656; m += 2) noopConsoleOnce(sid, line(m));
    expect(printed).toEqual([line(625)]);
    noopConsoleOnce(sid, line(660, 600));
    expect(printed).toEqual([line(625), line(660, 600)]);
    noopConsoleOnce(sid, line(625)); // back to the old reason: it is news again
    expect(printed.length).toBe(3);
  });

  it("N3 dedupe is per session", () => {
    const a = `noop-a-${Date.now()}`;
    const b = `noop-b-${Date.now()}`;
    noopConsoleOnce(a, line(1));
    noopConsoleOnce(b, line(2));
    noopConsoleOnce(a, line(3));
    expect(printed).toEqual([line(1), line(2)]);
  });
});

describe("round 37 seg 11: structural pruner identification (limitation 35)", () => {
  const source = Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n").padEnd(12_000, "z");
  const prune = (text: string) => text.slice(0, 4096) + DSH_TOOL_RESULT_PRUNE_MARKER + text.slice(text.length - 1024);

  it("I1 the pruner's head + marker + tail of its own source is a prune (untagged and tagged sources)", () => {
    expect(isDshPrunerRewrite(source, prune(source))).toBe(true);
    const tagged = `§12§ ${source}`;
    expect(isDshPrunerRewrite(tagged, prune(tagged))).toBe(true);
  });

  it("I2 Magic rewrites are never a prune: tag prefix, drop sentinel, re-tag of a pruned node", () => {
    expect(isDshPrunerRewrite(source, `§12§ ${source}`)).toBe(false);
    expect(isDshPrunerRewrite(source, "[dropped §12§]")).toBe(false);
    const pruned = prune(source);
    expect(isDshPrunerRewrite(pruned, `§12§ ${pruned}`)).toBe(false);
  });

  it("I3 text that only CONTAINS the marker (or a cut of another source) is not a prune", () => {
    const literal = `a${DSH_TOOL_RESULT_PRUNE_MARKER}b`;
    expect(isDshPrunerRewrite(`${literal} plus more text`, literal)).toBe(false);
    expect(isDshPrunerRewrite(source, prune(source.replace("row 1", "ROW 1")))).toBe(false);
  });
});
