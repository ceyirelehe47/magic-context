/**
 * Round 37 phase 2 — an UNFINISHED tool call survives a COLD process restart.
 *
 * D3 (default-native-roles.test.ts) rebuilds the Session object inside the same
 * process; module state (scheme registry, prepared DB statements, caches) is
 * shared, so it does not prove the cold path. Here process A (a real child
 * process) leaves a tool call without a result in the durable session log and
 * exits; process B (another real child process) reopens the Magic DB, restores
 * the session from the log, appends the result and continues — what headless
 * DSH does (every turn is a new process).
 *
 * Checked for the new default (native roles) and for a legacy fold session
 * (processed before round 37, no scheme row; B runs with no setting):
 *   - the session mode after reopening (native stays native, fold stays fold);
 *   - the open call's id is byte-identical and answered exactly once;
 *   - roles, call ↔ result pairing, reasoning and replay metadata on every
 *     assistant node (native); the fold view keeps its legacy rules;
 *   - the prefix served before the restart is unchanged after it;
 *   - B's provider view equals the same sequence run in ONE process (the cold
 *     path adds nothing and loses nothing).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALL_ID, processA, processB, type Wire } from "./cold-resume.fixture";

type OutA = { pid: number; served: Wire[]; scheme: string | null; logs: string[] };
type OutB = { pid: number; reopened: Wire[]; schemeAtOpen: string | null; afterResult: Wire[]; final: Wire[]; scheme: string | null; logs: string[] };

function spawn(proc: "a" | "b", mode: string, dir: string, sid: string): unknown {
  const out = join(dir, `${proc}.json`);
  const env = { ...process.env };
  delete env.MAGIC_CONTEXT_DSH_NATIVE_ROLES;
  const r = Bun.spawnSync({
    cmd: [process.execPath, "run", join(import.meta.dir, "cold-resume.fixture.ts"), proc, mode, join(dir, "context.db"), join(dir, "events.jsonl"), sid, out],
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`process ${proc} failed (${r.exitCode}): ${r.stderr.toString().slice(-2000)}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

function protocolViolations(w: Wire[]): string[] {
  const out: string[] = [];
  let open: Set<string> | null = null;
  for (let i = 0; i < w.length; i += 1) {
    const m = w[i]!;
    if (m.role === "tool") {
      if (open === null || m.toolCallId === undefined || !open.delete(m.toolCallId)) out.push(`#${i} tool ${m.toolCallId} answers no open call`);
      continue;
    }
    if (open !== null && open.size > 0) out.push(`calls ${[...open].join(",")} unanswered before #${i}`);
    open = m.role === "assistant" && m.calls ? new Set(m.calls.map((c) => c.id)) : null;
  }
  if (open !== null && open.size > 0) out.push(`calls ${[...open].join(",")} unanswered at the end`);
  return out;
}
const bytes = (w: Wire[]) => w.map((m) => JSON.stringify(m));
const roles = (w: Wire[]) => w.map((m) => (m.calls ? "assistant+calls" : m.role));
const problems = (logs: string[]) => logs.filter((l) => /failed|abandoned|error/i.test(l));

async function inOneProcess(mode: "native" | "fold") {
  const dir = mkdtempSync(join(tmpdir(), "dsh-cold-ref-"));
  const prev = process.env.MAGIC_CONTEXT_DSH_NATIVE_ROLES;
  delete process.env.MAGIC_CONTEXT_DSH_NATIVE_ROLES;
  try {
    const sid = `sess-cold-ref-${mode}`;
    await processA(mode, join(dir, "context.db"), join(dir, "events.jsonl"), sid, false);
    return await processB(mode, join(dir, "context.db"), join(dir, "events.jsonl"), sid);
  } finally {
    if (prev !== undefined) process.env.MAGIC_CONTEXT_DSH_NATIVE_ROLES = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("round 37 phase 2: unfinished tool call across a cold process restart", () => {
  it("R1 native (new-session default): process A leaves an open call and exits; process B reopens DB + log, answers it and continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-cold-native-"));
    try {
      const sid = "sess-cold-native";
      const a = spawn("a", "native", dir, sid) as OutA;
      const b = spawn("b", "native", dir, sid) as OutB;
      expect(a.pid).not.toBe(process.pid);
      expect(b.pid).not.toBe(a.pid);
      // A: native, the open call is the tail
      expect(a.scheme).toBe("native");
      expect(roles(a.served)).toEqual(["user", "assistant+calls", "tool", "assistant", "user", "assistant+calls"]);
      expect(a.served.at(-1)!.calls!.map((c) => c.id)).toEqual([CALL_ID]);
      // B reopened: same mode, same bytes, the call still open
      expect(b.schemeAtOpen).toBe("native");
      expect(bytes(b.reopened)).toEqual(bytes(a.served));
      // B answered it: exactly one tool message for that id, right after its assistant
      expect(bytes(b.afterResult).slice(0, a.served.length)).toEqual(bytes(a.served));
      expect(roles(b.afterResult)).toEqual(["user", "assistant+calls", "tool", "assistant", "user", "assistant+calls", "tool"]);
      expect(b.afterResult.filter((m) => m.toolCallId === CALL_ID).length).toBe(1);
      expect(b.afterResult.at(-1)!.toolCallId).toBe(CALL_ID);
      expect(b.afterResult.at(-1)!.content).toMatch(/^\u00a7\d+\u00a7 BODY2/);
      // B continued: one more tool step + a reply; protocol intact, nothing open
      expect(roles(b.final)).toEqual(["user", "assistant+calls", "tool", "assistant", "user", "assistant+calls", "tool", "assistant+calls", "tool", "assistant"]);
      expect(protocolViolations(b.final)).toEqual([]);
      const opener = b.final.find((m) => m.calls?.some((c) => c.id === CALL_ID))!;
      expect(opener.calls![0]!.arguments).toBe(JSON.stringify({ file_path: "b.ts" }));
      expect(opener.reasoning).toEqual(["reasoning 2"]);
      for (const m of b.final.filter((x) => x.role === "assistant")) {
        expect(m.reasoning?.length).toBe(1);
        expect(m.replay).toBeDefined();
      }
      expect(b.final.some((m) => m.content.includes("Magic Context note"))).toBe(false);
      expect(b.scheme).toBe("native");
      expect(problems([...a.logs, ...b.logs])).toEqual([]);
      // the cold path equals the same sequence in one process
      const ref = await inOneProcess("native");
      expect(bytes(b.final)).toEqual(bytes(ref.final));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("R2 legacy fold session (processed before round 37): the cold restart under the new default keeps it fold, answers the open call, same result as one process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-cold-fold-"));
    try {
      const sid = "sess-cold-fold";
      const a = spawn("a", "fold", dir, sid) as OutA;
      const b = spawn("b", "fold", dir, sid) as OutB;
      expect(b.pid).not.toBe(a.pid);
      expect(a.scheme).toBeNull(); // pre-round-37: no scheme row
      expect(a.served.some((m) => m.content.includes("Magic Context note"))).toBe(true);
      // legacy fold behaviour, characterized (known limitation 1, the fold of the LIVE turn):
      // the open call is already folded into a user note "no result recorded"
      expect(roles(a.served)).toEqual(["user", "user", "user", "user", "user"]);
      expect(a.served.at(-1)!.content).toContain("read the file b.ts (no result recorded");
      expect(bytes(b.reopened)).toEqual(bytes(a.served));
      // reopened under the new default: frozen fold, never migrated
      expect(b.scheme).toBe("fold");
      expect(protocolViolations(b.afterResult)).toEqual([]);
      expect(JSON.stringify(b.afterResult)).toContain("BODY2");
      expect(protocolViolations(b.final)).toEqual([]);
      expect(b.final.some((m) => m.content.includes("Magic Context note"))).toBe(true);
      expect(problems([...a.logs, ...b.logs])).toEqual([]);
      const ref = await inOneProcess("fold");
      expect(bytes(b.final)).toEqual(bytes(ref.final));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
