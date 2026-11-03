# Round 23 — sporadic `max-tokens` on the 40k / 100k routes (investigation only)

Source: decoded session logs of round 22 e2e runs 41616050491 (r1) and
41618120979 (r2) — every `assistant/message` whose stream `finish` is
`{kind: "max-tokens"}` (provider `stopReason: "length"`). Prompt = provider
usage `inputTokens + cacheReadTokens`; request `maxTokens` from the preceding
`request/header`.

| run / session | seq | route (configured window) | prompt (provider) | output | finish |
|---|---|---|---|---|---|
| r1 lock | 97 | opencode-go-40k (40 000) | 29 557 | 85 | max-tokens |
| r1 lock | 109 | opencode-go-40k | 29 826 | 1 | max-tokens |
| r1 lock | 140 | opencode-go-40k | 30 330 | 1 | max-tokens |
| r2 lock | 98 | opencode-go-40k | 29 478 | 174 | max-tokens |
| r2 lock | 110 | opencode-go-40k | 29 761 | 1 | max-tokens |
| r1 pnew | 170 | opencode-go-100k (100 000) | 87 959 | 1 | max-tokens |
| r1 pnew | 184 | opencode-go-100k | 88 228 | 1 | max-tokens |

Same routes, success: 40k up to 29 837 prompt (cmp, `tool-calls`), 100k up to
72 702. Header `maxTokens` = 4096 in every request.

## Verdict

- **Not a provider-side context overflow.** prompt + 4096 stays below even the
  artificial route window (40k: ≤ 34 426; 100k: ≤ 92 324), the real model
  window is larger, and the provider returns a normal `length` stop.
- **Not an oversized request from us.** What we (DSH + Magic) send fits.
- **Cause: client-side clamp of `max_tokens` in pi-ai.** DSH's model adapter
  `@deepseek-ai/dsh-llm-pi-ai` 0.2.1-rc.5 streams through
  `@earendil-works/pi-ai` (`^1.1.0`; 1.5.0 inspected). `buildBaseOptions` →
  `clampMaxTokensToContext(model, context, maxTokens)`:
  `max_tokens = min(maxTokens, max(1, contextWindow − estimateContextTokens(context) − 4096))`.
  `estimateContextTokens` prefers the last assistant message's `usage`, but
  dsh-llm-pi-ai replays every assistant message with `usage: emptyPiUsage()`
  (lib/index.js, both replay paths), so the estimate is always the full
  chars/3.5 sum of all messages **plus the tool schemas** (sent as a system
  message's `toolsAdded`, ≈ 9.2k estimated tokens here). Reconstructed for r1
  lock seq 97: messages ≈ 26 576 + tools ≈ 9 199 = 35 775 → 40 000 − 35 775 −
  4 096 ≈ 129 (observed 85, same order); seq 109 / 140: estimate > 35 904 →
  clamped to the minimum 1 → one output token.
- The estimate overshoots the provider's count by ≈ 20 %, so the clamp starts
  at ≈ 74–75 % real usage on a 40k window and ≈ 80–88 % on 100k, independent of
  Magic (the empty usage is DSH's, with or without Magic's surface rewrites).
- **Classification: not P0** under the round-23 rule (our request is not over
  the limit). Known limitation, see DSH-MAINTENANCE "Known limitations" 17.
