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
