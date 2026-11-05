/**
 * Round 31 — ctx_expand must not show Magic's OWN injected text.
 *
 * Real DSH 0.2.2-rc.1 e2e 42007576307 (scenario H, session A): the model called
 * ctx_expand(1, 17) and got `[1-4] U: <session-history></session-history>
 * <project-memory> <PROJECT_RULES> #2: …` — the m0 knowledge baseline (a
 * `magic-context`-sourced user message) rendered as if the user had typed the
 * project memory. OpenCode / Pi add those blocks at transform time and never
 * store them, so their ctx_expand never shows them; the DSH history view keeps
 * the message (ordinals must not move) and the historian / FTS index already
 * read it through `withoutInjectedText` (round 24c) — ctx_expand's raw-message
 * source (`readRawMessagesFromAgent`) did not.
 */
import { describe, expect, it } from "bun:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createUserMessage } from "../compat/dsh-0.1/session";
import { readRawMessagesFromAgent } from "./tools";

const M0 =
  "<session-history>\n</session-history>\n<project-memory>\n- [3] Architecture decision: every write goes through the outbox saga (codeword ARCH-KESTREL-4127).\n</project-memory>";
const HINT =
  "\n\n<ctx-search-hint>\nYour memory may contain 1 related fragments:\n- Architecture decision: every write…\n</ctx-search-hint>";
const MARKERS = ["<project-memory>", "<session-history>", "<ctx-search-hint>", "related fragments"];

function scenario(id: string): Session {
  const session = Session.create(SessionId(id), undefined, { id: SessionId(id), version: 4, createdAt: Date.now(), isSeeded: false, cwd: "/tmp/dsh-proj" } as never);
  const user = (text: string, injected = false) =>
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text }],
        source: injected ? { kind: "magic-context", plugin: "magic-context", messageId: `mc-test:${session.seq}` } : { kind: "user" },
      }) as never,
      { surfaceOp: "append" },
    );
  const assistant = (text: string) =>
    session.append(
      "assistant/message",
      { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: "text", text }], provider: "p", model: "m", source: { kind: "model" } as never } as never) } as never,
      { surfaceOp: "append" },
    );
  user(M0, true); // 1: m0 knowledge baseline
  user("Remember: the ledger has one writer."); // 2
  assistant("Noted."); // 3
  user(HINT, true); // 4
  user("What writes the ledger?"); // 5
  assistant("The outbox saga."); // 6
  return session;
}

const textOf = (m: { parts: unknown[] }) =>
  m.parts.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("\n");

describe("ctx_expand raw messages carry no Magic-injected text (round 31)", () => {
  it("knowledge baseline / hint messages keep their ordinal but lose Magic's own text", () => {
    const sid = "session-r31-expand";
    const agent = { id: sid, session: scenario(sid), options: { provider: "p", model: "m" } } as unknown as Agent;
    const messages = readRawMessagesFromAgent(agent);
    expect(messages.length).toBe(6);
    const all = messages.map(textOf).join("\n");
    for (const marker of MARKERS) expect(`${marker}: ${all.includes(marker)}`).toBe(`${marker}: false`);
    expect(textOf(messages[1]!)).toContain("one writer");
    expect(textOf(messages[5]!)).toContain("outbox saga");
    expect(messages.map((m) => m.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
