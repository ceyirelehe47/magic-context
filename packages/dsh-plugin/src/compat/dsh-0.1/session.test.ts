import { describe, expect, it } from "bun:test";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  isMagicSource,
  magicSource,
  magicUserMessage,
  promptTokensOf,
  replaceSurfaceRange,
  sessionEventAt,
  sessionEvents,
} from "./session";

function liveSession(): Session {
  const session = Session.create(SessionId("compat-session"));
  session.append(
    "user/message",
    createUserMessage({ content: [{ type: "text", text: "hello" }], source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
  session.append("user/message", magicUserMessage("knowledge", magicSource({ messageId: "m0" })), {
    surfaceOp: "append",
  });
  return session;
}

describe("compat/dsh-0.1 session seams on DSH 0.2", () => {
  it("sessionEvents reads the real log (Session.events no longer exists)", () => {
    const session = liveSession();
    expect((session as unknown as { events?: unknown }).events).toBeUndefined();
    const events = sessionEvents(session);
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("user/message");
    expect(sessionEventAt(session, 1)?.seq).toBe(events[1]?.seq);
    expect(sessionEventAt(session, 99)).toBeUndefined();
  });

  it("sessionEvents still accepts plain test doubles with an events array", () => {
    expect(sessionEvents({ events: [{ type: "x" }] }).length).toBe(1);
    expect(sessionEvents({})).toEqual([]);
    expect(sessionEvents(null)).toEqual([]);
  });

  it("Magic sources use the merge-extensible magic-context kind and recognise legacy kind:plugin", () => {
    const source = magicSource({ messageId: "m0" });
    expect(source.kind).toBe("magic-context");
    expect(isMagicSource(source)).toBe(true);
    expect(isMagicSource({ kind: "plugin", plugin: "magic-context" })).toBe(true);
    expect(isMagicSource({ kind: "plugin", plugin: "other" })).toBe(false);
    expect(isMagicSource({ kind: "user" })).toBe(false);
    const persisted = sessionEvents(liveSession())[1] as { data: { source: unknown } };
    expect(isMagicSource(persisted.data.source)).toBe(true);
  });

  it("replaceSurfaceRange lands a branded startSeq/endSeq replace", () => {
    const session = liveSession();
    const [first, second] = session.surface.nodes;
    const seq = replaceSurfaceRange(
      session,
      first as number,
      second as number,
      magicUserMessage("checkpoint", magicSource({ messageId: "cp" })),
      [first as number, second as number],
    );
    expect(session.surface.replaceGeneration).toBe(1);
    expect(session.surface.nodes).toEqual([seq as never]);
  });

  it("promptTokensOf = input + cacheRead + cacheWrite of one call", () => {
    expect(promptTokensOf({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 3 })).toBe(1050);
    expect(promptTokensOf({ inputTokens: 7 })).toBe(7);
    expect(promptTokensOf({ outputTokens: 7 })).toBeUndefined();
    expect(promptTokensOf(undefined)).toBeUndefined();
  });
});
