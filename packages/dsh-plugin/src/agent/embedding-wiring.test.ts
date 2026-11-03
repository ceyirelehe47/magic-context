/**
 * Round 24b (P1-1, item 2) — DSH never registered the project's embedding
 * provider and never started the automatic compartment backfill, so the
 * compartment (semantic) lane of ctx_search was always empty on DSH: the
 * tools' `ensureProjectRegistered` seam was never filled and nothing called
 * core `maybeAutoEmbedSessionBackfill` (OpenCode: transform hook; Pi: context
 * handler). Only a manual `/ctx-embed start` could embed, and even that found
 * no registered provider ("nothing to embed").
 *
 * The test drives the PRODUCTION pre-step (runContextPlaneStep) over a real
 * DSH Session with a user-tier `embedding` config pointing at a local fake
 * openai-compatible `/embeddings` server (deterministic bag-of-words vectors),
 * then calls the real ctx_search tool with a paraphrase that shares no
 * codeword with the facts:
 *   1. the project embedding is registered (snapshot provider/model),
 *   2. every compartment of the session is embedded by the automatic backfill,
 *   3. ctx_search's compartment lane returns the RIGHT compartment (range +
 *      title) for a paraphrased question.
 * And the degrade path (no model reachable — the CI case):
 *   4. the pre-step never throws, ctx_search still answers from the message
 *      FTS lane (the codeword hit, right ordinal) and says VISIBLY that
 *      semantic search is unavailable and results are full-text only.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { getProjectEmbeddingSnapshot } from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getEmbeddingCoverageStatus } from "@magic-context/core/features/magic-context/project-embedding-registry";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createAssistantMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";
import { transcriptRawMessageProvider } from "./historian-wiring";
import { registerCtxTools } from "./tools";

const KEY = (id: string) => `dsh:a1b2c3d4:${id}`;
const FACTS = [
  "Architecture decision: the outbox saga is the single writer, codeword ARCH-ORCA-5521.",
  "User constraint: never touch the tag table from a worker, codeword RULE-LYNX-7730.",
  "File relation: meter.ts reads its numbers from context-details.ts, codeword FILE-WREN-2049.",
  "Open todo: add a pruning job for stale leases, codeword TODO-IBIS-6618.",
];

const DIM = 128;
/** Deterministic bag-of-words vector: shared words → high cosine. */
function vectorOf(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % DIM]! += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

let server: ReturnType<typeof Bun.serve> | undefined;
let requests = 0;
const savedXdg = process.env.XDG_CONFIG_HOME;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests += 1;
      const body = (await request.json()) as { input: string[]; model: string };
      return Response.json({ model: body.model, data: body.input.map((t, index) => ({ index, embedding: vectorOf(t) })) });
    },
  });
});
afterAll(() => {
  server?.stop(true);
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

function writeUserConfig(root: string, endpoint: string): void {
  const configHome = join(root, "xdg-config");
  mkdirSync(join(configHome, "cortexkit"), { recursive: true });
  writeFileSync(
    join(configHome, "cortexkit", "magic-context.jsonc"),
    JSON.stringify({ embedding: { provider: "openai-compatible", endpoint, model: "fake-bow-embed" } }),
  );
  process.env.XDG_CONFIG_HOME = configHome;
}

function conversation(id: string, cwd: string): Session {
  const session = Session.create(SessionId(id), undefined, { id: SessionId(id), version: 4, createdAt: Date.now(), isSeeded: false, cwd } as never);
  const say = (role: "user" | "assistant", text: string) =>
    session.append(
      role === "user" ? "user/message" : "assistant/message",
      role === "user"
        ? (createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }) as never)
        : ({ turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: "text", text }], provider: "p", model: "m", source: { kind: "model" } as never } as never) } as never),
      { surfaceOp: "append" },
    );
  for (const fact of FACTS) {
    say("user", `Please remember this. ${fact}`);
    say("assistant", "Noted.");
  }
  say("user", "Now something unrelated: list the files.");
  say("assistant", "Listing.");
  return session;
}

function toolsCtx(): { ctx: Context; registered: ToolDefinition[] } {
  const registered: ToolDefinition[] = [];
  const ctx = { get: (name: string) => (name === "tools" ? { register: (d: ToolDefinition) => (registered.push(d), () => {}) } : undefined) };
  return { ctx: ctx as unknown as Context, registered };
}

async function waitFor(check: () => boolean, ms = 6000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

async function setup(sid: string, root: string) {
  const projectDir = join(root, "proj");
  mkdirSync(projectDir, { recursive: true });
  const db: Database = await createTestDb(join(root, "context.db"));
  const session = conversation(sid, projectDir);
  const agent = { id: sid, session, options: { provider: "p", model: "m" } } as unknown as Agent;
  const view = transcriptRawMessageProvider(agent, KEY(sid)).readMessages();
  // two compartments over the 8 fact messages; the tail (9, 10) stays live
  appendCompartments(db, KEY(sid), [
    {
      sequence: 0, startMessage: 1, endMessage: 4, startMessageId: view[0]!.id, endMessageId: view[3]!.id,
      title: "Outbox writer decision and tag table rule",
      content: "Decided the outbox saga is the single writer. The user forbids workers from touching the tag table.",
      p1: "Outbox saga single writer; workers never touch the tag table.", p2: "Outbox single writer; tag table rule.", p3: "Outbox decision.", p4: "Outbox", importance: 50, episodeType: "design",
    },
    {
      sequence: 1, startMessage: 5, endMessage: 8, startMessageId: view[4]!.id, endMessageId: view[7]!.id,
      title: "Meter data source and lease pruning todo",
      content: "The meter module reads its numbers from the context details module. Still to do: a pruning job for stale leases.",
      p1: "Meter reads numbers from context details; todo prune stale leases.", p2: "Meter source; lease pruning todo.", p3: "Meter source.", p4: "Meter", importance: 50, episodeType: "design",
    },
  ] as never);
  const deps: ContextPlaneDeps = {
    host: { ready: Promise.resolve({ kind: "ok", db, storageDir: root, livenessPath: "" }), canonicalKey: KEY },
    config: { enabled: false },
    directory: projectDir,
    log: () => {},
  };
  const { ctx, registered } = toolsCtx();
  registerCtxTools(ctx, { db, canonicalKey: KEY, memoryEnabled: true } as never);
  const search = registered.find((d) => d.name === "ctx_search")!;
  const exec = { agent: { id: sid, options: { provider: "p", model: "m" }, session: { header: { id: sid, cwd: projectDir } } }, signal: new AbortController().signal } as unknown as ToolRunContext;
  const identity = resolveProjectIdentityForSession(projectDir, false) as string;
  return { db, agent, view, deps, search, exec, identity, projectDir };
}

describe("DSH embedding registration + automatic compartment embedding (item 2)", () => {
  it("registers the provider, auto-embeds the compartments, and ctx_search's compartment lane answers a paraphrase", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-embed-wiring-"));
    writeUserConfig(root, `http://127.0.0.1:${server!.port}/v1`);
    const { db, agent, deps, search, exec, identity } = await setup("session-emb-a", root);
    try {
      expect(identity).toBeTruthy();
      await runContextPlaneStep(createContextPlaneState(), deps, { agent: agent as never, messages: [] as never }, async () => ({ reject: false, messages: [] }) as never);

      // 1. registered
      const registered = await waitFor(() => getProjectEmbeddingSnapshot(identity)?.provider === "openai-compatible");
      expect(registered).toBe(true);
      // 2. automatic backfill embedded every compartment (no /ctx-embed)
      const embedded = await waitFor(() => {
        const cov = getEmbeddingCoverageStatus(db, identity, KEY("session-emb-a"));
        return cov.session.total === 2 && cov.session.embedded === 2;
      });
      expect(embedded).toBe(true);
      expect(requests).toBeGreaterThan(0);

      // 3. paraphrase (no codeword, no exact sentence) → the right compartment
      const text = ((await search.execute({ query: "which module supplies the meter with its numbers", sources: ["message"] }, exec)) as { text: string }).text;
      expect(text).toMatch(/compartment_id=\d+ range=5-8 [^\n]*title=Meter data source/);
      expect(text).not.toMatch(/semantic search (is )?unavailable/i);
      const first = text.split("\n\n")[1] ?? "";
      expect(first).toContain("range=5-8");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("with no reachable model it degrades to full-text search with a visible diagnostic (never throws)", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-embed-wiring-"));
    // a closed port: every embedding request fails (the CI 'no model' case)
    writeUserConfig(root, "http://127.0.0.1:9/v1");
    const { db, agent, deps, search, exec, identity } = await setup("session-emb-b", root);
    try {
      await runContextPlaneStep(createContextPlaneState(), deps, { agent: agent as never, messages: [] as never }, async () => ({ reject: false, messages: [] }) as never);
      await waitFor(() => getProjectEmbeddingSnapshot(identity)?.provider === "openai-compatible");
      // FTS lane needs the message index (round 24a) — wait for it
      const view = transcriptRawMessageProvider(agent, KEY("session-emb-b")).readMessages();
      await waitFor(() => ((db.prepare("SELECT last_indexed_ordinal AS n FROM message_history_index WHERE session_id = ?").get(KEY("session-emb-b")) as { n: number } | null)?.n ?? 0) >= view.length);

      const text = ((await search.execute({ query: "FILE-WREN-2049" }, exec)) as { text: string }).text;
      expect(text).toMatch(/\[message\] score=[0-9.]+ ordinal=5 [^\n]*role=user\n[^\n]*FILE-WREN-2049/);
      expect(text).toMatch(/semantic search (is )?unavailable/i);
      expect(text).toMatch(/full-text/i);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
