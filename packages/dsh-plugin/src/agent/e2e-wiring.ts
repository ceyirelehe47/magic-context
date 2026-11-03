/**
 * agent/e2e-wiring — binds the round 22 E2E-ONLY hooks (`e2e-hooks.ts`) to the
 * agent plane's live objects. Registers nothing unless the master gate
 * `MAGIC_CONTEXT_DSH_E2E=1` and a switch are set (checked inside the hooks).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { acquireCompartmentLease, releaseCompartmentLease } from "@magic-context/core/features/magic-context/compartment-lease";
import { readEpochFloorSnapshot } from "@magic-context/core/features/magic-context/protection-window";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { MagicContextHostService } from "../index";
import type { PendingRestartChange } from "../settings/config-load";
import { e2eGateOpen, e2eHoldRemainingMs, e2eSay, registerE2eCompactAtIdle, registerE2eStatusDump } from "./e2e-hooks";
import { isMagicChildSession } from "./worker";

export interface E2eWiringDeps {
  host: MagicContextHostService;
  live: { pendingRestart(): PendingRestartChange[] };
  hotProtectedTokens(): number | undefined;
  hotHistorianModel(): string | undefined;
  busy(agent: unknown): boolean;
  db(): Database | undefined;
  env?: Record<string, string | undefined>;
}

type CommandsLike = {
  execute(agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<
    { commandId: unknown; result: { kind: string; text?: string } } | undefined
  >;
};

export const E2E_FAKE_LEASE_HOLDER = "e2e-fake-lease";

export function registerE2eWiring(ctx: Context, deps: E2eWiringDeps): void {
  const env = deps.env ?? process.env;
  if (!e2eGateOpen(env)) return;
  const c = ctx as unknown as {
    on(event: string, listener: (...args: any[]) => unknown, options?: unknown): () => unknown;
    get(name: string): unknown;
  };
  const isChild = (agent: unknown) => {
    try {
      return isMagicChildSession(agent as Agent);
    } catch {
      return true;
    }
  };
  const keyOf = (agent: unknown) => deps.host.canonicalKey(String((agent as { id?: unknown }).id ?? ""));
  const commands = () => c.get("commands") as CommandsLike | undefined;

  registerE2eCompactAtIdle({
    env,
    on: (event, listener) => c.on(event, listener),
    commands,
    isChild,
    historianBusy: deps.busy,
    holdRemainingMs: (agent) => e2eHoldRemainingMs(keyOf(agent)),
    fakeLease: (agent, _ms) => {
      const db = deps.db();
      if (db === undefined) return undefined;
      const key = keyOf(agent);
      if (acquireCompartmentLease(db, key, E2E_FAKE_LEASE_HOLDER) === null) return undefined;
      return () => releaseCompartmentLease(db, key, E2E_FAKE_LEASE_HOLDER);
    },
  });

  registerE2eStatusDump({
    env,
    on: (event, listener) => c.on(event, listener),
    isChild,
    stepSnapshot: (agent) => {
      const db = deps.db();
      let floor: number | null = null;
      try {
        floor = db === undefined ? null : readEpochFloorSnapshot(db, keyOf(agent));
      } catch {
        floor = null;
      }
      // Round 23c (scenario Y, kill -9): what the busy probe answers and the
      // lease row it answers about (holder pid) at this step.
      let leases: unknown[] = [];
      try {
        leases = db === undefined
          ? []
          : (db.prepare("SELECT holder_id, owner_pid, expires_at FROM compartment_state_lease WHERE session_id = ?").all(keyOf(agent)) as unknown[]);
      } catch {
        leases = [];
      }
      let historianBusy: boolean | null = null;
      try {
        historianBusy = deps.busy(agent);
      } catch {
        historianBusy = null;
      }
      return {
        historianBusy,
        leases,
        hotProtectedTokens: deps.hotProtectedTokens() ?? null,
        hotHistorianModel: deps.hotHistorianModel() ?? null,
        protectedFloor: floor,
        pendingRestartKeys: deps.live.pendingRestart().map((p) => p.key),
      };
    },
    turnSnapshot: async (agent) => {
      const a = agent as Agent;
      const remote = c.get("magicContextRemote") as
        | { settings(): Promise<unknown>; context(args: Record<string, unknown>): Promise<unknown> }
        | undefined;
      const out: Record<string, unknown> = {};
      try {
        out.settingsView = remote === undefined ? { error: "magicContextRemote unavailable" } : await remote.settings();
      } catch (error) {
        out.settingsView = { error: error instanceof Error ? error.message : String(error) };
      }
      try {
        const { provider, model } = a.options ?? {};
        out.popover = remote === undefined
          ? { error: "magicContextRemote unavailable" }
          : await remote.context({ sessionId: a.id, ...(provider && model ? { model: `${provider}/${model}` } : {}) });
      } catch (error) {
        out.popover = { error: error instanceof Error ? error.message : String(error) };
      }
      try {
        const reg = commands();
        const res = reg === undefined ? undefined : await reg.execute(agent, "/ctx-status", [], new AbortController().signal);
        out.ctxStatus = res === undefined ? { error: "ctx-status not resolved" } : { kind: res.result.kind, text: res.result.text ?? "" };
      } catch (error) {
        out.ctxStatus = { error: error instanceof Error ? error.message : String(error) };
      }
      out.pendingRestart = deps.live.pendingRestart();
      out.hotProtectedTokens = deps.hotProtectedTokens() ?? null;
      return out;
    },
  });
  e2eSay("e2e wiring active (MAGIC_CONTEXT_DSH_E2E=1)");
}
