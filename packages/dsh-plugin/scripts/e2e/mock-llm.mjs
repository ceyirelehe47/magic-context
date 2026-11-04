#!/usr/bin/env node
/**
 * Round 23b — deterministic OpenAI-compatible mock model for the extreme
 * context-pressure scenario (scenario X, checks X1…). E2E/TEST ONLY: it is a
 * separate process the e2e driver starts; nothing in the plugin knows about it.
 *
 *   node mock-llm.mjs <port> <plans.json> <requests.jsonl>
 *
 * Routes: POST /w<window>/v1/chat/completions (streaming or not). The window in
 * the path is the context window the mock ENFORCES, like a provider: every
 * request is priced with a real BPE tokenizer (ai-tokenizer, Claude encoding —
 * the same tokenizer core's estimateTokens uses; NOT DSH's chars/4 meter) over
 * the serialized messages + tools; a prompt above the window is rejected with
 * an OpenAI `context_length_exceeded` 400 (what pi-ai maps to a context
 * overflow). Every request is appended to <requests.jsonl> with its priced
 * prompt, max_tokens and the outcome — the evidence that we did or did not
 * send an over-window request.
 *
 * Behaviour: the newest user message carrying `[[MOCK:<plan>]]` selects a plan
 * (a list of steps from plans.json: {"bash": "<command>"} or {"text": "..."}).
 * Step k's bash command must print `MOCKSTEP:<plan>:<k>` (head and tail); the
 * mock advances past every step whose marker appears anywhere in the request,
 * remembers progress per (x-opencode-session, plan) and never regresses — so a
 * retried request repeats the same step, and a step whose output was
 * summarized away does not run again. Historian / summarizer requests (system
 * prompt mentions compartments, or a summarize instruction) get a fixed reply
 * so they never consume plan steps.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const [, , portArg, plansPath, logPath] = process.argv;
const port = Number(portArg);
const plans = JSON.parse(readFileSync(plansPath, "utf8"));
const require = createRequire(import.meta.url);

let tokenizer;
async function loadTokenizer() {
  const roots = (process.env.MOCK_TOKENIZER_ROOT ?? "").split(":").filter(Boolean);
  for (const root of roots) {
    try {
      const mod = await import(require.resolve("ai-tokenizer", { paths: [root] }));
      const enc = await import(require.resolve("ai-tokenizer/encoding/claude", { paths: [root] }));
      const T = mod.Tokenizer ?? mod.default?.Tokenizer ?? mod.default;
      tokenizer = new T(enc.stringEncoder ? enc : (enc.default ?? enc));
      return;
    } catch {
      // next root
    }
  }
  throw new Error("mock-llm: ai-tokenizer not found (MOCK_TOKENIZER_ROOT)");
}

function count(text) {
  return tokenizer.encode(text, "all").length;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? JSON.stringify(p))).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

/**
 * A minimal VALID historian answer: one compartment over every `[N]` / `[N-M]`
 * ordinal block of the chunk (the user turn), `unprocessed_from` = last + 1.
 * MOCK_HISTORIAN=invalid answers an empty output instead (historian failure).
 */
function historianXml(messages) {
  if (process.env.MOCK_HISTORIAN === "invalid") return "<output><compartments></compartments></output>";
  const user = [...messages].reverse().find((m) => m.role === "user");
  const text = textOf(user?.content);
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of text.matchAll(/^\[(\d+)(?:-(\d+))?\]/gm)) {
    lo = Math.min(lo, Number(m[1]));
    hi = Math.max(hi, Number(m[2] ?? m[1]));
  }
  if (!Number.isFinite(lo)) return "<output><compartments></compartments></output>";
  // Round 26 (scenario T, limitation 17): MOCK_HISTORIAN_DEFER_NEEDLE=<text>
  // leaves the chunk unprocessed FROM the first ordinal block that contains
  // <text> (a real `<unprocessed_from>` inside the chunk, as a historian does
  // when the chunk ends mid-topic). Only when an earlier block exists to cover.
  const needle = process.env.MOCK_HISTORIAN_DEFER_NEEDLE ?? "";
  let unprocessed = hi + 1;
  if (needle.length > 0) {
    const blocks = [...text.matchAll(/^\[(\d+)(?:-(\d+))?\]/gm)];
    for (let i = 0; i < blocks.length; i += 1) {
      const start = Number(blocks[i][1]);
      const body = text.slice(blocks[i].index, i + 1 < blocks.length ? blocks[i + 1].index : text.length);
      if (body.includes(needle)) {
        if (start > lo) {
          hi = start - 1;
          unprocessed = start;
        }
        break;
      }
    }
  }
  return `<output>
<compartments>
<compartment start="${lo}" end="${hi}" title="mock work ${lo}-${hi}" episode_type="design" importance="50">
<p1>The user ran mock plan steps ${lo}-${hi} (file reads).</p1>
<p2>Mock reads ${lo}-${hi}.</p2>
<p3>Reads completed.</p3>
<p4>MOCK ${lo}-${hi}</p4>
</compartment>
</compartments>
<facts>
</facts>
<meta>
<messages_processed>${lo}-${hi}</messages_processed>
<unprocessed_from>${unprocessed}</unprocessed_from>
</meta>
</output>`;
}

const progress = new Map();
const lastPlan = new Map(); // session -> newest plan seen // `${session}\0${plan}` -> { done, lastEmitted, emits }
let seq = 0;

function decide(body, session) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const all = messages.map((m) => textOf(m.content) + (m.tool_calls ? JSON.stringify(m.tool_calls) : "")).join("\n");
  if (/<compartment|compartments?\b.*historian|You are a historian/i.test(system)) {
    return { kind: "historian", text: historianXml(messages) };
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastUserText = textOf(lastUser?.content);
  if (/summar(y|ize)/i.test(lastUserText) && /conversation/i.test(lastUserText) && !/\[\[MOCK:/.test(lastUserText)) {
    return { kind: "summary", text: "Summary: the user ran mock plan steps." };
  }
  if (/session title|title for this/i.test(system + lastUserText)) return { kind: "title", text: "Mock session" };
  let plan;
  for (let i = messages.length - 1; i >= 0 && plan === undefined; i -= 1) {
    const m = /\[\[MOCK:([a-z0-9_-]+)\]\]/i.exec(textOf(messages[i].content));
    if (m) plan = m[1];
  }
  if (plan === undefined) {
    const m = /\[\[MOCK:([a-z0-9_-]+)\]\]/i.exec(all);
    if (m) plan = m[1];
  }
  // The plan's user message can be summarized away by a compaction mid-plan:
  // keep following the session's last plan.
  if (plan === undefined) plan = lastPlan.get(session);
  if (plan === undefined || !Array.isArray(plans[plan])) return { kind: "text", text: "ok" };
  lastPlan.set(session, plan);
  const steps = plans[plan];
  const key = `${session}\0${plan}`;
  const st = progress.get(key) ?? { done: 0, lastEmitted: 0, emits: 0 };
  for (let k = steps.length; k > st.done; k -= 1) {
    if (all.includes(`MOCKSTEP:${plan}:${k}`)) {
      st.done = k;
      break;
    }
  }
  // A bash step whose marker never shows up (dropped / summarized before the
  // next request) is not re-run forever: after 3 emissions it counts as done.
  if (st.lastEmitted > st.done && st.emits >= 3) st.done = st.lastEmitted;
  const k = st.done + 1;
  if (k > steps.length) {
    progress.set(key, st);
    return { kind: "text", text: `${plan}: all ${steps.length} steps done` };
  }
  if (st.lastEmitted === k) st.emits += 1;
  else {
    st.lastEmitted = k;
    st.emits = 1;
  }
  progress.set(key, st);
  const step = steps[k - 1];
  if (step.text !== undefined) {
    st.done = k; // text steps complete on emission
    return { kind: "text", text: step.text, plan, step: k };
  }
  // round 26 (scenario E): a tool step whose result cannot carry the step
  // marker (ctx_search) completes on emission when it says {"once": true}
  if (step.once === true) st.done = k;
  return { kind: "tool", name: step.tool ?? "bash", args: step.args ?? { description: `mock step ${k}`, command: step.bash }, plan, step: k };
}

function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => {
    raw += d;
  });
  req.on("end", () => {
    const n = ++seq;
    const m = /^\/w(\d+)\/v1\/chat\/completions/.exec(req.url ?? "");
    if (req.method !== "POST" || !m) {
      res.writeHead(404).end();
      return;
    }
    const window = Number(m[1]);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const session = String(req.headers["x-opencode-session"] ?? "none");
    const serialized = JSON.stringify({ messages: body.messages ?? [], tools: body.tools ?? [] });
    const promptTokens = count(serialized);
    const row = {
      n,
      at: Date.now(),
      session,
      window,
      promptTokens,
      chars: serialized.length,
      maxTokens: body.max_tokens ?? body.max_completion_tokens ?? null,
      messages: (body.messages ?? []).length,
      // round 25 (scenario W): the tool names the agent OFFERED in this request
      tools: (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.function?.name ?? t?.name).filter(Boolean),
    };
    // round 26 (scenario M): which of MOCK_LOG_NEEDLES (comma list) the request carried
    // round 27 (scenario F): for each MOCK_LOG_TAG_NEEDLES marker, the §N§ tag
    // numbers the request shows closest before it (within 400 chars, no other tag between)
    if (process.env.MOCK_LOG_TAG_NEEDLES) {
      const tagged = {};
      for (const needle of process.env.MOCK_LOG_TAG_NEEDLES.split(",").filter(Boolean)) {
        const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const hits = [...serialized.matchAll(new RegExp(`\u00a7(\\d+)\u00a7[^\u00a7]{0,400}?${esc}`, "g"))].map((m) => Number(m[1]));
        if (serialized.includes(needle)) tagged[needle] = hits;
      }
      if (Object.keys(tagged).length > 0) row.tagged = tagged;
    }
    if (process.env.MOCK_LOG_NEEDLES) row.needles = process.env.MOCK_LOG_NEEDLES.split(",").filter((x) => x && serialized.includes(x));
    if (promptTokens > window) {
      row.outcome = "context_length_exceeded";
      appendFileSync(logPath, `${JSON.stringify(row)}\n`);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `This model's maximum context length is ${window} tokens. However, your messages resulted in ${promptTokens} tokens. Please reduce the length of the messages.`,
            type: "invalid_request_error",
            param: "messages",
            code: "context_length_exceeded",
          },
        }),
      );
      return;
    }
    const d = decide(body, session);
    row.outcome = d.kind;
    if (d.plan) row.plan = d.plan;
    if (d.step) row.step = d.step;
    appendFileSync(logPath, `${JSON.stringify(row)}\n`);
    const id = `mock-${n}`;
    const created = Math.floor(Date.now() / 1000);
    const base = { id, object: "chat.completion.chunk", created, model: body.model };
    const outText = d.kind === "tool" ? "" : d.text;
    const completionTokens = Math.max(1, count(outText + (d.kind === "tool" ? JSON.stringify(d.args) : "")));
    const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
    const chunks = [];
    if (d.kind === "tool") {
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: d.name, arguments: JSON.stringify(d.args) } }] }, finish_reason: null }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: outText }, finish_reason: null }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    chunks.push({ ...base, choices: [], usage });
    if (body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created,
          model: body.model,
          choices: [
            d.kind === "tool"
              ? { index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: `call_${n}`, type: "function", function: { name: d.name, arguments: JSON.stringify(d.args) } }] }, finish_reason: "tool_calls" }
              : { index: 0, message: { role: "assistant", content: outText }, finish_reason: "stop" },
          ],
          usage,
        }),
      );
      return;
    }
    sse(res, chunks);
  });
});

await loadTokenizer();
server.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.error(`mock-llm listening on ${port}`);
});
