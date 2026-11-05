import { describe, expect, it } from "bun:test";
import { magicWorkerActivation } from "./subagent";

/**
 * Round 32 — DSH master (deepseek-ai/deepseek-harness fcc0ad4621, after
 * 0.2.2-rc.1) flattened `SubagentActivationSpec`: it now `extends
 * Omit<SubagentStartRequest, 'label' | 'signal'>` and `startActivation` reads
 * `spec.parent` / `spec.prompt` / `spec.maxDepth`; the nested `request` field
 * is gone. Every released DSH the plugin declares (0.2.1-rc.5, 0.2.2-alpha.3,
 * 0.2.2-rc.1) still reads `spec.request.*`. Real master code on the old spec:
 * `TypeError: undefined is not an object (evaluating 'spec.parent.id')`
 * (docs/dsh/e2e/evidence-round32). The spec therefore carries the task in both
 * places, with identical values.
 */
describe("magicWorkerActivation spec shape (released nested request + DSH master flattened)", () => {
  const parent = { id: "parent-1", session: { id: "parent-1" } } as never;
  const signal = new AbortController().signal;

  it("keeps the nested request read by rc.5 / alpha.3 / rc.1", () => {
    const spec = magicWorkerActivation(parent, {
      label: "w",
      prompt: [{ type: "text", text: "task" }],
      maxDepth: 1,
      signal,
      childId: "child-1",
    }) as unknown as { request: { parent: unknown; prompt: unknown[]; maxDepth: number } };
    expect(spec.request.parent).toBe(parent);
    expect(spec.request.prompt).toEqual([{ type: "text", text: "task" }]);
    expect(spec.request.maxDepth).toBe(1);
  });

  it("also carries parent / prompt / maxDepth at the top level (DSH master flattened spec)", () => {
    const spec = magicWorkerActivation(parent, {
      label: "w",
      prompt: [{ type: "text", text: "task" }],
      maxDepth: 1,
      signal,
      systemPrompt: "be terse",
    }) as unknown as Record<string, unknown> & { request: Record<string, unknown> };
    expect(spec.parent).toBe(parent);
    expect(spec.maxDepth).toBe(1);
    expect(spec.prompt).toEqual(spec.request.prompt);
    expect((spec.prompt as Array<{ text: string }>)[0]?.text).toContain("be terse");
    expect(spec.provider).toBe("spawn");
    expect(spec.delivery).toBe("caller");
    expect(spec.label).toBe("w");
    expect(spec.signal).toBe(signal);
  });

  it("adds no field the released spec does not know besides the flattened request copy", () => {
    const spec = magicWorkerActivation(parent, {
      label: "w",
      prompt: [{ type: "text", text: "task" }],
      signal,
      childId: "child-1",
    }) as unknown as Record<string, unknown>;
    expect(Object.keys(spec).sort()).toEqual(
      ["childId", "delivery", "label", "maxDepth", "parent", "prompt", "provider", "request", "signal"].sort(),
    );
  });
});
