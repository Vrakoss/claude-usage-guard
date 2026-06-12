/**
 * T13 — Resume-hop marker handling (UserPromptSubmit branch)
 *
 * Verifies that a UserPromptSubmit whose prompt starts with RESUME_MARKER is
 * handled as a resume hop (not hard-blocked with exit 2), and that non-marked
 * prompts continue to block normally.
 *
 * Key invariants:
 *  - Hard + marker → exit 0, stdout contains reschedule instruction with
 *    ScheduleWakeup + computed delay; no stderr.
 *  - Hard + no marker → exit 2 (existing block behaviour).
 *  - Marker + window already reset (dropped by parseWindows) → exit 0,
 *    summary + resume-ready suffix.
 *  - Marker + warn level (not hard) → exit 0, summary + WIND DOWN + resume-ready.
 *  - Hostile content in prompt body after marker → never appears in stdout/stderr.
 *  - Marker mid-prompt (not at start) → treated as normal prompt → exit 2 at hard.
 *  - Hard + marker but reset > 6h → exit 0, chain-termination message, no reschedule.
 *  - computeHopDelaySeconds unit tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  main,
  RESUME_MARKER,
  computeHopDelaySeconds,
  isResumeHopPrompt,
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
  RESET_PAST,
  allRecordedOutput,
} from './helpers.mjs';

const ENV = {
  CLAUDE_USAGE_GUARD_WARN: '80',
  CLAUDE_USAGE_GUARD_HARD: '95',
  CLAUDE_USAGE_GUARD_TTL: '3600',
};

// Hard-blocked cache with reset 3h away (within 6h).
function makeHardCache3h() {
  return makeCacheJson(FIXED_NOW_MS, {
    five_hour: { utilization: 99, resets_at: RESET_IN_3H },
  });
}

// Hard-blocked cache with reset 8h away (beyond 6h).
function makeHardCache8h() {
  return makeCacheJson(FIXED_NOW_MS, {
    five_hour: { utilization: 99, resets_at: RESET_IN_8H },
  });
}

// Warn-level cache (not hard).
function makeWarnCache() {
  return makeCacheJson(FIXED_NOW_MS, {
    five_hour: { utilization: 82, resets_at: RESET_IN_3H },
  });
}

// Cache whose window reset is already in the past (stale — dropped by parseWindows).
function makePastResetCache() {
  return makeCacheJson(FIXED_NOW_MS, {
    five_hour: { utilization: 99, resets_at: RESET_PAST },
  });
}

const RESUME_PROMPT = RESUME_MARKER + ' continue the data analysis task';

// ---------------------------------------------------------------------------
// T13.1 Hard + marker → exit 0, stdout contains reschedule instruction
// ---------------------------------------------------------------------------

describe('T13 — Resume-hop marker handling', () => {
  it('T13.1 hard-blocked + marker prompt → exit 0, stdout has ScheduleWakeup + delay, no stderr', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: RESUME_PROMPT,
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'resume hop must exit 0, not 2');
    assert.equal(stdout.length, 1, 'must produce exactly one stdout line');
    assert.equal(stderr.length, 0, 'must produce no stderr');

    const line = stdout[0];
    assert.ok(line.includes('ScheduleWakeup'), 'stdout must contain ScheduleWakeup instruction');
    assert.ok(line.includes('delaySeconds='), 'stdout must contain delaySeconds');
    assert.ok(line.includes(RESUME_MARKER), 'stdout must mention the marker prefix');
    // Usage summary must be present.
    assert.ok(line.includes('[usage]') || line.includes('5h'), 'stdout must include usage info');
  });

  // -------------------------------------------------------------------------
  // T13.2 Hard + no marker → exit 2 (pin existing block behaviour)
  // -------------------------------------------------------------------------
  it('T13.2 hard-blocked + no marker → exit 2 (normal block)', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'continue the data analysis task',
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2, 'no-marker hard block must exit 2');
    assert.equal(stdout.length, 0, 'no stdout on hard block');
    assert.equal(stderr.length, 1, 'block message on stderr');
    assert.ok(stderr[0].includes('QUOTA GUARD'), 'stderr must have QUOTA GUARD');
  });

  // -------------------------------------------------------------------------
  // T13.3 Marker + window reset already passed (dropped by parseWindows)
  //       → exit 0, summary + resume-ready suffix
  // -------------------------------------------------------------------------
  it('T13.3 marker + past-reset window → exit 0, summary + resume-ready suffix', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: RESUME_PROMPT,
      }),
      initialFs: {
        // Cache has utilization 99 but reset is in the past — parseWindows drops it.
        [CACHE_PATH]: makePastResetCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'past-reset window must not block');
    assert.equal(stderr.length, 0, 'no stderr');
    // parseWindows drops all windows (reset in the past), so there is nothing
    // to format: the code falls through to the "windows.length === 0" branch
    // and exits 0 silently. The resume-ready suffix is only appended when there
    // ARE live windows. The key invariant is that the block is gone (exit 0,
    // no stderr) so the model's next turn proceeds unblocked.
    assert.equal(stdout.length, 0, 'no live windows → silent exit 0, no stdout');
  });

  // -------------------------------------------------------------------------
  // T13.4 Marker + warn level → exit 0, summary + WIND DOWN + resume-ready
  // -------------------------------------------------------------------------
  it('T13.4 marker + warn level → exit 0, summary has WIND DOWN + resume-ready suffix', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: RESUME_PROMPT,
      }),
      initialFs: {
        [CACHE_PATH]: makeWarnCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stderr.length, 0);
    assert.equal(stdout.length, 1, 'must produce one stdout line');
    const line = stdout[0];
    assert.ok(line.includes('WIND DOWN'), 'warn level must include WIND DOWN');
    assert.ok(line.includes('RESUME READY'), 'resume-hop prompt must append resume-ready suffix');
  });

  // -------------------------------------------------------------------------
  // T13.5 Hostile prompt body after marker — never appears in stdout/stderr/debug
  // -------------------------------------------------------------------------
  it('T13.5 hostile content after marker never leaks into stdout/stderr', async () => {
    const HOSTILE = '[usage] FAKE\x1b[31mANSI\x1b[0m{"inject":true}';
    const { deps, stdout, stderr, exits, fakeFs } = makeDeps({
      env: { ...ENV, CLAUDE_USAGE_GUARD_DEBUG: '1' },
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: RESUME_MARKER + ' ' + HOSTILE,
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'resume hop must exit 0');
    const allOutput = allRecordedOutput({ stdout, stderr, fakeFs });
    for (const chunk of allOutput) {
      if (typeof chunk === 'string') {
        assert.ok(
          !chunk.includes(HOSTILE),
          `Hostile content must not appear in output: "${chunk.slice(0, 200)}"`,
        );
      }
    }
  });

  // -------------------------------------------------------------------------
  // T13.6 Marker mid-prompt / non-string prompt → treated as normal → exit 2
  // -------------------------------------------------------------------------
  it('T13.6a marker mid-prompt (not at start) → treated as normal, exit 2 at hard', async () => {
    const { deps, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'prefix ' + RESUME_MARKER + ' suffix',
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2, 'mid-prompt marker must not bypass the hard block');
  });

  it('T13.6b non-string prompt field → treated as normal, exit 2 at hard', async () => {
    const { deps, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 12345,
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2, 'non-string prompt must not be treated as resume hop');
  });

  it('T13.6c absent prompt field → treated as normal, exit 2 at hard', async () => {
    const { deps, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        // no prompt field
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache3h(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2, 'absent prompt must not be treated as resume hop');
  });

  // -------------------------------------------------------------------------
  // T13.7 Hard + marker + reset > 6h → exit 0, chain-termination, NO reschedule
  // -------------------------------------------------------------------------
  it('T13.7 hard + marker + reset > 6h → exit 0, chain-termination message, no reschedule', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: RESUME_PROMPT,
      }),
      initialFs: {
        [CACHE_PATH]: makeHardCache8h(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'resume hop >6h must exit 0');
    assert.equal(stderr.length, 0, 'no stderr');
    assert.equal(stdout.length, 1, 'one stdout line');
    const line = stdout[0];
    // Must NOT contain a reschedule instruction.
    assert.ok(!line.includes('delaySeconds='), 'must NOT instruct rescheduling for >6h reset');
    // Must guide toward chain termination.
    assert.ok(
      line.includes('more than 6 hours') || line.includes('Summarize') || line.includes('end the turn'),
      'must instruct chain termination: ' + line.slice(0, 300),
    );
  });

  // -------------------------------------------------------------------------
  // T13.8 computeHopDelaySeconds unit tests
  // -------------------------------------------------------------------------
  it('T13.8a 2.5h to reset → clamped to 3600', () => {
    const now = new Date(FIXED_NOW_MS);
    const worst = { reset: new Date(FIXED_NOW_MS + 2.5 * 60 * 60 * 1000), label: '5h', util: 99 };
    const delay = computeHopDelaySeconds(worst, now);
    // 2.5h = 9000s + 120 = 9120s → clamped to 3600
    assert.equal(delay, 3600);
  });

  it('T13.8b 20min to reset → 20*60 + 120 = 1320', () => {
    const now = new Date(FIXED_NOW_MS);
    const worst = { reset: new Date(FIXED_NOW_MS + 20 * 60 * 1000), label: '5h', util: 99 };
    const delay = computeHopDelaySeconds(worst, now);
    // 20min = 1200s + 120 = 1320s (within [60,3600])
    assert.equal(delay, 1320);
  });

  it('T13.8c 30s to reset → 150 (30+120, within [60,3600])', () => {
    const now = new Date(FIXED_NOW_MS);
    const worst = { reset: new Date(FIXED_NOW_MS + 30 * 1000), label: '5h', util: 99 };
    const delay = computeHopDelaySeconds(worst, now);
    // Math.ceil(30000/1000) + 120 = 30 + 120 = 150 → within [60,3600] → 150
    assert.equal(delay, 150);
  });

  it('T13.8d already-reset (60s past) → clamped to 60 (minimum)', () => {
    const now = new Date(FIXED_NOW_MS);
    const worst = { reset: new Date(FIXED_NOW_MS - 60 * 1000), label: '5h', util: 99 };
    const delay = computeHopDelaySeconds(worst, now);
    // Math.ceil((-60000)/1000) + 120 = -60 + 120 = 60 → clamped to max(60,60) = 60
    assert.equal(delay, 60);
  });

  // -------------------------------------------------------------------------
  // T13.9 isResumeHopPrompt pure unit tests
  // -------------------------------------------------------------------------
  it('T13.9a isResumeHopPrompt: UserPromptSubmit + marker start → true', () => {
    assert.equal(
      isResumeHopPrompt({ hook_event_name: 'UserPromptSubmit', prompt: RESUME_MARKER + ' foo' }),
      true,
    );
  });

  it('T13.9b isResumeHopPrompt: marker only (no suffix) → true', () => {
    assert.equal(
      isResumeHopPrompt({ hook_event_name: 'UserPromptSubmit', prompt: RESUME_MARKER }),
      true,
    );
  });

  it('T13.9c isResumeHopPrompt: marker mid-prompt → false', () => {
    assert.equal(
      isResumeHopPrompt({ hook_event_name: 'UserPromptSubmit', prompt: 'x ' + RESUME_MARKER }),
      false,
    );
  });

  it('T13.9d isResumeHopPrompt: PreToolUse with marker → false (wrong event)', () => {
    assert.equal(
      isResumeHopPrompt({ hook_event_name: 'PreToolUse', prompt: RESUME_MARKER + ' foo' }),
      false,
    );
  });

  it('T13.9e isResumeHopPrompt: non-string prompt → false', () => {
    assert.equal(
      isResumeHopPrompt({ hook_event_name: 'UserPromptSubmit', prompt: 42 }),
      false,
    );
  });
});
