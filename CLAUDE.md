# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code plugin that reads the user's subscription usage from Anthropic's (undocumented) OAuth usage endpoint and warns/blocks via hooks when usage windows approach exhaustion. Single production file, zero runtime dependencies, fail-open by design.

## Commands

```
npm test                          # full suite (node --test, discovers test/*.mjs)
node --test test/t3-cache.mjs     # single test file
node --test --test-name-pattern "T3.6" test/t3-cache.mjs   # single test case
node scripts/usage-guard.mjs      # live smoke test (reads real cache/creds, prints [usage] line)
```

No build step, no linter. **Never add `dependencies` or `devDependencies` to package.json** — the zero-deps CI job fails the build if either key exists. Node ≥ 18 only (built-ins + global `fetch`).

## Architecture

Everything lives in `scripts/usage-guard.mjs`. It is deliberately one file: the plugin spawns it as a fresh Node process on every hook event, so there is no shared state and startup cost matters.

- **Dependency injection:** all I/O (fs, fetch, execFile, env, stdin/stdout/stderr, clock, homedir, pid, exit) flows through `main(deps)`. The real `deps` object is built only in `buildRealDeps()`, which runs only when the file is the process entry point (`runningDirectly()`). Importing the module performs zero I/O — tests rely on this.
- **Pure helpers are exported** (`parseWindows`, `evaluateThresholds`, `thresholdsForLabel`, `validateCache`, `validatePauseState`, `decidePauseAction`, `readConfig`, `parseHookInput`, `makeTokenHolder`, `isResumeHopPrompt`, `isRecheckPrompt`, `computeHopDelaySeconds`, `RESUME_MARKER`, `RECHECK_COMMAND`, message builders) and unit-tested directly; everything else is tested through `main(deps)` with fakes.
- **Per-window-class thresholds:** `evaluateThresholds` scores each window against `thresholdsForLabel(label, cfg)` — 5h uses base `warn`/`hard`, 7d* uses `weeklyWarn`/`weeklyHard` (defaults 90/95) — and returns the **most severe** window (not the highest-utilization one), ties broken by utilization.
- **Pause latch (issue #5, breaks the degenerate re-hop loop):** a separate `~/.claude/usage-guard-pause.json` (`{resetAtMs, nextWakeupAtMs}`, numbers only, allowlisted by `validatePauseState`, atomic 0o600 write, fully fail-open) records that one wakeup is already pending. WRITTEN authoritatively in the `ScheduleWakeup` PreToolUse branch (only place a wakeup is known-scheduled; within the 6h horizon). READ on the two **non-resume** hard-block paths via `decidePauseAction`: a still-pending wakeup → emit `buildPauseWaitMessage` (stand down, do not re-schedule/probe) instead of inviting another. The `RESUME_MARKER` path is **carved out** (a fired hop is proof the wakeup fired → always re-evaluate fresh, never WAIT — prevents a buffer-early wakeup from being strangled). Fail-open is **asymmetric**: any doubt → SCHEDULE, never WAIT, so a poisoned/corrupt pause file can never disable blocking. Cleared on the transitions out of a pause (resume-ready, >6h chain termination, recheck-cleared). The guard does **not** hook `Stop`: a `Stop` hook cannot veto `/goal`'s forced continuation ("any block wins") and blocking would only force more — the latch instead minimizes per-re-drive cost.
- **Data flow:** stdin JSON → `parseHookInput` (empty stdin → `UserPromptSubmit` [manual invoke]; non-empty unparseable → `UnknownHookEvent`, which stays silent on stdout — a truncated payload may have been `PreToolUse` — but is still hard-gated) → for `PreToolUse`/`ScheduleWakeup`: cache-only block detection (no fetch), optional marker stamp via JSON stdout, always exit 0 → for all other events: `acquireData` (fresh cache within TTL → use; recent failure → 5-min negative cache; else read token and fetch) → `parseWindows(data, now)` (drops windows whose reset already passed — stale data must never block) → `evaluateThresholds` → output. The `[usage]` stdout summary is emitted **only** for `UserPromptSubmit`. A resume-hop `UserPromptSubmit` (prompt starts with `RESUME_MARKER`) is allowed through the hard gate; it gets a reschedule or resume-ready instruction appended to the summary. A `UserPromptSubmit` whose prompt is exactly `RECHECK_COMMAND` (`usage-guard recheck`, also `[usage-guard:recheck]`) calls `acquireData` with `{forceRefresh:true}`, which **bypasses both the positive and negative cache**, re-fetches the current login, then applies the honest block decision to the fresh result (still-hard → exit 2; cleared → exit 0 summary; unreadable → exit 0 fail-open). **Auto-heal:** on any fetch failure the negative-cache marker is written with `windows:{}` and `fetchedAt:null` (never resurrecting the prior fetch's windows), so a stale exhausted account can never block a freshly-switched account — `forceRefresh` + creds-missing returns `null` for the same reason.
- **Hook contract** (`hooks/hooks.json` wires both events to the same script): exit 0 = allow, exit 2 + stderr = block. `UserPromptSubmit` may print a `[usage]` summary to stdout (becomes model context). `PreToolUse` must never write **non-JSON** stdout; the single exception is the `ScheduleWakeup`-exempt path, which may emit exactly one allowlisted JSON line (`hookSpecificOutput`/`updatedInput` to stamp the `RESUME_MARKER` prefix) when hard-blocked and the prompt is unmarked — all other `PreToolUse` paths produce zero stdout. `ScheduleWakeup` is always exempt from the `PreToolUse` gate (can never exit 2) so a blocked model can sleep through the reset instead of being trapped. A `UserPromptSubmit` whose prompt starts with `RESUME_MARKER` (`[usage-guard:resume]`) is a scheduled resume hop: the guard routes it through exit 0, re-instructing reschedule-or-resume each hop.
- **Plugin packaging:** `.claude-plugin/plugin.json` (manifest) + `.claude-plugin/marketplace.json` (this repo doubles as its own marketplace). Version must be bumped in both `plugin.json` and `package.json`, with a `CHANGELOG.md` entry.

## Security invariants (test-enforced — do not weaken)

The file header of `usage-guard.mjs` documents the full posture. The load-bearing rules, each machine-checked by the suite:

- The OAuth access token is wrapped in `makeTokenHolder` the instant it is read and unwrapped at exactly **one** line (the `Authorization` header in `fetchUsage`). It must never reach stdout, stderr, cache, debug log, or an error message — `test/t4-token-leak.mjs` asserts a sentinel token never appears in any recorded channel.
- `refreshToken` on the credentials record is **never accessed** (`test/t5-credentials.mjs`).
- `USAGE_URL` is a hardcoded constant with **no env override** — a poisoned environment must not be able to redirect the bearer token (`test/t9-url-hardening.mjs`). `redirect: 'error'` on fetch is part of this.
- Cache and API responses pass through the `validateCache` allowlist; the pause-state file passes through `validatePauseState` (numbers-only, distrusts stale/poisoned far-future timestamps — a poisoned pause file must never pin a permanent WAIT and disable blocking). Nothing read from disk or network is ever echoed verbatim — output is rebuilt from validated numbers and re-formatted Dates.
- Every unexpected error → exit 0 with empty output (fail-open). Caught error objects are discarded, never stringified into output. Debug logging only writes allowlisted event codes (`DEBUG_EVENTS`) and primitive fields.

## Conventions

- Date output uses fixed English labels in local time (`Wed 19 Jun 19:00`), hand-rolled — **no `Intl`** (ICU output varies across Node versions and would break the 12-cell CI matrix).
- Tests: numbered files (`t1`–`t17`) with one concern each; build fakes via `makeDeps()` from `test/helpers.mjs` (in-memory fs recorder, fixed clock `FIXED_NOW_MS`, pid 4242, recorded fetch/exec/exit calls). Exception: `t12-entrypoint.mjs` spawns the real script (entry-point detection isn't reachable through `main(deps)`). Time-formatting assertions must be timezone-safe: assert shape/month (`Nov`, `\d{2}:\d{2}`), never an exact weekday or day-of-month — CI runs in multiple timezones' default (UTC) but local runs don't.
- The `claude-code/` prefix in `USER_AGENT` is deliberate (avoids an aggressively rate-limited bucket, see anthropics/claude-code#31637) — do not strip it.
