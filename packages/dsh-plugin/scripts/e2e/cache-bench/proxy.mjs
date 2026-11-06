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
// A path prefix /r/<tag>/ names the DSH route (bench-model.yml gives the main
// and historian routes different tags); it is stripped before forwarding.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const [port, outDir] = process.argv.slice(2);
const NONCE = process.env.BENCH_NONCE ?? "";
const UP = new URL(process.env.BENCH_UPSTREAM ?? "https://opencode.ai");
fs.mkdirSync(path.join(outDir, "bodies"), { recursive: true });
const log = fs.createWriteStream(path.join(outDir, "requests.jsonl"), { flags: "a" });
let n = 0;

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
  req.on("end", () => {
    const id = ++n;
    const t0 = Date.now();
    let p = req.url ?? "/";
    let tag = "main";
    const m = p.match(/^\/r\/([a-z0-9-]+)(\/.*)$/);
    if (m) { tag = m[1]; p = m[2]; }
    let raw = Buffer.concat(chunks);
    let body = null, nonced = false;
    try { body = JSON.parse(raw.toString("utf8")); } catch {}
    if (body) {
      nonced = addNonce(body);
      raw = Buffer.from(JSON.stringify(body));
      fs.writeFileSync(path.join(outDir, "bodies", `${id}.json`), raw);
    }
    const headers = { ...req.headers, host: UP.host, "accept-encoding": "identity", "content-length": String(raw.length) };
    const lib = UP.protocol === "http:" ? http : https;
    const up = lib.request({ protocol: UP.protocol, hostname: UP.hostname, port: UP.port || (UP.protocol === "http:" ? 80 : 443), path: p, method: req.method, headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      let buf = "", usage = null, tFirst = null, finish = null;
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
          try { const o = JSON.parse(d); if (o.usage) usage = o.usage; const f = o.choices?.[0]?.finish_reason; if (f) finish = f; } catch {}
        }
        if (!usage) { try { const o = JSON.parse(buf); usage = o.usage ?? null; finish = o.choices?.[0]?.finish_reason ?? finish; } catch {} }
        log.write(JSON.stringify({
          n: id, tag, kind: body ? kindOf(body, tag) : "unparsed", path: p.replace(/\?.*$/, ""), status: ur.statusCode,
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
    up.end(raw);
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`bench proxy on ${port} -> ${UP.origin} nonce=${NONCE ? "set" : "off"}`));
