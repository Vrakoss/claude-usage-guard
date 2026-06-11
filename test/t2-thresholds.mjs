/**
 * T2 — Threshold matrix
 *
 * Tests combinations of:
 *   utilization level: <WARN, ==WARN, between WARN..HARD, ==HARD, >HARD
 *   window:            five_hour (5h), seven_day (7d)
 *   event:             UserPromptSubmit, PreToolUse
 *
 * Expected behaviours:
 *   ok (< WARN)    → summary only (stdout), exit 0, no stderr
 *   warn (>= WARN) → summary + WIND DOWN (stdout), exit 0, no stderr
 *   hard (>= HARD) → UserPromptSubmit: stderr block + exit 2, empty stdout
 *                  → PreToolUse: stderr block + exit 2, empty stdout
 *
 * PreToolUse non-blocking paths must produce ZERO stdout.
 * PreToolUse hard block: reset <= 6h → ScheduleWakeup instruction in stderr
 *                        reset > 6h  → wrap-up instruction in stderr, no ScheduleWakeup
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCacheJson,
  CACHE_PATH,
  CREDS_PATH,
  FIXED_NOW_MS,
  RESET_IN_3H,
  RESET_IN_8H,
  makeCredsJson,
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WARN = 80;
const HARD = 95;

function makeEnv() {
  return {
    CLAUDE_USAGE_GUARD_WARN: String(WARN),
    CLAUDE_USAGE_GUARD_HARD: String(HARD),
    CLAUDE_USAGE_GUARD_TTL: '3600', // 1 hour TTL — cache always fresh
  };
}

/**
 * Run main with a single five_hour window at `util` utilization.
 * Cache is pre-seeded and will be treated as fresh (fetchedAt == now).
 * resetIso controls the resets_at timestamp.
 */
async function runWith5hWindow({ util, eventStdin, resetIso = RESET_IN_3H }) {
  const cache = makeCacheJson(FIXED_NOW_MS, {
    five_hour: { utilization: util, resets_at: resetIso },
  });

  const { deps, stdout, stderr, exits, fetchCalls } = makeDeps({
    env: makeEnv(),
    stdin: async () => eventStdin,
    initialFs: {
      [CACHE_PATH]: cache,
      [CREDS_PATH]: makeCredsJson('tok'),
    },
    now: () => new Date(FIXED_NOW_MS),
  });

  await main(deps);

  return { stdout, stderr, exits, fetchCalls };
}

async function runWith7dWindow({ util, eventStdin, resetIso = RESET_IN_8H }) {
  const cache = makeCacheJson(FIXED_NOW_MS, {
    seven_day: { utilization: util, resets_at: resetIso },
  });

  const { deps, stdout, stderr, exits, fetchCalls } = makeDeps({
    env: makeEnv(),
    stdin: async () => eventStdin,
    initialFs: {
      [CACHE_PATH]: cache,
      [CREDS_PATH]: makeCredsJson('tok'),
    },
    now: () => new Date(FIXED_NOW_MS),
  });

  await main(deps);

  return { stdout, stderr, exits, fetchCalls };
}

const UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit' });
const PTU = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });

// ---------------------------------------------------------------------------
// T2.1 — OK level (<WARN) × 5h × UserPromptSubmit
// ---------------------------------------------------------------------------

describe('T2 — Threshold matrix', () => {
  it('T2.1 5h util<WARN UserPromptSubmit: stdout summary, exit 0, no stderr, no fetch', async () => {
    const { stdout, stderr, exits, fetchCalls } = await runWith5hWindow({
      util: WARN - 1,
      eventStdin: UPS,
    });

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0].includes('[usage]'));
    assert.ok(stdout[0].includes('5h:'));
    assert.equal(stderr.length, 0);
    assert.equal(fetchCalls.length, 0); // cache hit — no fetch
    // No WIND DOWN in the summary
    assert.ok(!stdout[0].includes('WIND DOWN'));
  });

  // -------------------------------------------------------------------------
  // T2.2 — WARN level (==WARN) × 5h × UserPromptSubmit
  // -------------------------------------------------------------------------
  it('T2.2 5h util==WARN UserPromptSubmit: stdout has WIND DOWN suffix, exit 0, no stderr', async () => {
    const { stdout, stderr, exits } = await runWith5hWindow({
      util: WARN,
      eventStdin: UPS,
    });

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0].includes('WIND DOWN'));
    assert.ok(stdout[0].includes('[usage]'));
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T2.3 — between WARN and HARD × 5h × UserPromptSubmit
  // -------------------------------------------------------------------------
  it('T2.3 5h util between WARN..HARD UserPromptSubmit: stdout has WIND DOWN, exit 0', async () => {
    const { stdout, stderr, exits } = await runWith5hWindow({
      util: Math.floor((WARN + HARD) / 2),
      eventStdin: UPS,
    });

    assert.equal(exits[0], 0);
    assert.ok(stdout[0].includes('WIND DOWN'));
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T2.4 — HARD level (==HARD) × 5h × UserPromptSubmit → block
  // -------------------------------------------------------------------------
  it('T2.4 5h util==HARD UserPromptSubmit: stderr block, exit 2, empty stdout', async () => {
    const { stdout, stderr, exits } = await runWith5hWindow({
      util: HARD,
      eventStdin: UPS,
    });

    assert.equal(exits[0], 2);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 1);
    assert.ok(stderr[0].includes('QUOTA GUARD'));
    assert.ok(stderr[0].includes(`${HARD}%`)); // shows limit
    // Must contain reset time
    assert.ok(stderr[0].includes('reset'));
    // Must contain bypass hint
    assert.ok(stderr[0].includes('CLAUDE_USAGE_GUARD=off'));
  });

  // -------------------------------------------------------------------------
  // T2.5 — >HARD × 5h × UserPromptSubmit → block
  // -------------------------------------------------------------------------
  it('T2.5 5h util>HARD UserPromptSubmit: stderr block, exit 2, empty stdout', async () => {
    const { stdout, stderr, exits } = await runWith5hWindow({
      util: 99,
      eventStdin: UPS,
    });

    assert.equal(exits[0], 2);
    assert.equal(stdout.length, 0);
    assert.ok(stderr[0].includes('QUOTA GUARD'));
  });

  // -------------------------------------------------------------------------
  // T2.6 — OK level × 5h × PreToolUse → zero stdout
  // -------------------------------------------------------------------------
  it('T2.6 5h util<WARN PreToolUse: ZERO stdout, exit 0, no stderr', async () => {
    const { stdout, stderr, exits } = await runWith5hWindow({
      util: WARN - 1,
      eventStdin: PTU,
    });

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0); // MANDATORY: no stdout for PreToolUse
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T2.7 — WARN level × 5h × PreToolUse → zero stdout
  // -------------------------------------------------------------------------
  it('T2.7 5h util==WARN PreToolUse: ZERO stdout, exit 0', async () => {
    const { stdout, stderr, exits } = await runWith5hWindow({
      util: WARN,
      eventStdin: PTU,
    });

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T2.8 — HARD × 5h × PreToolUse, reset <= 6h → ScheduleWakeup instruction
  // -------------------------------------------------------------------------
  it('T2.8 5h util>=HARD PreToolUse reset<=6h: exit 2, stderr has ScheduleWakeup instruction', async () => {
    const { stdout, stderr, exits } = await runWith5hWindow({
      util: HARD,
      eventStdin: PTU,
      resetIso: RESET_IN_3H, // 3h from now → <= 6h
    });

    assert.equal(exits[0], 2);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 1);
    assert.ok(stderr[0].includes('QUOTA GUARD'));
    assert.ok(stderr[0].includes('ScheduleWakeup'), 'should instruct ScheduleWakeup chaining');
    assert.ok(!stderr[0].includes('Wrap up'), 'should NOT say Wrap up (that is the >6h path)');
  });

  // -------------------------------------------------------------------------
  // T2.9 — HARD × 7d × PreToolUse, reset > 6h → wrap-up instruction, NO ScheduleWakeup
  // -------------------------------------------------------------------------
  it('T2.9 7d util>=HARD PreToolUse reset>6h: exit 2, stderr has wrap-up, no ScheduleWakeup chain', async () => {
    const { stdout, stderr, exits } = await runWith7dWindow({
      util: HARD,
      eventStdin: PTU,
      resetIso: RESET_IN_8H, // 8h from now → > 6h
    });

    assert.equal(exits[0], 2);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 1);
    assert.ok(stderr[0].includes('QUOTA GUARD'));
    assert.ok(stderr[0].includes('Wrap up'), 'should say Wrap up for weekly window');
    assert.ok(!stderr[0].includes('ScheduleWakeup'), 'should NOT mention ScheduleWakeup for >6h');
  });

  // -------------------------------------------------------------------------
  // T2.10 — OK level × 7d × UserPromptSubmit
  // -------------------------------------------------------------------------
  it('T2.10 7d util<WARN UserPromptSubmit: summary includes 7d label, exit 0', async () => {
    const { stdout, stderr, exits } = await runWith7dWindow({
      util: 10,
      eventStdin: UPS,
    });

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0].includes('7d:'));
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T2.11 — WARN level × 7d × UserPromptSubmit
  // -------------------------------------------------------------------------
  it('T2.11 7d util==WARN UserPromptSubmit: WIND DOWN suffix present, exit 0', async () => {
    const { stdout, stderr, exits } = await runWith7dWindow({
      util: WARN,
      eventStdin: UPS,
    });

    assert.equal(exits[0], 0);
    assert.ok(stdout[0].includes('WIND DOWN'));
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T2.12 — HARD × 7d × UserPromptSubmit
  // -------------------------------------------------------------------------
  it('T2.12 7d util>=HARD UserPromptSubmit: stderr contains reset date+time, exit 2', async () => {
    const { stdout, stderr, exits } = await runWith7dWindow({
      util: 97,
      eventStdin: UPS,
      resetIso: RESET_IN_8H,
    });

    assert.equal(exits[0], 2);
    assert.equal(stdout.length, 0);
    assert.ok(stderr[0].includes('QUOTA GUARD'));
    // The block message for UserPromptSubmit uses fmtWeekdayDateTime → has date portion
    assert.ok(stderr[0].includes('reset'));
    assert.ok(stderr[0].includes('CLAUDE_USAGE_GUARD=off'));
  });

  // -------------------------------------------------------------------------
  // T2.13 — Worst window dominates when multiple windows present
  // -------------------------------------------------------------------------
  it('T2.13 worst window (highest util) triggers level, not average', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 10, resets_at: RESET_IN_3H },
      seven_day: { utilization: HARD, resets_at: RESET_IN_8H },
    });

    const { deps, stdout, stderr, exits } = makeDeps({
      env: makeEnv(),
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2);
    assert.equal(stdout.length, 0);
    assert.ok(stderr[0].includes('7d')); // the 7d window triggered
  });

  // -------------------------------------------------------------------------
  // T2.15 — WARN suffix for a weekly window includes the reset DATE, not a
  // bare time-of-day (regression: audit #2 — "past 19:00" for a reset days
  // away steered the model to a wakeup long before the actual reset)
  // -------------------------------------------------------------------------
  it('T2.15 7d WARN suffix: ScheduleWakeup hint includes weekday+date, not bare time', async () => {
    const { stdout, exits } = await runWith7dWindow({
      util: WARN,
      eventStdin: UPS,
      resetIso: RESET_IN_8H,
    });

    assert.equal(exits[0], 0);
    const line = stdout[0];
    assert.ok(line.includes('WIND DOWN'));
    const suffix = line.slice(line.indexOf('WIND DOWN'));
    // Timezone-safe: assert month name + HH:MM shape, never exact weekday/day.
    assert.ok(suffix.includes('Nov'), `suffix must carry the reset date: "${suffix}"`);
    assert.ok(/ScheduleWakeup past \S+ \d{1,2} Nov \d{2}:\d{2}/.test(suffix),
      `suffix must use weekday+date+time for weekly windows: "${suffix}"`);
  });

  // -------------------------------------------------------------------------
  // T2.14 — UserPromptSubmit block message contains formatted reset time, not raw ISO
  // -------------------------------------------------------------------------
  it('T2.14 UserPromptSubmit block: stderr message contains HH:MM formatted time, not raw ISO', async () => {
    const { stderr } = await runWith5hWindow({
      util: HARD,
      eventStdin: UPS,
      resetIso: RESET_IN_3H,
    });

    // Should contain formatted HH:MM time.
    assert.ok(stderr[0].match(/\d{2}:\d{2}/), 'should include HH:MM time');
    // Should NOT contain a raw ISO timestamp (which would look like "2023-11-15T02:13:00.000Z").
    assert.ok(!stderr[0].match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/),
      'should not include raw ISO timestamp format');
    // Should not contain raw milliseconds epoch.
    assert.ok(!stderr[0].match(/\d{13}/), 'should not include epoch ms');
  });
});
