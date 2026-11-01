# Round 8 evidence (real DSH 0.2.1-rc.5 web, profile `webtest`, 2026-11-01)

All files are redacted copies (`<work>` = sandbox work dir, web token removed).

| file | what it shows |
|---|---|
| `setup-disable-ptc.txt` | `setup --disable-preset ptc`: selection `cordis,minimal,standard (was: cordis,minimal,ptc,standard)`, rc=0 |
| `doctor-disable-ptc.txt` | doctor afterwards: `ptc: disabled`, cordis/minimal/standard `enabled`, composer indicator still the MC meter; `doctor --disable-preset ptc` rc=0; `doctor --all-presets` (expectation) rc=1 while ptc is off |
| `dump-ptc-disabled-summary.txt` | `dsh --dump-config` of the composed tree: `preset-ptc` back to stock (`compaction-basic` active, no magic rows), the other three presets keep `compaction-basic: disabled` + `magic-compaction`/`magic-agent`; `magic-meter.magicPresets` = cordis, minimal, standard |
| `setup-restore-all-presets.txt`, `doctor-restore-all-presets.txt` | `setup --all-presets` restores ptc; the profile patch is byte-identical to the pre-test file |
| `settings-live.json` | Settings endpoints, live: set threshold 50 → profile `magic-host` row written, `settings`/`context` report 50 (source `dsh`); stale revision → `conflict` (expected 0, actual 1, view returned); out-of-bounds 5 and unknown field → `invalid`, nothing written; ring grey 54 % before, yellow (`ckmc-warn`) 56 % after the next step; popover text (Nudge line = band name only); unset → row removed, back to 65 (source `jsonc`) |
| `r8-ring-before.png`, `r8-ring-after-step-threshold50.png`, `r8-popover-threshold50.png`, `r8-ring-after-unset.png` | screenshots of the same run |
