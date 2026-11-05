# Round 33 B · P2-B — several DSH processes on one profile (ST1 / DN1)

**Status:** 上游问题 (DSH-native). No adapter code change — reason below. Guidance
draft at the end; DSH issue draft in `b-upstream-issue-drafts.md` §3 (not filed).

## Reproducible?

- **Mechanism: yes, every time.** Rerun of the round-27 mechanism repro (one process
  rewriting `cordis.yml` exactly like DSH's `prepareProfile`, one reading it like
  `Include.read`, 3 s): 246 118 / 508 306 and 151 109 / 402 476 reads saw a non-array
  (`b-st1-repro-output.txt`).
- **End to end: intermittent, timing-dependent.** Seen in CI once (41787740600, scenario
  S, runs sw-1-3 and sw-2-3: rc 1 after ~0.3 s, "include (required) … config file must be
  a top-level array of entries: profiles/test/cordis.yml"), when five processes were
  started in the same instant on one profile. Since `605a8f7a4` scenario S gives each
  concurrent session its own profile copy; DN1 (WARN-only signature scan over every run
  log) has been PASS in every run since, including 42034146821 / 42037652492 /
  42034156577. Not re-run in a dedicated e2e this round (no new information to gain;
  the mechanism repro is deterministic).

## Whose problem?

**DSH-native.** `@deepseek-ai/dsh` `lib/profile-boot-*.js` `prepareProfile()` (and
`composeProfile()` with a resolved profile) rewrites `<profile>/cordis.yml` in place with
`writeFileSync` on **every** boot; a concurrent boot's `dsh-app-boot` `Include.read()`
throws on the empty read. Same code in 0.2.2-rc.1 (static, `b-st1-repro-output.txt`);
no profile lock or pid file exists in profile-boot. Magic is not involved: the failing
process dies during DSH's own boot, before any plugin (Magic included) is loaded.

## Can the adapter warn before the failure?

Evaluated, **not implemented**:

1. **No seam before the failure point.** The race is lost inside DSH's boot
   (`prepareProfile` / `Include.read`), before cordis loads plugins. The process that
   fails never runs adapter code, so it cannot print a hint, and the adapter cannot make
   the write atomic without patching DSH (forbidden).
2. **A warning in the surviving process is noise.** The adapter could notice other live
   DSH processes on the same storage (its liveness markers, `rpc/<hash>/port-<pid>.json`)
   — but several processes on one profile are legitimate and work fine once booted
   (scenario S ran five on one DB for rounds), and the survivor is not the one that
   failed. A warning there would fire on healthy setups and still not reach the user who
   saw the crash.
3. **`doctor` cannot see it after the fact.** The winning boot rewrites the file
   immediately, so a later `doctor` run finds a valid `cordis.yml`; there is nothing
   durable to detect.
4. **Risk/benefit:** any pre-start check would have to run in a launcher the adapter does
   not own (the user's shell / DSH CLI). The low-risk, honest output is documentation.

## Guidance draft (for DSH-MAINTENANCE / README, to be merged by the integrator)

> **Starting several `dsh` processes at once on the same profile.** DSH rewrites
> `<profile>/cordis.yml` on every start. If two processes start within a few
> milliseconds of each other on one profile, one of them can exit immediately with
> `dsh: startup failed … include (required) … config file must be a top-level array of
> entries: …/cordis.yml`. This is a DSH start-up race, not a Magic Context error, and
> nothing is lost: the file is valid again as soon as the other process finishes
> starting.
>
> - Just start the failed process again.
> - For scripts that launch several sessions at once: stagger the starts (≈ 1 s is
>   plenty), or give each concurrent launcher its own profile (`--profile <name>`; copies
>   of one profile share the same Magic Context database and sessions directory as long
>   as `DSH_HOME` / the storage path is the same).
> - Once started, several processes on one profile are fine for Magic Context (shared
>   SQLite with leases and an open lock).
> - Upstream: DSH would need an atomic write (temp + rename) of `cordis.yml`; tracked as
>   a draft issue, not filed.
