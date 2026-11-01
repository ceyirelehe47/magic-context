# Item 4 — real rc.5 session 0e0055dd (build 347a76d3c)

Profile `test`, extra patch `protected-4000.yml` (magic-agent `context.protectedTokens: 4000`; note: that
patch replaced the magic-agent row, so the historian threshold was the default 65 % and the historian ran on
the session route). 24k window.

Turns: 1 read LICENSE, 2 read src/agent/outbox.ts (14.9 kB), 3 read src/host/meter.ts (14.8 kB),
4 "call ctx_reduce", 5 "quote LICENSE", then (after a sandbox restart) 6 "reply OK", 7 "call ctx_reduce", 8 "reply DONE".

What happened (`real-item4-session-events-after.txt`, `real-item4-session-db.txt`, `real-item4-db-after.txt`):
- From turn 3 on the request sat at ~19.2k of 24k input tokens (80 %); with `maxTokens` 4096 every step ended
  `max-tokens` after 1 output token, so the model could not call `ctx_reduce` (turns 4 and 7).
- MC's own drops DID land on the real surface (they never could before the fix): the historian wrote 5
  compartments and queued drops for the covered messages; tags §1§ (turn-1 prompt) and §2§ (the folded
  tool-call assistant text) are `dropped` and the surface shows `[dropped §1§]` (seq 96, replace 10-10) and
  `[dropped §2§] … [tool: read …]` (seq 107, replace 21-21).
- Drops queued by hand for the two older tool results (§3§, §6§, the same `pending_ops` row ctx_reduce writes)
  stay pending: core's token-floor window protects all three tool tags (`protectedTagNumbers [3,6,9]`,
  floor 4000, cutoff 3 — read with the shipped `observedProtectionWindow` on a DB copy). That is core parity,
  not a DSH bug, but it is the gap the native pruner covers: nothing shrinks a protected 15 kB tool result.
- `§N§` ownership over raw events + surface: 0 duplicate numbers; one runtime-context snapshot in 8 turns.
