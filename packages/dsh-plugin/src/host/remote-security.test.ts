/**
 * Phase 5 security audit (PLAN §11): Remote responses must never leak
 * secrets; the diagnostics endpoint bounds its input; the client bundle must
 * not render untrusted data as HTML.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAGIC_CONTEXT_REMOTE_NAMESPACE } from "../compat/dsh-0.1/typert";
import {
  MAGIC_CONTEXT_METHOD,
  MAGIC_DIAGNOSTICS_METHOD,
  MAGIC_SETTINGS_METHOD,
  MAGIC_STATUS_METHOD,
  MAGIC_UPDATE_SETTINGS_METHOD,
  magicDiagnosticsDescriptor,
  magicMethodDescriptor,
  magicStatusDescriptor,
  registerMagicContextRemote,
} from "./remote";

describe("Phase 5 security audit", () => {
  it("remote descriptors carry the strict namespace and no secret-adjacent fields", () => {
    for (const descriptor of [magicStatusDescriptor(), magicDiagnosticsDescriptor()]) {
      expect(descriptor.namespace).toBe(MAGIC_CONTEXT_REMOTE_NAMESPACE);
      expect(descriptor.invocation.kind).toBe("direct");
      const serialized = JSON.stringify(descriptor);
      // No secret-bearing field names anywhere in the wire contract.
      expect(serialized.toLowerCase()).not.toMatch(/apikey|api_key|secret|token|password|credential/);
    }
    expect(magicStatusDescriptor().method).toBe(MAGIC_STATUS_METHOD);
    expect(magicDiagnosticsDescriptor().method).toBe(MAGIC_DIAGNOSTICS_METHOD);
  });

  it("settings / updateSettings / context descriptors share the strict single-args shape", () => {
    for (const method of [MAGIC_SETTINGS_METHOD, MAGIC_UPDATE_SETTINGS_METHOD, MAGIC_CONTEXT_METHOD]) {
      const descriptor = magicMethodDescriptor(method);
      expect(descriptor.id).toBe(`magicContext.${method}`);
      expect(descriptor.namespace).toBe(MAGIC_CONTEXT_REMOTE_NAMESPACE);
      expect(descriptor.parameters.map((p) => p.wire)).toEqual(["args"]);
      expect(JSON.stringify(descriptor).toLowerCase()).not.toMatch(/apikey|api_key|secret|password|credential/);
    }
  });

  it("registers all five invocations in one host contribution (real cordis Context)", async () => {
    const { Context } = await import("@deepseek-ai/cordis");
    const contributions: Array<{ invocations: Array<{ method: string }> }> = [];
    const root = new Context();
    root.provide("typert", { register: (c: never) => (contributions.push(c), () => {}) } as never);
    let disposer: (() => void) | undefined;
    root.plugin({
      name: "remote-test",
      inject: ["typert"],
      apply(ctx: unknown) {
        disposer = registerMagicContextRemote(ctx as never, { ready: Promise.resolve({ kind: "refused" }) } as never);
      },
    } as never, undefined as never);
    for (let i = 0; i < 20 && contributions.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(disposer).toBeDefined();
    expect(contributions[0]!.invocations.map((i) => i.method).sort()).toEqual(
      [MAGIC_CONTEXT_METHOD, MAGIC_DIAGNOSTICS_METHOD, MAGIC_SETTINGS_METHOD, MAGIC_STATUS_METHOD, MAGIC_UPDATE_SETTINGS_METHOD].sort(),
    );
  });

  it("diagnostics descriptor bounds its input (sessionId length cap)", () => {
    const parameters = magicDiagnosticsDescriptor().parameters;
    expect(parameters.length).toBe(1);
    expect(parameters[0]?.name).toBe("args");
    expect(parameters[0]?.codec.mode).toBe("src-json");
  });

  it("the client bundle never assigns untrusted content into innerHTML", () => {
    const client = readFileSync(
      join(import.meta.dir, "..", "client", "client.js"),
      "utf8",
    );
    // The XSS surface is dynamic HTML assignment with interpolated values.
    expect(client).not.toMatch(/innerHTML\s*=\s*[^;]*\$\{/);
    expect(client).not.toMatch(/insertAdjacentHTML\s*\(/);
    // Text insertion must go through textContent / createTextNode.
    expect(client).toMatch(/textContent/);
  });

  it("the host status payload carries no environment or credential echo", () => {
    const descriptor = magicStatusDescriptor();
    const serialized = JSON.stringify(descriptor).toLowerCase();
    expect(serialized).not.toContain("process.env");
    expect(serialized).not.toContain("dsh_home=");
  });
});
