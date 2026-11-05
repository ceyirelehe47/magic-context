# Round 33 B — upstream issue drafts (NOT filed)

Drafts only. Nothing here was posted to GitHub (no issue, PR or comment on
cortexkit/magic-context, deepseek-harness or any other repository). Filing is the
user's decision.

---

## 1. cortexkit/magic-context (core) — exact identifier queries lose to RRF neighbours

**Title:** `ctx_search`: an exact identifier match is not ranked first when message FTS and compartment vectors are RRF-fused

**Version:** core v0.49.35 (`packages/plugin/src/features/magic-context/search.ts`), any
harness (seen through the DSH adapter; the code path is harness-independent).

**What happens:** a memory/compartment that contains the literal query string (an
identifier such as `ARCH-KESTREL-4127`) is often not the first hit when local embeddings
are on (default `Xenova/all-MiniLM-L6-v2`). Ranks of the hit containing the code, four
codes, three runs: 4/6 5/6 1/6 1/6 · 5/7 6/7 1/7 1/7 · 1/7 5/7 1/7 1/7. With a
bag-of-words embedding mock the same session gives similar misses (e.g. 5/6), so this
is fusion, not one model's quirk.

**Why (reading of the code):** `mergeMessageAndCompartmentResults` adds
`1/(RRF_K + rank)` (RRF_K = 60) from the compartment vector list and from the message
FTS list (messages vote for the compartment that contains them). Exact containment of
the query earns nothing at this layer — the code comment says "Fusion decides ordering,
not relevance", and `VERBATIM_RANK_BONUS` only exists inside the message probe lists.
Identifier-like strings embed as near-noise, so the right compartment's vector rank is
effectively random. Example: compartment X = vector rank 0 + a weak FTS hit at rank 1 →
`1/60 + 1/61 = 0.03306`; compartment Y = FTS rank 0 (exact identifier) + vector rank 2
→ `1/60 + 1/62 = 0.03280` → X is ranked above Y.

**Minimal repro (sketch):** one session, three compartments; Y contains the line
`code ARCH-KESTREL-4127 = use the event bus`, X and Z are about a similar topic without
the code; embed with MiniLM (or any embedding where the code is uninformative); query
`ARCH-KESTREL-4127`. Expected: Y first. Actual: Y first only when its vector rank
happens to be ≤ 1.

**Suggested direction (for discussion):** give exact query containment its own
fused-list contribution at the merge layer (e.g. one extra rank-0 term, like
`VERBATIM_RANK_BONUS` does inside the probe lists), or treat an ID-shaped query
(`parseIdShapedQuery` already exists for numeric ids) as FTS-first. Needs golden
updates for the search tests.

---

## 2. deepseek-harness — token-meter does not reprice a plugin's surface `replace`

**Title:** `contextPressure.projectedTokens` keeps the pre-rewrite total after a plugin surface `replace` (no shadow-price claim available to plugins)

**Version:** `@deepseek-ai/dsh-token-meter` 0.2.1-rc.5 (executed), 0.2.2-rc.1 (same code,
static), master not checked.

**What happens:** `foldSurfaceProjection` prices a surface `replace` only when the
immediately preceding event is a `compaction/summary` or `compaction/prune` shadow-price
claim for exactly that range; otherwise the delta is 0 ("A replacement without an armed
claim folds with zero delta … at the cost of possible drift"). A plugin that rewrites
surface nodes through the surface transaction (here: truncating two large `read`
results under pressure, 16 884 → 3 134 chars each) cannot attach such a claim, so the
projection keeps counting the original size until the next provider usage sample.

**Minimal repro (runs against the published package):**

```ts
import { foldSurfaceProjection } from "@deepseek-ai/dsh-token-meter/lib/types/surface-projection.js";
// append a 16 884-char user/message (surfaceOp "append")         -> delta +4229
// replace the same seq with a 3 134-char copy, no preceding claim -> delta 0     (total 4229)
// same replace preceded by compaction/prune {shadowedRange 10..10, shadowedTokenCount 4221}
//                                                                 -> delta -3429 (total 800)
```

(full script and output: `b-c3-meter-repro.ts.txt`, `b-c3-meter-repro-output.txt`).

**Impact:** consumers of `contextPressure.projectedTokens` in the same pre-step (a
plugin's own trigger, the stock meter, a pressure-based compaction check) see e.g. 71 %
while the request actually sent is ≈ 48 % of the window; a threshold-driven action
fires early once.

**Suggested direction (for discussion):** let a plugin surface transaction declare the
heuristic token count of the range it replaces (the same shape as the compaction
shadow-price claim), or reprice claim-less replaces from the retained surface when it
is available (the measurement path keeps it; only the O(1) fold cannot).

---

## 3. deepseek-harness — concurrent boots on one profile race on `cordis.yml`

**Title:** Two `dsh` processes starting at the same instant on one profile can fail with "config file must be a top-level array of entries: …/cordis.yml"

**Version:** `@deepseek-ai/dsh` 0.2.1-rc.5 (observed in CI) and 0.2.2-rc.1 (same code,
static: `lib/profile-boot-*.js`).

**What happens:** every boot runs `prepareProfile()` (and `composeProfile()` with a
resolved profile), which does `writeFileSync(<profile>/cordis.yml, PROFILE_ROOT_CONFIG)`
in place (truncate, then write; same inode). A concurrent boot's `Include.read()`
(`dsh-app-boot`) can read the file between the truncate and the write: `yaml.load('')`
is `undefined`, the array check throws, the `include` plugin (required) fails, and the
process exits 1 after ~0.3 s:

```
dsh: startup failed: 1 required plugin did not activate
  include (required)
    TypeError: config file must be a top-level array of entries: …/profiles/test/cordis.yml
      at Include.read (…/dsh-app-boot/lib/index.js:164:35)
```

**Minimal repro:** mechanism only (one writer doing the same in-place write, one reader
doing readFile + yaml.load + Array.isArray, 3 s): 151 109 – 246 118 of 402 476 – 508 306
reads see a non-array (`b-st1-cordis-yml-race-repro.mjs.txt`, output
`b-st1-repro-output.txt`). End-to-end: start ≥ 2 `dsh headless` on the same profile in
the same few milliseconds (seen 2× in one CI run, 41787740600).

**Suggested direction:** write the root file atomically (temp file in the same
directory + `rename`), or skip the write when the content is already identical; the
loader write-back `Include._writeFile` also uses a fixed `<file>.tmp` name shared by all
processes (a second, latent race), which a per-process temp name would avoid.
