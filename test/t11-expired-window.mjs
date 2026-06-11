/**
 * T11 — Expired-window handling & English date formatting
 *
 * A window whose resets_at is already in the past carries stale utilization
 * (the window has reset server-side). It must never drive a warn/block and
 * must not appear in the summary. Regression guard for the scenario:
 * stale HARD-level cache + unreachable credentials => without expiry
 * filtering, prompts would be blocked indefinitely past the actual reset.
 *
 * Also asserts the fixed-English date format (weekday/month abbreviations),
 * timezone-safely (no exact weekday/day asserted, only month + shape).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindows, main } from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCacheJson,
  makeCredsJson,
  CACHE_PATH,
  CREDS_PATH,
  FIXED_NOW_MS,
  RESET_IN_3H,
  RESET_IN_8H,
  RESET_PAST,
} from './helpers.mjs';

const UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit' });
const PTU = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });

const ENV = {
  CLAUDE_USAGE_GUARD_WARN: '80',
  CLAUDE_USAGE_GUARD_HARD: '95',
  CLAUDE_USAGE_GUARD_TTL: '3600',
};

// ---------------------------------------------------------------------------
// parseWindows unit tests
// ---------------------------------------------------------------------------

describe('T11 — parseWindows expiry filtering (pure function)', () => {
  it('T11.1 with `now`, windows whose reset <= now are dropped', () => {
    const data = {
      windows: {
        five_hour: { utilization: 99, resets_at: RESET_PAST },
        seven_day: { utilization: 30, resets_at: RESET_IN_8H },
      },
    };
    const result = parseWindows(data, new Date(FIXED_NOW_MS));
    assert.equal(result.length, 1);
    assert.equal(result[0].label, '7d');
  });

  it('T11.2 reset exactly == now is treated as expired (dropped)', () => {
    const data = {
      windows: {
        five_hour: { utilization: 99, resets_at: new Date(FIXED_NOW_MS).toISOString() },
      },
    };
    const result = parseWindows(data, new Date(FIXED_NOW_MS));
    assert.equal(result.length, 0);
  });

  it('T11.3 without `now`, no expiry filtering happens (backward compat)', () => {
    const data = {
      windows: {
        five_hour: { utilization: 99, resets_at: RESET_PAST },
      },
    };
    const result = parseWindows(data);
    assert.equal(result.length, 1);
  });

  it('T11.4 all windows expired => empty list', () => {
    const data = {
      windows: {
        five_hour: { utilization: 99, resets_at: RESET_PAST },
        seven_day: { utilization: 97, resets_at: RESET_PAST },
      },
    };
    const result = parseWindows(data, new Date(FIXED_NOW_MS));
    assert.equal(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Integration: stale HARD cache must not block past its reset
// ---------------------------------------------------------------------------

describe('T11 — Expired windows never block (integration via main)', () => {
  // The regression scenario: cache is stale, window shows 99% but its reset
  // already passed, and credentials are unreachable (fail-soft returns the
  // stale cache). Must NOT block.
  it('T11.5 stale 99% cache with past reset + missing creds → exit 0, no block', async () => {
    const staleFetchedAt = FIXED_NOW_MS - 24 * 60 * 60 * 1000; // 1 day old
    const cache = makeCacheJson(staleFetchedAt, {
      five_hour: { utilization: 99, resets_at: RESET_PAST },
    });

    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      initialFs: { [CACHE_PATH]: cache }, // no CREDS_PATH => creds_missing
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'expired window must not block');
    assert.equal(stderr.length, 0, 'no block message');
    assert.equal(stdout.length, 0, 'expired window dropped => nothing to report');
  });

  it('T11.6 same scenario on PreToolUse → exit 0, tool allowed', async () => {
    const staleFetchedAt = FIXED_NOW_MS - 24 * 60 * 60 * 1000;
    const cache = makeCacheJson(staleFetchedAt, {
      five_hour: { utilization: 99, resets_at: RESET_PAST },
    });

    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => PTU,
      initialFs: { [CACHE_PATH]: cache },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stderr.length, 0);
    assert.equal(stdout.length, 0);
  });

  it('T11.7 expired 99% window + active 30% window → summary shows only active, no block', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 99, resets_at: RESET_PAST },
      seven_day: { utilization: 30, resets_at: RESET_IN_8H },
    });

    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stderr.length, 0);
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0].includes('7d: 30%'));
    assert.ok(!stdout[0].includes('5h'), 'expired window must not appear in summary');
  });
});

// ---------------------------------------------------------------------------
// English date formatting (timezone-safe assertions)
// ---------------------------------------------------------------------------

describe('T11 — English date formatting', () => {
  // FIXED_NOW_MS is 2023-11-14 UTC; RESET_IN_8H is 2023-11-15 UTC. In every
  // timezone the month is November, so asserting "Nov" is TZ-safe. Exact
  // weekday/day-of-month vary by TZ and are asserted only by shape.
  it('T11.8 7d block message uses English weekday + month abbreviations', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      seven_day: { utilization: 97, resets_at: RESET_IN_8H },
    });

    const { deps, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2);
    assert.match(
      stderr[0],
      /(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2} Nov \d{2}:\d{2}/,
      'reset must be formatted as "<EnWeekday> <day> Nov HH:MM"',
    );
    // No German abbreviations.
    assert.ok(!/\b(So|Mo|Di|Mi|Do|Fr|Sa)\b/.test(stderr[0]), 'no German weekday abbreviations');
    // No DD.MM. numeric date.
    assert.ok(!/\d{2}\.\d{2}\./.test(stderr[0]), 'no DD.MM. date format');
  });

  it('T11.9 5h summary uses English weekday + HH:MM', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 30, resets_at: RESET_IN_3H },
    });

    const { deps, stdout, exits } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.match(
      stdout[0],
      /reset (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}/,
      '5h reset must be "<EnWeekday> HH:MM"',
    );
  });
});
