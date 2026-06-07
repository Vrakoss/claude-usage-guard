/**
 * T6 — ScheduleWakeup exemption
 *
 * PreToolUse with tool_name "ScheduleWakeup" → exit 0, no output, NO fetch,
 * even when cache shows util >= HARD.
 *
 * Other tool names (Bash, Task, etc.) are still gated normally.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCacheJson,
  makeCredsJson,
  CACHE_PATH,
  CREDS_PATH,
  FIXED_NOW_MS,
  RESET_IN_3H,
} from './helpers.mjs';

const ENV = {
  CLAUDE_USAGE_GUARD_WARN: '80',
  CLAUDE_USAGE_GUARD_HARD: '95',
  CLAUDE_USAGE_GUARD_TTL: '3600',
};

// Cache showing HARD-level utilisation.
function makeHardCache() {
  return makeCacheJson(FIXED_NOW_MS, {
    five_hour: { utilization: 99, resets_at: RESET_IN_3H },
  });
}

describe('T6 — ScheduleWakeup exemption', () => {
  // -------------------------------------------------------------------------
  // T6.1 ScheduleWakeup: exit 0, no stdout, no stderr, no fetch
  // -------------------------------------------------------------------------
  it('T6.1 PreToolUse ScheduleWakeup exits 0 immediately with no output and no fetch', async () => {
    const { deps, stdout, stderr, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'ScheduleWakeup must exit 0');
    assert.equal(stdout.length, 0, 'must produce no stdout');
    assert.equal(stderr.length, 0, 'must produce no stderr');
    assert.equal(fetchCalls.length, 0, 'must NOT fetch (exits before data acquisition)');
  });

  // -------------------------------------------------------------------------
  // T6.2 ScheduleWakeup exempt even at util >= HARD (gate cannot block sleep)
  // -------------------------------------------------------------------------
  it('T6.2 ScheduleWakeup exempt even when cache util is at HARD threshold', async () => {
    // util == 95 which equals HARD — would normally block Bash.
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 95, resets_at: RESET_IN_3H },
    });

    const { deps, exits, fetchCalls, stdout, stderr } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
      }),
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(fetchCalls.length, 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T6.3 Other tool names (Bash) are NOT exempt — gated at HARD
  // -------------------------------------------------------------------------
  it('T6.3 PreToolUse Bash is not exempt — blocked at HARD utilization', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2, 'Bash tool must be blocked at HARD utilization');
    assert.equal(stdout.length, 0, 'no stdout for PreToolUse block');
    assert.equal(stderr.length, 1, 'block message on stderr');
  });

  // -------------------------------------------------------------------------
  // T6.4 PreToolUse Task tool is NOT exempt
  // -------------------------------------------------------------------------
  it('T6.4 PreToolUse Task tool is not exempt — blocked at HARD utilization', async () => {
    const { deps, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2, 'Task tool must be blocked at HARD');
  });

  // -------------------------------------------------------------------------
  // T6.5 ScheduleWakeup case-sensitive (lowercase is NOT exempt)
  // -------------------------------------------------------------------------
  it('T6.5 tool_name "schedulewakeup" (wrong case) is NOT exempt — checked against exact string', async () => {
    // The exemption checks === 'ScheduleWakeup' exactly.
    const { deps, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'schedulewakeup', // wrong case
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    // Not exempt → data is acquired (fetchCalls count varies by cache freshness,
    // but exit code must reflect HARD block).
    assert.equal(exits[0], 2, 'wrong-case tool_name should be treated as regular tool and blocked');
  });

  // -------------------------------------------------------------------------
  // T6.6 ScheduleWakeup with no cache (cold start) — still exempt, no fetch
  // -------------------------------------------------------------------------
  it('T6.6 ScheduleWakeup with cold start (no cache, no creds) — still exits 0, no fetch', async () => {
    const { deps, exits, fetchCalls, stdout, stderr } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
      }),
      initialFs: {}, // Nothing at all.
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(fetchCalls.length, 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 0);
  });
});
