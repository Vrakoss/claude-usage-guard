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
//
// TESTABILITY: all I/O is injected through `main(deps)`. Pure helpers are
// exported. Importing this module performs no I/O and exits nothing.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

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
const DEFAULT_TTL_S = 60;

const CACHE_BASENAME = 'usage-guard-cache.json';
const DEBUG_BASENAME = 'usage-guard-debug.log';
const CREDS_BASENAME = '.credentials.json';

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
]);

const REDACTED = '[redacted]';

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

  let ttl = readIntEnv(env, 'CLAUDE_USAGE_GUARD_TTL', DEFAULT_TTL_S);
  if (!Number.isFinite(ttl) || ttl < 0) ttl = DEFAULT_TTL_S;

  return { off, debug, warn, hard, ttlMs: ttl * 1000 };
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
 * Returns a freshly-built clean object: { fetchedAt, failedAt, windows }.
 * `raw` is never trusted for output.
 */
export function validateCache(raw) {
  if (!isPlainObject(raw)) return null;

  const fetchedAt =
    typeof raw.fetchedAt === 'number' && Number.isFinite(raw.fetchedAt)
      ? raw.fetchedAt
      : null;
  const failedAt =
    typeof raw.failedAt === 'number' && Number.isFinite(raw.failedAt)
      ? raw.failedAt
      : null;

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
 * Evaluate windows against config. Returns:
 *   { worst: window|null, level: 'ok'|'warn'|'hard' }
 * `worst` is the window with the highest utilization.
 */
export function evaluateThresholds(windows, cfg) {
  if (!windows || windows.length === 0) {
    return { worst: null, level: 'ok' };
  }
  let worst = windows[0];
  for (const w of windows) {
    if (w.util > worst.util) worst = w;
  }
  let level = 'ok';
  if (worst.util >= cfg.hard) level = 'hard';
  else if (worst.util >= cfg.warn) level = 'warn';
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

// ---------------------------------------------------------------------------
// Block / warn messages
// ---------------------------------------------------------------------------

/** UserPromptSubmit HARD block message (stderr). */
export function buildPromptBlockMessage(worst, cfg) {
  return (
    `QUOTA GUARD: ${worst.label} window at ${worst.util}% (limit ${cfg.hard}%). ` +
    `Prompts blocked until reset at ${fmtWeekdayDateTime(worst.reset)} local. ` +
    `Bypass: set CLAUDE_USAGE_GUARD=off.`
  );
}

/** UserPromptSubmit WARN suffix appended to the summary line (stdout). */
export function buildWarnSuffix(worst) {
  return (
    ` -- WIND DOWN: ${worst.label} window at ${worst.util}%. ` +
    `Finish current work; do NOT start new large tasks, agent fan-outs, or workflows. ` +
    `Prefer ScheduleWakeup past ${fmtTime(worst.reset)} in loops.`
  );
}

/**
 * PreToolUse HARD block message (stderr). Behavior depends on time-to-reset.
 * `now` is a Date.
 */
export function buildToolBlockMessage(worst, now) {
  const msToReset = worst.reset.getTime() - now.getTime();
  const sixHoursMs = 6 * 60 * 60 * 1000;
  if (msToReset <= sixHoursMs) {
    return (
      `QUOTA GUARD: ${worst.label} window at ${worst.util}%. ` +
      `Execution paused until reset at ${fmtTime(worst.reset)}. ` +
      `Call ScheduleWakeup with delaySeconds until then ` +
      `(chain 3600s wakeups if needed; ScheduleWakeup is exempt from this gate). ` +
      `After reset, resume the task. Do not retry other tools before reset.`
    );
  }
  return (
    `QUOTA GUARD: ${worst.label} window at ${worst.util}%. ` +
    `Resets ${fmtWeekdayDateTime(worst.reset)}. ` +
    `Wrap up: summarize state for the user and end the turn. Do not retry tools.`
  );
}

/**
 * Generic block-message dispatcher used by callers/tests.
 * eventName decides which message family to build.
 */
export function buildBlockMessage(worst, cfg, now, eventName) {
  if (eventName === 'PreToolUse') return buildToolBlockMessage(worst, now);
  return buildPromptBlockMessage(worst, cfg);
}

// ---------------------------------------------------------------------------
// Token redaction helper (defense-in-depth for logs)
// ---------------------------------------------------------------------------

/**
 * Always returns the redaction sentinel. Used so that any accidental attempt to
 * stringify a token value through this helper yields '[redacted]' regardless of
 * input. Never returns the original value.
 */
export function redactedToken(_value) {
  return REDACTED;
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
      const tok = tokenProbe ? tokenProbe() : null;
      if (tok && line.includes(tok)) return;
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
 * Read access token from the credentials file. Returns raw string or null.
 * Reads ONLY `.claudeAiOauth.accessToken`. The refresh credential on the same
 * record is never accessed.
 */
async function readTokenFromFile(deps) {
  try {
    const credsPath = joinPath(claudeDir(deps.homedir), CREDS_BASENAME);
    const text = await deps.fs.readFile(credsPath, 'utf8');
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.claudeAiOauth)) return null;
    const token = parsed.claudeAiOauth.accessToken;
    if (typeof token !== 'string' || token.length === 0) return null;
    return token;
  } catch {
    return null;
  }
}

/**
 * darwin: read token from Keychain via `security`. 3s timeout + kill.
 * Any error/timeout/empty => null (caller falls back to file).
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
        'security',
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
          done(out.length > 0 ? out : null);
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
    return validateCache(parsed);
  } catch {
    return null;
  }
}

/**
 * Allowlist-serialize then atomic-write (temp + rename) at mode 0o600.
 * `clean` must already be a validated object.
 */
async function writeCache(deps, clean, log) {
  try {
    const dir = claudeDir(deps.homedir);
    const cachePath = joinPath(dir, CACHE_BASENAME);
    // pid in the tmp name: UserPromptSubmit and PreToolUse hooks can run
    // concurrently in separate processes within the same millisecond.
    const pid = typeof deps.pid === 'number' ? deps.pid : 0;
    const tmpPath = joinPath(dir, `${CACHE_BASENAME}.${pid}.${deps.now().getTime()}.tmp`);
    const payload = JSON.stringify(clean);
    await deps.fs.writeFile(tmpPath, payload, { mode: 0o600 });
    await deps.fs.rename(tmpPath, cachePath);
  } catch {
    log('cache_write_failed', {});
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
  return validateCache({ fetchedAt: now.getTime(), failedAt: null, windows: body });
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
async function acquireData(deps, cfg, log, setProbe) {
  const now = deps.now().getTime();
  const cached = await readCache(deps);

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

  if (cached) log('cache_stale', {});
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
    return cached; // fail-soft: whatever stale cache we had (maybe null)
  }
  setProbe(raw); // expose to logger guard only; never used for output
  const tokenHolder = makeTokenHolder(raw);

  const fetched = await fetchUsage(deps, tokenHolder, log);
  if (fetched) {
    await writeCache(deps, fetched, log);
    return fetched;
  }

  // Fetch failed => write a negative-cache marker (preserving stale windows).
  const marker = {
    fetchedAt: cached && cached.fetchedAt !== null ? cached.fetchedAt : null,
    failedAt: deps.now().getTime(),
    windows: cached && cached.windows ? cached.windows : {},
  };
  const cleanMarker = validateCache(marker);
  if (cleanMarker) await writeCache(deps, cleanMarker, log);
  return cleanMarker;
}

// ---------------------------------------------------------------------------
// stdin parsing
// ---------------------------------------------------------------------------

/**
 * Parse the hook input. Empty/malformed => UserPromptSubmit (manual invoke).
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
    return { hook_event_name: 'UserPromptSubmit' };
  }
}

// ---------------------------------------------------------------------------
// main(deps)
// ---------------------------------------------------------------------------

/**
 * deps = {
 *   fetchImpl,
 *   fs (subset: readFile, writeFile, rename, appendFile [promises];
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

    // PreToolUse ScheduleWakeup exemption (so the model can sleep through reset).
    if (eventName === 'PreToolUse' && input.tool_name === 'ScheduleWakeup') {
      deps.exit(0);
      return;
    }

    // acquireData exposes the live raw token to the logger probe (for the
    // defense-in-depth line refusal) the instant it is read. The token is
    // never placed into output anywhere.
    const data = await acquireData(deps, cfg, log, (raw) => {
      liveTokenProbe = raw;
    });

    // Pass `now` so windows whose reset already passed are dropped — stale
    // data must never block past the actual reset.
    const windows = parseWindows(data, deps.now());
    const { worst, level } = evaluateThresholds(windows, cfg);

    if (eventName === 'PreToolUse') {
      if (level === 'hard' && worst) {
        log('blocked', { label: worst.label, util: worst.util });
        deps.stderr(buildToolBlockMessage(worst, deps.now()) + '\n');
        deps.exit(2);
        return;
      }
      // else: no stdout for PreToolUse (hook contract).
      log(level === 'warn' ? 'warn' : 'ok', {});
      deps.exit(0);
      return;
    }

    // UserPromptSubmit (and any other / manual event).
    if (level === 'hard' && worst) {
      log('blocked', { label: worst.label, util: worst.util });
      deps.stderr(buildPromptBlockMessage(worst, cfg) + '\n');
      deps.exit(2);
      return;
    }

    if (windows.length === 0) {
      // Nothing to report; fail-soft silent.
      log('ok', {});
      deps.exit(0);
      return;
    }

    let line = formatSummary(windows);
    if (level === 'warn' && worst) {
      line += buildWarnSuffix(worst);
      log('warn', {});
    } else {
      log('ok', {});
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
 */
function runningDirectly() {
  try {
    if (!process.argv[1]) return false;
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
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
