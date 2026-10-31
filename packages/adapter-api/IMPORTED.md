# Provenance

`packages/adapter-api` and `packages/dsh-plugin` were imported verbatim from the
community port **xiaohj233/dsh-magic-context** at commit `6c82abd`
(release v0.1.2, MIT, Copyright (c) 2026 xiao_hj909) — see `LICENSE`, `NOTICE`
and `THIRD_PARTY_NOTICES.md` in each package. Prebuilt `dist/` folders were not
imported. The only change in the import commit is wiring
`dsh-magic-context-adapter` to the in-repo workspace package (`workspace:*`)
instead of the `github:` spec.

Subsequent commits on the `dsh-integration` branch port the code from
DSH 0.1.0-rc.6 / Magic Context core 0.36.1 to `@deepseek-ai/dsh` 0.2.1-rc.5 /
core 0.49.x. See `docs/DSH-MAINTENANCE.md`.
