#!/usr/bin/env node
/**
 * Round 24b — deterministic OpenAI-compatible `/embeddings` mock for scenario H
 * (multi-session memory correctness, checks U13…). E2E/TEST ONLY: a separate
 * process the e2e driver starts; the plugin only sees an ordinary
 * `embedding.provider: "openai-compatible"` endpoint in the user jsonc.
 *
 *   node embed-mock.mjs <port> <requests.jsonl>
 *
 * Vectors are a bag of words (FNV-1a hashed into 256 dims, L2-normalized), so
 * texts that share words are close — enough to make the compartment
 * (semantic) lane of ctx_search deterministic on CI, where no real embedding
 * model is installed. Every request is logged (input count + purpose), never
 * the text.
 */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, log] = [Number(process.argv[2] ?? 18578), process.argv[3] ?? "/dev/null"];
const DIM = 256;

function vectorOf(text) {
  const v = new Array(DIM).fill(0);
  for (const word of String(text).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url?.endsWith("/embeddings")) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const parsed = JSON.parse(body);
      const input = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      appendFileSync(log, `${JSON.stringify({ at: Date.now(), n: input.length, model: parsed.model, input_type: parsed.input_type ?? null })}\n`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: parsed.model, data: input.map((t, index) => ({ index, embedding: vectorOf(t) })) }));
    } catch (error) {
      res.writeHead(400).end(String(error));
    }
  });
}).listen(port, "127.0.0.1", () => console.log(`embed-mock listening on ${port}`));
