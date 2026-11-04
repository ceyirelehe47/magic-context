#!/usr/bin/env python3
"""Round 29: does a dsh-magic-context manifest DECLARE a DSH version?

  dsh-declared.py <package.json | plugin .tgz> <dsh version>   -> exit 0 declared, 1 not

Mirrors DSH's plugin manager rule (dsh-app-boot evaluatePluginCompatibility:
`engines.dsh` decides alone, else every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
peer must accept the runtime) for the only range form this adapter uses: exact
versions joined by `||`. Any other range form counts as NOT declared (the CI
lanes then fall back to DSH's exact-version exemption, visibly). Used by
dsh-ci.yml, install-accept.sh and ci-check.py so CI grants an exemption only
to a package whose own declaration leaves the running DSH out (e.g. the old
dsh.2 tarball on 0.2.2-alpha.3), never to one that declares it.
"""
import json, re, sys, tarfile

EXACT = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$")


def load(path):
    if path.endswith(".tgz") or path.endswith(".tar.gz"):
        with tarfile.open(path) as t:
            return json.load(t.extractfile("package/package.json"))
    with open(path) as f:
        return json.load(f)


def accepts(rng, version):
    alts = [a.strip() for a in str(rng).split("||")]
    return all(EXACT.match(a) for a in alts) and version in alts


def declared(manifest, version):
    """(declared?, reason)"""
    engines = manifest.get("engines") or {}
    if "dsh" in engines:
        ok = accepts(engines["dsh"], version)
        return ok, f"engines.dsh {engines['dsh']!r}"
    peers = {k: v for k, v in (manifest.get("peerDependencies") or {}).items()
             if k == "@deepseek-ai/dsh" or k.startswith("@deepseek-ai/dsh-")}
    if not peers:
        return True, "no DSH requirement"
    bad = sorted(k for k, v in peers.items() if not accepts(v, version))
    ranges = sorted(set(peers.values()))
    return not bad, f"dsh peers {ranges} ({len(bad)}/{len(peers)} leave {version} out)"


if __name__ == "__main__":
    m = load(sys.argv[1])
    ok, why = declared(m, sys.argv[2])
    print(f"{m.get('name')}@{m.get('version')} {'declares' if ok else 'does NOT declare'} DSH {sys.argv[2]}: {why}")
    sys.exit(0 if ok else 1)
