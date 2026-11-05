### tarball head.tgz

- files: 381; top-level: ['LICENSE', 'NOTICE', 'README.md', 'README.zh.md', 'cordis.patch.yml', 'dist', 'package.json', 'src', 'types']
- name: "dsh-magic-context"
- version: "0.49.35-dsh.7"
- main: "dist/index.js"
- types: "./types/index.d.ts"
- bin: {"dsh-magic-context": "dist/cli.js"}
- dependencies: {"ai-tokenizer": "^1.0.6"}
- peerDependencies: {"@deepseek-ai/dsh-client-connection": "0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1", "@deepseek-ai/dsh-client-ui-primitives": "0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1", "@deepseek-ai/dsh-client-ui-slots": "0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1", "@deepseek-ai/dsh-session": "0.2.1-rc.5 || 0.2.2-
- peerDependenciesMeta: {"react": {"optional": true}, "@deepseek-ai/dsh-client-connection": {"optional": true}, "@deepseek-ai/dsh-client-ui-primitives": {"optional": true}, "@deepseek-ai/dsh-client-ui-slots": {"optional": true}}
- exports: {".": {"types": "./types/index.d.ts", "default": "./dist/index.js"}, "./agent": "./dist/entries/agent.js", "./compaction": "./dist/entries/compaction.js", "./commands": "./dist/entries/commands.js", "./tools": "./dist/entries/tools.js", "./remote": "./dist/entries/remote.js", "./meter": "./dist/entr
- devDependencies with workspace: specs (not installed by consumers): none
- entry files named by the manifest: 14, missing: none
- dist/cli.js: 1261059 bytes, mode 0o755, first line `#!/usr/bin/env node`
- B4 probe (static): dist/cli.js resolves realpath for the entry check: True
- B5 probe (static): dist files defining ctx_expand: 11; of those referencing withoutInjectedText: 2
- test files shipped (src/ is in `files`): 95
- npm pack: 381 files; only in bun pm pack: []; only in npm pack: []
- npm pack package.json version 0.49.35-dsh.7, devDependencies workspace specs kept: ['dsh-magic-context-adapter']

**result: PASS**
