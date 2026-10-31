/**
 * DSH API contract (compile-time).
 *
 * This file is part of `tsc --noEmit` (it is NOT a *.test.ts) and pins every
 * `@deepseek-ai/*` interface the adapter depends on, in the exact shape the
 * port to DSH 0.2.1-rc.5 relies on. A DSH upgrade that renames, removes or
 * re-shapes one of them breaks `bun run typecheck:dsh` with an error pointing
 * HERE, instead of silently degrading at runtime (the 0.1→0.2 `Session.events`
 * removal compiled fine behind `as` casts and returned an empty log).
 *
 * Each assertion is `Assert<...>`; a failing one reads
 * "Type 'false' does not satisfy the constraint 'true'".
 */
import type { Context, Events } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  AssistantMessage,
  MessageSource,
  MessageSourceMap,
  TokenUsage,
  UserMessage,
} from "@deepseek-ai/dsh-llm";
import type {
  Session,
  SessionEvent,
  SessionEventMap,
  SessionHeader,
  SessionSeq,
  SurfaceOp,
} from "@deepseek-ai/dsh-session";
import type {
  SubagentActivation,
  SubagentActivationSpec,
  SubagentResult,
  SubagentRuntime,
  SubagentStartRequest,
} from "@deepseek-ai/dsh-subagent";
import type { ToolRestriction } from "@deepseek-ai/dsh-tools";
import type {
  TypertContribution,
  TypertSchemaFactory,
} from "@deepseek-ai/dsh-typert-registry/types";
// Pulls in the `MessageSourceMap["magic-context"]` augmentation.
import type { MagicMessageSource } from "../compat/dsh-0.1/session";

type Assert<T extends true> = T;
type Has<T, K extends PropertyKey> = K extends keyof T ? true : false;
type Lacks<T, K extends PropertyKey> = K extends keyof T ? false : true;
type Extends<A, B> = [A] extends [B] ? true : false;

/* ── Session event log (Session.events removed in 0.2) ─────────────────── */
export type C_SessionNoEvents = Assert<Lacks<Session, "events">>;
export type C_SessionSnapshot = Assert<
  Extends<ReturnType<Session["snapshotEvents"]>, readonly SessionEvent[]>
>;
export type C_SessionEventAt = Assert<
  Extends<Parameters<Session["eventAt"]>, [seq: SessionSeq]>
>;
export type C_SessionEventAtReturn = Assert<
  Extends<ReturnType<Session["eventAt"]>, SessionEvent | undefined>
>;
export type C_SessionSurface = Assert<Has<Session, "surface">>;
export type C_SurfaceNodes = Assert<Extends<Session["surface"]["nodes"], readonly SessionSeq[]>>;
export type C_SurfaceGeneration = Assert<Extends<Session["surface"]["replaceGeneration"], number>>;
export type C_SessionHeaderCwd = Assert<Has<SessionHeader, "cwd">>;
export type C_SessionHeaderOrigin = Assert<Extends<SessionHeader["origin"], "subagent" | undefined>>;
export type C_SessionHeaderDepth = Assert<Has<SessionHeader, "delegationDepth">>;
export type C_SessionHeaderParent = Assert<Has<SessionHeader, "parentSession">>;

/* ── Surface replace: branded {startSeq,endSeq} ─────────────────────────── */
type ReplaceOp = Exclude<SurfaceOp, "append">;
export type C_ReplaceOp = Assert<
  Extends<ReplaceOp, { op: "replace"; startSeq: SessionSeq; endSeq: SessionSeq }>
>;
export type C_ReplaceNoStart = Assert<Lacks<ReplaceOp, "start">>;

/* ── Event payload shapes the transcript/nudge/historian read ───────────── */
export type C_UserEvent = Assert<Extends<SessionEventMap["user/message"], UserMessage>>;
export type C_AssistantEventMessage = Assert<
  Extends<SessionEventMap["assistant/message"]["message"], AssistantMessage>
>;
export type C_AssistantEventUsage = Assert<
  Extends<SessionEventMap["assistant/message"]["usage"], TokenUsage | undefined>
>;
export type C_AssistantNoTopContent = Assert<Lacks<SessionEventMap["assistant/message"], "content">>;
export type C_RequestContextWindow = Assert<Has<SessionEventMap["request/context"], "contextWindow">>;

/* ── TokenUsage: exclusive counters ─────────────────────────────────────── */
export type C_TokenUsage = Assert<
  Extends<
    TokenUsage,
    { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  >
>;

/* ── MessageSource: per-producer kinds, no catch-all "plugin" ───────────── */
export type C_NoPluginKind = Assert<Lacks<MessageSourceMap, "plugin">>;
export type C_MagicKind = Assert<Extends<MessageSourceMap["magic-context"], MagicMessageSource>>;
export type C_MagicInUnion = Assert<Extends<MagicMessageSource, MessageSource>>;
export type C_UserMessageSource = Assert<Extends<UserMessage["source"], MessageSource>>;

/* ── Agent lifecycle events ─────────────────────────────────────────────── */
export type C_AgentCreated = Assert<Has<Events, "agent/created">>;
export type C_NoSessionStart = Assert<Lacks<Events, "agent/session-start">>;
export type C_AgentInject = Assert<Has<Agent, "inject">>;
export type C_AgentSession = Assert<Extends<Agent["session"], Session>>;

/* ── Subagents: startActivation, caller delivery, no toolFilter/persona ─── */
export type C_StartActivation = Assert<Has<SubagentRuntime, "startActivation">>;
export type C_NoStart = Assert<Lacks<SubagentRuntime, "start">>;
export type C_Delivery = Assert<Extends<"caller", SubagentActivationSpec["delivery"]>>;
export type C_SpecProvider = Assert<Extends<SubagentActivationSpec["provider"], string>>;
export type C_NoToolFilter = Assert<Lacks<SubagentStartRequest, "toolFilter">>;
export type C_NoPersona = Assert<Lacks<SubagentStartRequest, "persona">>;
export type C_MaxDepth = Assert<Has<SubagentStartRequest, "maxDepth">>;
export type C_ActivationResult = Assert<Extends<SubagentActivation["result"], Promise<SubagentResult>>>;
export type C_ActivationDispose = Assert<Extends<ReturnType<SubagentActivation["dispose"]>, Promise<void>>>;
export type C_ResultStop = Assert<Has<SubagentResult, "stopReason">>;
export type C_ToolRestriction = Assert<
  Extends<{ allow: readonly string[] }, ToolRestriction>
>;

/* ── Typert: schema factories ───────────────────────────────────────────── */
export type C_TypertSchemas = Assert<
  Extends<TypertContribution["schemas"], readonly TypertSchemaFactory[]>
>;

/* ── Cordis context service lookup the adapter relies on ────────────────── */
export type C_CtxGet = Assert<Has<Context, "get">>;
export type C_CtxOn = Assert<Has<Context, "on">>;
