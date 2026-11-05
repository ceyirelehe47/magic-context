#!/usr/bin/env python3
"""Round 33 (P0) — inspect a packed dsh-magic-context tarball against its source manifest.

    tarball-inspect.py <plugin.tgz> <source package.json> [--npm <npm-packed.tgz>] [--expect-version V]

Prints a markdown report (file list summary, name / version / bin / peers / dependencies,
dist/cli.js shebang + mode, the entry files package.json `exports` / `main` / `bin` name,
fixes visible in the bundle) and exits 1 when the tarball is not what the source says:
  - name / version / peerDependencies / peerDependenciesMeta / dependencies / bin / exports
    differ from the source package.json, or any of them carries a `workspace:` spec;
  - a file named by main / types / bin / exports / dsh.bundle.patch is missing;
  - dist/cli.js has no `#!/usr/bin/env node` shebang or is not executable;
  - --npm given: the npm-packed tarball's file list differs from this one's.
The bundle probes (B4 realpath, B5 withoutInjectedText) only report presence: the dsh.6
tarball matches them too (round 33), so they decide nothing — the runtime checks
(install-accept-check.py A6 / A7, with the OLD tarball as control) do.
"""
import json
import sys
import tarfile

args = sys.argv[1:]
tgz, src = args[0], args[1]
npm_tgz = args[args.index("--npm") + 1] if "--npm" in args else None
expect = args[args.index("--expect-version") + 1] if "--expect-version" in args else None
source = json.load(open(src))
fails = []


def members(path):
    with tarfile.open(path) as t:
        return {m.name: m for m in t.getmembers() if m.isfile()}


def read(path, name):
    with tarfile.open(path) as t:
        return t.extractfile(name).read()


files = members(tgz)
pkg = json.loads(read(tgz, "package/package.json"))
print(f"### tarball {tgz.split('/')[-1]}\n")
print(f"- files: {len(files)}; top-level: {sorted({n.split('/')[1] for n in files})}")
for k in ("name", "version", "main", "types", "bin", "dependencies", "peerDependencies", "peerDependenciesMeta", "exports"):
    same = pkg.get(k) == source.get(k)
    print(f"- {k}: {json.dumps(pkg.get(k), ensure_ascii=False)[:300]}{'' if same else '  **differs from source: ' + json.dumps(source.get(k))[:200] + '**'}")
    if not same:
        fails.append(f"{k} differs from the source package.json")
if expect and pkg.get("version") != expect:
    fails.append(f"version {pkg.get('version')} != expected {expect}")
for k in ("dependencies", "peerDependencies", "optionalDependencies"):
    for dep, spec in (pkg.get(k) or {}).items():
        if str(spec).startswith("workspace:"):
            fails.append(f"{k}.{dep} = {spec}")
dev_ws = [d for d, s in (pkg.get("devDependencies") or {}).items() if str(s).startswith("workspace:")]
print(f"- devDependencies with workspace: specs (not installed by consumers): {dev_ws or 'none'}")

need = set()
for v in (pkg.get("main"), pkg.get("types"), *(pkg.get("bin") or {}).values(), (pkg.get("dsh") or {}).get("bundle", {}).get("patch")):
    if v:
        need.add(v)
for v in (pkg.get("exports") or {}).values():
    if isinstance(v, str):
        need.add(v)
    elif isinstance(v, dict):
        need.update(x for x in v.values() if isinstance(x, str))
missing = sorted(n for n in need if "package/" + n.lstrip("./") not in files)
print(f"- entry files named by the manifest: {len(need)}, missing: {missing or 'none'}")
fails += [f"missing {m}" for m in missing]

cli = "package/dist/cli.js"
if cli in files:
    head = read(tgz, cli)[:64].split(b"\n")[0].decode(errors="replace")
    mode = oct(files[cli].mode & 0o777)
    print(f"- dist/cli.js: {files[cli].size} bytes, mode {mode}, first line `{head}`")
    if head.strip() != "#!/usr/bin/env node":
        fails.append("dist/cli.js shebang")
    if not files[cli].mode & 0o111:
        fails.append("dist/cli.js not executable")
    body = read(tgz, cli).decode(errors="replace")
    print(f"- B4 probe (static, presence only — NOT discriminating, dsh.6 matches too): 'realpath' in dist/cli.js: {'realpathSync' in body or 'realpath' in body}")
else:
    fails.append("dist/cli.js missing")

expand_files = [n for n in files if n.startswith("package/dist/") and n.endswith(".js") and b"ctx_expand" in read(tgz, n)]
wit = [n for n in expand_files if b"withoutInjectedText" in read(tgz, n)]
print(f"- B5 probe (static, presence only — NOT discriminating, dsh.6 matches too): dist files defining ctx_expand: {len(expand_files)}; of those referencing withoutInjectedText: {len(wit)}")
tests = [n for n in files if n.endswith(".test.ts")]
print(f"- test files shipped (src/ is in `files`): {len(tests)}")

if npm_tgz:
    nf = members(npm_tgz)
    only_bun = sorted(set(files) - set(nf))
    only_npm = sorted(set(nf) - set(files))
    npkg = json.loads(read(npm_tgz, "package/package.json"))
    print(f"- npm pack: {len(nf)} files; only in bun pm pack: {only_bun[:10]}{'…' if len(only_bun) > 10 else ''}; only in npm pack: {only_npm[:10]}{'…' if len(only_npm) > 10 else ''}")
    print(f"- npm pack package.json version {npkg.get('version')}, devDependencies workspace specs kept: {[d for d, s in (npkg.get('devDependencies') or {}).items() if str(s).startswith('workspace:')]}")
    if only_bun or only_npm:
        fails.append("bun pm pack and npm pack ship different files")

print("\n**result: " + ("FAIL — " + "; ".join(fails) if fails else "PASS") + "**")
sys.exit(1 if fails else 0)
