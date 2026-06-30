/**
 * T17 — Per-window-class (weekly) thresholds (v0.6.0)
 *
 * The 7d* windows take their own WARN/HARD (CLAUDE_USAGE_GUARD_WEEKLY_WARN /
 * _WEEKLY_HARD, defaults 90/95) so a slowly filling weekly window does not wind
 * the agent down at the same bar as the volatile 5h window. evaluateThresholds
 * scores each window against ITS class thresholds and reports the most severe.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  main,
  readConfig,
  thresholdsForLabel,
  evaluateThresholds,
} from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCacheJson,
  makeCredsJson,
  CACHE_PATH,
  CREDS_PATH,
  FIXED_NOW_MS,
  RESET_IN_3H,
  RESET_IN_8H,
} from './helpers.mjs';

const D = new Date(FIXED_NOW_MS + 8 * 60 * 60 * 1000);
function win(label, util) {
  return { label, util, reset: D };
}

describe('T17 — Weekly thresholds', () => {
  // -------------------------------------------------------------------------
  // T17.1 readConfig defaults
  // -------------------------------------------------------------------------
  it('T17.1 weekly defaults are 90/95 when unset; base stays 80/95', () => {
    const cfg = readConfig({});
    assert.equal(cfg.warn, 80);
    assert.equal(cfg.hard, 95);
    assert.equal(cfg.weeklyWarn, 90);
    assert.equal(cfg.weeklyHard, 95);
  });

  // -------------------------------------------------------------------------
  // T17.2 readConfig validation: clamp, garbage→default, warn>=hard→reset pair
  // -------------------------------------------------------------------------
  it('T17.2a garbage weekly values fall back to defaults', () => {
    const cfg = readConfig({
      CLAUDE_USAGE_GUARD_WEEKLY_WARN: 'abc',
      CLAUDE_USAGE_GUARD_WEEKLY_HARD: '',
    });
    assert.equal(cfg.weeklyWarn, 90);
    assert.equal(cfg.weeklyHard, 95);
  });

  it('T17.2b weeklyWarn >= weeklyHard resets the pair to 90/95', () => {
    const cfg = readConfig({
      CLAUDE_USAGE_GUARD_WEEKLY_WARN: '96',
      CLAUDE_USAGE_GUARD_WEEKLY_HARD: '95',
    });
    assert.equal(cfg.weeklyWarn, 90);
    assert.equal(cfg.weeklyHard, 95);
  });

  it('T17.2c weekly values are clamped to 1..100 and honored when valid', () => {
    const cfg = readConfig({
      CLAUDE_USAGE_GUARD_WEEKLY_WARN: '200',
      CLAUDE_USAGE_GUARD_WEEKLY_HARD: '0',
    });
    // 200→100, 0→1; then warn(100) >= hard(1) → reset to defaults.
    assert.equal(cfg.weeklyWarn, 90);
    assert.equal(cfg.weeklyHard, 95);

    const cfg2 = readConfig({
      CLAUDE_USAGE_GUARD_WEEKLY_WARN: '85',
      CLAUDE_USAGE_GUARD_WEEKLY_HARD: '99',
    });
    assert.equal(cfg2.weeklyWarn, 85);
    assert.equal(cfg2.weeklyHard, 99);
  });

  it('T17.2d weekly thresholds are independent of base thresholds', () => {
    const cfg = readConfig({
      CLAUDE_USAGE_GUARD_WARN: '50',
      CLAUDE_USAGE_GUARD_HARD: '70',
      CLAUDE_USAGE_GUARD_WEEKLY_WARN: '88',
      CLAUDE_USAGE_GUARD_WEEKLY_HARD: '97',
    });
    assert.equal(cfg.warn, 50);
    assert.equal(cfg.hard, 70);
    assert.equal(cfg.weeklyWarn, 88);
    assert.equal(cfg.weeklyHard, 97);
  });

  // -------------------------------------------------------------------------
  // T17.3 thresholdsForLabel
  // -------------------------------------------------------------------------
  it('T17.3 thresholdsForLabel maps 7d* → weekly, 5h → base', () => {
    const cfg = readConfig({});
    assert.deepEqual(thresholdsForLabel('5h', cfg), { warn: 80, hard: 95 });
    assert.deepEqual(thresholdsForLabel('7d', cfg), { warn: 90, hard: 95 });
    assert.deepEqual(thresholdsForLabel('7d-opus', cfg), { warn: 90, hard: 95 });
    assert.deepEqual(thresholdsForLabel('7d-sonnet', cfg), { warn: 90, hard: 95 });
  });

  // -------------------------------------------------------------------------
  // T17.4 evaluateThresholds per-window-class scoring
  // -------------------------------------------------------------------------
  it('T17.4a 7d at 88% with default weekly (90) is OK — no wind-down', () => {
    const cfg = readConfig({});
    const { worst, level } = evaluateThresholds([win('7d', 88)], cfg);
    assert.equal(level, 'ok');
    assert.equal(worst.label, '7d');
  });

  it('T17.4b 7d at 92% → warn (weekly warn 90)', () => {
    const cfg = readConfig({});
    assert.equal(evaluateThresholds([win('7d', 92)], cfg).level, 'warn');
  });

  it('T17.4c 7d at 96% → hard (weekly hard 95)', () => {
    const cfg = readConfig({});
    assert.equal(evaluateThresholds([win('7d', 96)], cfg).level, 'hard');
  });

  it('T17.4d most-SEVERE wins, not highest util: 5h@85 (warn) outranks 7d@89 (ok)', () => {
    const cfg = readConfig({});
    const { worst, level } = evaluateThresholds([win('7d', 89), win('5h', 85)], cfg);
    assert.equal(level, 'warn', '5h crosses its 80 warn; 7d@89 is below its 90 warn');
    assert.equal(worst.label, '5h', 'the more severe (not the higher-util) window is worst');
  });

  it('T17.4e same severity → higher utilization breaks the tie', () => {
    const cfg = readConfig({});
    // 5h@97 (hard, base 95) vs 7d@98 (hard, weekly 95): both hard → higher util.
    const { worst, level } = evaluateThresholds([win('5h', 97), win('7d', 98)], cfg);
    assert.equal(level, 'hard');
    assert.equal(worst.label, '7d');
  });

  // -------------------------------------------------------------------------
  // T17.5 Integration: a 7d window at 55% no longer winds the agent down
  // -------------------------------------------------------------------------
  it('T17.5 UserPromptSubmit, 7d at 55% (default weekly) → summary only, no WIND DOWN', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 4, resets_at: RESET_IN_3H },
      seven_day: { utilization: 55, resets_at: RESET_IN_8H },
    });
    const { deps, stdout, stderr, exits } = makeDeps({
      env: { CLAUDE_USAGE_GUARD_TTL: '3600' }, // defaults for thresholds
      stdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
      initialFs: { [CACHE_PATH]: cache, [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stderr.length, 0);
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0].includes('[usage]'));
    assert.ok(stdout[0].includes('7d: 55%'));
    assert.ok(!stdout[0].includes('WIND DOWN'), 'a 55% weekly window must not wind down by default');
  });

  // -------------------------------------------------------------------------
  // T17.6 Integration: 5h still winds down at the (lower) base WARN
  // -------------------------------------------------------------------------
  it('T17.6 5h at 85% still winds down (base warn 80) even though weekly bar is 90', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 85, resets_at: RESET_IN_3H },
      seven_day: { utilization: 85, resets_at: RESET_IN_8H },
    });
    const { deps, stdout, exits } = makeDeps({
      env: { CLAUDE_USAGE_GUARD_TTL: '3600' },
      stdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
      initialFs: { [CACHE_PATH]: cache, [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.ok(stdout[0].includes('WIND DOWN'), '5h at 85 crosses base warn 80');
    // The wind-down must name the 5h window, not the (still-OK) 7d window.
    assert.ok(/5h window at 85%/.test(stdout[0]), 'wind-down driven by the 5h window');
  });

  // -------------------------------------------------------------------------
  // T17.7 Block message shows the WEEKLY hard limit for a weekly window
  // -------------------------------------------------------------------------
  it('T17.7 weekly window block uses weekly HARD (proves decoupling): base hard 99, weekly 95, 7d@97 → block at 95%', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      seven_day: { utilization: 97, resets_at: RESET_IN_8H },
    });
    const { deps, stderr, exits } = makeDeps({
      env: {
        CLAUDE_USAGE_GUARD_HARD: '99', // base would NOT block 97
        CLAUDE_USAGE_GUARD_WEEKLY_HARD: '95', // weekly DOES
        CLAUDE_USAGE_GUARD_WEEKLY_WARN: '90',
        CLAUDE_USAGE_GUARD_TTL: '3600',
      },
      stdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }),
      initialFs: { [CACHE_PATH]: cache, [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2, '7d@97 blocks under weekly hard 95 even though base hard is 99');
    assert.ok(stderr[0].includes('limit 95%'), 'block message shows the weekly hard limit');
  });

  // -------------------------------------------------------------------------
  // T17.8 Two simultaneously-hard windows with divergent resets: the most-severe
  // (here higher-util) window drives the block. When BOTH are hard the binding
  // constraint is the LATER reset (the agent stays blocked until every hard
  // window clears), so a hard weekly window resetting >6h out correctly yields
  // the wrap-up/handback message rather than a near-reset ScheduleWakeup that
  // would only bounce. (The weekly decoupling makes a hard 7d more reachable.)
  // -------------------------------------------------------------------------
  it('T17.8 PreToolUse, 5h hard (reset 3h) + 7d hard higher-util (reset 8h) → 7d drives, >6h handback', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 96, resets_at: RESET_IN_3H }, // hard (base 95), within 6h
      seven_day: { utilization: 99, resets_at: RESET_IN_8H }, // hard (weekly 95), > 6h, higher util
    });
    const { deps, stdout, stderr, exits } = makeDeps({
      env: { CLAUDE_USAGE_GUARD_TTL: '3600' }, // defaults: base 80/95, weekly 90/95
      stdin: async () => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      initialFs: { [CACHE_PATH]: cache, [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2, 'both windows hard → blocked');
    assert.equal(stdout.length, 0, 'no stdout for PreToolUse block');
    assert.ok(stderr[0].includes('7d'), 'the higher-util (later-reset) window drives the message');
    assert.ok(stderr[0].includes('Wrap up'), 'reset > 6h → wrap-up/handback, not a bouncing wakeup');
    assert.ok(!stderr[0].includes('ScheduleWakeup'), 'must not schedule a wakeup that would bounce');
  });
});
