# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-06-30

### Fixed

- **Quota-pause no longer enters a degenerate re-hop loop (issue #5).** While hard-blocked,
  Claude Code's `/goal` feature (a prompt-based `Stop` hook) re-drives the agent every turn.
  Each re-drive the agent re-scheduled a wakeup — stacking dozens — and sometimes ran a shell
  command to "check the reset", so usage *climbed while paused* (the guard burned the very
  quota it exists to conserve).

  A small pause-state file `~/.claude/usage-guard-pause.json` (numbers only —
  `{ resetAtMs, nextWakeupAtMs }`, strict allowlist via `validatePauseState`, atomic `0o600`
  write, fully fail-open) now records that a wakeup is already pending. It is written
  authoritatively on the `ScheduleWakeup` path (the one place the guard knows a wakeup was
  scheduled) and read on the two non-resume hard-block paths: if a wakeup is still pending the
  guard emits a **WAIT** instruction ("a wakeup is already pending — do NOT schedule another,
  do NOT probe usage, end the turn") instead of inviting yet another schedule. The block/hop
  messages are now **goal-aware** and explicitly forbid shell/tool probes (the reset time is
  already in the message). The reset boundary is latched once per pause and the existing
  `+120s` buffer keeps the resume wakeup landing *after* reset.

  A hook **cannot** make the agent genuinely idle while `/goal` is active — a `Stop` hook
  cannot veto another hook's forced continuation ("any block wins"), and blocking would only
  force more continuations. So the guard does **not** add a `Stop` hook; it minimizes the cost
  of each forced re-drive (one wakeup pending, zero probes) until `/goal`'s own no-progress cap
  yields.

  Invariants preserved (test-enforced): the `RESUME_MARKER` resume-hop path is carved OUT of
  the latch — a fired hop is proof the wakeup fired, so it always re-evaluates fresh and is
  never strangled by a buffer-early WAIT (no stuck state). Fail-open is **asymmetric**: any
  doubt (torn read, validation failure, poisoned far-future timestamp) → SCHEDULE, never WAIT,
  so a corrupt/poisoned pause file can never silently disable blocking. The pause file holds
  only two numbers and never the token; the `ScheduleWakeup` path still never exits 2 and a
  pause-write failure can never trap it.

### Added

- **Separate weekly thresholds (`CLAUDE_USAGE_GUARD_WEEKLY_WARN` / `_WEEKLY_HARD`, defaults
  90/95).** The `7d`, `7d-opus`, and `7d-sonnet` windows now take their own WARN/HARD so a
  slowly filling weekly window no longer winds the agent down at the same low bar as the
  volatile 5h window (which keeps the base `CLAUDE_USAGE_GUARD_WARN`/`_HARD`). `evaluateThresholds`
  scores each window against *its* window-class thresholds and reports the most severe (which
  is not necessarily the highest-utilization window). The weekly pair is validated and reset
  independently (clamp `1..100`; `weeklyWarn >= weeklyHard` resets the pair to 90/95).

## [0.5.0] - 2026-06-17

### Fixed

- **Account switch no longer keeps blocking after a login change (auto-heal).** When
  account A was exhausted and the user switched to account B, account A's stale 100%
  windows could keep blocking indefinitely: on every failed usage fetch the
  negative-cache marker resurrected the previous fetch's windows (and kept its old
  `fetchedAt`), so if account B's usage fetch ever failed (e.g. a business/Team token
  rejected on the personal OAuth usage endpoint), the loop never cleared.

  A failed fetch now writes a marker with **no windows** (`windows: {}`) and
  `fetchedAt: null`, so a stale exhausted account can never block a freshly-switched
  account. The marker still suppresses re-fetching for the negative-cache window via
  `failedAt`; it simply blocks nothing. This is the fail-open-consistent choice: a
  transient outage on a genuinely-exhausted *same* account briefly allows prompts
  (bounded by the negative-cache window) rather than trapping the user — and the
  `[usage]` summary is omitted only during such a transient failure.

### Added

- **`usage-guard recheck` command — force a fresh check against the current login.**
  Sending the prompt `usage-guard recheck` (also `[usage-guard:recheck]` or
  `usage guard recheck`, case-insensitive) forces a fetch that bypasses **all** cache
  (positive and negative) and applies the honest block decision to the fresh result:

  - current login under the limit → unblocked, prints the fresh `[usage]` line;
  - current login genuinely over the limit → still blocked (exit 2) — the command does
    no real work, so it cannot smuggle a task past the gate (exact-match only; any
    trailing text makes it a normal prompt);
  - current login unreadable (fetch fails / no credentials) → fail-open with an
    explanatory message, never resurrecting a previous account's data.

  The hard-block message and the SessionStart onboarding hint now advertise the command
  and when to use it (switched accounts, or a block believed to be wrong). Mirrors the
  existing `[usage-guard:resume]` magic-prefix precedent — the prompt box is the only
  surface a blocked user can reach.

  Invariants preserved: the OAuth token is still unwrapped at exactly one line; no
  `USAGE_URL` env override; all output is rebuilt from validated numbers; recheck is
  gated to `UserPromptSubmit` only (never `PreToolUse`/`ScheduleWakeup`) and every
  unexpected error still exits 0.

## [0.4.0] - 2026-06-12

### Added

- **SessionStart one-time onboarding hint (issue #1).** The `/plugin install` config
  instructions reach the model wrapped in a local-command-caveat, so the model does not
  act on them. A `SessionStart` hook's stdout arrives as trusted (uncaveated) context —
  the guard now uses it to post a one-time setup note when no `CLAUDE_USAGE_GUARD*` env
  var is set and the onboarded marker (`~/.claude/usage-guard-onboarded`) is absent.

  The hint explains the active defaults (WARN 80%, HARD 95%), shows the
  `~/.claude/settings.json` env block to customize them, mentions optional vars
  (`_TTL`, `_DEBUG`, `off`), and ends with an explicit instruction for the model to offer
  to apply the block for the user — converting trusted context into a proactive offer.

  Platform-aware: on macOS the note names the Keychain item (`Claude Code-credentials`,
  macOS only) and reminds the user to choose "Always Allow" on the one-time Keychain
  permission prompt. On all other platforms it refers only to `~/.claude/.credentials.json`.

  Invariants: the `SessionStart` branch never reads credentials, never fetches, never
  exits 2, and leaks nothing (output rebuilt from constants + a platform branch only).
  A `CLAUDE_USAGE_GUARD=off` guard exits before the branch runs, so a disabled guard
  never onboards. A failed marker write causes only a benign repeat at the next session
  start (hint has already been emitted before the write attempt). Fail-open everywhere.

  New artifacts: `~/.claude/usage-guard-onboarded` (onboarding marker, mode 0600).

### Changed

- Hook contract updated to v0.4.0 in the file header comment.
- `DEBUG_EVENTS` allowlist extended with `'onboarding'`.

### Tests

- 22 new tests: T14.1–T14.8 (`test/t14-session-start.mjs`) covering the full
  SessionStart surface, `isConfigured` unit tests, and `buildOnboardingMessage` shape
  checks (platform-aware, timezone-safe — no ISO dates, no absolute weekdays), including
  an explicit assertion that the credentials file is never read on the SessionStart path.
  T4.13 added to `test/t4-token-leak.mjs` pinning the no-leak/no-fetch invariant on the
  SessionStart path. (183 → 206 tests.)

## [0.3.0] - 2026-06-12

### Fixed

- **Session does not resume after quota reset (issue #3).** When a `ScheduleWakeup`
  fired during a hard-block, the harness re-entered its prompt verbatim as a
  `UserPromptSubmit`. The guard's exit-2 block erased that wake turn before the model
  ran — the resume chain died silently. Fixed via a two-part mechanism:

  **Marker stamping (PreToolUse/ScheduleWakeup path):** When the guard is hard-blocked
  and a `ScheduleWakeup` is dispatched with an unmarked prompt, the guard now emits a
  single allowlisted JSON line on stdout (`hookSpecificOutput` / `updatedInput`) that
  stamps `[usage-guard:resume]` onto the prompt. Sentinel prompts
  (`<<autonomous-loop>>`, `<<autonomous-loop-dynamic>>`) and already-marked prompts are
  left untouched. Any stamping error falls back to plain exit 0 — the branch can never
  exit 2.

  **Hop routing (UserPromptSubmit path):** A `UserPromptSubmit` whose prompt starts with
  `[usage-guard:resume]` is recognized as a resume hop and allowed through (exit 0)
  regardless of utilization. If still blocked and reset is ≤ 6h away, the guard appends
  a hop-suffix instructing the model to reschedule with the same prompt. If reset is >
  6h away, it instructs chain termination instead (no multi-day rescheduling). Once the
  window has reset (dropped by `parseWindows`), the guard appends a resume-ready suffix
  telling the model to resume the task. Sub-agent handling is threaded throughout: a
  `PreToolUse` block message now detects sub-agents via `agent_id` and instructs them
  to abort and return a resume brief to their caller (sub-agents cannot call
  `ScheduleWakeup`).

  The `[usage-guard:resume]` string is a **compatibility contract** — it must never
  change across plugin versions.

### Added

- `RESUME_MARKER` constant exported from `usage-guard.mjs` (the marker string; must
  never change).
- `isResumeHopPrompt(input)` exported pure helper — returns true iff the input is a
  `UserPromptSubmit` whose prompt starts with `RESUME_MARKER`.
- `computeHopDelaySeconds(worst, now)` exported pure helper — computes a
  `ScheduleWakeup` delay clamped to [60, 3600] with a 120s buffer past reset.
- `buildResumeHopSuffix(worst, now)` exported builder — the still-blocked re-schedule
  instruction appended to the hop stdout line.
- `buildResumeReadySuffix()` exported builder — the window-has-reset instruction
  appended when a resume-hop prompt arrives after reset.
- `buildToolBlockMessage` now accepts a third `isSubagent` argument (detected via
  `agent_id`) and emits a sub-agent-specific abort message.
- `buildPromptBlockMessage` now notes that scheduled resume wakeups are exempt.
- Debug events `resume_hop` and `wakeup_marked` added to `DEBUG_EVENTS` allowlist.
- 28 new tests: T13.1–T13.9 (resume-hop `UserPromptSubmit` handling), T6.7–T6.13
  (ScheduleWakeup marker-stamping paths), T4.12 (token-leak guard on new JSON-stdout
  path). (155 → 183 tests.)

### Changed

- **PreToolUse hook contract amended:** the `ScheduleWakeup`-exempt branch may now emit
  exactly one allowlisted JSON line on stdout (the `hookSpecificOutput` / `updatedInput`
  stamp) when hard-blocked and the prompt is unmarked. All other `PreToolUse` paths
  remain zero-stdout. The security posture comment and CLAUDE.md hook-contract paragraph
  are updated accordingly.

## [0.2.2] - 2026-06-12

### Fixed

- **macOS Keychain JSON-blob fix (issue #2).** macOS Claude Code stores the full
  credentials JSON as the Keychain item password, causing `readTokenFromKeychain` to
  forward the raw JSON blob as the Bearer token, producing a 401 for all macOS OAuth
  users. The success branch now detects a `{`-prefixed string and extracts the access
  token via a new private `extractAccessToken` helper (shared with `readTokenFromFile`).
  Bare token strings (historical contract) are returned unchanged. Corrupt blobs fall
  back to the credentials file; parseable-but-unusable shapes (missing or wrong-typed
  `accessToken`) also fall back. Corrupt blob with no file present → fail-soft exit 0.
  Six regression tests added (T5.10–T5.15) and one token-leak test under debug mode
  (T4.11). (148 → 155 tests.)

## [0.2.1] - 2026-06-11

Security-audit follow-up: hardening, correctness fixes, and one regression test per fix.

### Fixed

- **Entry-point detection no longer silently disables the guard behind symlinks or
  Windows path-case differences.** ESM resolves the entry point through symlinks while
  `argv[1]` keeps the symlink path; the naive string compare failed and the script
  exited without doing anything (fail-open hid the breakage). Paths are now realpath'd
  and case-folded on win32 before comparing.
- **WIND DOWN advisory now shows the reset date for weekly windows.** Previously a `7d`
  window resetting days away printed a bare time-of-day ("past 19:00"), steering the
  model to schedule a wakeup long before the actual reset.
- **Truncated/unparseable hook input no longer routes to UserPromptSubmit.** A payload
  cut off by the stdin grace timeout could have been `PreToolUse`, whose contract
  forbids stdout. Non-empty unparseable input is now an unknown event: silent on
  stdout, hard gate still enforced. Empty stdin (manual invoke) keeps printing the
  summary.
- **Failed cache renames no longer orphan `.tmp` files** in `~/.claude` (e.g. `EPERM`
  on Windows when the target is held open by a concurrent hook) — the temp file is
  unlinked on failure.
- **Future timestamps in the cache are distrusted.** A poisoned `fetchedAt` could pin
  the cache permanently "fresh" (never refetched); a future `failedAt` could pin the
  negative-cache backoff. Both are now treated as absent when validating.

### Security

- **macOS Keychain is invoked as `/usr/bin/security` (absolute path).** Consistent with
  the poisoned-environment threat model: PATH must not decide which binary we hand the
  keychain query to.
- Debug-log token guard now also refuses lines containing the JSON-escaped form of the
  token (defense-in-depth; `JSON.stringify` escaping could defeat a raw substring check).

### Removed

- Dead exports `buildBlockMessage` (never called) and `redactedToken` (test-only theater,
  guarded nothing in production paths).

### Changed

- Test helpers no longer double-record fetch/exec calls (default impl and wrapper each
  recorded once); call-count assertions tightened from `>= 1` to exact counts so a
  regression that fires duplicate requests now fails the suite.
- New `t12-entrypoint.mjs` spawns the real script (directly and through a
  symlink/junction) and asserts `main()` actually ran — entry-point detection is not
  reachable through `main(deps)` fakes. One regression test per fix above.
  (140 → 148 tests.)

## [0.2.0] - 2026-06-11

### Fixed

- **Expired windows no longer warn/block.** A window whose `resets_at` is already in the
  past carries stale utilization (it has reset server-side). Previously a stale cache
  combined with unreachable credentials could block prompts indefinitely past the actual
  reset, with a message pointing at a reset time that had already passed. Expired windows
  are now dropped from threshold evaluation and from the summary line.
- Cache temp-file names now include the process id, so concurrent `UserPromptSubmit` and
  `PreToolUse` hook processes cannot collide on the same temp path within one millisecond.

### Changed

- **Date formatting switched from German to fixed English labels** (local timezone), e.g.
  `reset Wed 19 Jun 19:00` instead of `reset Mi 19.06. 19:00`.
- CI matrix now also tests Node 24.

### Added

- `SECURITY.md` with private vulnerability reporting instructions.
- Tests for expired-window filtering, English formatting, and pid-unique temp files
  (130 → 140 tests).

## [0.1.0] - 2026-06-10

### Added

- Initial release: deterministic hook-enforced subscription-quota guard for Claude Code.
  WARN/HARD thresholds over the `5h`/`7d`/per-model windows, gate-and-self-sleep pause
  design via `ScheduleWakeup`, opaque token holder, frozen endpoint URL, allowlist cache
  validation, allowlist debug logging, fail-open error handling, zero dependencies.
