// Round 36 line I — bench pipeline tests for the recording proxy (proxy.mjs),
// run by `bun test` in packages/dsh-plugin (dsh-ci "dsh-plugin tests").
//
// S4 (200k stress evo bench 42238241963, fold turns 1 / 2): when a turn hit its
// timeout and DSH was killed, the proxy kept the upstream request open — the
// provider finished (and billed) the generation 82–151 s after the turn ended.
// A client that goes away must abort the upstream request, and the request is
// still logged (marked clientAborted).
//
// I1 (1M evo bench 42262946905, native run 2): both historian requests got
// HTTP 400 from the provider in 23 / 45 ms and the proxy kept no trace of why —
// non-2xx response bodies must be recorded (resp/<n>.json "errorBody", capped).
//
// P3 (verification run 42274076026, native, no turn timed out): 55 requests were
// logged clientAborted, 53 of them with usage and a finish reason — DSH closes the
// socket once it has read `data: [DONE]`, before the upstream connection ends.
// A response the client read to its end ([DONE]) is complete: it must not be
// logged as clientAborted.
import { afterEach, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PROXY = path.join(import.meta.dir, "proxy.mjs");
// the bench runs the proxy with node (cache-bench / evo-bench run.sh); bun only when node is absent
const NODE = Bun.which("node") ?? process.execPath;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => server.close());
  return (server.address() as { port: number }).port;
}

async function startProxy(upstreamPort: number): Promise<{ port: number; out: string; proc: ChildProcess }> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bench-proxy-"));
  const probe = http.createServer();
  const port = await listen(probe);
  probe.close();
  const proc = spawn(NODE, [PROXY, String(port), out], {
    env: { ...process.env, BENCH_UPSTREAM: `http://127.0.0.1:${upstreamPort}`, BENCH_NONCE: "", BENCH_ABLATE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanups.push(() => {
    proc.kill("SIGKILL");
    fs.rmSync(out, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("proxy did not start")), 5000);
    proc.stdout!.on("data", (c) => {
      if (String(c).includes("bench proxy on")) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  return { port, out, proc };
}

const body = JSON.stringify({ model: "m", stream: true, messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] });

async function waitFor<T>(f: () => T | undefined, ms = 4000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = f();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

function logLines(out: string): Array<Record<string, unknown>> {
  const p = path.join(out, "requests.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("bench proxy (round 36 line I)", () => {
  it("S4: a client that disconnects mid-stream aborts the upstream request, and the request is logged as clientAborted", async () => {
    let upstreamClosedAt: number | undefined;
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      const tick = setInterval(() => res.write('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'), 50);
      res.on("close", () => {
        clearInterval(tick);
        upstreamClosedAt = Date.now();
      });
      // a long generation: only ends on its own after 30 s
      setTimeout(() => res.end("data: [DONE]\n\n"), 30_000).unref();
    });
    const up = await listen(upstream);
    const { port, out } = await startProxy(up);
    const abortedAt = await new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve(Date.now());
        });
      });
      req.on("error", () => {});
      req.end(body);
    });
    const closed = await waitFor(() => upstreamClosedAt);
    expect(closed).toBeDefined();
    expect(closed! - abortedAt).toBeLessThan(2000);
    const line = await waitFor(() => logLines(out).find((l) => l.n === 1));
    expect(line).toBeDefined();
    expect(line!.clientAborted).toBe(true);
  }, 15_000);

  it("I1: a non-2xx upstream response body is recorded (resp/<n>.json errorBody), still forwarded unchanged", async () => {
    const errorJson = JSON.stringify({ error: { message: "max_tokens is too large", type: "invalid_request_error" } });
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(errorJson);
      });
    });
    const up = await listen(upstream);
    const { port, out } = await startProxy(up);
    const got = await new Promise<{ status: number; text: string }>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t }));
      });
      req.end(body);
    });
    expect(got.status).toBe(400);
    expect(got.text).toBe(errorJson);
    const line = await waitFor(() => logLines(out).find((l) => l.n === 1));
    expect(line?.status).toBe(400);
    const resp = JSON.parse(fs.readFileSync(path.join(out, "resp", "1.json"), "utf8"));
    expect(resp.errorBody).toBe(errorJson);
  }, 15_000);

  it("control: a 200 stream is forwarded and logged with its usage, no errorBody, not clientAborted", async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n');
        res.end('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
      });
    });
    const up = await listen(upstream);
    const { port, out } = await startProxy(up);
    await new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.end(body);
    });
    const line = await waitFor(() => logLines(out).find((l) => l.n === 1));
    expect(line?.status).toBe(200);
    expect((line?.usage as { prompt_tokens: number }).prompt_tokens).toBe(3);
    expect(line?.clientAborted).toBeUndefined();
    const resp = JSON.parse(fs.readFileSync(path.join(out, "resp", "1.json"), "utf8"));
    expect(resp.text).toBe("hi");
    expect(resp.errorBody).toBeUndefined();
  }, 15_000);

  it("P3: a client that closes after reading data: [DONE] (upstream not yet ended) is not logged as clientAborted", async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"tool_calls"}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
        // the provider ends the HTTP response a little later
        setTimeout(() => res.end(), 800).unref();
      });
    });
    const up = await listen(upstream);
    const { port, out } = await startProxy(up);
    await new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" } }, (res) => {
        let t = "";
        res.on("data", (c) => {
          t += c;
          if (t.includes("[DONE]")) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", () => {});
      req.end(body);
    });
    const line = await waitFor(() => logLines(out).find((l) => l.n === 1));
    expect(line?.status).toBe(200);
    expect((line?.usage as { prompt_tokens: number }).prompt_tokens).toBe(5);
    expect(line?.finish).toBe("tool_calls");
    expect(line?.clientAborted).toBeUndefined();
  }, 15_000);
});
