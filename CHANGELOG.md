# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
