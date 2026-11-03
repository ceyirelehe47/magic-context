import { describe, expect, it } from "bun:test";
import { stripPersistedAssistantText } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import {
  TagNotationFilter,
  createOutputTagStripListener,
  registerOutputTagStrip,
  requestCarriesMagicTags,
  stripTagNotationStream,
} from "./output-tag-strip";

/**
 * Round 17 (real rc.5 e2e run 41537851210, check C5): every reply of a Magic
 * session reached the user as "§8§ The first exported …" — the model copies
 * the `§N§ ` prefix Magic puts on every message, and DSH had no persistence
 * boundary that strips it (upstream: OpenCode `experimental.text.complete`,
 * Pi `message_end`). These tests pin the `llm/stream` boundary that does.
 */

type Chunk = { type: string; index?: number; text?: string; block?: Record<string, unknown> };

async function collect(chunks: Chunk[]): Promise<Chunk[]> {
  async function* source() {
    for (const c of chunks) yield c;
  }
  const out: Chunk[] = [];
  for await (const c of stripTagNotationStream(source())) out.push(c);
  return out;
}

function streamed(text: string, cuts: number[]): string[] {
  const pieces: string[] = [];
  let at = 0;
  for (const cut of cuts) {
    pieces.push(text.slice(at, cut));
    at = cut;
  }
  pieces.push(text.slice(at));
  return pieces.filter((p) => p.length > 0);
}

function run(pieces: string[]): string {
  const f = new TagNotationFilter();
  let out = "";
  for (const p of pieces) out += f.push(p);
  out += f.flush();
  expect(out).toBe(f.text);
  return out;
}

describe("TagNotationFilter (streaming §N§ strip)", () => {
  it("drops a leading §N§ prefix and the whitespace after it, however the deltas split it", () => {
    const text = "§8§ The first exported constant is `ADAPTER_META_KEY`.";
    const want = "The first exported constant is `ADAPTER_META_KEY`.";
    expect(run([text])).toBe(want);
    for (let a = 1; a < 8; a += 1) {
      for (let b = a + 1; b < 10; b += 1) expect(run(streamed(text, [a, b]))).toBe(want);
    }
  });

  it("drops stacked prefixes and mid-text pairs, keeps legitimate § and digits", () => {
    expect(run(["§3§ §4§ hello"])).toBe("hello");
    expect(run(["see §12§ above"])).toBe("see  above");
    expect(run(["Art. § 5 and §5.1 stay; 99 files"])).toBe("Art. § 5 and §5.1 stay; 99 files");
    expect(run(["price §", "12 total"])).toBe("price §12 total");
    expect(run(["ends with §1"])).toBe("ends with §1");
    expect(run(["§§ odd"])).toBe("§§ odd");
  });

  it("keeps leading whitespace that is not followed by a prefix", () => {
    expect(run(["  ", "hi"])).toBe("  hi");
    expect(run(["   "])).toBe("   ");
    expect(run(["\n", "§2§", " ", "ok"])).toBe("ok");
  });

  it("agrees with core stripPersistedAssistantText on the shapes real models emit", () => {
    for (const text of [
      "§23§ AMBER-FALCON-7319",
      "§11§ The first exported constant is `MAGIC_PRESSURE_KEY` (line 36).",
      "§3§ WORKER_SELFTEST {\"ok\":false}",
      "plain answer with no tags",
    ]) {
      expect(run([text])).toBe(stripPersistedAssistantText(text));
    }
  });
});

describe("stripTagNotationStream", () => {
  it("filters text deltas per block, rewrites the text block-end, leaves reasoning and tool calls alone", async () => {
    const out = await collect([
      { type: "block-start", index: 0 },
      { type: "reasoning-delta", index: 0, text: "Reply with tag §2§" },
      { type: "block-end", index: 0, block: { type: "reasoning", text: "Reply with tag §2§" } },
      { type: "block-start", index: 1 },
      { type: "text-delta", index: 1, text: "§2" },
      { type: "text-delta", index: 1, text: "3§ AMBER" },
      { type: "text-delta", index: 1, text: "-FALCON §" },
      { type: "block-end", index: 1, block: { type: "text", text: "§23§ AMBER-FALCON §" } },
      { type: "tool-call-delta", index: 2, argumentsDelta: "{\"q\":\"§4§\"}" },
      { type: "finish" },
    ] as never);
    const text = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    expect(text).toBe("AMBER-FALCON §");
    const ends = out.filter((c) => c.type === "block-end");
    expect(ends[0]?.block).toEqual({ type: "reasoning", text: "Reply with tag §2§" });
    expect(ends[1]?.block).toEqual({ type: "text", text: "AMBER-FALCON §" });
    expect(out.find((c) => c.type === "reasoning-delta")?.text).toBe("Reply with tag §2§");
    expect(out.find((c) => c.type === "tool-call-delta")).toEqual({
      type: "tool-call-delta",
      index: 2,
      argumentsDelta: "{\"q\":\"§4§\"}",
    });
    expect(out[out.length - 1]?.type).toBe("finish");
  });

  it("filters a text block that arrives whole (no deltas)", async () => {
    const out = await collect([{ type: "block-end", index: 0, block: { type: "text", text: "§7§ done" } }]);
    expect(out).toEqual([{ type: "block-end", index: 0, block: { type: "text", text: "done" } }]);
  });
});

describe("createOutputTagStripListener (llm/stream waterfall)", () => {
  const tagged = [
    { role: "system", content: [{ type: "text", text: "sys" }] },
    { role: "user", content: [{ type: "text", text: "§1§ remember AMBER" }] },
  ];
  const untagged = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  async function* reply(): AsyncIterable<Chunk> {
    yield { type: "text-delta", index: 0, text: "§2§ hi" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "§2§ hi" } };
  }
  async function texts(stream: AsyncIterable<unknown>): Promise<string> {
    let s = "";
    for await (const c of stream as AsyncIterable<Chunk>) if (c.type === "text-delta") s += c.text;
    return s;
  }

  it("strips on agent-loop requests of tagged (Magic) sessions only", async () => {
    const listener = createOutputTagStripListener({ isAgentLoopRequest: () => true });
    expect(await texts(listener({ messages: tagged }, reply as never))).toBe("hi");
    expect(await texts(listener({ messages: untagged }, reply as never))).toBe("§2§ hi");
    const handBuilt = createOutputTagStripListener({ isAgentLoopRequest: () => false });
    expect(await texts(handBuilt({ messages: tagged }, reply as never))).toBe("§2§ hi");
    const disabled = createOutputTagStripListener({ isAgentLoopRequest: () => true, isEnabled: () => false });
    expect(await texts(disabled({ messages: tagged }, reply as never))).toBe("§2§ hi");
  });

  it("fails open when the request probe throws", async () => {
    const logs: string[] = [];
    const listener = createOutputTagStripListener({
      isAgentLoopRequest: () => {
        throw new Error("boom");
      },
      log: (m) => logs.push(m),
    });
    expect(await texts(listener({ messages: tagged }, reply as never))).toBe("§2§ hi");
    expect(logs.join("\n")).toContain("boom");
  });

  it("requestCarriesMagicTags looks for a Magic §N§ text prefix anywhere in the request", () => {
    expect(requestCarriesMagicTags(tagged)).toBe(true);
    expect(requestCarriesMagicTags(untagged)).toBe(false);
    expect(requestCarriesMagicTags([{ role: "user", content: "§4§ string content" }])).toBe(true);
    expect(requestCarriesMagicTags(undefined)).toBe(false);
  });
});

describe("registerOutputTagStrip", () => {
  it("registers one llm/stream waterfall listener that strips Magic sessions' replies", async () => {
    const seen: Array<{ event: string; listener: (...args: unknown[]) => unknown }> = [];
    registerOutputTagStrip({ on: (event, listener) => seen.push({ event, listener: listener as never }) }, {
      isAgentLoopRequest: () => true,
    });
    expect(seen.map((s) => s.event)).toEqual(["llm/stream"]);
    async function* reply() {
      yield { type: "text-delta", index: 0, text: "§9§ ok" };
    }
    let text = "";
    const stream = seen[0]!.listener({ messages: [{ role: "user", content: [{ type: "text", text: "§1§ q" }] }] }, reply);
    for await (const c of stream as AsyncIterable<{ text?: string }>) text += c.text ?? "";
    expect(text).toBe("ok");
  });
});
