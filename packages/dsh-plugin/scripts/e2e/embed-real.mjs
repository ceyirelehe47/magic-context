#!/usr/bin/env node
/**
 * Round 26 (P1-3, scenario E) — an OpenAI-compatible `/embeddings` endpoint
 * backed by a REAL embedding model: Xenova/all-MiniLM-L6-v2 (core's default
 * `local` model) through @huggingface/transformers, mean pooling + L2
 * normalization (the sentence-transformers recipe). E2E/TEST ONLY: a separate
 * process; the plugin only sees an ordinary `openai-compatible` endpoint, so
 * the comparison with embed-mock.mjs (bag of words) changes nothing but the
 * vectors.
 *
 *   node embed-real.mjs <port> <requests.jsonl> <transformers-root>
 *
 * Every request is logged (input count), never the text.
 */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const [port, log, root] = [Number(process.argv[2] ?? 18580), process.argv[3] ?? "/dev/null", process.argv[4] ?? process.cwd()];
const require = createRequire(import.meta.url);
const T = await import(require.resolve("@huggingface/transformers", { paths: [root] }));
if (process.env.EMBED_REAL_CACHE) T.env.cacheDir = process.env.EMBED_REAL_CACHE;
const extractor = await T.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "fp32" });

async function embed(texts) {
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  return out.tolist();
}

// warm-up: the model is downloaded/compiled before we report "listening"
await embed(["warm up"]);

createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => {
    raw += d;
  });
  req.on("end", async () => {
    if (req.method !== "POST" || !/\/embeddings$/.test(req.url ?? "")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = JSON.parse(raw);
      const input = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? "")];
      const vectors = await embed(input);
      appendFileSync(log, `${JSON.stringify({ at: Date.now(), n: input.length, model: body.model ?? null })}\n`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          model: body.model ?? "minilm-real",
          data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
      );
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error).slice(0, 200) } }));
    }
  });
}).listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.error(`embed-real listening on ${port} (Xenova/all-MiniLM-L6-v2, 384 dims)`);
});
