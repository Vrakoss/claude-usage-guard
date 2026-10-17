# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.1] - 2026-10-17

Follow-ups from the review of 0.10.0 (issue #14), tracked in issue #18. No change to the
guard's behavior or to `hooks/hooks.json`.

### Added

- **The hook-form timing harness is in the repo:** `scripts/bench-hook-forms.mjs`. It is
  the tool behind the shell-form vs exec-form medians in the 0.10.0 entry and the README
  "Hook form" section. Run `node scripts/bench-hook-forms.mjs [runs] [--no-shell]`; the
  header comment documents the options. It is dev tooling only: never wired into the
  hooks, zero dependencies, no machine-specific paths. Every spawned guard runs against a
  throwaway home holding a seeded fresh cache, so it never reads a login token or calls the
  network. Before timing, a seed probe runs each guard form once against a seed at 100%
  and requires a block (exit 2): only a guard that answers from the seeded cache can
  block, so a cache miss (for example after a cache schema drift) aborts the run before
  any timing. The harness also aborts if a timed call exits non-zero, prints to stdout or
  touches that home. A re-run in this release (Windows 11, Node 22, 20 interleaved runs,
  cache hit) gave medians of 121.7 ms through Git Bash, 73.6 ms in exec form and 54.0 ms
  for a bare `node -e 0`, in line with the 0.10.0 figures.

### Documentation

- README "Install": on Windows, `node` on PATH must resolve to a real `node.exe`. Exec form
  cannot spawn a `.cmd` or `.bat` shim, so a shim-only setup gets a non-blocking hook error
  and the guard is off. Documented as a residual, not a safety feature.
- CHANGELOG: prose lines reflowed to the 92-column wrap target (whitespace only).

### Tests

- `test/t23-bench-harness.mjs` (new): the harness exists with a usage header, imports Node
  built-ins only, carries no machine-specific paths, never names fetch, a network module or
  the credentials file, is not wired into the hooks, and runs nothing on import. Its seeded
  cache and its probe seed are checked against the guard's own `validateCache` and
  thresholds. One end-to-end case runs a real exec-form round with a hard-blocking cache in
  the outer home: the run only passes if the harness isolates the home. Another runs the
  harness against a guard copy with a drifted cache schema: the seed probe must abort the
  run before it prints any timing. A third runs it against a guard copy that writes a stray
  file into its home on every call: the home check must abort the run before any timing.
- `test/t19-hooks-config.mjs`: T19.18 now rejects any shell-form hook command string in
  README.md and CLAUDE.md (such as `node "${CLAUDE_PLUGIN_ROOT}/…"` or the script as
  `command`) instead of two exact removed sentences, with a self-check (T19.19). T19.15
  drops its command regex, which T19.2 (`command === 'node'`) already covers. New T19.20
  pins the Windows shim note.
- `test/t20-docs-privacy.mjs`: a tool-call count whose thousands are grouped with dots or
  spaces (plain, no-break or thin) is now flagged too, not only one grouped with commas.
- `test/t21-readme-line-width.mjs`: CHANGELOG.md prose is held to the same 92-column limit
  as the README.

## [0.10.0] - 2026-10-17

### Changed

- **Hooks run in exec form (issue #14).** All three hooks (`UserPromptSubmit`,
  `PreToolUse`, `SessionStart`) now use `"command": "node"` with
  `"args": ["${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs"]` instead of the shell-form
  command string. Claude Code spawns `node` directly, so Windows no longer starts a Git
  Bash process for every hook call. Measured on Windows 11, Node 22, PreToolUse payload,
  medians of 20 interleaved runs in two sessions: about 125 ms through Git Bash vs 70–77 ms
  in exec form, roughly 50 ms less per gated tool call. The `PreToolUse` denylist matcher
  is unchanged.
- **Breaking: requires Claude Code ≥ 2.1.139**, the release that added the hook `args`
  field. An older client drops `args` without an error and runs a bare `node`, which reads
  the hook payload as a script, exits 1 and shows a non-blocking hook error. The guard is
  then off. A plugin cannot declare a minimum client version that Claude Code enforces, so
  this is a documented residual (README "Install"), not a safety guarantee.

### Tests

- `test/t19-hooks-config.mjs` pins exec form: each hook has `command: "node"`, `args` equal
  to the script path, timeout 20, and no other keys (no `shell`, `async`, `asyncRewake`,
  `if` or `onFailure`). New cases check that the script path exists in the plugin and that
  the README install section states the version requirement and the older-client residual.
- `test/t20-docs-privacy.mjs`: a tool-call count now needs a k/M suffix or a number of at
  least 1000, so ordinary prose such as "the first 2 tool calls" no longer trips the check.
  A new case proves small counts pass and large ones are still caught.
- `test/t21-readme-line-width.mjs`: the README line limit is now the 92-column wrap target
  itself (it allowed 95). Three README lines were reflowed to fit.

### Documentation

- README: new "Hook form" section and the Claude Code ≥ 2.1.139 requirement in "Install".
- CLAUDE.md: the hook-wiring bullet describes exec form and the minimum client version.
- `scripts/usage-guard.mjs`: reflowed the `MAX_WINDOW_KEY_SCAN` JSDoc and noted exec form
  in the file header. No behavior change.

## [0.9.0] - 2026-10-17

Follow-ups from the reviews of 0.7.0 (issue #10) and 0.8.0 (issue #11), tracked in
issue #13.

### Changed

- **Window-key scanning is bounded for CPU, not just size.** `orderedWindowKeys` used to
  grammar-check and sort every key of a windows object before the `MAX_WINDOWS` (16) bound
  was applied, so a huge payload cost O(n log n). Now only the first `MAX_WINDOW_KEY_SCAN`
  (256 = 16 × `MAX_WINDOWS`) keys in payload order are examined. The four classic keys are
  still looked up directly, so they are never pushed out. A per-model window that appears
  after the first 256 keys is ignored, which the real endpoint (about a dozen top-level
  keys) never comes close to. Collecting the key list (`Object.keys`) is still linear, but
  it costs less than the `JSON.parse` that produced the object. Measured on Windows,
  Node 22, `validateCache` + `parseWindows` on 200k valid keys went from ~335 ms to ~136 ms
  (median of 7).

### Tests

- `test/t18-per-model-windows.mjs`: the 48-character key limit now has a boundary test
  (48 accepted, 49 rejected, directly and through `validateCache`/`parseWindows`), so an
  off-by-one in the length check fails the suite. New cases pin `MAX_WINDOW_KEY_SCAN`,
  the keep/ignore edge at the 256th key, classic keys surviving past the budget, and a
  20k-key payload sorted only within the budget.
- `test/t19-hooks-config.mjs`: T19.13 now covers both main-thread block branches (reset
  within 6h, and reset more than 6h out). Each case checks it hit its branch and that no
  sub-agent hand-back wording appears.

### Documentation

- Added the one-time upgrade note to the 0.7.0 entry: upgrading from 0.6.0 while
  hard-blocked leaves a short fail-open window until the next prompt refetches.
- README: reflowed the over-long lines in "Which tools are gated" ("Why these ten") and
  "Sub-agents abort", and the first trade-off no longer claims, without data, that almost
  every turn reaches a `Bash`/`Edit` call. It now says the overrun depends on the workload.
  A new test (`test/t21-readme-line-width.mjs`) fails on any README prose line wider than
  95 columns (code blocks, table rows and images are exempt).
- README: the cache validation bullet mentions the 256-key scan budget.
- README "Why these ten" and the 0.8.0 entry no longer state personal usage volume (a
  tool-call count and a time window). Only the ~9% and ~5% shares remain. A new test
  (`test/t20-docs-privacy.mjs`) fails if a usage-volume figure comes back.
- CLAUDE.md: the test-convention sentence covers `t1`–`t22` and names every test file that
  does not use `test/helpers.mjs`. A new test (`test/t22-claude-md-test-list.mjs`) fails
  when a test file is added without updating that sentence.

## [0.8.0] - 2026-10-17

### Changed

- **`PreToolUse` no longer runs on every tool (issue #11).** The matcher went from `*` to a
  denylist written as a JavaScript-RegExp negative lookahead. The guard is not spawned for
  `Read`, `Grep`, `Glob`, `LSP`, `ToolSearch`, `TodoWrite`, `TaskOutput`, `TaskStop`,
  `SubagentHandback` and `StructuredOutput`. Everything else stays gated, including
  `ScheduleWakeup`, every `mcp__*` tool and any future tool. On one developer's measured
  workload the ten ungated tools together were ~9% of tool calls (the read-only/local subset
  ~5%), so ~9% of hook spawns are skipped, each one a Git Bash + Node pair costing ~165 ms
  on Windows.
- README documents the gated set and its trade-offs: ungated tools can keep running past
  HARD until the next gated call, and the matcher relies on Claude Code's documented
  JavaScript-RegExp matcher semantics.

### Fixed

- **A hard-blocked sub-agent can now return its resume brief.** The block message tells a
  sub-agent to hand a resume brief back to its caller, but with matcher `*` the hand-back
  tool (`SubagentHandback`, or `StructuredOutput` for workflow agents) was blocked too, so
  the brief was lost. Both are now ungated, and so is `TaskStop`, so a paused model can
  still halt background work.
- **Block messages no longer claim every tool is gated.** The sub-agent HARD message now
  says work tools are gated but the hand-back tools (`SubagentHandback`, `StructuredOutput`)
  are not, and tells the sub-agent to use one to return its brief. The names come from the
  new exported `HANDBACK_TOOLS` constant, and `test/t19-hooks-config.mjs` checks each one is
  ungated by the matcher. The resume-hop suffix's "All other tools are gated" line was
  reworded the same way.

### Not changed

- The hooks stay in shell form. Exec form (`command` + `args`) would skip the Git Bash
  process on Windows, but clients older than Claude Code 2.1.139 drop `args` and run a bare
  `node` that evaluates the hook payload as a script. That silently disables the guard, and
  a plugin cannot declare a minimum client version, so exec form is deferred.

## [0.7.0] - 2026-10-17

### Added

- **Every per-model usage window is kept (issue #10).** The window set used to be a fixed
  allowlist (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`), so a window
  such as `seven_day_fable` — or any future per-model window — was dropped before
  evaluation and never reached the cache. Any `seven_day_<model>` / `five_hour_<model>` key
  matching a strict grammar (lowercase alphanumeric segments, max 48 chars) is now accepted
  with the same per-entry validation (finite utilization clamped `0..100`, parseable
  `resets_at`). New keys get a derived label (`seven_day_fable` → `7d-fable`) and the weekly
  thresholds (`5h-<model>` gets the base ones). They appear in the `[usage]` status line, in
  threshold evaluation, and in the cache.
- **Bounded window count.** At most 16 windows are accepted (`MAX_WINDOWS`), the four
  classic ones always first and the rest in sorted key order, so a poisoned payload cannot
  bloat the cache file or the status line.
- **Versioned cache schema.** `~/.claude/usage-guard-cache.json` now carries
  `schemaVersion: 1` and is documented in the README as a stable read-only contract
  (`{schemaVersion, fetchedAt, failedAt, windows}`) for other tools such as
  `gated-delivery`.

### Changed

- A cache without `schemaVersion: 1` (written by an older guard, or an unknown future shape)
  is treated as a miss and refetched once — never a crash, never a block from the old data.
- A malformed or already-reset **per-model** window is dropped on its own; a malformed
  classic window still rejects the whole cache/response, as before. Keys outside the grammar
  are still ignored.

### Upgrade note (added in 0.9.0)

- **One-time fail-open window when upgrading while hard-blocked.** A cache written by 0.6.0
  has no `schemaVersion`, so 0.7.0 and later treat it as a miss. `PreToolUse` only reads the
  cache (it never fetches), so until the next `UserPromptSubmit` refetches, the tool gate
  fails open, and a `ScheduleWakeup` issued in that gap gets no `[usage-guard:resume]`
  stamp. `SessionStart` does not fetch either, so it does not close the gap. The next
  prompt refetches and blocks again if the account is still over HARD. This follows the
  fail-open design: the guard would rather miss a block once than block on data it cannot
  trust.

## [0.6.0] - 2026-06-30

### Fixed

- **Quota-pause no longer enters a degenerate re-hop loop (issue #5).** While hard-blocked,
  Claude Code's `/goal` feature (a prompt-based `Stop` hook) re-drives the agent every turn.
  Each re-drive the agent re-scheduled a wakeup — stacking dozens — and sometimes ran a
  shell command to "check the reset", so usage *climbed while paused* (the guard burned the
  very quota it exists to conserve).

  A small pause-state file `~/.claude/usage-guard-pause.json` (numbers only —
  `{ resetAtMs, nextWakeupAtMs }`, strict allowlist via `validatePauseState`, atomic `0o600`
  write, fully fail-open) now records that a wakeup is already pending. It is written
  authoritatively on the `ScheduleWakeup` path (the one place the guard knows a wakeup was
  scheduled) and read on the two non-resume hard-block paths: if a wakeup is still pending
  the guard emits a **WAIT** instruction ("a wakeup is already pending — do NOT schedule
  another, do NOT probe usage, end the turn") instead of inviting yet another schedule. The
  block/hop messages are now **goal-aware** and explicitly forbid shell/tool probes (the
  reset time is already in the message). The reset boundary is latched once per pause and
  the existing `+120s` buffer keeps the resume wakeup landing *after* reset.

  A hook **cannot** make the agent genuinely idle while `/goal` is active — a `Stop` hook
  cannot veto another hook's forced continuation ("any block wins"), and blocking would only
  force more continuations. So the guard does **not** add a `Stop` hook; it minimizes the
  cost of each forced re-drive (one wakeup pending, zero probes) until `/goal`'s own
  no-progress cap yields.

  Invariants preserved (test-enforced): the `RESUME_MARKER` resume-hop path is carved OUT of
  the latch — a fired hop is proof the wakeup fired, so it always re-evaluates fresh and is
  never strangled by a buffer-early WAIT (no stuck state). Fail-open is **asymmetric**: any
  doubt (torn read, validation failure, poisoned far-future timestamp) → SCHEDULE, never
  WAIT, so a corrupt/poisoned pause file can never silently disable blocking. The pause file
  holds only two numbers and never the token; the `ScheduleWakeup` path still never exits 2
  and a pause-write failure can never trap it.

### Added

- **Separate weekly thresholds (`CLAUDE_USAGE_GUARD_WEEKLY_WARN` / `_WEEKLY_HARD`, defaults
  90/95).** The `7d`, `7d-opus`, and `7d-sonnet` windows now take their own WARN/HARD so a
  slowly filling weekly window no longer winds the agent down at the same low bar as the
  volatile 5h window (which keeps the base `CLAUDE_USAGE_GUARD_WARN`/`_HARD`).
  `evaluateThresholds` scores each window against *its* window-class thresholds and reports
  the most severe (which is not necessarily the highest-utilization window). The weekly pair
  is validated and reset independently (clamp `1..100`; `weeklyWarn >= weeklyHard` resets
  the pair to 90/95).

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
