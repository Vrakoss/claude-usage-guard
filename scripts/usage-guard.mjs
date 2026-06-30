// claude-usage-guard — deterministic hook-enforced subscription-quota guard.
// Single-file, zero-dependency (node: builtins + global fetch). Node >= 18.
//
// SECURITY POSTURE (read before editing):
//  - The OAuth access token is wrapped in an opaque holder the instant it is
//    read. It is unwrapped exactly once, at the line that builds the
//    Authorization header. It must never reach output, cache, log, or error.
//  - Only the access token is read; the long-lived refresh credential on the
//    same record is never accessed (verified by the test suite).
//  - The usage endpoint URL is hardcoded & frozen — no env override — so a
//    poisoned env cannot redirect the bearer token to an attacker host.
//  - Cached JSON is validated against a strict allowlist on read. Nothing from
//    the cache is ever echoed verbatim; all output is rebuilt from validated
//    numbers and freshly re-formatted parsed Dates.
//  - Every unexpected error => exit 0 with empty output (fail-soft / fail-open).
//    Caught error objects are discarded, never stringified into output.
//  - PreToolUse hook contract amendment (v0.3.0): the ScheduleWakeup-exempt
//    branch may emit exactly ONE JSON line on stdout when it stamps a resume
//    marker onto an unmarked wakeup prompt while hard-blocked. All other
//    PreToolUse paths produce zero stdout. The JSON shape is strictly allowlisted
//    (permissionDecision, permissionDecisionReason, updatedInput with only
//    delaySeconds/prompt/reason fields). Any deviation falls back to plain exit 0.
//
// HOOK CONTRACT (v0.4.0):
//  - SessionStart: exit 0 always. Stdout posts a one-time onboarding hint (built
//    only from constants + platform branch) when not yet onboarded and no
//    CLAUDE_USAGE_GUARD* env var is set. Never fetches, never reads credentials,
//    never exits 2.
//  - UserPromptSubmit: exit 0 = allow (may print [usage] summary to stdout);
//    exit 2 + stderr = block. The [usage-guard:resume] prefix identifies a
//    scheduled resume wakeup; the guard lets these through the prompt gate,
//    re-instructs reschedule-or-resume each hop.
//    A prompt of exactly `usage-guard recheck` (the RECHECK_COMMAND, also the
//    bracket form [usage-guard:recheck]) forces a fresh fetch that bypasses ALL
//    cache (positive + negative), then applies the normal block decision to the
//    fresh result — so it can clear a stale cross-account block but cannot let
//    work through on a genuinely over-limit account.
//
// AUTO-HEAL (v0.5.0): a failed fetch NO LONGER carries the previous fetch's
// windows into the negative-cache marker (windows := {}). Resurrecting stale
// windows across a credential/account switch let an exhausted account A keep
// blocking a fresh account B indefinitely (each failed B fetch re-preserved
// A's windows). Dropping them on failure is the fail-open-consistent choice;
// the manual `usage-guard recheck` is the fast-path recovery.
//  - PreToolUse: exit 0 = allow; exit 2 + stderr = block. NEVER exit 2 on the
//    ScheduleWakeup path (so the model can never be trapped). The ScheduleWakeup
//    path may stamp the RESUME_MARKER onto an unmarked wakeup prompt (one JSON
//    line stdout) when hard-blocked, to ensure the wake turn is recognized as
//    a resume hop and handled correctly by the UserPromptSubmit branch.
//
// PAUSE LATCH (v0.6.0): a degenerate re-hop loop was reported (issue #5) — while
// hard-blocked, Claude Code's /goal feature (a prompt-based Stop hook) re-drives
// the agent every turn; each re-drive the agent re-scheduled a wakeup and
// sometimes ran a shell probe, stacking dozens of wakeups and BURNING the very
// quota the guard exists to conserve. A hook CANNOT make the agent idle (a Stop
// hook cannot veto /goal's forced continuation — "any block wins"), so the guard
// instead minimizes the cost of each forced re-drive. A small state file
// `usage-guard-pause.json` (numbers only: { resetAtMs, nextWakeupAtMs }, strict
// allowlist via validatePauseState, atomic 0o600 write, fully fail-open) records
// that a wakeup is already pending. It is WRITTEN authoritatively on the
// ScheduleWakeup PreToolUse path (the one place we KNOW a wakeup was scheduled),
// and READ on the two non-resume hard-block paths to emit a WAIT instruction
// ("a wakeup is already pending — do NOT schedule another, do NOT probe, end the
// turn") instead of inviting yet another schedule. The RESUME_MARKER path is
// carved OUT of the latch: a fired resume hop is PROOF the wakeup fired, so it
// always re-evaluates fresh and never WAITs (else a buffer-early wakeup would be
// strangled and the chain would die). Fail-open is ASYMMETRIC: any doubt (torn
// read, validation failure, poisoned far-future timestamp) → SCHEDULE, never
// WAIT, so a corrupt/poisoned pause file can never silently disable blocking.
//
// WEEKLY THRESHOLDS (v0.6.0): the 7d* windows take their own WARN/HARD
// (CLAUDE_USAGE_GUARD_WEEKLY_WARN / _WEEKLY_HARD, defaults 90/95) so a slowly
// filling weekly window does not wind the agent down at the same low bar as the
// volatile 5h window. evaluateThresholds now scores each window against ITS
// window-class thresholds and reports the most severe.
//
// TESTABILITY: all I/O is injected through `main(deps)`. Pure helpers are
// exported. Importing this module performs no I/O and exits nothing.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Frozen, no env override by design (prevents token exfiltration via env).
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Static UA; the `claude-code/` prefix avoids an aggressively rate-limited
// bucket (anthropics/claude-code#31637).
const USER_AGENT = 'claude-code/2.0.0 (usage-guard-plugin)';
const ANTHROPIC_BETA = 'oauth-2025-04-20';

const FETCH_TIMEOUT_MS = 10_000;
const KEYCHAIN_TIMEOUT_MS = 3_000;
const NEGATIVE_CACHE_MS = 300_000; // 5 min fail-soft backoff

const DEFAULT_WARN = 80;
const DEFAULT_HARD = 95;
// Weekly (7d*) windows get their own, more lenient defaults so a slowly filling
// weekly window does not wind the agent down at the same bar as the 5h window.
const DEFAULT_WEEKLY_WARN = 90;
const DEFAULT_WEEKLY_HARD = 95;
const DEFAULT_TTL_S = 60;

// Resume-hop chaining only makes sense within this horizon; beyond it the chain
// terminates instead of sleeping for days. Shared by the block message, the
// resume-hop branch, and the pause-state validator.
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// Pause-latch tuning (v0.6.0, issue #5).
//  - SKEW: the largest amount a scheduled wakeup may legitimately land past its
//    own reset (must exceed computeHopDelaySeconds's +120s buffer). A pause
//    record whose nextWakeupAtMs is further past resetAtMs than this is treated
//    as poisoned and dropped.
//  - GRACE: how long past the latched reset a pause record stays trusted before
//    it is treated as stale (expired) on read.
const PAUSE_WAKEUP_SKEW_MS = 180_000; // 3 min
const PAUSE_GRACE_MS = 15 * 60_000; // 15 min

const CACHE_BASENAME = 'usage-guard-cache.json';
const DEBUG_BASENAME = 'usage-guard-debug.log';
const CREDS_BASENAME = '.credentials.json';
const ONBOARD_BASENAME = 'usage-guard-onboarded';
const PAUSE_BASENAME = 'usage-guard-pause.json';

// Window keys we understand, mapped to display labels.
const WINDOW_LABELS = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d-opus',
  seven_day_sonnet: '7d-sonnet',
};

// Allowed debug event codes (allowlist). Anything else is dropped.
const DEBUG_EVENTS = new Set([
  'guard_off',
  'cache_hit',
  'cache_invalid',
  'cache_miss',
  'cache_stale',
  'negative_cache',
  'fetch_ok',
  'fetch_failed',
  'creds_missing',
  'keychain_timeout',
  'keychain_error',
  'blocked',
  'warn',
  'ok',
  'unexpected',
  'cache_write_failed',
  'resume_hop',
  'wakeup_marked',
  'onboarding',
  'recheck',
  'recheck_blocked',
  'pause_scheduled',
  'pause_wait',
  'pause_cleared',
  'pause_write_failed',
]);

const REDACTED = '[redacted]';

// ---------------------------------------------------------------------------
// Resume-hop marker — COMPATIBILITY CONTRACT: this string must never change.
// It identifies a UserPromptSubmit that was injected by a ScheduleWakeup
// fired during a hard-block. The guard lets these through the prompt gate
// and re-instructs the model to reschedule or resume depending on state.
// ---------------------------------------------------------------------------

/**
 * Marker prefix stamped onto wakeup prompts by the ScheduleWakeup hook path
 * when the guard is hard-blocked. NEVER change this string — it is a
 * compatibility contract across plugin versions.
 */
export const RESUME_MARKER = '[usage-guard:resume]';

/**
 * User-typed command that forces a fresh usage check, bypassing all cache
 * (positive AND negative). Intended for when the user has switched accounts or
 * believes a block is a mistake. The bracket form mirrors RESUME_MARKER.
 */
export const RECHECK_COMMAND = 'usage-guard recheck';
const RECHECK_BRACKET = '[usage-guard:recheck]';

/**
 * Sentinel strings used by the Claude Code harness for autonomous loop
 * scheduling. These must never be rewritten by the guard.
 */
const AUTONOMOUS_SENTINELS = new Set([
  '<<autonomous-loop-dynamic>>',
  '<<autonomous-loop>>',
]);

// ---------------------------------------------------------------------------
// Token hygiene — opaque holder
// ---------------------------------------------------------------------------

/**
 * Wrap a raw secret string so it cannot be accidentally serialized or logged.
 * The raw value is only retrievable via `.use()`.
 */
export function makeTokenHolder(raw) {
  const holder = {
    use() {
      return raw;
    },
    toString() {
      return REDACTED;
    },
    toJSON() {
      return REDACTED;
    },
    [Symbol.for('nodejs.util.inspect.custom')]() {
      return REDACTED;
    },
  };
  return holder;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readIntEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * Build effective config from env. Invalid/NaN => default; clamp 1..100;
 * if WARN >= HARD, reset both to defaults.
 */
export function readConfig(env) {
  const off = String(env.CLAUDE_USAGE_GUARD || '').toLowerCase() === 'off';
  const debug = String(env.CLAUDE_USAGE_GUARD_DEBUG || '') === '1';

  let warn = clamp(readIntEnv(env, 'CLAUDE_USAGE_GUARD_WARN', DEFAULT_WARN), 1, 100);
  let hard = clamp(readIntEnv(env, 'CLAUDE_USAGE_GUARD_HARD', DEFAULT_HARD), 1, 100);
  if (warn >= hard) {
    warn = DEFAULT_WARN;
    hard = DEFAULT_HARD;
  }

  // Weekly (7d*) thresholds are independent of the 5h thresholds. Same
  // validation discipline: invalid/NaN => default, clamp 1..100, and if
  // weeklyWarn >= weeklyHard the pair is reset to its own defaults.
  let weeklyWarn = clamp(
    readIntEnv(env, 'CLAUDE_USAGE_GUARD_WEEKLY_WARN', DEFAULT_WEEKLY_WARN),
    1,
    100,
  );
  let weeklyHard = clamp(
    readIntEnv(env, 'CLAUDE_USAGE_GUARD_WEEKLY_HARD', DEFAULT_WEEKLY_HARD),
    1,
    100,
  );
  if (weeklyWarn >= weeklyHard) {
    weeklyWarn = DEFAULT_WEEKLY_WARN;
    weeklyHard = DEFAULT_WEEKLY_HARD;
  }

  let ttl = readIntEnv(env, 'CLAUDE_USAGE_GUARD_TTL', DEFAULT_TTL_S);
  if (!Number.isFinite(ttl) || ttl < 0) ttl = DEFAULT_TTL_S;

  return { off, debug, warn, hard, weeklyWarn, weeklyHard, ttlMs: ttl * 1000 };
}

// ---------------------------------------------------------------------------
// Cache validation (security-critical, strict allowlist)
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a single window entry. Returns a clean object with a numeric
 * utilization (clamped 0..100) and an ISO resets_at string, or null on any
 * deviation.
 */
function validateWindowEntry(entry) {
  if (!isPlainObject(entry)) return null;
  const { utilization, resets_at } = entry;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  if (typeof resets_at !== 'string') return null;
  const d = new Date(resets_at);
  if (Number.isNaN(d.getTime())) return null;
  return {
    utilization: clamp(utilization, 0, 100),
    resets_at: d.toISOString(),
  };
}

/**
 * Strict allowlist validator for the cache object. ANY deviation (wrong shape,
 * non-finite numbers, unparseable dates, unknown windows are simply dropped)
 * that leaves us without a usable structure => return null (treat as miss).
 *
 * When `nowMs` is provided, timestamps from the future are distrusted and
 * treated as absent: a poisoned `fetchedAt` could otherwise pin the cache
 * permanently "fresh" (never refetched), and a future `failedAt` could pin
 * the negative-cache backoff indefinitely.
 *
 * Returns a freshly-built clean object: { fetchedAt, failedAt, windows }.
 * `raw` is never trusted for output.
 */
export function validateCache(raw, nowMs) {
  if (!isPlainObject(raw)) return null;

  let fetchedAt =
    typeof raw.fetchedAt === 'number' && Number.isFinite(raw.fetchedAt)
      ? raw.fetchedAt
      : null;
  let failedAt =
    typeof raw.failedAt === 'number' && Number.isFinite(raw.failedAt)
      ? raw.failedAt
      : null;

  if (typeof nowMs === 'number' && Number.isFinite(nowMs)) {
    if (fetchedAt !== null && fetchedAt > nowMs) fetchedAt = null;
    if (failedAt !== null && failedAt > nowMs) failedAt = null;
  }

  if (fetchedAt === null && failedAt === null) return null;

  const cleanWindows = {};
  if (raw.windows !== undefined) {
    if (!isPlainObject(raw.windows)) return null;
    for (const key of Object.keys(WINDOW_LABELS)) {
      const w = raw.windows[key];
      if (w === undefined || w === null) continue;
      const cleaned = validateWindowEntry(w);
      if (cleaned === null) return null; // present-but-malformed => whole cache invalid
      cleanWindows[key] = cleaned;
    }
  }

  return { fetchedAt, failedAt, windows: cleanWindows };
}

/**
 * Strict allowlist validator for the pause-state file (v0.6.0, issue #5).
 * The file holds ONLY two numbers — { resetAtMs, nextWakeupAtMs } — and never
 * any token or user data. ANY deviation => null (treated as "no pause"), which
 * degrades to the pre-v0.6.0 always-reschedule behavior (fail-open).
 *
 * When `nowMs` is provided the record is distrusted in three ways, each closing
 * a way a stale or poisoned file could misbehave:
 *   - resetAtMs already in the past  => stale (window reset) => null.
 *   - resetAtMs implausibly far in the future (beyond the 6h resume horizon
 *     plus grace) => poisoned attempt to pin the guard into permanent WAIT
 *     (which would silently disable blocking) => null.
 *   - nextWakeupAtMs landing further past resetAtMs than the hop buffer could
 *     ever produce => implausible => null.
 * The polarity is deliberately opposite to validateCache (which distrusts a
 * FUTURE fetchedAt): here a far-future resetAtMs is the poison.
 *
 * Returns a freshly-built clean object; `raw` is never trusted for output.
 */
export function validatePauseState(raw, nowMs) {
  if (!isPlainObject(raw)) return null;
  const { resetAtMs, nextWakeupAtMs } = raw;
  if (typeof resetAtMs !== 'number' || !Number.isFinite(resetAtMs)) return null;
  if (typeof nextWakeupAtMs !== 'number' || !Number.isFinite(nextWakeupAtMs)) return null;

  if (typeof nowMs === 'number' && Number.isFinite(nowMs)) {
    if (resetAtMs <= nowMs) return null; // stale: window already reset
    if (resetAtMs > nowMs + SIX_HOURS_MS + PAUSE_GRACE_MS) return null; // poisoned far-future
  }
  if (nextWakeupAtMs > resetAtMs + PAUSE_WAKEUP_SKEW_MS) return null; // implausible wakeup

  return { resetAtMs, nextWakeupAtMs };
}

/**
 * Decide what to instruct an already-hard-blocked, non-resume-hop turn to do:
 *   'wait'     — a wakeup is still pending in the future; do NOT schedule
 *                another (this is what breaks the degenerate re-hop loop).
 *   'schedule' — no pending wakeup (none recorded, or the recorded one has
 *                already fired); instruct/allow a single wakeup.
 * `pauseState` is normally a validatePauseState result (or null). The inline
 * `typeof nextWakeupAtMs === 'number'` is defensive belt-and-suspenders so a
 * caller (or future code path) passing an unvalidated/partial object can never
 * trip a NaN/undefined comparison into a spurious 'wait'. Fail-open is
 * asymmetric: a null/expired/poisoned/malformed state yields 'schedule', never
 * 'wait'.
 */
export function decidePauseAction(pauseState, now) {
  if (
    pauseState &&
    typeof pauseState.nextWakeupAtMs === 'number' &&
    now.getTime() < pauseState.nextWakeupAtMs
  ) {
    return 'wait';
  }
  return 'schedule';
}

// ---------------------------------------------------------------------------
// Window parsing
// ---------------------------------------------------------------------------

/**
 * From validated cache data, produce a list of window descriptors:
 *   [{ label, util (rounded int), reset (Date) }]
 * Skips null/missing windows.
 *
 * When `now` (a Date) is provided, windows whose reset time has already
 * passed are dropped: their utilization is stale by definition (the window
 * has reset server-side), so they must never drive a warn/block. Without
 * this, a stale cache plus unreachable credentials could block prompts
 * indefinitely past the actual reset.
 */
export function parseWindows(data, now) {
  const out = [];
  if (!data || !isPlainObject(data.windows)) return out;
  const nowMs = now instanceof Date ? now.getTime() : null;
  for (const [key, label] of Object.entries(WINDOW_LABELS)) {
    const w = data.windows[key];
    if (!w) continue;
    const util = Math.round(w.utilization);
    const reset = new Date(w.resets_at);
    if (Number.isNaN(reset.getTime())) continue;
    if (nowMs !== null && reset.getTime() <= nowMs) continue;
    out.push({ label, util, reset });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Threshold evaluation
// ---------------------------------------------------------------------------

/**
 * The WARN/HARD pair that applies to a given window label. Weekly (7d*) windows
 * use the weekly thresholds; everything else (5h) uses the base thresholds.
 */
export function thresholdsForLabel(label, cfg) {
  if (isWeeklyLabel(label)) {
    return { warn: cfg.weeklyWarn, hard: cfg.weeklyHard };
  }
  return { warn: cfg.warn, hard: cfg.hard };
}

const SEVERITY = { ok: 0, warn: 1, hard: 2 };

/** Level of a single window against its own window-class thresholds. */
function windowLevel(w, cfg) {
  const { warn, hard } = thresholdsForLabel(w.label, cfg);
  if (w.util >= hard) return 'hard';
  if (w.util >= warn) return 'warn';
  return 'ok';
}

/**
 * Evaluate windows against config. Returns:
 *   { worst: window|null, level: 'ok'|'warn'|'hard' }
 * Each window is scored against ITS window-class thresholds (5h vs weekly), and
 * the most SEVERE window wins (hard > warn > ok), ties broken by utilization.
 * Note: the most severe is not necessarily the highest-utilization window — a
 * 5h at 85% (warn 80) outranks a 7d at 88% (weekly warn 90, still ok).
 */
export function evaluateThresholds(windows, cfg) {
  if (!windows || windows.length === 0) {
    return { worst: null, level: 'ok' };
  }
  let worst = windows[0];
  let level = windowLevel(worst, cfg);
  for (const w of windows) {
    const wl = windowLevel(w, cfg);
    if (
      SEVERITY[wl] > SEVERITY[level] ||
      (SEVERITY[wl] === SEVERITY[level] && w.util > worst.util)
    ) {
      worst = w;
      level = wl;
    }
  }
  return { worst, level };
}

// ---------------------------------------------------------------------------
// Date / summary formatting
// ---------------------------------------------------------------------------

// Fixed English labels, local timezone. Deterministic across ICU versions
// (no Intl), unambiguous internationally (no DD/MM vs MM/DD).
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtWeekdayTime(d) {
  return `${WEEKDAYS_SHORT[d.getDay()]} ${fmtTime(d)}`;
}

function fmtWeekdayDateTime(d) {
  return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${fmtTime(d)}`;
}

// 7d windows show date; 5h shows weekday+time only.
function isWeeklyLabel(label) {
  return label.startsWith('7d');
}

function fmtReset(w) {
  return isWeeklyLabel(w.label) ? fmtWeekdayDateTime(w.reset) : fmtWeekdayTime(w.reset);
}

/**
 * One-line human summary across all available windows.
 *   [usage] 5h: 32% (reset Sun 15:50) | 7d: 5% (reset Wed 19 Jun 19:00) | ...
 */
export function formatSummary(windows) {
  const parts = windows.map(
    (w) => `${w.label}: ${w.util}% (reset ${fmtReset(w)})`,
  );
  return `[usage] ${parts.join(' | ')}`;
}

/**
 * Base [usage] line shared by the plain, recheck-cleared, and resume-ready
 * UserPromptSubmit branches: the summary plus the WARN wind-down suffix when at
 * warn level. Each caller appends its own branch-specific suffix. Keeping this
 * one place avoids the summary+warn assembly drifting across the three sites.
 * (buildWarnSuffix is a hoisted function declaration defined below.)
 */
function buildUsageLine(windows, level, worst) {
  let line = formatSummary(windows);
  if (level === 'warn' && worst) line += buildWarnSuffix(worst);
  return line;
}

// ---------------------------------------------------------------------------
// Resume-hop helpers
// ---------------------------------------------------------------------------

/**
 * Returns true iff the input is a UserPromptSubmit whose prompt text starts
 * with RESUME_MARKER. Strict startsWith — mid-prompt occurrences do NOT count.
 * Non-string prompts are treated as normal prompts (not resume hops).
 */
export function isResumeHopPrompt(input) {
  return (
    input.hook_event_name === 'UserPromptSubmit' &&
    typeof input.prompt === 'string' &&
    input.prompt.startsWith(RESUME_MARKER)
  );
}

/**
 * Returns true iff the input is a UserPromptSubmit whose prompt is exactly the
 * recheck command (the whole prompt, after trim/lowercase/whitespace-collapse).
 * Forgiving on spacing and hyphen-vs-space, but EXACT-match only — trailing
 * task text makes it a normal prompt (so it cannot smuggle work past the gate).
 * Accepted forms: `usage-guard recheck`, `usage guard recheck`,
 * `[usage-guard:recheck]` (any case).
 */
export function isRecheckPrompt(input) {
  if (input.hook_event_name !== 'UserPromptSubmit') return false;
  if (typeof input.prompt !== 'string') return false;
  const p = input.prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  return (
    p === RECHECK_COMMAND ||
    p === 'usage guard recheck' ||
    p === RECHECK_BRACKET
  );
}

/**
 * Compute the ScheduleWakeup delaySeconds for a resume hop.
 * Clamps to [60, 3600] (harness limits). The +120s buffer ensures the
 * wakeup lands after the reset, not at the exact second.
 */
export function computeHopDelaySeconds(worst, now) {
  return Math.max(
    60,
    Math.min(
      3600,
      Math.ceil((worst.reset.getTime() - now.getTime()) / 1000) + 120,
    ),
  );
}

// ---------------------------------------------------------------------------
// Block / warn messages
// ---------------------------------------------------------------------------

/** UserPromptSubmit HARD block message (stderr). */
export function buildPromptBlockMessage(worst, cfg) {
  const { hard } = thresholdsForLabel(worst.label, cfg);
  return (
    `QUOTA GUARD: ${worst.label} window at ${worst.util}% (limit ${hard}%). ` +
    `Prompts blocked until reset at ${fmtWeekdayDateTime(worst.reset)} local. ` +
    `Switched accounts, or think this block is wrong (stale data, wrong login)? ` +
    `Send the prompt "${RECHECK_COMMAND}" to force a fresh check against your CURRENT login — ` +
    `it ignores all cached data and re-reads your real usage. ` +
    `Bypass entirely: set CLAUDE_USAGE_GUARD=off. ` +
    `Scheduled resume wakeups (prefixed ${RESUME_MARKER}) are exempt and will still fire.`
  );
}

/**
 * UserPromptSubmit HARD block message after a recheck (stderr). A still-hard
 * result means the CURRENT login is genuinely over the limit (a failed fetch
 * yields no windows and never reaches this path), so the fresh check confirms
 * the block rather than clearing it.
 */
export function buildRecheckBlockMessage(worst, cfg) {
  const { hard } = thresholdsForLabel(worst.label, cfg);
  return (
    `QUOTA GUARD (rechecked): ${worst.label} window at ${worst.util}% (limit ${hard}%) ` +
    `on your current login. Fresh check confirms the block is real — resets at ` +
    `${fmtWeekdayDateTime(worst.reset)} local. ` +
    `If you switched accounts, the new account is also over its limit. ` +
    `Bypass: set CLAUDE_USAGE_GUARD=off.`
  );
}

/**
 * Suffix appended to the [usage] summary when a recheck clears the block
 * (current login is under the hard limit). Stdout, exit 0.
 */
export function buildRecheckClearedSuffix() {
  return ` -- RECHECK: current login is under the hard limit. Unblocked.`;
}

/**
 * Stdout line when a recheck could not read any usage for the current login
 * (fetch failed / no usable windows). The guard cannot measure this account,
 * so it fails open (exit 0). Built from constants only.
 */
export function buildRecheckUnreadableMessage() {
  return (
    `[usage-guard] Recheck: could not read usage for your current login ` +
    `(no usage data returned). The guard cannot measure this account, so prompts ` +
    `are allowed (fail-open). If you expected this account to be measured, confirm ` +
    `you are logged into the right account and that it has subscription usage.`
  );
}

/** UserPromptSubmit WARN suffix appended to the summary line (stdout). */
export function buildWarnSuffix(worst) {
  // fmtReset, not fmtTime: a weekly window may reset days away — a bare
  // time-of-day would read as "today" and steer the model to a wakeup that
  // lands long before the actual reset.
  return (
    ` -- WIND DOWN: ${worst.label} window at ${worst.util}%. ` +
    `Finish current work; do NOT start new large tasks, agent fan-outs, or workflows. ` +
    `Prefer ScheduleWakeup past ${fmtReset(worst)} in loops.`
  );
}

/**
 * PreToolUse HARD block message (stderr). Behavior depends on time-to-reset
 * and whether we are in a sub-agent.
 * `now` is a Date, `isSubagent` is a boolean.
 */
export function buildToolBlockMessage(worst, now, isSubagent) {
  const msToReset = worst.reset.getTime() - now.getTime();
  if (isSubagent) {
    return (
      `QUOTA GUARD: ${worst.label} window at ${worst.util}%. ` +
      `You are a sub-agent: ScheduleWakeup is NOT available here. ` +
      `All tools are gated. STOP now — return a resume brief to your caller: ` +
      `summarize current state, remaining steps, and exact relaunch instructions ` +
      `(context, tool calls, arguments). Your caller will relaunch you after reset.`
    );
  }
  if (msToReset <= SIX_HOURS_MS) {
    const delay = computeHopDelaySeconds(worst, now);
    return (
      `QUOTA GUARD: ${worst.label} window at ${worst.util}%. ` +
      `Execution paused until reset at ${fmtReset(worst)}. ` +
      `Your ONLY next action: call ScheduleWakeup (exempt from this gate) with ` +
      `delaySeconds=${delay} and a prompt STARTING WITH ${RESUME_MARKER} followed by ` +
      `a one-line resume brief (task to resume; which sub-agents to relaunch with what context — ` +
      `sub-agents abort on block and need fresh launch). ` +
      `Schedule it AT MOST ONCE: if you are re-driven (e.g. by a goal or autonomous loop) ` +
      `and a wakeup is already pending, do NOT schedule another. ` +
      `Do NOT run shell commands or any other tool to check usage or the reset — the reset ` +
      `time is stated above and probing only burns more quota. ` +
      `The guard lets that wakeup back through each hop and tells you whether to ` +
      `reschedule or resume. Then end the turn. Do not retry other tools before reset.`
    );
  }
  return (
    `QUOTA GUARD: ${worst.label} window at ${worst.util}%. ` +
    `Resets ${fmtWeekdayDateTime(worst.reset)}. ` +
    `Wrap up: summarize state for the user and end the turn (include a resume brief in your summary). Do not retry tools.`
  );
}

/**
 * Suffix appended to the UserPromptSubmit stdout line when a resume-hop is
 * still blocked (window not yet reset). Instructs the model to reschedule the
 * next hop; the hop delay is computed internally via computeHopDelaySeconds.
 */
export function buildResumeHopSuffix(worst, now) {
  const delay = computeHopDelaySeconds(worst, now);
  return (
    ` -- RESUME HOP: ${worst.label} still at ${worst.util}% (reset ${fmtReset(worst)}). ` +
    `Still blocked. Your ONLY action: call ScheduleWakeup ONCE with delaySeconds=${delay} ` +
    `and the SAME prompt (starting with ${RESUME_MARKER}), then end the turn. ` +
    `Do NOT run shell or any other tool to check usage/reset — probing burns quota. ` +
    `If a goal or autonomous loop re-drives you before that wakeup fires, it cannot make ` +
    `progress until reset: just end the turn without scheduling again. ` +
    `All other tools are gated/denied.`
  );
}

/**
 * Block message (stderr) for an already-hard-blocked, non-resume turn when a
 * wakeup is ALREADY pending (decidePauseAction => 'wait'). This is the latch
 * that breaks the degenerate re-hop loop: instead of inviting yet another
 * ScheduleWakeup, it tells the model to stand down. Built from validated
 * numbers + constants only; `nextWakeupAtMs` has already passed validatePauseState.
 */
export function buildPauseWaitMessage(worst, nextWakeupAtMs) {
  const wakeupAt = new Date(nextWakeupAtMs);
  const whenSuffix = Number.isNaN(wakeupAt.getTime())
    ? ''
    : ` (~${fmtWeekdayDateTime(wakeupAt)} local)`;
  return (
    `QUOTA GUARD: ${worst.label} window at ${worst.util}%. ` +
    `A wakeup is ALREADY scheduled${whenSuffix} and will resume you after reset. ` +
    `Do NOT schedule another wakeup, and do NOT run shell commands or any other tool to ` +
    `check usage or the reset — probing only burns more quota. ` +
    `If a goal or autonomous loop is re-driving you, it cannot make progress until reset: ` +
    `STOP now and end the turn. The pending wakeup is the only thing that should run next.`
  );
}

/**
 * Suffix appended to the UserPromptSubmit stdout line when a resume-hop
 * prompt arrives after the window has reset (dropped by parseWindows because
 * resets_at is now in the past, or utilization fell below hard threshold).
 * Instructs the model to resume the task described in the prompt.
 */
export function buildResumeReadySuffix() {
  return (
    ` -- RESUME READY: quota window has reset. ` +
    `RESUME the task described in this prompt now. ` +
    `Relaunch any aborted sub-agents fresh with a context brief.`
  );
}

/**
 * Suffix appended to the UserPromptSubmit stdout line when a resume-hop is
 * still hard-blocked but the worst window does not reset for more than 6 hours.
 * A multi-hour wakeup chain is inappropriate at that horizon — instruct the
 * model to wind the chain down and hand back to the user instead of sleeping
 * for days.
 */
export function buildResumeTerminationSuffix(worst) {
  return (
    ` -- RESUME HOP: ${worst.label} window does not reset for more than 6 hours ` +
    `(${fmtWeekdayDateTime(worst.reset)} local). ` +
    `Do NOT reschedule for days. Summarize the task state for the user and end the turn cleanly.`
  );
}

// ---------------------------------------------------------------------------
// Onboarding helpers
// ---------------------------------------------------------------------------

/**
 * True if any CLAUDE_USAGE_GUARD* env var is set to a non-empty value.
 * Prefix scan (not a fixed list) so future config vars suppress automatically.
 */
export function isConfigured(env) {
  return Object.keys(env).some(
    (k) => k.startsWith('CLAUDE_USAGE_GUARD') && String(env[k] ?? '') !== '',
  );
}

/**
 * One-time onboarding hint posted to SessionStart stdout.
 * Built only from DEFAULT_WARN/DEFAULT_HARD constants + a platform branch.
 * Contains no credentials, no dates, no user data.
 */
export function buildOnboardingMessage(platform) {
  const credLine =
    platform === 'darwin'
      ? `Credentials: read from the macOS Keychain item "Claude Code-credentials" (a one-time ` +
        `Keychain permission prompt may appear — choose "Always Allow"), falling back to ` +
        `~/.claude/.credentials.json.`
      : `Credentials: read from ~/.claude/.credentials.json.`;
  return (
    `[usage-guard] One-time setup note (will not repeat):\n` +
    `Active defaults: WARN at ${DEFAULT_WARN}%, HARD block at ${DEFAULT_HARD}%.\n` +
    `To customize, add an env block to ~/.claude/settings.json:\n` +
    `  "env": {\n` +
    `    "CLAUDE_USAGE_GUARD_WARN": "${DEFAULT_WARN}",\n` +
    `    "CLAUDE_USAGE_GUARD_HARD": "${DEFAULT_HARD}"\n` +
    `  }\n` +
    `Optional: CLAUDE_USAGE_GUARD_WEEKLY_WARN / _WEEKLY_HARD (separate thresholds for the 7d* ` +
    `windows, defaults ${DEFAULT_WEEKLY_WARN}/${DEFAULT_WEEKLY_HARD}), ` +
    `CLAUDE_USAGE_GUARD_TTL (cache seconds), CLAUDE_USAGE_GUARD_DEBUG=1 (diagnostics), ` +
    `CLAUDE_USAGE_GUARD=off (disable). Env reloads at next session start.\n` +
    `If you ever get blocked right after switching accounts (or think a block is wrong), ` +
    `send the prompt "${RECHECK_COMMAND}" to force a fresh check against your current login.\n` +
    `${credLine}\n` +
    `If the user wants different thresholds, offer to add the env block above to their settings.json.`
  );
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function joinPath(...parts) {
  // Normalize to forward-slash join; Node fs accepts forward slashes on Windows.
  return parts.join('/').replace(/\\/g, '/');
}

function claudeDir(homedir) {
  return joinPath(homedir(), '.claude');
}

// ---------------------------------------------------------------------------
// Debug logging (allowlist only)
// ---------------------------------------------------------------------------

/**
 * Create a debug logger. Only allowlisted event codes and known-safe
 * primitive fields are written. As defense-in-depth, any line containing the
 * loaded token value is refused.
 *
 * `tokenProbe` is a function returning the current raw token (or null) so the
 * final write can refuse to emit a line containing it.
 */
function makeDebugLogger(deps, cfg, tokenProbe) {
  if (!cfg.debug) {
    return () => {};
  }
  const logPath = joinPath(claudeDir(deps.homedir), DEBUG_BASENAME);
  return (event, fields) => {
    try {
      if (!DEBUG_EVENTS.has(event)) return;
      const entry = { ts: deps.now().toISOString(), event };
      if (isPlainObject(fields)) {
        for (const [k, v] of Object.entries(fields)) {
          // Only allow safe primitives.
          if (typeof v === 'number' && Number.isFinite(v)) entry[k] = v;
          else if (typeof v === 'string') entry[k] = v;
          else if (typeof v === 'boolean') entry[k] = v;
        }
      }
      const line = JSON.stringify(entry);
      // Defense-in-depth: never write a line containing the token value.
      // Check the JSON-escaped form too — stringify escapes quotes and
      // backslashes, which would otherwise defeat a raw includes() check.
      const tok = tokenProbe ? tokenProbe() : null;
      if (tok) {
        if (line.includes(tok)) return;
        const escaped = JSON.stringify(tok).slice(1, -1);
        if (escaped !== tok && line.includes(escaped)) return;
      }
      // Synchronous append so the entry survives an imminent process.exit.
      // (Debug mode is opt-in diagnostics; sync I/O is acceptable here.)
      if (typeof deps.fs.appendFileSync === 'function') {
        deps.fs.appendFileSync(logPath, line + '\n', { mode: 0o600 });
      } else if (typeof deps.fs.appendFile === 'function') {
        // Fallback: fire-and-forget async (may be lost on immediate exit).
        deps.fs.appendFile(logPath, line + '\n', { mode: 0o600 }).catch(() => {});
      }
    } catch {
      // discard
    }
  };
}

// ---------------------------------------------------------------------------
// Credential acquisition
// ---------------------------------------------------------------------------

/**
 * Extract the access token from a parsed credentials object.
 * Reads ONLY `.claudeAiOauth.accessToken` — the refresh credential on the
 * same record is never accessed. Returns the raw token string or null.
 */
function extractAccessToken(parsed) {
  if (!isPlainObject(parsed) || !isPlainObject(parsed.claudeAiOauth)) return null;
  const token = parsed.claudeAiOauth.accessToken;
  if (typeof token !== 'string' || token.length === 0) return null;
  return token;
}

/**
 * Read access token from the credentials file. Returns raw string or null.
 * Reads ONLY `.claudeAiOauth.accessToken`. The refresh credential on the same
 * record is never accessed.
 */
async function readTokenFromFile(deps) {
  try {
    const credsPath = joinPath(claudeDir(deps.homedir), CREDS_BASENAME);
    const text = await deps.fs.readFile(credsPath, 'utf8');
    return extractAccessToken(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * darwin: read token from Keychain via `security`. 3s timeout + kill.
 * Any error/timeout/empty => null (caller falls back to file).
 * Absolute binary path: consistent with the poisoned-env threat model — a
 * PATH-shadowed `security` must not be what we invoke.
 *
 * macOS Claude Code stores the full credentials JSON blob as the Keychain item
 * password (issue #2). When the output starts with '{' it is treated as JSON
 * and the access token is extracted from it; bare strings are returned as-is
 * (historical contract). Corrupt blobs => null so the file fallback gets its
 * chance.
 */
async function readTokenFromKeychain(deps, log) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    try {
      const child = deps.execFileImpl(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: KEYCHAIN_TIMEOUT_MS, encoding: 'utf8', killSignal: 'SIGKILL' },
        (err, stdout) => {
          if (err) {
            // Distinguish timeout for debug log only (no error object logged).
            if (err.killed || err.signal === 'SIGKILL') log('keychain_timeout', {});
            else log('keychain_error', {});
            done(null);
            return;
          }
          const out = typeof stdout === 'string' ? stdout.trim() : '';
          if (out.length === 0) {
            done(null);
            return;
          }
          if (!out.startsWith('{')) {
            // Bare token (historical contract). Real tokens never start with '{'.
            done(out);
            return;
          }
          // macOS Claude Code stores the FULL credentials JSON as the item password
          // (issue #2). A '{'-prefixed string is never a bearer token: extract the
          // access token, or return null so the file fallback gets its chance.
          // The parse AND the extract both live inside this try so the whole
          // callback body is throw-proof — a throw escaping here would bypass
          // main()'s fail-open net and crash the hook process.
          let token = null;
          try {
            token = extractAccessToken(JSON.parse(out));
          } catch {
            // Corrupt blob — discard silently (the SyntaxError embeds input snippets).
          }
          done(token);
        },
      );
      // Belt-and-suspenders kill in case the impl ignores the timeout option.
      if (child && typeof child.on === 'function') {
        child.on('error', () => done(null));
      }
    } catch {
      done(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Cache read / write
// ---------------------------------------------------------------------------

async function readCache(deps) {
  try {
    const cachePath = joinPath(claudeDir(deps.homedir), CACHE_BASENAME);
    const text = await deps.fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(text);
    return validateCache(parsed, deps.now().getTime());
  } catch {
    return null;
  }
}

/**
 * Allowlist-serialize then atomic-write (temp + rename) at mode 0o600.
 * `clean` must already be a validated object.
 */
async function writeCache(deps, clean, log) {
  let tmpPath = null;
  try {
    const dir = claudeDir(deps.homedir);
    const cachePath = joinPath(dir, CACHE_BASENAME);
    // pid in the tmp name: UserPromptSubmit and PreToolUse hooks can run
    // concurrently in separate processes within the same millisecond.
    const pid = typeof deps.pid === 'number' ? deps.pid : 0;
    tmpPath = joinPath(dir, `${CACHE_BASENAME}.${pid}.${deps.now().getTime()}.tmp`);
    const payload = JSON.stringify(clean);
    await deps.fs.writeFile(tmpPath, payload, { mode: 0o600 });
    await deps.fs.rename(tmpPath, cachePath);
  } catch {
    log('cache_write_failed', {});
    // Best-effort cleanup: a failed rename (e.g. EPERM on Windows while the
    // target is held open by a concurrent hook) must not leave .tmp files
    // accumulating in ~/.claude.
    if (tmpPath !== null && typeof deps.fs.unlink === 'function') {
      try {
        await deps.fs.unlink(tmpPath);
      } catch {
        // discard
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pause-state read / write / clear (v0.6.0, issue #5)
// ---------------------------------------------------------------------------

/**
 * Read + validate the pause-state file. Returns a clean { resetAtMs,
 * nextWakeupAtMs } object or null on any problem (missing, unparseable, invalid,
 * stale, poisoned). Throw-proof — mirrors readCache.
 */
async function readPauseState(deps) {
  try {
    const pausePath = joinPath(claudeDir(deps.homedir), PAUSE_BASENAME);
    const text = await deps.fs.readFile(pausePath, 'utf8');
    const parsed = JSON.parse(text);
    return validatePauseState(parsed, deps.now().getTime());
  } catch {
    return null;
  }
}

/**
 * Allowlist-serialize then atomic-write (temp + rename) the pause state at mode
 * 0o600. `clean` must already be a validatePauseState result. Throw-proof —
 * mirrors writeCache, including the Windows EPERM tmp-cleanup.
 */
async function writePauseState(deps, clean, log) {
  let tmpPath = null;
  try {
    const dir = claudeDir(deps.homedir);
    const pausePath = joinPath(dir, PAUSE_BASENAME);
    const pid = typeof deps.pid === 'number' ? deps.pid : 0;
    tmpPath = joinPath(dir, `${PAUSE_BASENAME}.${pid}.${deps.now().getTime()}.tmp`);
    // Serialize only the two validated numbers — never `raw`.
    const payload = JSON.stringify({
      resetAtMs: clean.resetAtMs,
      nextWakeupAtMs: clean.nextWakeupAtMs,
    });
    await deps.fs.writeFile(tmpPath, payload, { mode: 0o600 });
    await deps.fs.rename(tmpPath, pausePath);
    log('pause_scheduled', { nextWakeupAtMs: clean.nextWakeupAtMs });
  } catch {
    log('pause_write_failed', {});
    if (tmpPath !== null && typeof deps.fs.unlink === 'function') {
      try {
        await deps.fs.unlink(tmpPath);
      } catch {
        // discard
      }
    }
  }
}

/**
 * Remove the pause-state file. Called on the transitions OUT of a pause
 * (resume-ready, chain termination, recheck-cleared). Throw-proof; a missing
 * file (ENOENT) is a no-op.
 */
async function clearPauseState(deps, log) {
  try {
    if (typeof deps.fs.unlink !== 'function') return;
    const pausePath = joinPath(claudeDir(deps.homedir), PAUSE_BASENAME);
    await deps.fs.unlink(pausePath);
    log('pause_cleared', {});
  } catch {
    // discard — missing file or unlink failure is benign (validator expires it).
  }
}

// ---------------------------------------------------------------------------
// Network fetch
// ---------------------------------------------------------------------------

/**
 * Fetch usage from the frozen endpoint. Returns a validated clean cache object
 * on success, or null on any failure. Token is unwrapped ONLY here.
 */
async function fetchUsage(deps, tokenHolder, log) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await deps.fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: {
        // The ONLY place the raw token is unwrapped.
        Authorization: `Bearer ${tokenHolder.use()}`,
        'anthropic-beta': ANTHROPIC_BETA,
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
      // Defense-in-depth: never follow redirects — a 3xx must not cause the
      // Authorization header to be re-sent anywhere (even same-origin).
      redirect: 'error',
    });
    if (!res || res.status !== 200) {
      log('fetch_failed', { status: res && typeof res.status === 'number' ? res.status : 0 });
      return null;
    }
    const body = await res.json();
    const clean = serializeUsageResponse(body, deps.now());
    if (!clean) {
      log('fetch_failed', { status: 200 });
      return null;
    }
    log('fetch_ok', {});
    return clean;
  } catch {
    log('fetch_failed', { status: 0 });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a raw API response through the SAME allowlist validator used for the
 * cache, producing a clean cache object with a fresh fetchedAt and the
 * windows we recognize. Returns null if nothing usable.
 */
function serializeUsageResponse(body, now) {
  if (!isPlainObject(body)) return null;
  // validateCache is the single source of truth: it allowlists known window
  // keys, validates each present entry (rejecting the whole response on any
  // malformed present window), and ignores unknown keys.
  const nowMs = now.getTime();
  return validateCache({ fetchedAt: nowMs, failedAt: null, windows: body }, nowMs);
}

// ---------------------------------------------------------------------------
// Data acquisition orchestration
// ---------------------------------------------------------------------------

/**
 * Acquire usage data following the cache/negative-cache/fetch policy.
 * Returns a clean cache object or null. Fail-soft: any problem => returns the
 * best (possibly stale) valid cache we have, or null.
 *
 * `setProbe(raw)` is invoked with the raw token the instant it is read, so the
 * debug logger can refuse to emit any line containing it. The token is never
 * used for output anywhere in this function.
 */
async function acquireData(deps, cfg, log, setProbe, opts = {}) {
  const now = deps.now().getTime();
  const forceRefresh = opts.forceRefresh === true;
  const cached = await readCache(deps);

  // forceRefresh (manual `usage-guard recheck`) bypasses BOTH caches: the
  // user is explicitly asking us to re-measure their current login.
  if (!forceRefresh) {
    // Fresh positive cache.
    if (cached && cached.fetchedAt !== null && now - cached.fetchedAt < cfg.ttlMs) {
      log('cache_hit', {});
      return cached;
    }

    // Negative cache: recent failure => don't hit network (fail-soft).
    if (cached && cached.failedAt !== null && now - cached.failedAt < NEGATIVE_CACHE_MS) {
      log('negative_cache', {});
      return cached;
    }
  }

  if (forceRefresh) log('recheck', {});
  else if (cached) log('cache_stale', {});
  else log('cache_miss', {});

  // Acquire credentials (platform-aware).
  let raw = null;
  if (deps.platform === 'darwin') {
    raw = await readTokenFromKeychain(deps, log);
    if (!raw) raw = await readTokenFromFile(deps);
  } else {
    raw = await readTokenFromFile(deps);
  }
  if (!raw) {
    log('creds_missing', {});
    // On a manual recheck the user explicitly distrusts the cache, so stale
    // windows must not be resurrected when creds are unreadable — return null
    // (fail open) rather than the old account's data.
    return forceRefresh ? null : cached; // fail-soft: stale cache (maybe null)
  }
  setProbe(raw); // expose to logger guard only; never used for output
  const tokenHolder = makeTokenHolder(raw);

  const fetched = await fetchUsage(deps, tokenHolder, log);
  if (fetched) {
    await writeCache(deps, fetched, log);
    return fetched;
  }

  // Fetch failed => write a negative-cache marker. AUTO-HEAL: do NOT carry the
  // previous fetch's windows forward. Resurrecting them let an exhausted prior
  // account keep blocking a freshly-switched account indefinitely (each failed
  // fetch re-preserved the stale windows). fetchedAt is also cleared so the
  // marker never looks "fresh". The marker still suppresses re-fetching for
  // NEGATIVE_CACHE_MS via failedAt; it simply blocks nothing.
  const failNowMs = deps.now().getTime();
  const marker = {
    fetchedAt: null,
    failedAt: failNowMs,
    windows: {},
  };
  const cleanMarker = validateCache(marker, failNowMs);
  if (cleanMarker) await writeCache(deps, cleanMarker, log);
  return cleanMarker;
}

// ---------------------------------------------------------------------------
// stdin parsing
// ---------------------------------------------------------------------------

/**
 * Parse the hook input.
 *  - Empty/absent stdin => UserPromptSubmit (manual invoke).
 *  - Non-empty but unparseable => UnknownHookEvent: most likely a truncated
 *    hook payload (e.g. stdin cut off by the read-grace timeout). The original
 *    event is unknown and may have been PreToolUse, which must never produce
 *    stdout — so main() keeps unknown events silent while still enforcing the
 *    hard gate.
 */
export function parseHookInput(text) {
  if (typeof text !== 'string') {
    return { hook_event_name: 'UserPromptSubmit' };
  }
  // PowerShell pipes prepend a UTF-8 BOM — strip it so manual
  // invocation on Windows parses the same as a direct hook spawn.
  text = text.replace(/^﻿/, '');
  if (text.trim() === '') {
    return { hook_event_name: 'UserPromptSubmit' };
  }
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) return { hook_event_name: 'UserPromptSubmit' };
    if (typeof parsed.hook_event_name !== 'string') {
      parsed.hook_event_name = 'UserPromptSubmit';
    }
    return parsed;
  } catch {
    return { hook_event_name: 'UnknownHookEvent' };
  }
}

// ---------------------------------------------------------------------------
// main(deps)
// ---------------------------------------------------------------------------

/**
 * deps = {
 *   fetchImpl,
 *   fs (subset: readFile, writeFile, rename, unlink, appendFile [promises];
 *       appendFileSync [sync, optional — used for debug log so it survives exit]),
 *   execFileImpl, platform, env, stdin (async () => text),
 *   stdout (fn), stderr (fn), now (() => Date), homedir (() => string),
 *   pid (number, for unique tmp-file names), exit (code => void)
 * }
 */
export async function main(deps) {
  // Token probe shared with the logger (set once a token is read). We keep it
  // here so the debug logger can refuse lines containing the live token.
  let liveTokenProbe = null;

  try {
    const cfg = readConfig(deps.env);

    // The logger probes the live token (if any) to refuse lines containing it.
    const log = makeDebugLogger(deps, cfg, () => liveTokenProbe);

    if (cfg.off) {
      log('guard_off', {});
      deps.exit(0);
      return;
    }

    let inputText = '';
    try {
      inputText = await deps.stdin();
    } catch {
      inputText = '';
    }
    const input = parseHookInput(inputText);
    const eventName = input.hook_event_name;

    // -------------------------------------------------------------------------
    // SessionStart — one-time onboarding hint (never fetches, never exits 2).
    // -------------------------------------------------------------------------
    if (eventName === 'SessionStart') {
      try {
        if (!isConfigured(deps.env)) {
          const markerPath = joinPath(claudeDir(deps.homedir), ONBOARD_BASENAME);
          let onboarded = true;
          try { await deps.fs.readFile(markerPath, 'utf8'); }
          catch { onboarded = false; }
          if (!onboarded) {
            deps.stdout(buildOnboardingMessage(deps.platform) + '\n');
            log('onboarding', {});
            try { await deps.fs.writeFile(markerPath, 'v1\n', { mode: 0o600 }); }
            catch { /* discard — benign repeat next session */ }
          }
        }
      } catch { /* discard — fail-open */ }
      deps.exit(0);
      return;
    }

    // -------------------------------------------------------------------------
    // PreToolUse ScheduleWakeup — upgraded exemption with resume-marker stamping.
    // This branch MUST NEVER exit 2. Any deviation → plain exit 0.
    // -------------------------------------------------------------------------
    if (eventName === 'PreToolUse' && input.tool_name === 'ScheduleWakeup') {
      try {
        // Determine block state from cache ONLY — no fetch on this path.
        const cachedData = await readCache(deps);
        if (cachedData) {
          const wakeupWindows = parseWindows(cachedData, deps.now());
          const { worst: wakeupWorst, level: wakeupLevel } = evaluateThresholds(wakeupWindows, cfg);
          // The delay we both tell the harness (updatedInput.delaySeconds) AND
          // record in the latch — one identical value, clamped to the harness's
          // [60,3600] ScheduleWakeup limits, so the recorded nextWakeupAtMs always
          // matches the wakeup the harness will actually fire (no drift between
          // the stamp and the latch). null when no finite delay was supplied.
          const rawDelay =
            isPlainObject(input.tool_input) &&
            typeof input.tool_input.delaySeconds === 'number' &&
            Number.isFinite(input.tool_input.delaySeconds)
              ? input.tool_input.delaySeconds
              : null;
          const stampDelaySec = rawDelay !== null ? clamp(Math.round(rawDelay), 60, 3600) : null;
          if (
            wakeupLevel === 'hard' &&
            wakeupWorst &&
            isPlainObject(input.tool_input) &&
            typeof input.tool_input.prompt === 'string'
          ) {
            const originalPrompt = input.tool_input.prompt;
            // Never stamp sentinels or already-marked prompts.
            if (
              !originalPrompt.startsWith(RESUME_MARKER) &&
              !AUTONOMOUS_SENTINELS.has(originalPrompt)
            ) {
              // Build updatedInput from allowlist only.
              const updatedInput = {};
              if (stampDelaySec !== null) {
                updatedInput.delaySeconds = stampDelaySec;
              }
              updatedInput.prompt = RESUME_MARKER + ' ' + originalPrompt;
              if (typeof input.tool_input.reason === 'string') {
                updatedInput.reason = input.tool_input.reason;
              }
              const jsonOutput = JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'allow',
                  permissionDecisionReason: 'usage-guard: tagged wakeup as quota resume hop',
                  updatedInput,
                },
              });
              deps.stdout(jsonOutput + '\n');
              log('wakeup_marked', { label: wakeupWorst.label, util: wakeupWorst.util });
            }
          }

          // Latch: record that a wakeup is now pending so LATER non-resume
          // re-drives (e.g. a /goal Stop-hook loop) are told to WAIT instead of
          // stacking another wakeup. Authoritative — this is the one place we
          // KNOW a wakeup is being scheduled. fs-only (never stdout), inside the
          // try, throw-proof. Only within the 6h resume horizon; beyond it the
          // resume chain terminates rather than sleeps, so a latch is moot.
          // This shrinks the loop, it does not eliminate it: a re-drive that
          // reads the file in the brief window before this rename lands still
          // sees no latch and may invite one more wakeup (the fix is best-effort
          // de-duplication, not a hard lock — a hook cannot stop /goal anyway).
          if (
            wakeupLevel === 'hard' &&
            wakeupWorst &&
            isPlainObject(input.tool_input) &&
            wakeupWorst.reset.getTime() - deps.now().getTime() <= SIX_HOURS_MS
          ) {
            // Same value the stamp put into updatedInput.delaySeconds, so the
            // latch and the actual wakeup never diverge. Fall back to the
            // recommended hop delay when none was supplied.
            const delaySec =
              stampDelaySec !== null
                ? stampDelaySec
                : computeHopDelaySeconds(wakeupWorst, deps.now());
            const nowMs = deps.now().getTime();
            const pauseClean = validatePauseState(
              {
                resetAtMs: wakeupWorst.reset.getTime(),
                nextWakeupAtMs: nowMs + delaySec * 1000,
              },
              nowMs,
            );
            if (pauseClean) await writePauseState(deps, pauseClean, log);
          }
        }
      } catch {
        // Any deviation → plain exit 0 with no output. The single JSON line is
        // fully built before the one deps.stdout() call, so a throw either
        // precedes the write (nothing is emitted) or follows it (a complete,
        // valid line is already out). Either way we fall through to exit 0 and
        // can never exit 2 — a blocked model must never be trapped here.
      }
      deps.exit(0);
      return;
    }

    // A manual `usage-guard recheck` prompt forces a fresh fetch that bypasses
    // all cache (positive + negative) — see acquireData forceRefresh.
    const recheck = isRecheckPrompt(input);

    // acquireData exposes the live raw token to the logger probe (for the
    // defense-in-depth line refusal) the instant it is read. The token is
    // never placed into output anywhere.
    const data = await acquireData(
      deps,
      cfg,
      log,
      (raw) => {
        liveTokenProbe = raw;
      },
      { forceRefresh: recheck },
    );

    // Pass `now` so windows whose reset already passed are dropped — stale
    // data must never block past the actual reset.
    const windows = parseWindows(data, deps.now());
    const { worst, level } = evaluateThresholds(windows, cfg);

    if (eventName === 'PreToolUse') {
      if (level === 'hard' && worst) {
        const isSubagent = typeof input.agent_id === 'string' && input.agent_id.length > 0;
        // Latch: if a wakeup is already pending, do NOT invite another — tell the
        // model to stand down (breaks the degenerate re-hop loop). Sub-agents
        // cannot ScheduleWakeup, so the WAIT path does not apply to them; they
        // keep the existing return-a-resume-brief instruction.
        if (!isSubagent) {
          const pause = await readPauseState(deps);
          if (decidePauseAction(pause, deps.now()) === 'wait') {
            log('pause_wait', { label: worst.label, util: worst.util });
            deps.stderr(buildPauseWaitMessage(worst, pause.nextWakeupAtMs) + '\n');
            deps.exit(2);
            return;
          }
        }
        log('blocked', { label: worst.label, util: worst.util });
        deps.stderr(buildToolBlockMessage(worst, deps.now(), isSubagent) + '\n');
        deps.exit(2);
        return;
      }
      // else: no stdout for PreToolUse (hook contract).
      log(level === 'warn' ? 'warn' : 'ok', {});
      deps.exit(0);
      return;
    }

    // -------------------------------------------------------------------------
    // UserPromptSubmit (and any other / manual event).
    // -------------------------------------------------------------------------

    // Manual recheck: report the FRESH result honestly. A still-hard result
    // confirms the current login is genuinely over the limit (blocks); anything
    // else clears the block. The recheck command does no real work, so this
    // cannot smuggle a task past the gate.
    if (recheck) {
      if (level === 'hard' && worst) {
        log('recheck_blocked', { label: worst.label, util: worst.util });
        deps.stderr(buildRecheckBlockMessage(worst, cfg) + '\n');
        deps.exit(2);
        return;
      }
      // Recheck cleared the block (or is unreadable) → drop any pending pause
      // latch so a future pause starts clean.
      await clearPauseState(deps, log);
      if (windows.length === 0) {
        deps.stdout(buildRecheckUnreadableMessage() + '\n');
        log('ok', {});
        deps.exit(0);
        return;
      }
      log(level === 'warn' ? 'warn' : 'ok', {});
      deps.stdout(buildUsageLine(windows, level, worst) + buildRecheckClearedSuffix() + '\n');
      deps.exit(0);
      return;
    }

    if (level === 'hard' && worst) {
      // Resume hops are CARVED OUT of the pause latch: a fired resume-hop prompt
      // is proof the wakeup fired, so always re-evaluate fresh — never WAIT it
      // (else a buffer-early wakeup would be strangled and the chain would die).
      if (isResumeHopPrompt(input)) {
        // Resume hop: still blocked. Determine time-to-reset.
        const msToReset = worst.reset.getTime() - deps.now().getTime();
        log('resume_hop', { label: worst.label, util: worst.util });
        if (msToReset <= SIX_HOURS_MS) {
          // Within 6h: re-instruct a single reschedule.
          const line = formatSummary(windows) + buildResumeHopSuffix(worst, deps.now());
          deps.stdout(line + '\n');
          deps.exit(0);
          return;
        } else {
          // Beyond 6h: chain-termination, no reschedule — drop the pending latch.
          await clearPauseState(deps, log);
          const line = formatSummary(windows) + buildResumeTerminationSuffix(worst);
          deps.stdout(line + '\n');
          deps.exit(0);
          return;
        }
      }
      // Normal hard block (no marker). If a wakeup is already pending, stand down
      // instead of inviting another — this is what breaks the degenerate re-hop
      // loop driven by a /goal-style continuation.
      const pause = await readPauseState(deps);
      if (decidePauseAction(pause, deps.now()) === 'wait') {
        log('pause_wait', { label: worst.label, util: worst.util });
        deps.stderr(buildPauseWaitMessage(worst, pause.nextWakeupAtMs) + '\n');
        deps.exit(2);
        return;
      }
      log('blocked', { label: worst.label, util: worst.util });
      deps.stderr(buildPromptBlockMessage(worst, cfg) + '\n');
      deps.exit(2);
      return;
    }

    // Past the hard block → not hard-blocked right now. A resume-hop prompt that
    // reaches here means the window reset and the pause is genuinely over — clear
    // the latch so the next pause starts clean. A normal (non-resume) prompt is
    // deliberately NOT cleared here: the latch is self-GC'ing — validatePauseState
    // treats a latch whose resetAtMs has passed as absent (so a stale latch can
    // never cause a spurious WAIT), and the next pause overwrites it. That keeps
    // an unlink syscall off the hot path of every ordinary prompt.
    if (isResumeHopPrompt(input)) {
      await clearPauseState(deps, log);
    }

    if (windows.length === 0 || eventName !== 'UserPromptSubmit') {
      // Nothing to report, or an unknown/truncated event. Unknown events may
      // have been PreToolUse, whose contract forbids stdout — stay silent.
      log(level === 'warn' ? 'warn' : 'ok', {});
      deps.exit(0);
      return;
    }

    log(level === 'warn' ? 'warn' : 'ok', {});
    let line = buildUsageLine(windows, level, worst);

    // If this is a resume-hop prompt but the window has since reset (or util
    // fell below hard), append the ready suffix so the model resumes the task.
    if (isResumeHopPrompt(input)) {
      line += buildResumeReadySuffix();
    }

    deps.stdout(line + '\n');
    deps.exit(0);
  } catch {
    // Fail-soft / fail-open: never stringify the caught error.
    try {
      deps.exit(0);
    } catch {
      // last resort: nothing
    }
  }
}

// ---------------------------------------------------------------------------
// Real entry point — only runs when executed directly.
// ---------------------------------------------------------------------------

/**
 * True only when this file is the process entry point (run directly), false
 * when imported. Compares the resolved path of import.meta.url against argv[1].
 * Importing the module in tests must execute nothing.
 *
 * Two traps the naive string compare falls into, both of which would silently
 * disable the guard (fail-open hides the breakage):
 *  - ESM resolves the entry point through symlinks (import.meta.url is the
 *    realpath) while argv[1] keeps the symlink path — e.g. a symlinked plugin
 *    install. Realpath both sides before comparing.
 *  - Windows paths are case-insensitive (c:\ vs C:\) — case-fold on win32.
 * The realpath call only happens when the cheap compare already failed AND the
 * candidate entry has our basename, so importing this module stays I/O-free.
 */
function runningDirectly() {
  try {
    if (!process.argv[1]) return false;
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const self = fileURLToPath(import.meta.url);
    const entry = resolve(process.argv[1]);
    if (norm(self) === norm(entry)) return true;
    if (!norm(entry).endsWith('usage-guard.mjs')) return false;
    return norm(realpathSync(entry)) === norm(realpathSync(self));
  } catch {
    return false;
  }
}

async function buildRealDeps() {
  const fsp = await import('node:fs/promises');
  const fsSync = await import('node:fs');
  const os = await import('node:os');
  const cp = await import('node:child_process');

  const readStdin = () =>
    new Promise((resolve) => {
      let data = '';
      try {
        if (process.stdin.isTTY) {
          resolve('');
          return;
        }
        process.stdin.setEncoding('utf8');
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          resolve(data);
        };
        process.stdin.on('data', (chunk) => {
          data += chunk;
        });
        process.stdin.on('end', finish);
        process.stdin.on('error', () => {
          if (!resolved) {
            resolved = true;
            resolve('');
          }
        });
        // Guard against a hung stdin: resolve after a short grace window.
        setTimeout(finish, 2000).unref?.();
      } catch {
        resolve('');
      }
    });

  return {
    fetchImpl: (...a) => fetch(...a),
    fs: {
      readFile: fsp.readFile,
      writeFile: fsp.writeFile,
      rename: fsp.rename,
      unlink: fsp.unlink,
      appendFile: fsp.appendFile,
      appendFileSync: fsSync.appendFileSync,
    },
    execFileImpl: cp.execFile,
    platform: process.platform,
    env: process.env,
    stdin: readStdin,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    now: () => new Date(),
    homedir: () => os.homedir(),
    pid: process.pid,
    exit: (code) => process.exit(code),
  };
}

if (runningDirectly()) {
  buildRealDeps()
    .then((deps) => main(deps))
    .catch(() => {
      try {
        process.exit(0);
      } catch {
        // noop
      }
    });
}
