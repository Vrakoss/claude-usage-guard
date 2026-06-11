# claude-usage-guard

A zero-dependency [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin that
**warns you as you approach your subscription usage limits and blocks new work when a
window is exhausted** — deterministically, via hooks. When a limit is hit during a tool
call, it steers the model to *self-schedule a wakeup past the reset* instead of burning
through retries.

> **Heads up:** this reads an **undocumented** endpoint and **fails open**. Read the
> [Disclaimer](#disclaimer) before relying on it.

## Why

There are two ways to run into a usage window in Claude Code, and both hurt when they
happen *unintentionally*:

- **With "extra usage" enabled** on your plan, work silently continues past your included
  limits and is **billed at API-token rates** — an unattended loop, agent fan-out, or
  long autonomous session can keep spending real money without you noticing.
- **Without it**, the session just hits the wall mid-task.

The guard is a deterministic backstop for both: it warns you while there is still time to
wind down, and hard-blocks new work *before* a window is exhausted — so you stay within
your plan's included usage instead of rolling into billed extra usage, and an autonomous
session pauses itself until the reset instead of burning retries (or your wallet).

## What it does

The guard runs on two hook events and reads your usage from Anthropic's OAuth usage
endpoint (cached locally). It compares the worst utilization across your rolling windows
(`5h`, `7d`, and the per-model `7d-opus` / `7d-sonnet` windows when present) against two
thresholds — **WARN** (default 80%) and **HARD** (default 95%). Windows whose reset time
has already passed are ignored entirely — stale data can never block you past the actual
reset.

Reset times are shown in your **local timezone** with fixed English labels, e.g.
`[usage] 5h: 32% (reset Sun 15:50) | 7d: 5% (reset Wed 19 Jun 19:00)`.

| Event | Condition | Behavior | Exit |
|-------|-----------|----------|------|
| `UserPromptSubmit` | worst `< WARN` | Prints a one-line `[usage] …` status to context | `0` |
| `UserPromptSubmit` | `WARN ≤` worst `< HARD` | Status line **+ WIND DOWN** advisory (finish current work, don't start big tasks) | `0` |
| `UserPromptSubmit` | worst `≥ HARD` | **Blocks the prompt**; stderr explains when it resets and how to bypass | `2` |
| `PreToolUse` | tool is `ScheduleWakeup` | **Exempt** — always allowed (so the model can sleep through the reset) | `0` |
| `PreToolUse` | worst `< HARD` | Allowed silently (no stdout, per hook contract) | `0` |
| `PreToolUse` | worst `≥ HARD`, reset **≤ 6h** away | **Blocks the tool**; instructs the model to call `ScheduleWakeup` until reset, then resume | `2` |
| `PreToolUse` | worst `≥ HARD`, reset **> 6h** away | **Blocks the tool**; instructs the model to wrap up, summarize, and end the turn | `2` |

### Gate-and-self-sleep pause design

When a **short** (5-hour) window is exhausted mid-task, blocking every tool *except*
`ScheduleWakeup` turns the limit into a **pause** rather than a failure: the model is told
to schedule a wakeup (chaining 3600s sleeps if needed) and resume the same task after the
reset. `ScheduleWakeup` itself is always exempt from the gate, so the model can never be
trapped — it can always schedule its own wakeup.

For a **weekly** window (reset more than 6 hours out), self-sleeping is pointless, so the
guard instead tells the model to summarize state for you and end the turn cleanly.

## Install

```text
/plugin marketplace add Vrakoss/claude-usage-guard
/plugin install usage-guard@claude-usage-guard
```

The first command registers this repo as a plugin marketplace; the second installs the
`usage-guard` plugin from it. Requires Node.js **≥ 18** on your PATH (Claude Code already
needs Node, so this is normally satisfied).

**Verify:** start a new session and submit any prompt. A `[usage] 5h: N% …` line
should appear in context. No line = guard failed open (missing creds / network /
Node) — set `CLAUDE_USAGE_GUARD_DEBUG=1` and check the debug log.

## Configuration

All configuration is via environment variables. Invalid / non-numeric values fall back to
the default; percentages are clamped to `1..100`; if `WARN ≥ HARD` both reset to defaults.

| Variable | Default | Meaning |
|----------|---------|---------|
| `CLAUDE_USAGE_GUARD` | *(unset)* | Set to `off` to disable the guard entirely (immediate exit 0, no output). The advertised bypass. |
| `CLAUDE_USAGE_GUARD_WARN` | `80` | Utilization % at which the WIND DOWN advisory appears. |
| `CLAUDE_USAGE_GUARD_HARD` | `95` | Utilization % at which prompts/tools are blocked. |
| `CLAUDE_USAGE_GUARD_TTL` | `60` | Seconds to trust the cached usage snapshot before re-fetching. |
| `CLAUDE_USAGE_GUARD_DEBUG` | *(unset)* | Set to `1` to append allowlisted JSON-lines diagnostics to `~/.claude/usage-guard-debug.log`. |

### Where to set these

These are read from your **process environment**, so any mechanism that exports
them to the Claude Code process works. The simplest is the `env` block in your
Claude Code `settings.json`:

```jsonc
// ~/.claude/settings.json  (user-scope — all projects)
// or  <project>/.claude/settings.json  (one project)
{
  "env": {
    "CLAUDE_USAGE_GUARD_WARN": "80",
    "CLAUDE_USAGE_GUARD_HARD": "95"
  }
}
```

Use **user-scope** to match the user-scope plugin install; use project-scope to
tune one repo. Values reload on the **next session start** (env is read at launch).
A shell `export CLAUDE_USAGE_GUARD=off` also works for sessions started from that
shell.

There is **no** environment variable to override the usage endpoint URL — this is a
deliberate security decision (see below).

## Threat model & security

This plugin handles your Claude OAuth access token. It is designed so that the token
cannot leak through the usual exfiltration channels:

- **Token is read locally only.** On Linux/Windows it reads `~/.claude/.credentials.json`
  and uses *only* `claudeAiOauth.accessToken`. On macOS it first asks the Keychain
  (`security find-generic-password -s "Claude Code-credentials" -w`, 3s timeout) and falls
  back to the file. The `refreshToken` property is **never read anywhere** in the code
  (machine-checked by the test suite).
- **Opaque token holder.** The moment the token is read it is wrapped in an object whose
  `toString()`, `toJSON()`, and Node `util.inspect` custom hook all return `[redacted]`.
  The raw value is unwrapped at exactly **one** line — the one that builds the
  `Authorization: Bearer …` header. It never appears in any cache, log, output, or error
  message.
- **Hardcoded endpoint URL — no override by design.** The usage URL
  (`https://api.anthropic.com/api/oauth/usage`) is a frozen constant with **no env
  override**, so a poisoned environment cannot redirect your bearer token to an
  attacker-controlled host.
- **Allowlist cache validate-on-read.** The local cache
  (`~/.claude/usage-guard-cache.json`, written `0600` on POSIX — Windows ACLs
  inherit the user profile dir — atomic temp-file + rename writes) is
  run through a strict allowlist validator on every read: utilizations must be finite
  numbers (clamped `0..100`), reset timestamps must parse to a valid date. Any deviation
  discards the whole cache. **Nothing from the cache is ever echoed verbatim** — all output
  is rebuilt from validated numbers and freshly re-formatted parsed dates.
- **Allowlist debug logging.** Debug mode only ever writes a fixed set of event codes plus
  known-safe primitives (e.g. an HTTP `status` number). It never writes raw errors,
  response bodies, or anything from the credential path. As defense-in-depth, the final
  log-writer additionally refuses any line that contains the live token value.
- **Fails open, never crashes your session.** Every unexpected error results in exit 0 with
  empty output. Caught error objects are discarded, never stringified into output (an error
  object can carry request context, including headers).
- **Zero dependencies.** The script uses only Node built-ins and global `fetch`. There is
  no third-party supply-chain surface. CI asserts `package.json` declares no
  `dependencies` or `devDependencies`.

## Disclaimer

- This plugin queries an **undocumented** endpoint, `/api/oauth/usage`. It is not part of
  any public API contract and **may change or vanish at any time** without notice.
- The guard **FAILS OPEN to no enforcement** on any error — missing credentials, network
  failures, schema changes, anything. **Do not treat it as a load-bearing control.** It is
  a best-effort convenience nudge, not a guarantee that you will stay under your limit.
- This project is **not affiliated with, endorsed by, or supported by Anthropic.** Use at
  your own risk.

## Troubleshooting

- **Getting 429s / rate-limited unexpectedly.** The guard sends a static
  `User-Agent: claude-code/2.0.0 (usage-guard-plugin)`. The `claude-code/` prefix
  deliberately avoids a more aggressively rate-limited request bucket
  (see anthropics/claude-code#31637). Do not strip that prefix.
- **macOS Keychain prompt.** On macOS the first run may prompt for Keychain access to read
  the Claude credentials. Allow it (or "Always Allow") so the guard can read your token. If
  you deny it, the guard falls back to the credentials file and, failing that, simply does
  nothing (fail-open).
- **Disable temporarily.** Set `CLAUDE_USAGE_GUARD=off` in your `settings.json` `env`
  block (see [Where to set these](#where-to-set-these)) to bypass the guard entirely.
- **Diagnose behavior.** Set `CLAUDE_USAGE_GUARD_DEBUG=1` and inspect
  `~/.claude/usage-guard-debug.log` (allowlisted, token-safe diagnostics).

## Uninstall

```text
/plugin uninstall usage-guard@claude-usage-guard
/plugin marketplace remove claude-usage-guard
```

You can also delete the local artifacts the guard creates:

- `~/.claude/usage-guard-cache.json`
- `~/.claude/usage-guard-debug.log` (only if you enabled debug mode)

## License

[MIT](./LICENSE) © 2026 Vrakoss
