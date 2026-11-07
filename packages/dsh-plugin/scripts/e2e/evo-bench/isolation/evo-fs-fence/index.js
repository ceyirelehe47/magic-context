// Round 37 phase 2 — evo bench isolation, BENCH ONLY (installed into the bench
// profiles by evo-bench/run.sh; never shipped, never part of the plugin).
//
// The DSH in-process file tools (read / read_image / write / edit, and anything
// else that resolves a model-controlled path through `ctx.fs.resolve`) run inside
// the DSH host process, so the kernel boundaries the bench sets up (outer bwrap
// namespace for the whole DSH process, inner bwrap for every bash command and
// every ripgrep spawn) cannot hide the host's own storage from them. This
// plugin fences `ctx.fs.resolve`: a target that canonicalizes (symlinks
// resolved, nearest existing ancestor for new paths) under one of
// `hiddenRoots` is refused before any read, listing or write happens. The host
// itself never reads its session store / Magic DB through `ctx.fs`, so the
// host keeps full access; only the model's file tools are fenced.
import { realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

export const name = "evo-fs-fence";
export const inject = ["fs"];

function canonical(path) {
  let current = resolve(path);
  const tail = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

export function isHidden(target, roots) {
  const key = canonical(target);
  return roots.some((root) => key === root || key.startsWith(root.endsWith(sep) ? root : root + sep));
}

export function apply(ctx, config) {
  const roots = (config?.hiddenRoots ?? []).filter((p) => typeof p === "string" && p.length > 0).map(canonical);
  const fs = ctx.fs;
  const original = fs.resolve;
  if (typeof original !== "function") throw new Error("evo-fs-fence: ctx.fs.resolve is not a function");
  const fenced = async function (path, opts) {
    const target = await original.call(this, path, opts);
    const key = String(target?.targetKey ?? "");
    if (key.length > 0 && isHidden(key, roots)) {
      const error = new Error(`EACCES: permission denied, '${target.displayPath ?? path}' (evo-bench isolation)`);
      error.code = "EACCES";
      throw error;
    }
    return target;
  };
  fs.resolve = fenced;
  ctx.effect?.(() => () => {
    if (fs.resolve === fenced) fs.resolve = original;
  });
  ctx.logger?.info?.(`evo-fs-fence: ${roots.length} hidden root(s)`);
}
