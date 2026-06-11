# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
