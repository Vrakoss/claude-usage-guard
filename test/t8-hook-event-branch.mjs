/**
 * T8 — Hook event branch (parseHookInput)
 *
 * Tests the pure parseHookInput helper and its integration in main():
 *  - {"hook_event_name":"PreToolUse","tool_name":"Bash"}  → PreToolUse behaviour
 *  - {"hook_event_name":"UserPromptSubmit"}               → UserPromptSubmit behaviour
 *  - empty stdin                                           → UserPromptSubmit behaviour
 *  - garbage stdin                                         → UserPromptSubmit behaviour
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHookInput, main } from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCacheJson,
  makeCredsJson,
  CACHE_PATH,
  CREDS_PATH,
  FIXED_NOW_MS,
  RESET_IN_3H,
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// parseHookInput unit tests
// ---------------------------------------------------------------------------

describe('T8 — parseHookInput (pure function)', () => {
  it('T8.1 valid PreToolUse JSON → returns parsed object', () => {
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    const result = parseHookInput(input);
    assert.equal(result.hook_event_name, 'PreToolUse');
    assert.equal(result.tool_name, 'Bash');
  });

  it('T8.2 valid UserPromptSubmit JSON → returns parsed object', () => {
    const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit' });
    const result = parseHookInput(input);
    assert.equal(result.hook_event_name, 'UserPromptSubmit');
  });

  it('T8.2b UTF-8 BOM-prefixed JSON (PowerShell pipe) → parsed, event preserved', () => {
    const input = '﻿' + JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    const result = parseHookInput(input);
    assert.equal(result.hook_event_name, 'PreToolUse');
    assert.equal(result.tool_name, 'Bash');
  });

  it('T8.3 empty string → UserPromptSubmit', () => {
    const result = parseHookInput('');
    assert.equal(result.hook_event_name, 'UserPromptSubmit');
  });

  it('T8.4 whitespace-only string → UserPromptSubmit', () => {
    const result = parseHookInput('   \n\t  ');
    assert.equal(result.hook_event_name, 'UserPromptSubmit');
  });

  it('T8.5 garbage/invalid JSON → UserPromptSubmit', () => {
    const result = parseHookInput('{{not json}}');
    assert.equal(result.hook_event_name, 'UserPromptSubmit');
  });

  it('T8.6 null input → UserPromptSubmit', () => {
    const result = parseHookInput(null);
    assert.equal(result.hook_event_name, 'UserPromptSubmit');
  });

  it('T8.7 JSON array (not object) → UserPromptSubmit', () => {
    const result = parseHookInput('[1, 2, 3]');
    assert.equal(result.hook_event_name, 'UserPromptSubmit');
  });

  it('T8.8 JSON object without hook_event_name → defaults to UserPromptSubmit', () => {
    const result = parseHookInput(JSON.stringify({ tool_name: 'Bash' }));
    assert.equal(result.hook_event_name, 'UserPromptSubmit');
    assert.equal(result.tool_name, 'Bash'); // other keys preserved
  });

  it('T8.9 JSON object with non-string hook_event_name → defaults to UserPromptSubmit', () => {
    const result = parseHookInput(JSON.stringify({ hook_event_name: 42 }));
    assert.equal(result.hook_event_name, 'UserPromptSubmit');
  });

  it('T8.10 extra fields in PreToolUse object are preserved', () => {
    const result = parseHookInput(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 'abc123',
    }));
    assert.equal(result.hook_event_name, 'PreToolUse');
    assert.equal(result.tool_name, 'Bash');
    assert.equal(result.session_id, 'abc123');
  });
});

// ---------------------------------------------------------------------------
// Integration: hook event routes to correct behaviour in main()
// ---------------------------------------------------------------------------

const ENV = {
  CLAUDE_USAGE_GUARD_WARN: '80',
  CLAUDE_USAGE_GUARD_HARD: '95',
  CLAUDE_USAGE_GUARD_TTL: '3600',
};

// Cache at ok level (below WARN) — so both events produce distinct, comparable outputs.
function makeOkCache() {
  return makeCacheJson(FIXED_NOW_MS, {
    five_hour: { utilization: 30, resets_at: RESET_IN_3H },
  });
}

// Cache at HARD level — so both events produce distinct block vs. no-stdout outputs.
function makeHardCache() {
  return makeCacheJson(FIXED_NOW_MS, {
    five_hour: { utilization: 99, resets_at: RESET_IN_3H },
  });
}

describe('T8 — Hook event branch (integration via main)', () => {
  // -------------------------------------------------------------------------
  // T8.11 UserPromptSubmit at ok level → stdout summary, exit 0
  // -------------------------------------------------------------------------
  it('T8.11 UserPromptSubmit (ok level) → stdout summary, exit 0', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
      initialFs: {
        [CACHE_PATH]: makeOkCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0].includes('[usage]'));
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T8.12 PreToolUse (Bash) at ok level → no stdout, exit 0
  // -------------------------------------------------------------------------
  it('T8.12 PreToolUse Bash (ok level) → zero stdout, exit 0', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      initialFs: {
        [CACHE_PATH]: makeOkCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0, 'PreToolUse must never write to stdout');
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T8.13 Empty stdin treated as UserPromptSubmit → stdout, exit 0
  // -------------------------------------------------------------------------
  it('T8.13 empty stdin → UserPromptSubmit behaviour: stdout summary', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => '',
      initialFs: {
        [CACHE_PATH]: makeOkCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    // Should behave as UserPromptSubmit → write summary to stdout.
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0].includes('[usage]'));
  });

  // -------------------------------------------------------------------------
  // T8.14 Garbage stdin → UserPromptSubmit behaviour: stdout summary
  // -------------------------------------------------------------------------
  it('T8.14 garbage stdin → UserPromptSubmit behaviour: stdout summary', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => 'not json at all !!!',
      initialFs: {
        [CACHE_PATH]: makeOkCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 1);
    assert.ok(stdout[0].includes('[usage]'));
  });

  // -------------------------------------------------------------------------
  // T8.15 PreToolUse hard block has no stdout (only stderr)
  // -------------------------------------------------------------------------
  it('T8.15 PreToolUse Bash at HARD level → zero stdout, stderr block, exit 2', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2);
    assert.equal(stdout.length, 0, 'PreToolUse block must not write to stdout');
    assert.equal(stderr.length, 1);
    assert.ok(stderr[0].includes('QUOTA GUARD'));
  });

  // -------------------------------------------------------------------------
  // T8.16 UserPromptSubmit hard block → stderr block, exit 2, no stdout
  // -------------------------------------------------------------------------
  it('T8.16 UserPromptSubmit at HARD level → stderr block, exit 2, zero stdout', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
      initialFs: {
        [CACHE_PATH]: makeHardCache(),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 2);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 1);
    assert.ok(stderr[0].includes('QUOTA GUARD'));
    assert.ok(stderr[0].includes('CLAUDE_USAGE_GUARD=off'));
  });
});
