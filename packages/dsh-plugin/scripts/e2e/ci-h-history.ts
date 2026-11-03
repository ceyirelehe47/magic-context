// Round 25b e2e helper (scenario H, check U14): which codewords does each
// message of a session's HISTORY view carry — every part, i.e. user / assistant
// text AND tool-call inputs and tool results?
//
//   bun scripts/e2e/ci-h-history.ts <session.jsonl> <codes,comma,separated>
//
// The history view (readRawMessagesFromAgent = ctx_expand's source) is the
// numbering compartments use. ci-h.ts's `factMessages` come from the
// message-history FTS rows, which index user/assistant TEXT only, so a
// codeword an assistant wrote into a tool call (h-f3: ctx_memory write of
// FILE-HERON-2261 at the ordinal after the fact's user message) was invisible
// to U14 and the compartment that summarised that call was flagged
// (e2e 41688260239). Injected Magic blocks (<project-memory>,
// <session-history>, <ctx-search-hint>) are flagged per message so the check
// can keep excluding them.
// Prints JSON only; no secrets are read.
import { readFileSync } from "node:fs";
import { decodeSeqRanges, Session, SessionId } from "@deepseek-ai/dsh-session";
import { readRawMessagesFromAgent } from "../../src/agent/tools";

const [sessionPath, codesArg] = process.argv.slice(2);
if (!sessionPath || !codesArg) {
  console.error("usage: ci-h-history.ts <session.jsonl> <codes>");
  process.exit(2);
}
const codes = codesArg.split(",").filter(Boolean);
type Ev = Record<string, unknown> & { type: string; seq: number };
const lines = readFileSync(sessionPath, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Ev);
const header = lines[0] as unknown as { id: string };
// Storage-form seq ranges expanded, as in ci-history.ts (round 24c).
const events = lines.slice(1).map((e) =>
  Array.isArray(e.sourceEventSeqs) ? { ...e, sourceEventSeqs: decodeSeqRanges(e.sourceEventSeqs) } : e,
);
const session = Session.create(SessionId(header.id), events as never);
const history = readRawMessagesFromAgent({ session } as never);
const INJECTED = /<(project-memory|session-history|ctx-search-hint)>/;
const rows = history.map((m) => {
  const text = JSON.stringify((m as { parts?: unknown[] }).parts ?? []);
  const kinds = [...new Set(((m as { parts?: Array<{ type?: string }> }).parts ?? []).map((p) => String(p?.type ?? "")))];
  return {
    ordinal: (m as { ordinal: number }).ordinal,
    parts: kinds,
    codes: codes.filter((c) => text.includes(c)),
    injected: INJECTED.test(text),
  };
});
console.log(JSON.stringify({ historyCount: history.length, rows }));
