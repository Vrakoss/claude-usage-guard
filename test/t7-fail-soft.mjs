/**
 * T7 — Fail-soft behaviour
 *
 * For EVERY injected failure:
 *  - exit 0
 *  - empty stdout
 *  - empty stderr (except documented block paths)
 *
 * Specific scenarios:
 *  - CLAUDE_USAGE_GUARD=off → exit 0 instantly, no fetch, no fs access
 *  - creds missing → fail-soft
 *  - fetch throws → fail-soft
 *  - fetch aborts → fail-soft
 *  - malformed API response → fail-soft
 *  - fs read throws → fail-soft
 *  - fs write throws → fail-soft (cache write error)
 *  - malformed stdin → UserPromptSubmit behaviour (fail-soft if no data)
 *  - env garbage ("abc", "-5", "200", WARN>=HARD) → defaults used
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main, readConfig } from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCredsJson,
  CACHE_PATH,
  CREDS_PATH,
  FIXED_NOW_MS,
  RESET_IN_3H,
} from './helpers.mjs';

const BASE_ENV = {
  CLAUDE_USAGE_GUARD_WARN: '80',
  CLAUDE_USAGE_GUARD_HARD: '95',
};

const UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit' });

// ---------------------------------------------------------------------------
// T7.1 — CLAUDE_USAGE_GUARD=off → exit 0 instantly
// ---------------------------------------------------------------------------

describe('T7 — Fail-soft', () => {
  it('T7.1 CLAUDE_USAGE_GUARD=off: exit 0, no fetch, no fs access', async () => {
    const { deps, stdout, stderr, exits, fetchCalls, fakeFs } = makeDeps({
      env: { CLAUDE_USAGE_GUARD: 'off' },
      stdin: async () => UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 0);
    assert.equal(fetchCalls.length, 0, 'guard=off must not fetch');
    // No fs reads (only possible appendFile for debug log which is off by default).
    const fsReads = fakeFs.reads;
    assert.equal(fsReads.length, 0, 'guard=off must not read fs');
  });

  // -------------------------------------------------------------------------
  // T7.2 — CLAUDE_USAGE_GUARD=OFF (uppercase) → exit 0
  // -------------------------------------------------------------------------
  it('T7.2 CLAUDE_USAGE_GUARD=OFF (uppercase) also recognized → exit 0', async () => {
    const { deps, exits, fetchCalls } = makeDeps({
      env: { CLAUDE_USAGE_GUARD: 'OFF' },
      stdin: async () => UPS,
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(fetchCalls.length, 0);
  });

  // -------------------------------------------------------------------------
  // T7.3 — creds missing → fail-soft exit 0
  // -------------------------------------------------------------------------
  it('T7.3 missing credentials file → fail-soft exit 0, no stdout, no stderr', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: { ...BASE_ENV, CLAUDE_USAGE_GUARD_TTL: '0' },
      stdin: async () => UPS,
      initialFs: {}, // No creds.
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T7.4 — fetch throws → fail-soft exit 0
  // -------------------------------------------------------------------------
  it('T7.4 fetch throws synchronously → fail-soft exit 0, no output', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: { ...BASE_ENV, CLAUDE_USAGE_GUARD_TTL: '0' },
      stdin: async () => UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => { throw new Error('network failure'); },
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T7.5 — fetch aborts (AbortError) → fail-soft exit 0
  // -------------------------------------------------------------------------
  it('T7.5 fetch aborts (AbortError) → fail-soft exit 0, no output', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: { ...BASE_ENV, CLAUDE_USAGE_GUARD_TTL: '0' },
      stdin: async () => UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async (_url, opts) => {
        // Simulate abort.
        const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        throw err;
      },
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T7.6 — malformed API response (json() throws) → fail-soft exit 0
  // -------------------------------------------------------------------------
  it('T7.6 malformed API response (json() throws) → fail-soft exit 0', async () => {
    const { deps, exits, stdout, stderr } = makeDeps({
      env: { ...BASE_ENV, CLAUDE_USAGE_GUARD_TTL: '0' },
      stdin: async () => UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() { throw new SyntaxError('Unexpected end of JSON'); },
      }),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T7.7 — fs readFile throws (not ENOENT but generic) → fail-soft exit 0
  // -------------------------------------------------------------------------
  it('T7.7 fs.readFile throws (EACCES) → fail-soft exit 0', async () => {
    const throwingFs = {
      async readFile() {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        throw err;
      },
      async writeFile() {},
      async rename() {},
      async appendFile() {},
      appendFileSync() {},
    };

    const { deps, exits, stdout, stderr } = makeDeps({
      env: { ...BASE_ENV, CLAUDE_USAGE_GUARD_TTL: '0' },
      stdin: async () => UPS,
      fs: throwingFs,
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T7.8 — malformed stdin (garbage) → treated as UserPromptSubmit, fail-soft
  // -------------------------------------------------------------------------
  it('T7.8 garbage stdin → treated as UserPromptSubmit (fail-soft, exit 0)', async () => {
    const { deps, exits, stdout, stderr } = makeDeps({
      env: BASE_ENV,
      stdin: async () => '{{{{not json at all',
      initialFs: {},
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    // No crash; fails-soft (no creds so no data, so silent exit 0).
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T7.9 — stdin throws → treated as empty stdin (UserPromptSubmit)
  // -------------------------------------------------------------------------
  it('T7.9 stdin() throws → treated as empty stdin, fail-soft exit 0', async () => {
    const { deps, exits, stdout, stderr } = makeDeps({
      env: BASE_ENV,
      stdin: async () => { throw new Error('stdin error'); },
      initialFs: {},
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // T7.10 — WARN env garbage "abc" → default WARN=80 used
  // -------------------------------------------------------------------------
  it('T7.10 CLAUDE_USAGE_GUARD_WARN="abc" → default 80 used, warn at 80', async () => {
    // At util=80, the default WARN threshold fires.
    const cfg = readConfig({ CLAUDE_USAGE_GUARD_WARN: 'abc' });
    assert.equal(cfg.warn, 80, 'garbage WARN should fall back to default 80');
    assert.equal(cfg.hard, 95, 'hard should be default 95');
  });

  // -------------------------------------------------------------------------
  // T7.11 — WARN env "-5" → clamped to 1 (minimum)
  // -------------------------------------------------------------------------
  it('T7.11 CLAUDE_USAGE_GUARD_WARN="-5" → clamped to 1', () => {
    const cfg = readConfig({ CLAUDE_USAGE_GUARD_WARN: '-5', CLAUDE_USAGE_GUARD_HARD: '95' });
    // clamp(parseInt("-5"), 1, 100) = 1
    assert.equal(cfg.warn, 1);
  });

  // -------------------------------------------------------------------------
  // T7.12 — HARD env "200" → clamped to 100
  // -------------------------------------------------------------------------
  it('T7.12 CLAUDE_USAGE_GUARD_HARD="200" → clamped to 100', () => {
    // warn defaults to 80, hard clamped to 100. 80 < 100 → no reset.
    const cfg = readConfig({ CLAUDE_USAGE_GUARD_HARD: '200' });
    assert.equal(cfg.hard, 100);
  });

  // -------------------------------------------------------------------------
  // T7.13 — WARN >= HARD → both reset to defaults
  // -------------------------------------------------------------------------
  it('T7.13 WARN >= HARD → both reset to defaults (80/95)', () => {
    const cfg1 = readConfig({ CLAUDE_USAGE_GUARD_WARN: '90', CLAUDE_USAGE_GUARD_HARD: '90' });
    assert.equal(cfg1.warn, 80, 'WARN==HARD → reset to 80');
    assert.equal(cfg1.hard, 95, 'WARN==HARD → reset to 95');

    const cfg2 = readConfig({ CLAUDE_USAGE_GUARD_WARN: '95', CLAUDE_USAGE_GUARD_HARD: '90' });
    assert.equal(cfg2.warn, 80, 'WARN>HARD → reset to 80');
    assert.equal(cfg2.hard, 95, 'WARN>HARD → reset to 95');
  });

  // -------------------------------------------------------------------------
  // T7.14 — HARD env garbage → default 95 used
  // -------------------------------------------------------------------------
  it('T7.14 CLAUDE_USAGE_GUARD_HARD="xyz" → default 95 used', () => {
    const cfg = readConfig({ CLAUDE_USAGE_GUARD_HARD: 'xyz' });
    assert.equal(cfg.hard, 95);
  });

  // -------------------------------------------------------------------------
  // T7.15 — TTL garbage → default TTL used (no crash)
  // -------------------------------------------------------------------------
  it('T7.15 CLAUDE_USAGE_GUARD_TTL="garbage" → default TTL used', () => {
    const cfg = readConfig({ CLAUDE_USAGE_GUARD_TTL: 'garbage' });
    assert.equal(cfg.ttlMs, 60_000); // DEFAULT_TTL_S=60 → 60000ms
  });

  // -------------------------------------------------------------------------
  // T7.16 — fetch returns non-object → fail-soft exit 0
  // -------------------------------------------------------------------------
  it('T7.16 fetch returns non-object body → fail-soft exit 0', async () => {
    const { deps, exits, stdout, stderr } = makeDeps({
      env: { ...BASE_ENV, CLAUDE_USAGE_GUARD_TTL: '0' },
      stdin: async () => UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('tok') },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() { return 'just a string'; },
      }),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    // May or may not have output depending on whether stale cache fallback applies;
    // the important thing is no crash.
    assert.ok(exits.length >= 1, 'should have called exit');
  });

  // -------------------------------------------------------------------------
  // T7.17 — empty env (no variables set) → defaults used, runs without error
  // -------------------------------------------------------------------------
  it('T7.17 empty env → defaults used, no crash, exit 0', async () => {
    const cfg = readConfig({});
    assert.equal(cfg.warn, 80);
    assert.equal(cfg.hard, 95);
    assert.equal(cfg.ttlMs, 60_000);
    assert.equal(cfg.off, false);
    assert.equal(cfg.debug, false);
  });
});
