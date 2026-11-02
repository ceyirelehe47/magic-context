# Round 11 item 2 — real rc.5 web (`webtest`, build 313b67393), Playwright headless shell

Session "Round 7 Hello Test" (MC-managed, ring at 58 %). All changes made through the real Settings modal
(Account menu → Settings → Magic Context → Execute threshold → Override/Inherit → Save), ring read from the
composer dock right after closing the modal, **with no agent step in between**.

| scenario | Save → "Saved" | ring right after Save (no step) | round 8 behaviour |
|---|---|---|---|
| idle, override 54 (`ring-refresh.json`) | 2.5 s | `ckmc-warn` (yellow) from the first sample (≤1 s after Saved), title "Execute threshold 54 %" | grey until the next agent step |
| idle, Inherit | 2.0 s | grey, "Execute threshold 65 %" | yellow until the next agent step |
| during a running turn, override 54 (`turn-save.json`) | 4.9 s; "Still saving — DSH applies profile edits between agent steps…" shown at 4.0 s (watchdog hint, 3 s) | yellow immediately | button sat on "Saving…" > 3 s with no feedback |
| after the turn, Inherit | 1.8 s | grey immediately | — |

Profile patch: `magic-host` row written with `executeThresholdPercentage: 54`, removed again on Inherit.
Console errors: none. Screenshots: `r11-ring-before.png`, `r11-1_set-*.png`, `r11-2_inherit-*.png`,
`r11-3_set_during_turn-*.png`, `r11-5_inherit_after_turn-*.png`.
Not exercised live: the 20 s give-up path (stop blocking + reload; unit/static only) — no real save took that long.
