/**
 * T6 — ScheduleWakeup exemption
 *
 * PreToolUse with tool_name "ScheduleWakeup" → exit 0, NO exit 2 ever,
 * even when cache shows util >= HARD.
 *
 * v0.3.0 — upgraded exemption: when hard-blocked and the prompt is unmarked,
 * the guard stamps RESUME_MARKER onto the prompt via PreToolUse JSON stdout
 * (updatedInput), then exits 0. This ensures the wake turn is recognized as a
 * resume hop by the UserPromptSubmit branch.
 *
 * Cache READS are allowed on this path (to determine block state). No FETCH
 * ever happens on this path.
 *
 * Other tool names (Bash, Task, etc.) are still gated normally.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main, RESUME_MARKER } from '../scripts/usage-guard.mjs';
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

// Cache showing OK-level utilisation.
function makeOkCache() {
  return makeCacheJson(FIXED_NOW_MS, {
    five_hour: { utilization: 30, resets_at: RESET_IN_3H },
  });
}

describe('T6 — ScheduleWakeup exemption', () => {
  // -------------------------------------------------------------------------
  // T6.1 ScheduleWakeup without tool_input: exit 0, no stdout, no stderr, no fetch
  // -------------------------------------------------------------------------
  it('T6.1 PreToolUse ScheduleWakeup (no tool_input) exits 0 with no output and no fetch', async () => {
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
    assert.equal(stdout.length, 0, 'no tool_input → no stdout JSON');
    assert.equal(stderr.length, 0, 'must produce no stderr');
    assert.equal(fetchCalls.length, 0, 'must NOT fetch (no fetch on ScheduleWakeup path)');
  });

  // -------------------------------------------------------------------------
  // T6.2 ScheduleWakeup exempt even at util >= HARD
  // -------------------------------------------------------------------------
  it('T6.2 ScheduleWakeup exempt even when cache util is at HARD threshold', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 95, resets_at: RESET_IN_3H },
    });

    const { deps, exits, fetchCalls, stderr } = makeDeps({
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
    const { deps, exits } = makeDeps({
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

  // -------------------------------------------------------------------------
  // T6.7 Blocked + unmarked wakeup prompt → marker is stamped via JSON stdout
  // -------------------------------------------------------------------------
  it('T6.7 blocked + unmarked ScheduleWakeup prompt → exit 0, JSON stdout stamps marker, no fetch', async () => {
    const ORIGINAL_PROMPT = 'resume my data analysis task';
    const REASON = 'quota reset in 3h';

    const { deps, stdout, stderr, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: {
          delaySeconds: 3600,
          prompt: ORIGINAL_PROMPT,
          reason: REASON,
        },
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'ScheduleWakeup must always exit 0');
    assert.equal(stderr.length, 0, 'no stderr');
    assert.equal(fetchCalls.length, 0, 'must NOT fetch on ScheduleWakeup path');

    // Exactly one JSON line on stdout.
    assert.equal(stdout.length, 1, 'must produce exactly one stdout line');
    const parsed = JSON.parse(stdout[0]);
    const hookOutput = parsed.hookSpecificOutput;
    assert.ok(hookOutput, 'must have hookSpecificOutput');
    assert.equal(hookOutput.hookEventName, 'PreToolUse');
    assert.equal(hookOutput.permissionDecision, 'allow');
    assert.ok(typeof hookOutput.permissionDecisionReason === 'string');

    const updatedInput = hookOutput.updatedInput;
    assert.ok(updatedInput, 'must have updatedInput');

    // updatedInput key set must be a subset of {delaySeconds, prompt, reason}.
    const allowedKeys = new Set(['delaySeconds', 'prompt', 'reason']);
    for (const key of Object.keys(updatedInput)) {
      assert.ok(allowedKeys.has(key), `unexpected key in updatedInput: ${key}`);
    }

    // prompt must start with RESUME_MARKER.
    assert.ok(
      typeof updatedInput.prompt === 'string' && updatedInput.prompt.startsWith(RESUME_MARKER),
      `updatedInput.prompt must start with RESUME_MARKER, got: "${updatedInput.prompt}"`,
    );
    // prompt must contain the original prompt.
    assert.ok(
      updatedInput.prompt.includes(ORIGINAL_PROMPT),
      'updatedInput.prompt must contain the original prompt',
    );
    // delaySeconds must be passed through.
    assert.equal(updatedInput.delaySeconds, 3600);
    // reason must be passed through.
    assert.equal(updatedInput.reason, REASON);
  });

  // -------------------------------------------------------------------------
  // T6.8 Already-marked prompt → no JSON stdout (plain exit 0)
  // -------------------------------------------------------------------------
  it('T6.8 blocked + already-marked ScheduleWakeup prompt → plain exit 0, no stdout', async () => {
    const { deps, stdout, stderr, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: {
          delaySeconds: 3600,
          prompt: RESUME_MARKER + ' resume my data analysis task',
        },
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0, 'already-marked prompt must not produce JSON stdout');
    assert.equal(stderr.length, 0);
    assert.equal(fetchCalls.length, 0);
  });

  // -------------------------------------------------------------------------
  // T6.9 Sentinel prompt → untouched (no stdout)
  // -------------------------------------------------------------------------
  it('T6.9 sentinel prompt (<<autonomous-loop>>) → not stamped, plain exit 0', async () => {
    const { deps, stdout, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: {
          delaySeconds: 3600,
          prompt: '<<autonomous-loop>>',
        },
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0, 'sentinel prompt must not be stamped');
    assert.equal(fetchCalls.length, 0);
  });

  it('T6.9b sentinel <<autonomous-loop-dynamic>> → not stamped, plain exit 0', async () => {
    const { deps, stdout, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: {
          delaySeconds: 3600,
          prompt: '<<autonomous-loop-dynamic>>',
        },
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0, 'autonomous-loop-dynamic must not be stamped');
  });

  // -------------------------------------------------------------------------
  // T6.10 Not blocked (OK cache) → plain exit 0, no stdout
  // -------------------------------------------------------------------------
  it('T6.10 not blocked (ok level) + unmarked prompt → plain exit 0, no stdout', async () => {
    const { deps, stdout, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: {
          delaySeconds: 3600,
          prompt: 'resume my data analysis task',
        },
      }),
      initialFs: {
        [CACHE_PATH]: makeOkCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0, 'not blocked → no JSON stamping needed');
    assert.equal(fetchCalls.length, 0, 'no fetch on ScheduleWakeup path');
  });

  // -------------------------------------------------------------------------
  // T6.11 Malformed tool_input → plain exit 0, no stdout
  // -------------------------------------------------------------------------
  it('T6.11 malformed tool_input (array) → plain exit 0, no stdout', async () => {
    const { deps, stdout, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: ['not', 'an', 'object'],
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0, 'malformed tool_input must not produce JSON stdout');
  });

  it('T6.11b non-string tool_input.prompt → plain exit 0, no stdout', async () => {
    const { deps, stdout, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: {
          delaySeconds: 3600,
          prompt: 12345, // not a string
        },
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0, 'non-string prompt must not produce JSON stdout');
  });

  // -------------------------------------------------------------------------
  // T6.12 delaySeconds passthrough: non-finite is omitted from updatedInput
  // -------------------------------------------------------------------------
  it('T6.12 non-finite delaySeconds is omitted from updatedInput', async () => {
    const { deps, stdout, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: {
          delaySeconds: 'not-a-number',
          prompt: 'resume task',
        },
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    if (stdout.length === 1) {
      const parsed = JSON.parse(stdout[0]);
      const updatedInput = parsed.hookSpecificOutput.updatedInput;
      assert.ok(
        !Object.prototype.hasOwnProperty.call(updatedInput, 'delaySeconds'),
        'non-finite delaySeconds must be omitted from updatedInput',
      );
    }
  });

  // -------------------------------------------------------------------------
  // T6.13 Blocked + unmarked prompt without reason field — reason omitted
  // -------------------------------------------------------------------------
  it('T6.13 no reason field in tool_input → updatedInput has no reason key', async () => {
    const { deps, stdout, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: {
          delaySeconds: 1800,
          prompt: 'resume task',
          // no reason field
        },
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    if (stdout.length === 1) {
      const parsed = JSON.parse(stdout[0]);
      const updatedInput = parsed.hookSpecificOutput.updatedInput;
      assert.ok(
        !Object.prototype.hasOwnProperty.call(updatedInput, 'reason'),
        'absent reason must not appear in updatedInput',
      );
    }
  });
});
