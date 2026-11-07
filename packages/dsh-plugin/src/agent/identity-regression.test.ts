import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  deriveEventMessage,
  replaceSurfaceRange,
  sessionEventAt,
} from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { createContextPlaneState, runContextPlaneStep, type ContextPlaneDeps } from "./context-plane";

/**
 * Round 13 B — long-session identity regression (deterministic, synthetic DSH
 * event streams). The tag identity contract the adapter relies on:
 *
 *  - every tag row is keyed `${messageId}:pN` (messages) or by callId (tools)
 *    and once written its (tag_number → key) pair never changes;
 *  - every §N§ on the surface prefixes exactly ONE original content, and no
 *    number appears on two different contents;
 *  - a queued drop lands on the content its number was given to, never on a
 *    twin with the same or similar text;
 *  - replaying the same log after a process restart (fresh in-process state,
 *    session rebuilt from its persisted events, same DB) reproduces the
 *    surface byte-for-byte and writes nothing.
 *
 * Scenarios: long session, several consecutive tool calls in one step, a
 * historian-style surface replacement (compaction) followed by re-reading the
 * same file, restart replay, identical / near-identical messages, and surface
 * replacements that change a node's role (assistant/tool → user).
 */

const SID = "sess-identity";
const KEY = `dsh:a1b2c3d4:${SID}`;
const MODEL_SOURCE = { kind: "model", provider: "d", model: "m" } as never;

type TagRow = { tag_number: number; type: string; status: string; message_id: string };

function texts(session: Session): string[] {
  return session.surface.nodes
    .map((seq) => sessionEventAt(session, seq))
    .map((event) => (event ? deriveEventMessage(event) : undefined))
    .filter((m) => m !== undefined)
    .map((m) => {
      const msg = m as unknown as { role: string; content: Array<{ type: string; text?: string }> };
      return `${msg.role}:${msg.content.map((p) => p.text ?? `[${p.type}]`).join("|")}`;
    });
}

function surfaceBytes(session: Session): string {
  return JSON.stringify(
    session.surface.nodes.map((seq) => {
      const event = sessionEventAt(session, seq);
      return event ? deriveEventMessage(event) : null;
    }),
  );
}

/** §N§ → the set of distinct contents (prefix stripped) it labels on the surface. */
function numberOwners(session: Session): Map<number, Set<string>> {
  const owners = new Map<number, Set<string>>();
  for (const seq of session.surface.nodes) {
    const event = sessionEventAt(session, seq);
    const msg = event ? (deriveEventMessage(event) as unknown as { content: Array<{ type: string; text?: string }> } | undefined) : undefined;
    for (const part of msg?.content ?? []) {
      const text = part.text ?? "";
      for (const m of text.matchAll(/\u00a7(\d+)\u00a7 ?/g)) {
        const n = Number(m[1]);
        const rest = text.slice((m.index ?? 0) + m[0].length).split(/\u00a7\d+\u00a7/)[0]!.slice(0, 80);
        if (rest.startsWith("]")) continue; // "[dropped §N§]" placeholder
        const set = owners.get(n) ?? new Set<string>();
        set.add(rest);
        owners.set(n, set);
      }
    }
  }
  return owners;
}

interface Ctx {
  db: Database;
  session: () => Session;
  step: () => Promise<void>;
  /** Round 36 line C: later passes run after an idle gap past cache_ttl (core's idle-expiry ride). */
  idle: () => void;
  restart: () => void;
  tags: () => TagRow[];
  applied: string[];
}

async function scenario(fn: (ctx: Ctx) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-magic-ident-"));
  const db = await createTestDb(join(dir, "c.db"));
  try {
    let session = Session.create(SessionId(SID));
    const applied: string[] = [];
    let nowOffset = 0;
    const deps: ContextPlaneDeps = {
      host: { ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: "" }), canonicalKey: (id: string) => `dsh:a1b2c3d4:${id}` },
      config: { nativeRoles: false }, // round 37: legacy fold view pinned (default is native for new sessions)
      cacheTtl: "5m",
      now: () => Date.now() + nowOffset,
      log: (m) => {
        if (m.includes("applied plan")) applied.push(m);
      },
    };
    let state = createContextPlaneState();
    const step = async () => {
      await runContextPlaneStep(state, deps, { agent: { id: session.id, session } as never, messages: [] as never }, async () => ({ reject: false, messages: [] } as never));
    };
    const restart = () => {
      // Process restart: the persisted log (a deep copy, as JSONL would give)
      // is restored into a new Session; all in-process Magic state is gone.
      const events = JSON.parse(JSON.stringify(session.snapshotEvents()));
      session = Session.create(SessionId(SID), events);
      state = createContextPlaneState();
    };
    const tags = () =>
      db.prepare("SELECT tag_number, type, status, message_id FROM tags WHERE session_id = ? ORDER BY tag_number").all(KEY) as TagRow[];
    await fn({ db, session: () => session, step, restart, tags, applied, idle: () => (nowOffset = 6 * 60_000) });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

let turnNo = 0;

function user(session: Session, text: string) {
  session.append("user/message", createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }) as never, { surfaceOp: "append" });
}

function reply(session: Session, text: string) {
  turnNo += 1;
  session.append(
    "assistant/message",
    { turn: turnNo, step: 2, stream: [], message: createAssistantMessage({ content: [{ type: "text", text }], provider: "d", model: "m", source: MODEL_SOURCE } as never) } as never,
    { surfaceOp: "append" },
  );
}

/** One assistant step with N consecutive tool calls, then their N results. */
function toolBurst(session: Session, prefix: string, calls: Array<{ name: string; body: string }>) {
  turnNo += 1;
  const content = calls.map((c, i) => ({ type: "tool-call", id: `${prefix}-${i}`, name: c.name, arguments: JSON.stringify({ i }) }));
  session.append(
    "assistant/message",
    { turn: turnNo, step: 1, stream: [], message: createAssistantMessage({ content: content as never, provider: "d", model: "m", source: MODEL_SOURCE } as never) } as never,
    { surfaceOp: "append" },
  );
  calls.forEach((c, i) => {
    const result = createToolResultMessage({ callId: `${prefix}-${i}` as never, content: [{ type: "text", text: c.body }], isError: false });
    session.append("tool/result", { turn: turnNo, step: 1, message: result } as never, { surfaceOp: "append" });
  });
}

const FILE_A = Array.from({ length: 120 }, (_, i) => `${i + 1}: const a${i} = ${i};`).join("\n");

/** Assert the identity contract against an earlier tag snapshot. */
function expectIdentity(ctx: Ctx, earlier: TagRow[]) {
  const now = ctx.tags();
  const byNum = new Map(now.map((t) => [t.tag_number, t.message_id]));
  for (const t of earlier) expect(byNum.get(t.tag_number)).toBe(t.message_id);
  expect(new Set(now.map((t) => t.tag_number)).size).toBe(now.length);
  expect(new Set(now.map((t) => t.message_id)).size).toBe(now.length);
  for (const t of now.filter((r) => r.type === "message")) expect(t.message_id).toMatch(/:p\d+$/);
  expect(now.some((t) => t.message_id.startsWith("mc-op:"))).toBe(false);
  const owners = numberOwners(ctx.session());
  for (const [n, set] of owners) {
    expect({ n, owners: [...set] }).toEqual({ n, owners: [[...set][0]!] });
    expect(byNum.has(n)).toBe(true);
  }
}

describe("long-session tag identity (round 13 B)", () => {
  it("long session + bursts of consecutive tool calls + identical/near-identical messages: stable keys, one owner per §N§", async () => {
    await scenario(async (ctx) => {
      let snap: TagRow[] = [];
      for (let i = 1; i <= 12; i += 1) {
        const s = ctx.session();
        user(s, i % 3 === 0 ? "please continue" : `please continue (${i})`);
        toolBurst(s, `t${i}`, [
          { name: "read", body: i % 4 === 0 ? FILE_A : `file ${i}\n${"x".repeat(200)}` },
          { name: "grep", body: `match ${i}` },
          { name: "glob", body: "a.ts\nb.ts" }, // identical body every turn
        ]);
        reply(s, i % 2 === 0 ? "done" : `done ${i}`); // identical assistant text on even turns
        await ctx.step();
        expectIdentity(ctx, snap);
        snap = ctx.tags();
      }
      expect(snap.filter((t) => t.type === "tool").length).toBe(36);
      expect(snap.length).toBeGreaterThanOrEqual(36 + 12);
      const owners = numberOwners(ctx.session());
      const pc = [...owners].filter(([, set]) => [...set][0] === "please continue").map(([n]) => n);
      expect(pc.length).toBe(4);
      expect(new Set(pc).size).toBe(4);
    });
  });

  it("drop targets the exact number: identical twins keep their content", async () => {
    await scenario(async (ctx) => {
      for (let i = 1; i <= 8; i += 1) {
        const s = ctx.session();
        user(s, "same question");
        toolBurst(s, `d${i}`, [{ name: "read", body: `SAME BODY ${"y ".repeat(15000)}` }]);
        reply(s, `answer ${i}`);
        await ctx.step();
      }
      const tags = ctx.tags();
      const tools = tags.filter((t) => t.type === "tool");
      const msgs = tags.filter((t) => t.type === "message");
      const targetTool = tools[1]!; // second of eight identical bodies
      const targetMsg = msgs.find((t) => t.tag_number < targetTool.tag_number && t.tag_number > tools[0]!.tag_number)!;
      queuePendingOp(ctx.db, KEY, targetTool.tag_number, "drop", Date.now());
      queuePendingOp(ctx.db, KEY, targetMsg.tag_number, "drop", Date.now());
      ctx.idle(); // round 36 line C: queued drops land on a core reclaim ride
      await ctx.step();
      const after = new Map(ctx.tags().map((t) => [t.tag_number, t.status]));
      expect(after.get(targetTool.tag_number)).toBe("dropped");
      expect(after.get(targetMsg.tag_number)).toBe("dropped");
      for (const t of ctx.tags()) {
        if (t.tag_number !== targetTool.tag_number && t.tag_number !== targetMsg.tag_number) expect(t.status).toBe("active");
      }
      const joined = texts(ctx.session()).join("\n");
      expect(joined).toContain(`[dropped \u00a7${targetTool.tag_number}\u00a7]`);
      expect(joined).toContain(`[dropped \u00a7${targetMsg.tag_number}\u00a7]`);
      expect(joined).toContain(`\u00a7${tools[0]!.tag_number}\u00a7 SAME BODY`);
      expect(joined).toContain(`\u00a7${tools[2]!.tag_number}\u00a7 SAME BODY`);
      expect(joined.split("SAME BODY").length - 1).toBe(7);
      expectIdentity(ctx, tags);
    });
  });

  it("historian-style compaction (surface replace → user-role summary), then re-reading the same file: new number, old keys unchanged", async () => {
    await scenario(async (ctx) => {
      for (let i = 1; i <= 4; i += 1) {
        const s = ctx.session();
        user(s, `turn ${i}`);
        toolBurst(s, `h${i}`, [{ name: "read", body: FILE_A }]);
        reply(s, `ok ${i}`);
        await ctx.step();
      }
      const before = ctx.tags();
      const firstRead = before.find((t) => t.type === "tool")!;
      const s = ctx.session();
      const cut = [...s.surface.nodes].slice(0, 8);
      replaceSurfaceRange(
        s,
        cut[0]!,
        cut[cut.length - 1]!,
        createUserMessage({ content: [{ type: "text", text: "Summary: turns 1-2 read a.ts" }], source: { kind: "user" } }) as never,
        cut,
      );
      await ctx.step();
      expectIdentity(ctx, before);
      user(ctx.session(), "read a.ts again");
      toolBurst(ctx.session(), "h5", [{ name: "read", body: FILE_A }]);
      reply(ctx.session(), "ok 5");
      await ctx.step();
      const now = ctx.tags();
      expectIdentity(ctx, before);
      const reread = now.find((t) => t.message_id === "h5-0")!;
      expect(reread).toBeDefined();
      expect(reread.tag_number).toBeGreaterThan(Math.max(...before.map((t) => t.tag_number)));
      expect(reread.tag_number).not.toBe(firstRead.tag_number);
      const joined = texts(ctx.session()).join("\n");
      expect(joined).not.toContain(`\u00a7${firstRead.tag_number}\u00a7 1: const a0`);
      expect(joined).toContain(`\u00a7${reread.tag_number}\u00a7 1: const a0`);
    });
  });

  it("surface replacement changes roles (Magic's tagged copy of an assistant reply is a user node; a host then replaces that copy): keys stay on the ORIGINAL message", async () => {
    await scenario(async (ctx) => {
      const ids: string[] = [];
      for (let i = 1; i <= 3; i += 1) {
        const s = ctx.session();
        user(s, `q${i}`);
        reply(s, `a${i}`);
        const ev = s.snapshotEvents().at(-1) as unknown as { data: { message: { id: string } } };
        ids.push(String(ev.data.message.id));
        await ctx.step();
      }
      const before = ctx.tags();
      const s = ctx.session();
      // Coordinator copies are user/message replaces (coordinator.ts): the a2
      // reply is now a user-role node on the surface ...
      const idx = texts(s).findIndex((t) => t.endsWith(" a2"));
      expect(texts(s)[idx]).toMatch(/^user:\u00a7\d+\u00a7 a2$/);
      // ... but its tag is keyed by the original ASSISTANT message, not the op copy.
      const a2 = before.find((t) => t.message_id === `${ids[1]}:p0`);
      expect(a2).toBeDefined();
      // A host replace of that copy (content restated).
      const target = s.surface.nodes[idx]!;
      replaceSurfaceRange(s, target, target, createUserMessage({ content: [{ type: "text", text: "a2 (restated)" }], source: { kind: "user" } }) as never, [target]);
      await ctx.step();
      expectIdentity(ctx, before);
      const owners = numberOwners(ctx.session());
      expect(owners.get(a2!.tag_number)).toBeUndefined(); // the old number is not reused for the restated text
      const bytes = surfaceBytes(ctx.session());
      const tagsNow = ctx.tags();
      await ctx.step();
      expect(surfaceBytes(ctx.session())).toBe(bytes);
      expect(ctx.tags()).toEqual(tagsNow);
    });
  });

  it("restart + outbox replay: the persisted log restored into a fresh process reproduces the surface byte-for-byte and writes nothing", async () => {
    await scenario(async (ctx) => {
      for (let i = 1; i <= 6; i += 1) {
        const s = ctx.session();
        user(s, i % 2 ? "same" : `same ${i}`);
        toolBurst(s, `r${i}`, [
          { name: "read", body: `R${i} ${"z ".repeat(12000)}` },
          { name: "grep", body: "hit" },
        ]);
        reply(s, "ok");
        await ctx.step();
      }
      const t0 = ctx.tags();
      queuePendingOp(ctx.db, KEY, t0.find((t) => t.type === "tool")!.tag_number, "drop", Date.now());
      await ctx.step();
      const tags = ctx.tags();
      const bytes = surfaceBytes(ctx.session());
      const outboxSql = "SELECT op_id, status, generation FROM dsh_context_outbox WHERE session_id = ? ORDER BY created_at, op_id";
      const outbox = ctx.db.prepare(outboxSql).all(KEY);
      const applied = ctx.applied.length;

      for (let r = 0; r < 2; r += 1) {
        ctx.restart();
        expect(surfaceBytes(ctx.session())).toBe(bytes);
        // Restoring a seed appends DSH's own `session/end-seed` marker; Magic
        // must append nothing after it.
        const restored = ctx.session().snapshotEvents();
        expect(restored.at(-1)?.type).toBe("session/end-seed" as never);
        await ctx.step();
        await ctx.step();
        expect(surfaceBytes(ctx.session())).toBe(bytes);
        expect(ctx.session().snapshotEvents().length).toBe(restored.length);
        expect(ctx.tags()).toEqual(tags);
        expect(ctx.db.prepare(outboxSql).all(KEY)).toEqual(outbox);
        expect(ctx.applied.length).toBe(applied);
      }
      expectIdentity(ctx, tags);
    });
  });

  it("two independent runs of the same synthetic stream render the same surface text (determinism)", async () => {
    const run = async () => {
      let out = "";
      await scenario(async (ctx) => {
        for (let i = 1; i <= 5; i += 1) {
          const s = ctx.session();
          user(s, "go");
          toolBurst(s, `x${i}`, [{ name: "read", body: `X${i}` }, { name: "glob", body: "a" }]);
          reply(s, "ok");
          await ctx.step();
        }
        out = texts(ctx.session()).join("\n");
      });
      return out;
    };
    const a = await run();
    const b = await run();
    expect(a.length).toBeGreaterThan(0);
    expect(b).toBe(a);
  });
});
