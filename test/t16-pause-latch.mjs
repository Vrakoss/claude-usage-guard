/**
 * T16 — Pause latch (v0.6.0, issue #5)
 *
 * The latch breaks the degenerate re-hop loop: while hard-blocked, a /goal-style
 * Stop-hook re-drives the agent every turn. Without the latch each re-drive
 * re-schedules a wakeup (stacking dozens) and may run quota-burning probes. The
 * latch records that ONE wakeup is already pending and tells subsequent
 * non-resume re-drives to stand down.
 *
 * Coverage:
 *  - validatePauseState: allowlist + stale/poisoned-timestamp rejection.
 *  - decidePauseAction: wait vs schedule predicate.
 *  - ScheduleWakeup branch WRITES the latch (authoritative), within 6h only.
 *  - PreToolUse / UserPromptSubmit hard block READ the latch → WAIT message.
 *  - RESUME_MARKER carve-out: a fired hop NEVER waits (no stuck state).
 *  - Sub-agents never get the WAIT path.
 *  - Fail-open is ASYMMETRIC: corrupt/poisoned latch → SCHEDULE, never WAIT.
 *  - A pause-write failure never traps the ScheduleWakeup path (still exit 0).
 *  - Clear on the transitions out of a pause (resume-ready, recheck-cleared).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  main,
  RESUME_MARKER,
  validatePauseState,
  decidePauseAction,
} from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCacheJson,
  makeCredsJson,
  CACHE_PATH,
  CREDS_PATH,
  PAUSE_PATH,
  FIXED_NOW_MS,
  RESET_IN_3H,
  RESET_IN_8H,
  RESET_PAST,
} from './helpers.mjs';

const ENV = {
  CLAUDE_USAGE_GUARD_WARN: '80',
  CLAUDE_USAGE_GUARD_HARD: '95',
  CLAUDE_USAGE_GUARD_WEEKLY_WARN: '80',
  CLAUDE_USAGE_GUARD_WEEKLY_HARD: '95',
  CLAUDE_USAGE_GUARD_TTL: '3600',
};

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const GRACE_MS = 15 * 60_000;

// Hard cache, 5h window resetting 3h out (within the 6h resume horizon).
function hardCache3h() {
  return makeCacheJson(FIXED_NOW_MS, {
    five_hour: { utilization: 99, resets_at: RESET_IN_3H },
  });
}

// A pause file whose wakeup is still pending (1h in the future), reset 3h out.
function pendingPauseJson() {
  return JSON.stringify({
    resetAtMs: FIXED_NOW_MS + 3 * 60 * 60 * 1000,
    nextWakeupAtMs: FIXED_NOW_MS + 60 * 60 * 1000,
  });
}

describe('T16 — Pause latch', () => {
  // -------------------------------------------------------------------------
  // T16.1 validatePauseState — accepts a clean record
  // -------------------------------------------------------------------------
  it('T16.1 validatePauseState accepts finite numbers and returns a clean copy', () => {
    const reset = FIXED_NOW_MS + 2 * 60 * 60 * 1000;
    const next = FIXED_NOW_MS + 60 * 60 * 1000;
    const clean = validatePauseState({ resetAtMs: reset, nextWakeupAtMs: next, extra: 'x' }, FIXED_NOW_MS);
    assert.deepEqual(clean, { resetAtMs: reset, nextWakeupAtMs: next });
    // No extra keys leak through.
    assert.deepEqual(Object.keys(clean).sort(), ['nextWakeupAtMs', 'resetAtMs']);
  });

  // -------------------------------------------------------------------------
  // T16.2 validatePauseState — rejections
  // -------------------------------------------------------------------------
  it('T16.2a non-object / array / null → null', () => {
    assert.equal(validatePauseState(null, FIXED_NOW_MS), null);
    assert.equal(validatePauseState('x', FIXED_NOW_MS), null);
    assert.equal(validatePauseState([1, 2], FIXED_NOW_MS), null);
    assert.equal(validatePauseState(42, FIXED_NOW_MS), null);
  });

  it('T16.2b missing / non-finite numbers → null', () => {
    const reset = FIXED_NOW_MS + 60 * 60 * 1000;
    assert.equal(validatePauseState({ resetAtMs: reset }, FIXED_NOW_MS), null);
    assert.equal(validatePauseState({ nextWakeupAtMs: reset }, FIXED_NOW_MS), null);
    assert.equal(validatePauseState({ resetAtMs: NaN, nextWakeupAtMs: reset }, FIXED_NOW_MS), null);
    assert.equal(validatePauseState({ resetAtMs: reset, nextWakeupAtMs: Infinity }, FIXED_NOW_MS), null);
    assert.equal(validatePauseState({ resetAtMs: '1', nextWakeupAtMs: 2 }, FIXED_NOW_MS), null);
  });

  it('T16.2c resetAtMs already passed (stale) → null', () => {
    const past = FIXED_NOW_MS - 1000;
    assert.equal(
      validatePauseState({ resetAtMs: past, nextWakeupAtMs: past }, FIXED_NOW_MS),
      null,
    );
  });

  it('T16.2d resetAtMs implausibly far in the future (poisoned pin-WAIT) → null', () => {
    const farReset = FIXED_NOW_MS + SIX_HOURS_MS + GRACE_MS + 60_000;
    assert.equal(
      validatePauseState({ resetAtMs: farReset, nextWakeupAtMs: FIXED_NOW_MS + 1000 }, FIXED_NOW_MS),
      null,
    );
  });

  it('T16.2e nextWakeupAtMs further past resetAtMs than the buffer could produce → null', () => {
    const reset = FIXED_NOW_MS + 60 * 60 * 1000;
    const wayAfter = reset + 10 * 60_000; // 10 min past reset >> 3 min skew
    assert.equal(
      validatePauseState({ resetAtMs: reset, nextWakeupAtMs: wayAfter }, FIXED_NOW_MS),
      null,
    );
  });

  it('T16.2f without nowMs the staleness checks are skipped but skew still applies', () => {
    const reset = FIXED_NOW_MS - 1000; // would be stale if nowMs given
    const ok = validatePauseState({ resetAtMs: reset, nextWakeupAtMs: reset }, undefined);
    assert.deepEqual(ok, { resetAtMs: reset, nextWakeupAtMs: reset });
    assert.equal(
      validatePauseState({ resetAtMs: reset, nextWakeupAtMs: reset + 10 * 60_000 }, undefined),
      null,
    );
  });

  // -------------------------------------------------------------------------
  // T16.3 decidePauseAction predicate
  // -------------------------------------------------------------------------
  it('T16.3a null pause → schedule', () => {
    assert.equal(decidePauseAction(null, new Date(FIXED_NOW_MS)), 'schedule');
  });
  it('T16.3b pending wakeup (future) → wait', () => {
    const pause = { resetAtMs: FIXED_NOW_MS + 3600_000, nextWakeupAtMs: FIXED_NOW_MS + 1000 };
    assert.equal(decidePauseAction(pause, new Date(FIXED_NOW_MS)), 'wait');
  });
  it('T16.3c wakeup already fired (past) → schedule', () => {
    const pause = { resetAtMs: FIXED_NOW_MS + 3600_000, nextWakeupAtMs: FIXED_NOW_MS - 1000 };
    assert.equal(decidePauseAction(pause, new Date(FIXED_NOW_MS)), 'schedule');
  });

  // -------------------------------------------------------------------------
  // T16.4 ScheduleWakeup branch WRITES the latch (within 6h)
  // -------------------------------------------------------------------------
  it('T16.4 hard + ScheduleWakeup with delaySeconds → pause file written with computed nextWakeupAtMs', async () => {
    const { deps, exits, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: { delaySeconds: 3600, prompt: 'resume task' },
      }),
      initialFs: { [CACHE_PATH]: hardCache3h(), [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'ScheduleWakeup always exits 0');
    const written = fakeFs._peek(PAUSE_PATH);
    assert.ok(written, 'pause file must be written');
    const parsed = JSON.parse(written);
    assert.equal(parsed.resetAtMs, FIXED_NOW_MS + 3 * 60 * 60 * 1000, 'resetAtMs = window reset');
    assert.equal(parsed.nextWakeupAtMs, FIXED_NOW_MS + 3600 * 1000, 'nextWakeupAtMs = now + delay');
    assert.deepEqual(Object.keys(parsed).sort(), ['nextWakeupAtMs', 'resetAtMs'], 'only the two numbers');
  });

  // -------------------------------------------------------------------------
  // T16.5 ScheduleWakeup with reset > 6h does NOT write a latch (chain terminates)
  // -------------------------------------------------------------------------
  it('T16.5 hard + ScheduleWakeup but reset > 6h → no pause file (beyond resume horizon)', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      seven_day: { utilization: 99, resets_at: RESET_IN_8H },
    });
    const { deps, exits, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: { delaySeconds: 3600, prompt: 'resume task' },
      }),
      initialFs: { [CACHE_PATH]: cache, [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(fakeFs._peek(PAUSE_PATH), undefined, 'no latch beyond the 6h horizon');
  });

  // -------------------------------------------------------------------------
  // T16.6 PreToolUse hard + pending latch → WAIT message (no schedule invite)
  // -------------------------------------------------------------------------
  it('T16.6 PreToolUse hard + pending wakeup → exit 2, WAIT message, no ScheduleWakeup invite', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      initialFs: {
        [CACHE_PATH]: hardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
        [PAUSE_PATH]: pendingPauseJson(),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2, 'tool still blocked');
    assert.equal(stdout.length, 0, 'no stdout on PreToolUse');
    assert.equal(stderr.length, 1);
    assert.ok(stderr[0].includes('ALREADY scheduled'), 'must say a wakeup is already scheduled');
    assert.ok(stderr[0].includes('Do NOT schedule'), 'must tell the model to stand down');
    assert.ok(!stderr[0].includes('delaySeconds='), 'must NOT invite another ScheduleWakeup');
  });

  // -------------------------------------------------------------------------
  // T16.7 PreToolUse hard + NO/expired latch → normal block (ScheduleWakeup invite)
  // -------------------------------------------------------------------------
  it('T16.7 PreToolUse hard + no latch → normal block message invites ScheduleWakeup', async () => {
    const { deps, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      initialFs: { [CACHE_PATH]: hardCache3h(), [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2);
    assert.ok(stderr[0].includes('ScheduleWakeup'), 'normal block invites ScheduleWakeup');
    assert.ok(stderr[0].includes('delaySeconds='), 'normal block carries a delay');
  });

  // -------------------------------------------------------------------------
  // T16.8 Sub-agent never gets the WAIT path even with a pending latch
  // -------------------------------------------------------------------------
  it('T16.8 PreToolUse hard + pending latch + sub-agent → sub-agent brief, not WAIT', async () => {
    const { deps, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        agent_id: 'sub-123',
      }),
      initialFs: {
        [CACHE_PATH]: hardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
        [PAUSE_PATH]: pendingPauseJson(),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2);
    assert.ok(stderr[0].includes('sub-agent'), 'sub-agent gets the return-a-brief message');
    assert.ok(!stderr[0].includes('ALREADY scheduled'), 'sub-agent must not get the WAIT message');
  });

  // -------------------------------------------------------------------------
  // T16.9 UserPromptSubmit normal hard + pending latch → WAIT message, exit 2
  // -------------------------------------------------------------------------
  it('T16.9 UserPromptSubmit (unmarked) hard + pending latch → WAIT message, exit 2', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'keep going on the task',
      }),
      initialFs: {
        [CACHE_PATH]: hardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
        [PAUSE_PATH]: pendingPauseJson(),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2);
    assert.equal(stdout.length, 0);
    assert.ok(stderr[0].includes('ALREADY scheduled'));
    assert.ok(!stderr[0].includes('delaySeconds='));
  });

  // -------------------------------------------------------------------------
  // T16.10 RESUME_MARKER carve-out: a fired hop NEVER waits (stuck-state guard)
  // -------------------------------------------------------------------------
  it('T16.10 resume-hop marker + pending latch + still hard within 6h → reschedule, NOT wait', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: RESUME_MARKER + ' resume the analysis',
      }),
      initialFs: {
        [CACHE_PATH]: hardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
        [PAUSE_PATH]: pendingPauseJson(), // wakeup "pending" — but the hop fired
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'resume hop exits 0, never blocks');
    assert.equal(stderr.length, 0);
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0].includes('RESUME HOP'), 'fired hop re-instructs reschedule');
    assert.ok(stdout[0].includes('ScheduleWakeup'), 'must reschedule, not be strangled by the latch');
    assert.ok(!stdout[0].includes('ALREADY scheduled'), 'carve-out: must NOT emit the WAIT message');
  });

  // -------------------------------------------------------------------------
  // T16.11 Fail-open: corrupt latch on PreToolUse hard → SCHEDULE (normal block)
  // -------------------------------------------------------------------------
  it('T16.11 corrupt pause file → treated as no latch → normal block (never WAIT)', async () => {
    const { deps, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      initialFs: {
        [CACHE_PATH]: hardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
        [PAUSE_PATH]: '{ this is not json',
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2);
    assert.ok(stderr[0].includes('ScheduleWakeup'), 'corrupt latch must NOT cause a WAIT');
    assert.ok(!stderr[0].includes('ALREADY scheduled'));
  });

  // -------------------------------------------------------------------------
  // T16.12 Poisoning: far-future resetAtMs cannot pin WAIT (disable blocking)
  // -------------------------------------------------------------------------
  it('T16.12 poisoned far-future resetAtMs latch → ignored → normal block, not WAIT', async () => {
    const poisoned = JSON.stringify({
      resetAtMs: FIXED_NOW_MS + 100 * 60 * 60 * 1000, // 100h out
      nextWakeupAtMs: FIXED_NOW_MS + 99 * 60 * 60 * 1000,
    });
    const { deps, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      initialFs: {
        [CACHE_PATH]: hardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
        [PAUSE_PATH]: poisoned,
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2, 'block must still happen');
    assert.ok(!stderr[0].includes('ALREADY scheduled'), 'poisoned latch cannot pin WAIT');
    assert.ok(stderr[0].includes('ScheduleWakeup'));
  });

  // -------------------------------------------------------------------------
  // T16.13 A pause-write failure never traps the ScheduleWakeup path
  // -------------------------------------------------------------------------
  it('T16.13 pause write failure → ScheduleWakeup still exit 0, marker still stamped', async () => {
    const { deps, stdout, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: { delaySeconds: 3600, prompt: 'resume task' },
      }),
      initialFs: { [CACHE_PATH]: hardCache3h(), [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
    });
    // Make every write throw (covers the tmp write inside writePauseState).
    deps.fs.writeFile = async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };

    await main(deps);

    assert.equal(exits[0], 0, 'write failure must never trap the ScheduleWakeup path');
    // The marker stamp is emitted before the latch write, so stdout still has it.
    assert.equal(stdout.length, 1, 'marker stamp still emitted');
    assert.ok(JSON.parse(stdout[0]).hookSpecificOutput.updatedInput.prompt.startsWith(RESUME_MARKER));
  });

  // -------------------------------------------------------------------------
  // T16.14 Clear on resume-ready: marker prompt after reset unlinks the latch
  // -------------------------------------------------------------------------
  it('T16.14 resume-hop marker + window reset → pause file cleared', async () => {
    const cache = makeCacheJson(FIXED_NOW_MS, {
      // util 99 but reset already passed → parseWindows drops it → not hard.
      five_hour: { utilization: 99, resets_at: RESET_PAST },
    });
    const { deps, exits, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: RESUME_MARKER + ' resume the analysis',
      }),
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('tok'),
        [PAUSE_PATH]: pendingPauseJson(),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(fakeFs._peek(PAUSE_PATH), undefined, 'latch cleared once the pause is over');
    assert.ok(fakeFs.unlinks.some((u) => u.path === PAUSE_PATH), 'unlink recorded for the pause file');
  });

  // -------------------------------------------------------------------------
  // T16.15 No delaySeconds supplied → latch falls back to computeHopDelaySeconds
  // -------------------------------------------------------------------------
  it('T16.15 ScheduleWakeup with no delaySeconds → latch uses the computed hop delay', async () => {
    const { deps, exits, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: { prompt: 'resume task' }, // no delaySeconds
      }),
      initialFs: { [CACHE_PATH]: hardCache3h(), [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    const parsed = JSON.parse(fakeFs._peek(PAUSE_PATH));
    // computeHopDelaySeconds for a 3h reset = ceil(10800)+120 = 10920 → clamp 3600.
    assert.equal(parsed.nextWakeupAtMs, FIXED_NOW_MS + 3600 * 1000, 'latch falls back to the clamped hop delay');
  });

  // -------------------------------------------------------------------------
  // T16.16 Sub-60 delaySeconds → clamped to the 60s floor in BOTH stamp and latch
  // -------------------------------------------------------------------------
  it('T16.16 sub-60 delaySeconds → stamp and latch both clamp to 60s (no divergence)', async () => {
    const { deps, exits, stdout, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'ScheduleWakeup',
        tool_input: { delaySeconds: 10, prompt: 'resume task' }, // below the 60s floor
      }),
      initialFs: { [CACHE_PATH]: hardCache3h(), [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    // Stamp clamps to 60...
    assert.equal(JSON.parse(stdout[0]).hookSpecificOutput.updatedInput.delaySeconds, 60);
    // ...and the latch records the identical 60s.
    assert.equal(JSON.parse(fakeFs._peek(PAUSE_PATH)).nextWakeupAtMs, FIXED_NOW_MS + 60 * 1000);
  });
});
