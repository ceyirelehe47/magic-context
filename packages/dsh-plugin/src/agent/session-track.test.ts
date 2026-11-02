import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { createTestDb, createTestStorageDir } from "../test-utils";
import { resolveKnowledgeProjectPath } from "./knowledge-gate";
import { registerSessionProjectTracking } from "./session-track";

// Round 14 scan (real rc.5 DB: two dsh rows with project_path
// "/workspace/work/e2e/ws"): agent/created tracking wrote the RAW cwd, while
// the knowledge gate writes the resolved project identity (git:… / dir:…) for
// the same session. Every new process re-fired agent/created and overwrote
// the identity with the raw path until the next pre-step, and sessions that
// never reached a gated pre-step kept the raw path (dreamer discovery and
// project-scoped memory then see a bogus "project").
describe("registerSessionProjectTracking", () => {
  it("records the resolved project identity, the same value the knowledge gate writes", async () => {
    const dir = createTestStorageDir();
    const db = await createTestDb(join(dir, "context.db"));
    try {
      let handler: ((payload: { agent: unknown }) => unknown) | undefined;
      const ctx = {
        on: (name: string, fn: (payload: { agent: unknown }) => unknown) => {
          if (name === "agent/created") handler = fn;
          return () => {};
        },
      } as unknown as Context;
      registerSessionProjectTracking(ctx, {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: join(dir, "l") } as never),
          canonicalKey: (id: string) => `dsh:abc:${id}`,
        },
      });
      const cwd = dir; // a plain directory (no git) → "dir:<hash>"
      handler?.({ agent: { id: "session-1", session: { id: "session-1", header: { cwd } } } });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const row = db
        .prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
        .get("dsh:abc:session-1") as { project_path: string } | null;
      const expected = resolveKnowledgeProjectPath(cwd);
      expect(expected).toBeDefined();
      expect(row?.project_path).toBe(expected!);
      expect(row?.project_path).not.toBe(cwd);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Round 15: rows written before f95710825 still hold the raw cwd. A startup
// repair rewrites them to the resolved identity — idempotently, only for
// harness='dsh', only raw absolute paths of directories that still exist and
// resolve, and with a compare-and-set on the old value.
describe("normalizeDshSessionProjectRows", () => {
  it("rewrites legacy raw-path dsh rows to the resolved identity and leaves everything else alone", async () => {
    const { normalizeDshSessionProjectRows } = await import("./session-track");
    const dir = createTestStorageDir();
    const db = await createTestDb(join(dir, "context.db"));
    try {
      const ins = db.prepare(
        "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, 1)",
      );
      ins.run("dsh:abc:raw", "dsh", dir); // legacy raw path → identity
      ins.run("dsh:abc:ok", "dsh", "git:deadbeef"); // already an identity
      ins.run("dsh:abc:dir", "dsh", "dir:0123abcd"); // already an identity
      ins.run("dsh:abc:gone", "dsh", join(dir, "does-not-exist")); // vanished dir: keep
      ins.run("dsh:abc:rel", "dsh", "relative/path"); // not absolute: keep
      ins.run("oc-1", "opencode", dir); // other harness: never touched
      const expected = resolveKnowledgeProjectPath(dir);
      expect(expected).toBeDefined();

      const first = normalizeDshSessionProjectRows(db);
      expect(first).toEqual({ scanned: 3, updated: 1 });
      const get = (id: string, harness = "dsh") =>
        (db.prepare("SELECT project_path FROM session_projects WHERE session_id = ? AND harness = ?").get(id, harness) as
          | { project_path: string }
          | null)?.project_path;
      expect(get("dsh:abc:raw")).toBe(expected!);
      expect(get("dsh:abc:ok")).toBe("git:deadbeef");
      expect(get("dsh:abc:dir")).toBe("dir:0123abcd");
      expect(get("dsh:abc:gone")).toBe(join(dir, "does-not-exist"));
      expect(get("dsh:abc:rel")).toBe("relative/path");
      expect(get("oc-1", "opencode")).toBe(dir);

      // Idempotent: nothing left to change.
      expect(normalizeDshSessionProjectRows(db)).toEqual({ scanned: 2, updated: 0 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs once from registerSessionProjectTracking after the bootstrap settles", async () => {
    const dir = createTestStorageDir();
    const db = await createTestDb(join(dir, "context.db"));
    try {
      db.prepare(
        "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'dsh', ?, 1)",
      ).run("dsh:abc:old", dir);
      const ctx = { on: () => () => {} } as unknown as Context;
      registerSessionProjectTracking(ctx, {
        host: {
          ready: Promise.resolve({ kind: "ok", db, storageDir: dir, livenessPath: join(dir, "l") } as never),
          canonicalKey: (id: string) => `dsh:abc:${id}`,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const row = db
        .prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
        .get("dsh:abc:old") as { project_path: string } | null;
      expect(row?.project_path).toBe(resolveKnowledgeProjectPath(dir)!);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
