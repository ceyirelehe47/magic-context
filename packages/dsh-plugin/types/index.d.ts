/**
 * Public type surface of `dsh-magic-context` (the package root export).
 *
 * Hand-maintained on purpose: the implementation's own declarations reach into
 * Magic Context core (`@magic-context/core/*` path aliases that only resolve
 * inside this monorepo), so a tsc-emitted `dist/index.d.ts` would not resolve
 * for consumers. `src/contracts/public-types.contract.ts` pins this file
 * against the implementation (`bun run typecheck:dsh` fails on drift).
 */
import type { Context } from "@deepseek-ai/cordis";

/** Cordis plugin name (loader diagnostics). */
export declare const name: "magic-context-dsh";

/** Host plugin configuration. */
export interface MagicHostConfig {
  directory?: string;
  port?: number;
  homeHash?: string;
}

/** Shared-store bootstrap outcome (the DB handle is opaque to consumers). */
export type DshStorageBootstrap =
  | {
      readonly kind: "ok";
      readonly db: unknown;
      readonly storageDir: string;
      readonly livenessPath: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: "schema-fence" | "migration-guard";
      readonly detail: unknown;
    };

export type MagicSummarizeHook = (
  input: unknown,
  agent: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/** `ctx.magicContextHost` — the host service the adapter's planes consume. */
export interface MagicContextHostService {
  readonly ready: Promise<DshStorageBootstrap>;
  canonicalKey(dshSessionId: string): string;
  parseKey(key: string): { homeHash: string; dshSessionId: string } | undefined;
  registerSummarizeHook(hook: MagicSummarizeHook): void;
  summarizeHook(): MagicSummarizeHook | undefined;
}

export declare function apply(ctx: Context, config?: MagicHostConfig): void;
export declare function defaultHomeHash(): string;
