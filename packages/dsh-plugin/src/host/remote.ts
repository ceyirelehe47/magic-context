/**
 * host/remote — the `magicContext` Typert Remote namespace (Phase 2 slice C).
 *
 * The persistent-bundle client→host channel is NOT the dynamic-package
 * `harness.handle` / `host.call` pair (dsh-reference §G.1, §F.4): a persistent
 * bundle's browser half reaches the host through the Typert Gateway over the
 * shared `/api` RPC channel (`ctx.connection.rpc.call('/api',
 * 'magicContext/status', { args })`), and the host half registers a strict
 * InvocationDescriptor with `ctx.typert.register(...)`. This module registers
 * the `magicContext/status` endpoint against the live `magicContextHost`
 * service, with no runtime dependency beyond Cordis + the core — the
 * typertRemote binding is hand-built (the protocol package's frozen
 * `{service, serviceKey, namespace}` shape) and the descriptor uses src-json
 * codecs, so no decorators or generated artifacts are involved.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import { resolveCortexKitUserConfigPath } from "@magic-context/core/config/migrate-config-location";
import {
  LATEST_SUPPORTED_VERSION,
  getPersistedSchemaVersion,
} from "@magic-context/core/features/magic-context/storage-db";
import type TypertRegistry from "@deepseek-ai/dsh-typert-registry";
import type { InvocationDescriptor } from "@deepseek-ai/dsh-typert-protocol";
import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry/types";
import { MAGIC_CONTEXT_REMOTE_NAMESPACE } from "../compat/dsh-0.1/typert";
import type { MagicContextHostService } from "../index";
import { MAGIC_CONTEXT_PACKAGE } from "../doctor/env";
import type { MagicContextPluginConfig } from "@magic-context/core/config";
import { loadPluginConfigQuiet, pendingRestartChanges, type PendingRestartChange } from "../settings/config-load";
import {
  MAGIC_OVERRIDE_BOUNDS,
  MAGIC_OVERRIDE_FIELDS,
  MAGIC_SETTINGS_NAMESPACE,
  resolveEffectiveSettings,
  resolveThresholds,
  validateMagicSettingsOps,
  type EffectiveMagicSettings,
  type MagicDshOverrides,
  type MagicSettingsOp,
  type MagicThresholds,
} from "../settings/magic-settings";
import { readSessionContextDetails, type MagicSessionContextDetails } from "./context-details";
import { fireAndForget } from "../agent/fire-and-forget";

/** Wire endpoint name (client calls `magicContext/status`). */
export const MAGIC_STATUS_METHOD = "status";

/** Wire endpoint name for the per-session diagnostics (Phase 4). */
export const MAGIC_DIAGNOSTICS_METHOD = "diagnostics";

/** Wire endpoint: read the DSH settings overlay + jsonc + effective values. */
export const MAGIC_SETTINGS_METHOD = "settings";

/** Wire endpoint: write overlay fields through `settings.mutate` (revisioned). */
export const MAGIC_UPDATE_SETTINGS_METHOD = "updateSettings";

/** Wire endpoint: per-session context details for the composer indicator. */
export const MAGIC_CONTEXT_METHOD = "context";

/** The structural `ctx.settings` face this remote uses (dsh-settings 0.2.1-rc.5). */
export interface SettingsFormsView {
  readonly writable?: boolean;
  describe(options?: { redactSecrets?: boolean }): Array<{
    ns: string;
    revision: number;
    value?: unknown;
    user?: unknown;
    base?: unknown;
    schema?: unknown;
  }>;
  mutate(ns: string, ops: readonly MagicSettingsOp[], expectedRevision?: number): Promise<void>;
}

/** JSON view served to the settings page. */
export interface MagicSettingsView {
  /** dsh-settings is mounted and serves the `magic-host` namespace. */
  readonly available: boolean;
  /** Why the form is read-only / unavailable (human readable). */
  readonly reason?: string;
  readonly writable: boolean;
  readonly namespace: string;
  readonly revision?: number;
  /** Raw user-layer section (fields present here are DSH-overridden in the profile patch). */
  readonly user: MagicDshOverrides;
  /** Live overrides the running host actually applies (any patch layer). */
  readonly live: MagicDshOverrides;
  readonly effective: EffectiveMagicSettings;
  /** Thresholds for the default model key (preview). */
  readonly thresholds: MagicThresholds;
  readonly jsonc: {
    readonly path: string;
    readonly exists: boolean;
    readonly loaded: boolean;
  };
  readonly bounds: typeof MAGIC_OVERRIDE_BOUNDS;
  readonly fields: readonly string[];
  readonly precedence: string;
  /**
   * Round 21: restart-only jsonc sections edited since the agent plane
   * started — `running` is applied now, `next` after a DSH restart.
   */
  readonly pendingRestart: readonly PendingRestartChange[];
}

export type MagicUpdateSettingsResult =
  | { readonly ok: true; readonly view: MagicSettingsView }
  | {
      readonly ok: false;
      readonly code: "conflict" | "invalid" | "unavailable" | "refused";
      readonly message: string;
      readonly expected?: number;
      readonly actual?: number;
      readonly view?: MagicSettingsView;
    };

export const MAGIC_SETTINGS_PRECEDENCE =
  "DSH override (set here) > magic-context.jsonc (project > user) > core default; unset = inherit jsonc. The jsonc file is never written.";

/** JSON-safe per-session diagnostics (outbox/tags/compartments/meta). */
export interface MagicSessionDiagnostics {
  readonly sessionId: string;
  readonly outbox: {
    readonly pending: number;
    readonly applied: number;
    readonly committed: number;
    readonly abandoned: number;
  };
  readonly tags: { readonly active: number; readonly dropped: number };
  readonly compartments: number;
  readonly meta: { readonly lastContextPercentage?: number; readonly hasM0: boolean };
}

/** JSON-safe status summary served to the browser card / header action. */
export interface MagicStatus {
  readonly package: string;
  readonly harness: "dsh";
  readonly storage: {
    readonly ok: boolean;
    readonly schemaVersion?: number;
    readonly latestSupported: number;
    readonly reason?: "schema-fence" | "migration-guard" | "error";
    readonly detail?: string;
  };
  readonly config: { readonly path: string; readonly exists: boolean };
  readonly preset: { readonly dir: string; readonly exists: boolean };
  readonly sessionId?: string | null;
}

function dshHome(): string {
  const explicit = process.env.DSH_HOME;
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  return join(homedir(), ".dsh");
}

/** Cordis Service backing the `magicContext` Remote namespace. */
export class MagicContextRemoteService extends Service {
  /** Hand-built Typert Gateway binding (protocol `bindTypertRemote` shape). */
  readonly typertRemote: Readonly<{
    service: MagicContextRemoteService;
    serviceKey: string;
    namespace: string;
  }>;

  constructor(
    ctx: Context,
    private readonly host: MagicContextHostService,
  ) {
    super(ctx, "magicContextRemote");
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: "magicContextRemote",
      namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE,
    });
  }

  /** `magicContext/status` — current adapter state for one session. */
  async status(args: { sessionId?: string } = {}): Promise<MagicStatus> {
    const bootstrap = await this.host.ready;
    const storage = (() => {
      if (bootstrap.kind !== "ok") {
        return {
          ok: false,
          latestSupported: LATEST_SUPPORTED_VERSION,
          reason: bootstrap.reason,
          detail: safeDetail(bootstrap.detail),
        };
      }
      return {
        ok: true,
        schemaVersion: getPersistedSchemaVersion(bootstrap.db),
        latestSupported: LATEST_SUPPORTED_VERSION,
      };
    })();
    const home = dshHome();
    const configPath = resolveCortexKitUserConfigPath();
    const presetDir = join(home, ".agent-presets", "magic-standard");
    return {
      package: MAGIC_CONTEXT_PACKAGE,
      harness: "dsh",
      storage,
      config: { path: configPath, exists: existsSync(configPath) },
      preset: { dir: presetDir, exists: existsSync(join(presetDir, "agent.cordis.yml")) },
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
    };
  }

  /** Optional `ctx.settings` (dsh-settings); absent in headless profiles. */
  private settingsForms(): SettingsFormsView | undefined {
    const forms = this.ctx.get("settings") as SettingsFormsView | undefined;
    return forms !== undefined && typeof forms.describe === "function" ? forms : undefined;
  }

  /** `magicContext/settings` — overlay + jsonc + effective values. */
  async settings(_args: Record<string, never> = {} as Record<string, never>): Promise<MagicSettingsView> {
    return buildSettingsView(this.settingsForms(), this.host);
  }

  /**
   * `magicContext/updateSettings` — validated overlay edits through
   * `settings.mutate(ns, ops, expectedRevision)`. A stale revision answers
   * `conflict` with the fresh view so the page can rebase the draft.
   */
  async updateSettings(args: { ops?: unknown; expectedRevision?: unknown }): Promise<MagicUpdateSettingsResult> {
    return applySettingsUpdate(this.settingsForms(), this.host, args);
  }

  /** `magicContext/context` — per-session details for the composer indicator popover. */
  async context(args: { sessionId?: unknown; model?: unknown; contextWindow?: unknown; usedTokens?: unknown }): Promise<MagicSessionContextDetails> {
    const sessionId = String(args?.sessionId ?? "").slice(0, 512);
    const model = typeof args?.model === "string" ? args.model.slice(0, 256) : undefined;
    const contextWindow = typeof args?.contextWindow === "number" && args.contextWindow > 0 ? args.contextWindow : undefined;
    const bootstrap = await this.host.ready;
    const effective = effectiveFor(this.host);
    return readSessionContextDetails({
      db: bootstrap.kind === "ok" ? bootstrap.db : undefined,
      canonicalSessionId: wireSessionToCanonical(this.host, sessionId),
      sessionId,
      effective,
      thresholds: resolveThresholds(effective, model, contextWindow),
    });
  }

  /** `magicContext/diagnostics` — per-session context-management state. */
  async diagnostics(args: { sessionId: string }): Promise<MagicSessionDiagnostics> {
    // Security: bound the session id (Remote 限额 — PLAN §11) and never echo
    // unvalidated input into SQL beyond the bound parameter.
    const sessionId = String(args?.sessionId ?? "").slice(0, 512);
    const empty = {
      sessionId,
      outbox: { pending: 0, applied: 0, committed: 0, abandoned: 0 },
      tags: { active: 0, dropped: 0 },
      compartments: 0,
      meta: { hasM0: false },
    };
    // Every Magic table is keyed by the canonical `dsh:<home>:<id>` key; the
    // raw wire id used to be queried as is and always read zeros (round 15).
    const key = wireSessionToCanonical(this.host, sessionId);
    if (key === undefined) return empty;
    const bootstrap = await this.host.ready;
    if (bootstrap.kind !== "ok") return empty;
    const db = bootstrap.db;
    const count = (sql: string, ...params: (string | number)[]) =>
      (db.prepare(sql).get(...params) as { n: number }).n;
    try {
      const outbox = {
        pending: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'pending'",
          key,
        ),
        applied: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'applied'",
          key,
        ),
        committed: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'committed'",
          key,
        ),
        abandoned: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'abandoned'",
          key,
        ),
      };
      const tags = {
        active: count(
          "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'active'",
          key,
        ),
        dropped: count(
          "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'dropped'",
          key,
        ),
      };
      const compartments = count(
        "SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?",
        key,
      );
      const metaRow = db
        .prepare(
          "SELECT last_context_percentage, cached_m0_bytes FROM session_meta WHERE session_id = ?",
        )
        .get(key) as
        | { last_context_percentage: number | null; cached_m0_bytes: Uint8Array | null }
        | undefined;
      return {
        sessionId,
        outbox,
        tags,
        compartments,
        meta: {
          ...(typeof metaRow?.last_context_percentage === "number"
            ? { lastContextPercentage: metaRow.last_context_percentage }
            : {}),
          hasM0: metaRow?.cached_m0_bytes !== null && metaRow?.cached_m0_bytes !== undefined,
        },
      };
    } catch {
      return empty;
    }
  }
}

/**
 * Resolve a session id received over the Remote wire to this home's canonical
 * Magic key. Accepts the DSH-native id or this home's canonical key; answers
 * undefined (never throws) for an empty id, a malformed id (the key separator
 * inside a native id) or another home's canonical key.
 */
export function wireSessionToCanonical(
  host: Pick<MagicContextHostService, "canonicalKey"> & Partial<Pick<MagicContextHostService, "parseKey">>,
  raw: string,
): string | undefined {
  if (raw.length === 0) return undefined;
  try {
    const parsed = host.parseKey?.(raw);
    if (parsed !== undefined) return host.canonicalKey(parsed.dshSessionId) === raw ? raw : undefined;
    return host.canonicalKey(raw);
  } catch {
    return undefined;
  }
}

function safeDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** Strict single-`args` descriptor (src-json codecs, no schemas). */
export function magicMethodDescriptor(method: string): InvocationDescriptor {
  return {
    id: `magicContext.${method}`,
    service: "magicContextRemote",
    namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE,
    method,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "args",
        wire: "args",
        source: "json",
        codec: { mode: "src-json" },
      },
    ],
    result: { mode: "src-json" },
    sourceLocation: {
      file: "packages/dsh-plugin/src/host/remote.ts",
      line: 1,
      column: 1,
    },
  };
}

/** Strict descriptor for `magicContext/status` (src-json codecs, no schemas). */
export function magicStatusDescriptor(): InvocationDescriptor {
  return {
    id: "magicContext.status",
    service: "magicContextRemote",
    namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE,
    method: MAGIC_STATUS_METHOD,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "args",
        wire: "args",
        source: "json",
        codec: { mode: "src-json" },
      },
    ],
    result: { mode: "src-json" },
    sourceLocation: {
      file: "packages/dsh-plugin/src/host/remote.ts",
      line: 1,
      column: 1,
    },
  };
}

/** Strict descriptor for `magicContext/diagnostics` (Phase 4). */
export function magicDiagnosticsDescriptor(): InvocationDescriptor {
  return {
    id: "magicContext.diagnostics",
    service: "magicContextRemote",
    namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE,
    method: MAGIC_DIAGNOSTICS_METHOD,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "args",
        wire: "args",
        source: "json",
        codec: { mode: "src-json" },
      },
    ],
    result: { mode: "src-json" },
    sourceLocation: {
      file: "packages/dsh-plugin/src/host/remote.ts",
      line: 1,
      column: 1,
    },
  };
}

/**
 * Provide the remote service and register the `magicContext/status`
 * contribution. Returns a disposer, or undefined when the Typert registry is
 * absent from this host plane (headless profiles) — callers must tolerate
 * that. Registration is fiber-owned: the contribution auto-withdraws when the
 * calling plugin is stopped or updated.
 */
export function registerMagicContextRemote(
  ctx: Context,
  host: MagicContextHostService,
): (() => void) | undefined {
  const typert = ctx.get("typert") as TypertRegistry | undefined;
  if (typert === undefined) return undefined;

  const service = new MagicContextRemoteService(ctx, host);
  // The Service constructor provides `magicContextRemote`; no explicit
  // ctx.provide here (a second provide on the same fiber throws).

  const contribution: TypertContribution = {
    package: MAGIC_CONTEXT_PACKAGE,
    face: "host",
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      magicStatusDescriptor(),
      magicDiagnosticsDescriptor(),
      magicMethodDescriptor(MAGIC_SETTINGS_METHOD),
      magicMethodDescriptor(MAGIC_UPDATE_SETTINGS_METHOD),
      magicMethodDescriptor(MAGIC_CONTEXT_METHOD),
    ],
  };
  const disposer = typert.register(contribution);
  return () => {
    // The typert disposer may return a promise; never leave its rejection unhandled.
    fireAndForget(disposer(), undefined, "typert disposer");
  };
}

// ------------------------------------------------------------ settings

let jsoncCache: { at: number; dir: string; value: Partial<MagicContextPluginConfig> | undefined } | undefined;

/** jsonc (core loader) for the host cwd, cached briefly (the page polls). */
export function loadJsoncForHost(directory = process.cwd(), now = Date.now()): Partial<MagicContextPluginConfig> | undefined {
  if (jsoncCache !== undefined && jsoncCache.dir === directory && now - jsoncCache.at < 3_000) return jsoncCache.value;
  let value: Partial<MagicContextPluginConfig> | undefined;
  try {
    value = loadPluginConfigQuiet(directory);
  } catch {
    value = undefined;
  }
  jsoncCache = { at: now, dir: directory, value };
  return value;
}

/** Test seam: drop the jsonc cache. */
export function resetJsoncCache(): void {
  jsoncCache = undefined;
}

function effectiveFor(host: MagicContextHostService): EffectiveMagicSettings {
  return withExplicitRow(resolveEffectiveSettings(loadJsoncForHost(), host.overrides?.() ?? {}), host);
}

/**
 * Round 22: the agent plane resolves the hot keys as DSH override > explicit
 * profile row > jsonc. The jsonc-only view showed "default" for a row-set
 * historian.model the agent was running with (real rc.5, scenario K).
 */
export function withExplicitRow(effective: EffectiveMagicSettings, host: MagicContextHostService): EffectiveMagicSettings {
  let row: { historianModel?: string; protectedTokens?: number } = {};
  try {
    row = host.explicitRowConfig?.() ?? {};
  } catch {
    row = {};
  }
  let out = effective;
  if (typeof row.historianModel === "string" && effective.historianModel.source !== "dsh") {
    out = { ...out, historianModel: { value: row.historianModel, source: "profile" } };
  }
  if (typeof row.protectedTokens === "number" && effective.protectedTokens.source !== "dsh") {
    out = { ...out, protectedTokens: { value: row.protectedTokens, source: "profile" } };
  }
  return out;
}

function pendingRestartFor(host: MagicContextHostService): PendingRestartChange[] {
  try {
    const running = host.runningConfig?.() as Partial<MagicContextPluginConfig> | undefined;
    return pendingRestartChanges(running, loadJsoncForHost());
  } catch {
    return [];
  }
}

function pickOverlay(section: unknown): MagicDshOverrides {
  if (section === null || typeof section !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const field of MAGIC_OVERRIDE_FIELDS) {
    const value = (section as Record<string, unknown>)[field];
    if (value !== undefined && value !== null) out[field] = value;
  }
  return out as MagicDshOverrides;
}

export function buildSettingsView(
  forms: SettingsFormsView | undefined,
  host: MagicContextHostService,
): MagicSettingsView {
  const effective = effectiveFor(host);
  const configPath = resolveCortexKitUserConfigPath();
  const common = {
    namespace: MAGIC_SETTINGS_NAMESPACE,
    live: host.overrides?.() ?? {},
    effective,
    thresholds: resolveThresholds(effective, undefined),
    jsonc: { path: configPath, exists: existsSync(configPath), loaded: jsoncCache?.value !== undefined },
    bounds: MAGIC_OVERRIDE_BOUNDS,
    fields: MAGIC_OVERRIDE_FIELDS,
    precedence: MAGIC_SETTINGS_PRECEDENCE,
    pendingRestart: pendingRestartFor(host),
  };
  if (forms === undefined) {
    return {
      ...common,
      available: false,
      reason: "dsh-settings is not mounted in this profile (headless?); edit magic-context.jsonc or the profile cordis.patch.yml.",
      writable: false,
      user: {},
    };
  }
  let entry: ReturnType<SettingsFormsView["describe"]>[number] | undefined;
  try {
    entry = forms.describe({ redactSecrets: true }).find((candidate) => candidate.ns === MAGIC_SETTINGS_NAMESPACE);
  } catch (error) {
    return {
      ...common,
      available: false,
      reason: `settings.describe failed: ${error instanceof Error ? error.message : String(error)}`,
      writable: false,
      user: {},
    };
  }
  if (entry === undefined) {
    return {
      ...common,
      available: false,
      reason: `profile entry \`${MAGIC_SETTINGS_NAMESPACE}\` exposes no live form (host schemastery unresolvable, or the row id differs).`,
      writable: false,
      user: {},
    };
  }
  return {
    ...common,
    available: true,
    writable: forms.writable !== false,
    revision: entry.revision,
    user: pickOverlay(entry.user),
  };
}

function conflictNumbers(error: unknown): { expected?: number; actual?: number } | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const e = error as { code?: unknown; expected?: unknown; actual?: unknown; name?: unknown };
  if (e.code !== "SETTINGS_CONFLICT" && e.name !== "SettingsConflictError") return undefined;
  return {
    ...(typeof e.expected === "number" ? { expected: e.expected } : {}),
    ...(typeof e.actual === "number" ? { actual: e.actual } : {}),
  };
}

export async function applySettingsUpdate(
  forms: SettingsFormsView | undefined,
  host: MagicContextHostService,
  args: { ops?: unknown; expectedRevision?: unknown },
): Promise<MagicUpdateSettingsResult> {
  if (forms === undefined || typeof forms.mutate !== "function") {
    return { ok: false, code: "unavailable", message: "dsh-settings is not mounted in this profile." };
  }
  const invalid = validateMagicSettingsOps(args?.ops);
  if (invalid !== undefined) return { ok: false, code: "invalid", message: invalid };
  const expected = args?.expectedRevision;
  if (expected !== undefined && !(typeof expected === "number" && Number.isSafeInteger(expected) && expected >= 0)) {
    return { ok: false, code: "invalid", message: "expectedRevision must be a non-negative integer" };
  }
  if (forms.writable === false) {
    return { ok: false, code: "refused", message: "the active profile does not accept form edits", view: buildSettingsView(forms, host) };
  }
  const ops = (args.ops as MagicSettingsOp[]).map((op) =>
    op.op === "set"
      ? { op: "set" as const, path: [...op.path], value: typeof op.value === "string" ? op.value.trim() : op.value }
      : { op: "unset" as const, path: [...op.path] },
  );
  try {
    await forms.mutate(MAGIC_SETTINGS_NAMESPACE, ops, expected as number | undefined);
  } catch (error) {
    const conflict = conflictNumbers(error);
    if (conflict !== undefined) {
      return {
        ok: false,
        code: "conflict",
        message: "the settings changed since this page read them; reloaded — review and save again",
        ...conflict,
        view: buildSettingsView(forms, host),
      };
    }
    return {
      ok: false,
      code: "refused",
      message: error instanceof Error ? error.message : String(error),
      view: buildSettingsView(forms, host),
    };
  }
  return { ok: true, view: buildSettingsView(forms, host) };
}
