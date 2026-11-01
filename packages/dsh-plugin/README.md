# dsh-magic-context

Magic Context for DeepSeek Harness (DSH). A DSH plugin bundle (host / agent /
client) that loads the shared Magic Context SQLite store (`harness='dsh'` row
isolation) and registers the `ctx_*` tools, `/ctx-*` commands, knowledge
injection, historian/dreamer scheduling, Magic compaction, a **Magic Context
section on the DSH Settings page** and a **Magic Context context meter** in
the composer.

> Community port maintained on the `dsh-integration` branch of a fork of
> https://github.com/cortexkit/magic-context (MIT). Not affiliated with the
> DeepSeek projects. Maintainer notes: `docs/DSH-MAINTENANCE.md`.

Compatibility: DSH **0.2.1-rc.5** (exact; `doctor` checks it), Magic Context
core v0.49.x shared schema (v95).

## Install

Install the package into the DSH profile (`dsh plugin --profile <name> add
dsh-magic-context`, or put the built package in the profile's `node_modules`),
then wire it:

```sh
dsh-magic-context setup  --profile web                 # first run: Magic in a generated `magic-standard` mode
dsh-magic-context setup  --profile web --all-presets   # or: Magic in every stock mode (standard, ptc, minimal, cordis)
dsh-magic-context setup  --profile web --preset standard,ptc
dsh-magic-context setup  --profile web --disable-preset ptc
dsh-magic-context doctor --profile web                 # per-preset enabled/disabled + meter state
```

`setup` adds the bundle to `dsh.profile.bundles` and writes a managed block
into `$DSH_HOME/profiles/<name>/cordis.patch.yml`: per enabled agent preset
it disables `compaction-basic` and mounts `magic-compaction` + `magic-agent`;
profile-wide it swaps the stock `token-meter` row for `magic-meter`. Flat
(headless/tui) profiles have one pseudo-preset, `root`. The selection is
remembered in the block; `--preset` / `--disable-preset` add/remove relative
to it, an empty selection removes the block. It also creates
`~/.config/cortexkit/magic-context.jsonc` once (never overwritten). Restart
DSH (or start new sessions) after changing presets.

## Settings

Magic Context reads the shared `magic-context.jsonc` (project
`.cortexkit/magic-context.jsonc` > user `~/.config/cortexkit/…`), the same file
OpenCode and Pi use. On DSH, **Settings → Magic Context** can override a few
fields per profile, live:

| field | meaning |
|---|---|
| Enabled | turn Magic Context's per-step work on/off |
| Historian model | `provider/model` for compartment runs — use a large-window route |
| Historian await at turn end (ms) | headless only; 0 = off |
| Execute threshold % | when Magic starts reducing (20–90) |
| Per-model execute threshold | `provider/model` → % |
| Protected tokens | token floor of newest tool output that is never dropped |

**Precedence: DSH override > `magic-context.jsonc` > core default.** An unset
DSH field inherits the jsonc value ("reset" = clear the field). DSH never
writes the jsonc file. Edits land in the active profile's `cordis.patch.yml`
(`- id: magic-host` row) and apply on the next agent step without restarting.

## Context meter

The composer ring shows **Magic Context's** context usage: yellow from the MC
execute threshold, red from just below the force threshold; click it for the
details (thresholds, system/tools/conversation split, compartments and
historian state, pending drops, knowledge tokens, nudge) and a link to the
settings section. The native DSH ring is hidden by `setup`: the real token
meter keeps running (other plugins such as `tool-result-pruner` depend on its
`tokenMeter` service) but its `contextPressure` projection is republished as
`magicContextPressure`, so only the MC ring renders.

## Uninstall

`dsh-magic-context setup --profile <name> --disable-preset <each enabled
preset>` (removes the managed block), then remove the bundle from the
profile. The shared SQLite and `dsh_*` adapter tables are intentionally kept
(cross-harness data).

## License

MIT. Upstream copyright notices: see `THIRD_PARTY_NOTICES.md` and `NOTICE`.
