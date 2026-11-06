// Bounded live observation copy of existing cache-bench proxy. NOT sole egress or a hard dollar cap.
// Round 36 cache bench: a recording reverse proxy in front of OpenCode Go.
//
//   node proxy.mjs <port> <out-dir>          (env BENCH_NONCE, BENCH_UPSTREAM)
//
// Every chat request DSH sends is forwarded unchanged to BENCH_UPSTREAM
// (default https://opencode.ai) except for ONE edit made identically in both
// bench groups: "[bench-nonce <BENCH_NONCE>]\n" is prepended to the text of the
// first system message, so the first request of a run cannot reuse the provider
// prefix cache left by an earlier run (DeepSeek caches by prompt prefix across
// requests). An empty BENCH_NONCE disables the edit.
//
// Writes <out-dir>/requests.jsonl (one line per request: timing, route tag,
// kind, raw provider usage) and <out-dir>/bodies/<n>.json (the forwarded body,
// for the prefix-divergence analysis). Request HEADERS are never written: the
// Authorization header carries the API key.
//
// Round 36 line D (DIAGNOSIS ONLY, bench-only; product code and defaults are
// untouched): BENCH_ABLATE=<comma list> rewrites MAIN-agent requests (kind
// "main") before forwarding, so the output-token difference can be attributed:
//   nosys     remove the "## Magic Context" system-prompt section
//   notools   remove the tools the baseline does not have (ctx_*, todowrite)
//   notags    strip "§N§ " tags from message text and the self-tag paragraph
//   noreason  drop reasoning_content from assistant messages (roles kept)
//   fold      baseline emulation of the plugin's DSH surface fold: every
//             assistant message (+ its tool results) becomes a user message,
//             tool arcs rendered with the plugin's v2 prose note, no
//             reasoning_content (agent/transcript.ts renderToolRecord)
//   foldtail  like fold, but the arcs after the LAST user message (the live
//             turn) stay native assistant/tool messages with their reasoning
//             (estimates a "do not fold the live turn" fix)
//   foldplain like fold, but without the "Magic Context note" sentence (role
//             flattening alone: results become bare user text)
//   pad       append a neutral ~5.8k-char paragraph to the system prompt
//             (same length as the plugin's Magic Context section)
// Each applied edit is listed in requests.jsonl ("ablated"). The response
// stream's reasoning / text / tool calls are written to resp/<n>.json (the
// model's own output; no headers).
//
// A path prefix /r/<tag>/ names the DSH route (bench-model.yml gives the main
// and historian routes different tags); it is stripped before forwarding.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const [port, outDir] = process.argv.slice(2);
const NONCE = process.env.BENCH_NONCE ?? "";
const ABLATE = new Set((process.env.BENCH_ABLATE ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const UP = new URL(process.env.BENCH_UPSTREAM ?? "https://opencode.ai");
fs.mkdirSync(path.join(outDir, "bodies"), { recursive: true });
fs.mkdirSync(path.join(outDir, "resp"), { recursive: true });
const log = fs.createWriteStream(path.join(outDir, "requests.jsonl"), { flags: "a" });
let n = 0, forwarded = 0, estimate = 0, coolUntil = 0;
const MAX_REQUESTS = Number(process.env.LONGRUN_MAX_REQUESTS ?? 300);
const STOP_USD = Number(process.env.LONGRUN_ESTIMATE_STOP_USD ?? 4);
const deadline = Date.now() + Number(process.env.LONGRUN_SECONDS ?? 2400) * 1000;
function estimatedCost(u) {
  if (!Number.isFinite(u?.prompt_tokens) || !Number.isFinite(u?.completion_tokens)) return 0;
  const h = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  return (h * .006 + (u.prompt_tokens - h) * .30 + u.completion_tokens * 1.20) / 1e6;
}

function sysText(msg) {
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}
function addNonce(body) {
  if (!NONCE || !Array.isArray(body.messages)) return false;
  const m = body.messages.find((x) => x.role === "system" || x.role === "developer");
  if (!m) return false;
  const tag = `[bench-nonce ${NONCE}]\n`;
  if (typeof m.content === "string") m.content = tag + m.content;
  else if (Array.isArray(m.content) && m.content.length && typeof m.content[0].text === "string") m.content[0].text = tag + m.content[0].text;
  else return false;
  return true;
}
const BASE_TOOLS_EXTRA = /^(ctx_[a-z_]+|todowrite)$/;
const MC_HEAD = "## Magic Context\n";
const SELF_TAG_END = 'To refer to an item in your prose, write "tag 12".';
const SELF_TAG_START = "Every user message, every text you write and every tool result in this conversation carries a tag";
const PAD = ("This paragraph is neutral filler added by the cache bench to match the length of the Magic Context section; it carries no instruction and can be ignored. ").repeat(39).trim();
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "");
function mapSys(body, f) {
  const m = body.messages.find((x) => x.role === "system" || x.role === "developer");
  if (!m) return false;
  const before = textOf(m.content);
  const after = f(before);
  if (after === before) return false;
  m.content = after;
  return true;
}
function describe(tc) {
  let a = {};
  try { a = JSON.parse(tc.function?.arguments ?? "{}"); } catch {}
  const p = a.file_path ?? a.filePath ?? a.path;
  const n = tc.function?.name ?? "tool";
  return n === "read" && p ? `read the file ${p}` : `used ${n}`;
}
function foldMessages(msgs, opts = {}) {
  const out = [];
  let i = 0;
  let stop = msgs.length;
  if (opts.keepTail) for (let j = msgs.length - 1; j >= 0; j -= 1) if (msgs[j].role === "user") { stop = j + 1; break; }
  while (i < msgs.length) {
    const m = msgs[i];
    if (i >= stop) { out.push(m); i += 1; continue; }
    if (m.role !== "assistant") { out.push(m); i += 1; continue; }
    const text = textOf(m.content);
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (!calls.length) { out.push({ role: "user", content: text }); i += 1; continue; }
    const results = [];
    i += 1;
    while (i < msgs.length && msgs[i].role === "tool") { results.push(textOf(msgs[i].content)); i += 1; }
    const note = `Magic Context note: these tool calls already ran and finished; their results are merged below as plain reference text, in this order: ${calls.map(describe).join("; ")}. Do not run them again to get the same result; call tools normally for new work.`;
    out.push({ role: "user", content: [text, opts.plain ? "" : note, ...results].filter((x) => x && x.length).join("\n\n") });
  }
  return out;
}
function ablate(body) {
  const done = [];
  if (!ABLATE.size || !Array.isArray(body.messages)) return done;
  if (ABLATE.has("nosys") && mapSys(body, (s) => {
    const a = s.indexOf(MC_HEAD);
    if (a < 0) return s;
    const e = s.indexOf(SELF_TAG_END, a);
    const end = e < 0 ? s.indexOf("\n## ", a + MC_HEAD.length) : e + SELF_TAG_END.length;
    return end < 0 ? s.slice(0, a) : s.slice(0, a) + s.slice(end).replace(/^\n+/, "");
  })) done.push("nosys");
  if (ABLATE.has("notools") && Array.isArray(body.tools)) {
    const k = body.tools.length;
    body.tools = body.tools.filter((t) => !BASE_TOOLS_EXTRA.test(t?.function?.name ?? ""));
    if (body.tools.length !== k) done.push(`notools(-${k - body.tools.length})`);
  }
  if (ABLATE.has("notags")) {
    let k = 0;
    const strip = (t) => t.replace(/§\d+§ ?/g, () => { k += 1; return ""; });
    mapSys(body, (s) => {
      const a = s.indexOf(SELF_TAG_START);
      const e = s.indexOf(SELF_TAG_END, a);
      return a < 0 || e < 0 ? s : s.slice(0, a) + s.slice(e + SELF_TAG_END.length);
    }) && done.push("notags-sys");
    for (const m of body.messages) {
      if (m.role === "system") continue;
      if (typeof m.content === "string") m.content = strip(m.content);
      else if (Array.isArray(m.content)) for (const p of m.content) if (typeof p?.text === "string") p.text = strip(p.text);
    }
    if (k) done.push(`notags(${k})`);
  }
  if (ABLATE.has("noreason")) {
    let k = 0;
    for (const m of body.messages) if (m.role === "assistant" && "reasoning_content" in m) { delete m.reasoning_content; k += 1; }
    if (k) done.push(`noreason(${k})`);
  }
  for (const mode of ["fold", "foldtail", "foldplain"]) {
    if (!ABLATE.has(mode)) continue;
    const before = body.messages.filter((m) => m.role === "assistant").length;
    body.messages = foldMessages(body.messages, { keepTail: mode === "foldtail", plain: mode === "foldplain" });
    const after = body.messages.filter((m) => m.role === "assistant").length;
    if (before) done.push(`${mode}(${before - after}/${before})`);
  }
  if (ABLATE.has("pad") && mapSys(body, (s) => `${s}\n\n${PAD}`)) done.push("pad");
  return done;
}
function kindOf(body, tag) {
  if (tag === "hist") return "historian";
  const s = sysText((body.messages ?? []).find((x) => x.role === "system" || x.role === "developer"));
  if (/Create a concise title/i.test(s)) return "title";
  if (Array.isArray(body.tools) && body.tools.length && /You are an AI agent powered by DeepSeek Harness/.test(s)) return "main";
  return "other"; // e.g. compaction-basic's summarizer (no tools)
}

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const id = ++n;
    const t0 = Date.now();
    // Respect upstream capacity advice between SDK retries; do not add retries.
    if (coolUntil > Date.now()) await new Promise(resolve => setTimeout(resolve, coolUntil - Date.now()));
    if (forwarded >= MAX_REQUESTS || estimate >= STOP_USD || Date.now() >= deadline) {
      const stopped = { n:id, status:429, kind:'guard', reason:'request/time/observed-estimate limit', forwarded, estimate, t0 };
      fs.writeFileSync(path.join(outDir, 'proxy-stopped.json'), JSON.stringify(stopped));
      log.write(JSON.stringify(stopped) + '\n');
      res.writeHead(429, {'content-type':'application/json'}); res.end(JSON.stringify({error:{message:stopped.reason}})); return;
    }
    forwarded += 1;
    let p = req.url ?? "/";
    let tag = "main";
    const m = p.match(/^\/r\/([a-z0-9-]+)(\/.*)$/);
    if (m) { tag = m[1]; p = m[2]; }
    let raw = Buffer.concat(chunks);
    let body = null, nonced = false, ablated = [], kind = "unparsed";
    try { body = JSON.parse(raw.toString("utf8")); } catch {}
    if (body) {
      kind = kindOf(body, tag);
      if (kind === "main") ablated = ablate(body);
      nonced = addNonce(body);
      raw = Buffer.from(JSON.stringify(body));
      fs.writeFileSync(path.join(outDir, "bodies", `${id}.json`), raw);
    }
    const headers = { ...req.headers, host: UP.host, "accept-encoding": "identity", "content-length": String(raw.length) };
    const lib = UP.protocol === "http:" ? http : https;
    const up = lib.request({ protocol: UP.protocol, hostname: UP.hostname, port: UP.port || (UP.protocol === "http:" ? 80 : 443), path: p, method: req.method, headers }, (ur) => {
      if (ur.statusCode === 429) coolUntil = Math.max(coolUntil, Date.now() + 30000);
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      let buf = "", usage = null, tFirst = null, finish = null;
      let rText = "", rReason = "";
      const rCalls = [];
      ur.on("data", (c) => {
        if (tFirst === null) tFirst = Date.now();
        res.write(c);
        buf += c.toString("utf8");
        if (buf.length > 4_000_000) buf = buf.slice(-2_000_000);
      });
      ur.on("end", () => {
        res.end();
        // SSE: usage normally rides on the last data chunk; plain JSON: top level.
        for (const line of buf.split(/\r?\n/)) {
          const d = line.startsWith("data:") ? line.slice(5).trim() : null;
          if (!d || d === "[DONE]") continue;
          try {
            const o = JSON.parse(d); if (o.usage) usage = o.usage; const f = o.choices?.[0]?.finish_reason; if (f) finish = f;
            const dl = o.choices?.[0]?.delta;
            if (dl) {
              if (typeof dl.content === "string") rText += dl.content;
              const rr = dl.reasoning_content ?? dl.reasoning;
              if (typeof rr === "string") rReason += rr;
              for (const tc of dl.tool_calls ?? []) {
                const j = tc.index ?? 0;
                rCalls[j] ??= { name: "", arguments: "" };
                if (tc.function?.name) rCalls[j].name += tc.function.name;
                if (tc.function?.arguments) rCalls[j].arguments += tc.function.arguments;
              }
            }
          } catch {}
        }
        if (!usage) { try { const o = JSON.parse(buf); usage = o.usage ?? null; finish = o.choices?.[0]?.finish_reason ?? finish; } catch {} }
        estimate += estimatedCost(usage);
        try { fs.writeFileSync(path.join(outDir, "resp", `${id}.json`), JSON.stringify({ n: id, kind, reasoning: rReason, text: rText, tool_calls: rCalls.filter(Boolean) })); } catch {}
        log.write(JSON.stringify({
          n: id, tag, kind, ablated, path: p.replace(/\?.*$/, ""), status: ur.statusCode,
          t0, tFirst, t1: Date.now(), ms: Date.now() - t0, model: body?.model ?? null, stream: body?.stream ?? null,
          nMessages: body?.messages?.length ?? null, nTools: body?.tools?.length ?? null, nonced, finish, usage,
        }) + "\n");
      });
    });
    up.on("error", (e) => {
      log.write(JSON.stringify({ n: id, tag, path: p, status: 0, t0, t1: Date.now(), error: String(e.message ?? e) }) + "\n");
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    up.setTimeout(120000, () => up.destroy(new Error("bounded upstream timeout")));
    up.end(raw);
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`bench proxy on ${port} -> ${UP.origin} nonce=${NONCE ? "set" : "off"}`));
