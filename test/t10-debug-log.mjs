/**
 * T10 — Debug-log allowlist
 *
 * With debug mode enabled, parse every debug log line as JSON and assert:
 *  - Each line has {ts (ISO string), event (string from known allowlist)}
 *  - Every field value is a primitive (string, number, boolean)
 *  - No line contains the sentinel token
 *  - No line has a field value that is an object, array, or undefined
 *  - Only allowlisted event codes appear
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCacheJson,
  makeNegativeCacheJson,
  makeCredsJson,
  CACHE_PATH,
  CREDS_PATH,
  CLAUDE_DIR,
  DEBUG_LOG_PATH,
  FIXED_NOW_MS,
  RESET_IN_3H,
  SENTINEL_TOKEN,
} from './helpers.mjs';

// Known-allowlisted event codes from the source.
const ALLOWED_EVENTS = new Set([
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

const UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit' });
const DEBUG_ENV = {
  CLAUDE_USAGE_GUARD_WARN: '80',
  CLAUDE_USAGE_GUARD_HARD: '95',
  CLAUDE_USAGE_GUARD_TTL: '3600',
  CLAUDE_USAGE_GUARD_DEBUG: '1',
};

// ---------------------------------------------------------------------------
// Helper: collect debug log lines and validate each one
// ---------------------------------------------------------------------------

function collectDebugLines(fakeFs) {
  const raw = fakeFs._peek(DEBUG_LOG_PATH) ?? '';
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function assertDebugLineValid(line, label = '') {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    assert.fail(`${label} debug log line is not valid JSON: "${line}"`);
  }

  // Must have ts (ISO string).
  assert.ok(typeof parsed.ts === 'string', `${label} ts must be a string: ${line}`);
  assert.ok(!Number.isNaN(new Date(parsed.ts).getTime()),
    `${label} ts must be a valid ISO date: ${parsed.ts}`);

  // Must have event from allowlist.
  assert.ok(typeof parsed.event === 'string', `${label} event must be a string: ${line}`);
  assert.ok(ALLOWED_EVENTS.has(parsed.event),
    `${label} event "${parsed.event}" not in allowlist`);

  // Every value must be a safe primitive.
  for (const [key, value] of Object.entries(parsed)) {
    const type = typeof value;
    assert.ok(
      type === 'string' || type === 'number' || type === 'boolean',
      `${label} field "${key}" must be a primitive, got ${type}: ${JSON.stringify(value)}`
    );
    if (type === 'number') {
      assert.ok(Number.isFinite(value),
        `${label} field "${key}" must be a finite number, got ${value}`);
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// T10.1 — cache_hit path
// ---------------------------------------------------------------------------

describe('T10 — Debug-log allowlist', () => {
  it('T10.1 cache_hit path: debug log has {ts, event:"cache_hit"} with valid primitives', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 30, resets_at: RESET_IN_3H },
    });

    const { deps, fakeFs, exits } = makeDeps({
      env: DEBUG_ENV,
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    const lines = collectDebugLines(fakeFs);
    assert.ok(lines.length >= 1, 'should have debug log lines');

    for (const line of lines) {
      assertDebugLineValid(line, 'T10.1:');
    }

    const events = lines.map((l) => JSON.parse(l).event);
    assert.ok(events.includes('cache_hit'), `expected cache_hit event, got: ${events}`);
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T10.2 — cache_miss + fetch_ok path
  // -------------------------------------------------------------------------
  it('T10.2 cache_miss+fetch_ok path: debug log events are valid and from allowlist', async () => {
    const { deps, fakeFs, exits } = makeDeps({
      env: { ...DEBUG_ENV, CLAUDE_USAGE_GUARD_TTL: '0' }, // always stale
      stdin: async () => UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return { five_hour: { utilization: 30, resets_at: RESET_IN_3H } };
        },
      }),
    });

    await main(deps);

    const lines = collectDebugLines(fakeFs);
    assert.ok(lines.length >= 1);

    for (const line of lines) {
      assertDebugLineValid(line, 'T10.2:');
    }

    const events = lines.map((l) => JSON.parse(l).event);
    // Should have cache_miss and fetch_ok.
    assert.ok(events.includes('cache_miss'), `expected cache_miss, got: ${events}`);
    assert.ok(events.includes('fetch_ok'), `expected fetch_ok, got: ${events}`);
  });

  // -------------------------------------------------------------------------
  // T10.3 — negative_cache path
  // -------------------------------------------------------------------------
  it('T10.3 negative_cache path: debug log has negative_cache event', async () => {
    const failedAt = FIXED_NOW_MS - 60_000; // 1 min ago
    const cache = makeNegativeCacheJson(failedAt, null, {});

    const { deps, fakeFs, exits } = makeDeps({
      env: DEBUG_ENV,
      stdin: async () => UPS,
      initialFs: { [CACHE_PATH]: cache },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    const lines = collectDebugLines(fakeFs);
    for (const line of lines) {
      assertDebugLineValid(line, 'T10.3:');
    }

    const events = lines.map((l) => JSON.parse(l).event);
    assert.ok(events.includes('negative_cache'), `expected negative_cache, got: ${events}`);
  });

  // -------------------------------------------------------------------------
  // T10.4 — creds_missing path
  // -------------------------------------------------------------------------
  it('T10.4 creds_missing path: debug log has creds_missing event', async () => {
    const { deps, fakeFs } = makeDeps({
      env: { ...DEBUG_ENV, CLAUDE_USAGE_GUARD_TTL: '0' },
      stdin: async () => UPS,
      initialFs: {}, // No creds.
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    const lines = collectDebugLines(fakeFs);
    for (const line of lines) {
      assertDebugLineValid(line, 'T10.4:');
    }

    const events = lines.map((l) => JSON.parse(l).event);
    assert.ok(events.includes('creds_missing'), `expected creds_missing, got: ${events}`);
  });

  // -------------------------------------------------------------------------
  // T10.5 — guard_off path
  // -------------------------------------------------------------------------
  it('T10.5 guard_off path: debug log has guard_off event', async () => {
    const { deps, fakeFs } = makeDeps({
      env: { CLAUDE_USAGE_GUARD: 'off', CLAUDE_USAGE_GUARD_DEBUG: '1' },
      stdin: async () => UPS,
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    const lines = collectDebugLines(fakeFs);
    for (const line of lines) {
      assertDebugLineValid(line, 'T10.5:');
    }

    const events = lines.map((l) => JSON.parse(l).event);
    assert.ok(events.includes('guard_off'), `expected guard_off, got: ${events}`);
  });

  // -------------------------------------------------------------------------
  // T10.6 — blocked path (HARD level)
  // -------------------------------------------------------------------------
  it('T10.6 blocked path: debug log has "blocked" event with primitive fields only', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 99, resets_at: RESET_IN_3H },
    });

    const { deps, fakeFs, exits } = makeDeps({
      env: DEBUG_ENV,
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    const lines = collectDebugLines(fakeFs);
    for (const line of lines) {
      const entry = assertDebugLineValid(line, 'T10.6:');
      if (entry.event === 'blocked') {
        // 'blocked' carries label and util — both must be primitives.
        if ('label' in entry) {
          assert.equal(typeof entry.label, 'string');
        }
        if ('util' in entry) {
          assert.equal(typeof entry.util, 'number');
          assert.ok(Number.isFinite(entry.util));
        }
      }
    }

    const events = lines.map((l) => JSON.parse(l).event);
    assert.ok(events.includes('blocked'), `expected blocked, got: ${events}`);
    assert.equal(exits[0], 2);
  });

  // -------------------------------------------------------------------------
  // T10.7 — fetch_failed path
  // -------------------------------------------------------------------------
  it('T10.7 fetch_failed path: debug log has fetch_failed event', async () => {
    const { deps, fakeFs, exits } = makeDeps({
      env: { ...DEBUG_ENV, CLAUDE_USAGE_GUARD_TTL: '0' },
      stdin: async () => UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({ status: 429, async json() { return {}; } }),
    });

    await main(deps);

    const lines = collectDebugLines(fakeFs);
    for (const line of lines) {
      assertDebugLineValid(line, 'T10.7:');
    }

    const events = lines.map((l) => JSON.parse(l).event);
    assert.ok(events.includes('fetch_failed'), `expected fetch_failed, got: ${events}`);
  });

  // -------------------------------------------------------------------------
  // T10.8 — sentinel token never appears in debug log
  // -------------------------------------------------------------------------
  it('T10.8 sentinel token never appears in any debug log line', async () => {
    const { deps, fakeFs, exits } = makeDeps({
      env: { ...DEBUG_ENV, CLAUDE_USAGE_GUARD_TTL: '0' },
      stdin: async () => UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson(SENTINEL_TOKEN) },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return { five_hour: { utilization: 30, resets_at: RESET_IN_3H } };
        },
      }),
    });

    await main(deps);

    const debugContent = fakeFs._peek(DEBUG_LOG_PATH) ?? '';
    assert.ok(!debugContent.includes(SENTINEL_TOKEN),
      'sentinel token must never appear in debug log');
  });

  // -------------------------------------------------------------------------
  // T10.9 — debug mode OFF: no debug log written
  // -------------------------------------------------------------------------
  it('T10.9 debug mode OFF: no debug log file written', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 30, resets_at: RESET_IN_3H },
    });

    const { deps, fakeFs, exits } = makeDeps({
      env: {
        CLAUDE_USAGE_GUARD_WARN: '80',
        CLAUDE_USAGE_GUARD_HARD: '95',
        CLAUDE_USAGE_GUARD_TTL: '3600',
        // CLAUDE_USAGE_GUARD_DEBUG not set
      },
      stdin: async () => UPS,
      initialFs: { [CACHE_PATH]: cache },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    const debugContent = fakeFs._peek(DEBUG_LOG_PATH);
    // Either not written or empty.
    assert.ok(!debugContent, 'debug log must not be written when debug mode is off');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T10.10 — warn path
  // -------------------------------------------------------------------------
  it('T10.10 warn path: debug log has "warn" event', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 80, resets_at: RESET_IN_3H }, // exactly at WARN
    });

    const { deps, fakeFs, exits } = makeDeps({
      env: DEBUG_ENV,
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    const lines = collectDebugLines(fakeFs);
    for (const line of lines) {
      assertDebugLineValid(line, 'T10.10:');
    }

    const events = lines.map((l) => JSON.parse(l).event);
    assert.ok(events.includes('warn'), `expected warn event, got: ${events}`);
    assert.equal(exits[0], 0);
  });
});
