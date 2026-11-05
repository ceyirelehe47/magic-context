/**
 * Round 34 — B6 option (a), user-approved 2026-11-06 00:09 CST.
 *
 * B6 (已复现 round 33, docs/dsh/e2e/evidence-round33/a-release-candidate.md,
 * a-npm-eresolve-rc5-head.txt / a-npm-eresolve-alpha3-head.txt): `npm install`
 * of the packed tarball next to the npm-installed DSH 0.2.1-rc.5 / 0.2.2-alpha.3
 * failed with ERESOLVE through an ABSENT optional peer: npm resolved
 * `@deepseek-ai/dsh-client-ui-primitives` to its highest declared alternative
 * (0.2.2-rc.1), whose own peer `cordis ~4.1.0` conflicts with the tree's cordis.
 * Experiment X5 (same runs) removed the four optional peers (client-connection,
 * client-ui-primitives, client-ui-slots, react) and npm then resolved on rc.5
 * and alpha.3.
 *
 * The adapter never resolves them through Node: `src/client/client.js` is a
 * browser classic script whose `require("react")` is DSH's `__ModuleLoader__`
 * (framework static modules), and `@deepseek-ai/dsh-client-connection` is a
 * cordis service named in `dsh.client.inject`, not an import. This narrows the
 * declaration only: every non-optional DSH / cordis peer stays as it was.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
  peerDependencies: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  dsh?: { client?: { inject?: string[] } };
};

const DROPPED = [
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-slots",
  "react",
];

const KEPT: Record<string, string> = {
  "@deepseek-ai/cordis": "~4.0.5 || 4.0.6-alpha.2 || ~4.1.0",
  "@deepseek-ai/cordis-plugin-include": "~1.0.10 || 1.0.11-alpha.2 || ~1.1.0",
  "@deepseek-ai/dsh-agent": "0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1",
  "@deepseek-ai/dsh-compaction": "0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1",
  "@deepseek-ai/dsh-compaction-basic": "0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1",
  "@deepseek-ai/dsh-llm": "0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1",
  "@deepseek-ai/dsh-session": "0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1",
  "@deepseek-ai/dsh-token-meter": "0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1",
};

describe("B6 option (a): no optional client peers (round 34)", () => {
  test("the four optional client peers are not declared", () => {
    for (const name of DROPPED) expect(`${name} ${name in pkg.peerDependencies}`).toBe(`${name} false`);
  });

  test("no peerDependenciesMeta entry is left (no optional peer at all)", () => {
    expect(pkg.peerDependenciesMeta ?? {}).toEqual({});
  });

  test("every non-optional peer is unchanged (narrowing only)", () => {
    expect(pkg.peerDependencies).toEqual(KEPT);
  });

  test("the client still asks DSH for the connection service by name (inject), not through a peer", () => {
    expect(pkg.dsh?.client?.inject).toContain("@deepseek-ai/dsh-client-connection");
  });
});
