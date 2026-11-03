import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const FIX = join(process.cwd(), "src/agent/crash-recovery.fixture.ts");
let bad = 0;
for (let i = 0; i < Number(process.argv[2] ?? 10); i++) {
  const dir = mkdtempSync(join(tmpdir(), "race-"));
  const mk = (mode: string, sid: string, point?: string) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (point) { env.MAGIC_CONTEXT_DSH_E2E = "1"; env.MAGIC_CONTEXT_DSH_E2E_CRASH_AT = point; }
    return Bun.spawn({ cmd: [process.execPath, "run", FIX, mode, join(dir, "context.db"), join(dir, `${sid}.events.jsonl`), sid, join(dir, `${sid}.done`)], cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  };
  const b = mk("plane", "b"); const a = mk("historian", "a", "historian-publish");
  const [ca, cb] = await Promise.all([a.exited, b.exited]);
  const ea = await new Response(a.stderr).text(); const eb = await new Response(b.stderr).text();
  const ok = existsSync(join(dir, "a.events.jsonl")) && ea.includes("crash point historian-publish") && cb === 0;
  if (!ok) { bad++; console.log(`iter ${i}: codeA=${ca} codeB=${cb} eventsA=${existsSync(join(dir, "a.events.jsonl"))}\nA: ${ea.slice(-1500)}\nB: ${eb.slice(-800)}`); }
  rmSync(dir, { recursive: true, force: true });
}
console.log("bad", bad);
