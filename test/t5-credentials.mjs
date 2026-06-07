/**
 * T5 — Credentials acquisition
 *
 * win32 + linux: reads ~/.claude/.credentials.json (assert via fs recorder + homedir injection)
 * darwin:        execFile called with ['find-generic-password','-s','Claude Code-credentials','-w']
 * darwin keychain error → file fallback
 * darwin keychain timeout → file fallback
 * both missing → fail-soft exit 0, empty stdout, empty stderr
 *
 * INVARIANT TEST: source file text must NOT contain the literal string "refreshToken"
 *                 (machine-checked architect invariant — the script never reads it)
 */

import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { main } from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCredsJson,
  makeCacheJson,
  CACHE_PATH,
  CREDS_PATH,
  CLAUDE_DIR,
  HOME,
  FIXED_NOW_MS,
  RESET_IN_3H,
  SENTINEL_TOKEN,
} from './helpers.mjs';

const UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit' });
const ENV_ALWAYS_STALE = {
  CLAUDE_USAGE_GUARD_WARN: '80',
  CLAUDE_USAGE_GUARD_HARD: '95',
  CLAUDE_USAGE_GUARD_TTL: '0', // always stale → always fetches
};

// ---------------------------------------------------------------------------
// T5.0 — INVARIANT: source file never contains "refreshToken"
// ---------------------------------------------------------------------------

describe('T5 — Credentials', () => {
  it('T5.0 INVARIANT: scripts/usage-guard.mjs never reads "refreshToken"', async () => {
    const src = await readFile(
      new URL('../scripts/usage-guard.mjs', import.meta.url),
      'utf8'
    );
    // The string must appear ZERO times in the source code.
    const count = (src.match(/refreshToken/g) || []).length;
    assert.equal(count, 0,
      'Architect invariant violated: "refreshToken" must not appear in usage-guard.mjs');
  });

  // -------------------------------------------------------------------------
  // T5.1 linux: reads credentials from ~/.claude/.credentials.json
  // -------------------------------------------------------------------------
  it('T5.1 linux: reads credentials from correct path under homedir', async () => {
    const customHome = '/custom/home/linux';
    const credsPath = `${customHome}/.claude/.credentials.json`;

    const { deps, fetchCalls, fakeFs } = makeDeps({
      env: ENV_ALWAYS_STALE,
      stdin: async () => UPS,
      platform: 'linux',
      homedir: () => customHome,
      initialFs: {
        [credsPath]: makeCredsJson('linux-token'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() { return {}; },
      }),
    });

    await main(deps);

    // readFile should have been called with the correct creds path.
    const credsRead = fakeFs.reads.find((r) => r.path.includes('.credentials.json'));
    assert.ok(credsRead, 'should have read the credentials file');
    assert.ok(credsRead.path.includes(customHome), 'creds path must use injected homedir');

    // Fetch should have been called (proving the token was found and used).
    assert.ok(fetchCalls.length >= 1, 'fetch should be called when creds are found');
  });

  // -------------------------------------------------------------------------
  // T5.2 win32: reads credentials from the correct path
  // -------------------------------------------------------------------------
  it('T5.2 win32: reads credentials from correct path under homedir', async () => {
    const customHome = 'C:/Users/WinUser';
    const credsPath = `${customHome}/.claude/.credentials.json`;

    const { deps, fetchCalls, fakeFs } = makeDeps({
      env: ENV_ALWAYS_STALE,
      stdin: async () => UPS,
      platform: 'win32',
      homedir: () => customHome,
      initialFs: {
        [credsPath]: makeCredsJson('win32-token'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() { return {}; },
      }),
    });

    await main(deps);

    const credsRead = fakeFs.reads.find((r) => r.path.includes('.credentials.json'));
    assert.ok(credsRead, 'should have read the credentials file on win32');
    // Path should use the custom homedir.
    const normRead = credsRead.path.replace(/\\/g, '/');
    assert.ok(normRead.includes('C:/Users/WinUser'), 'must use injected homedir');

    assert.ok(fetchCalls.length >= 1);
  });

  // -------------------------------------------------------------------------
  // T5.3 darwin: execFile called with correct security arguments
  // -------------------------------------------------------------------------
  it('T5.3 darwin: execFile called with find-generic-password args', async () => {
    const { deps, execCalls, exits } = makeDeps({
      env: ENV_ALWAYS_STALE,
      stdin: async () => UPS,
      platform: 'darwin',
      initialFs: {},
      now: () => new Date(FIXED_NOW_MS),
      execFileImpl: (_cmd, _args, _opts, cb) => {
        cb(null, 'darwin-keychain-token\n');
        return { on() {} };
      },
      fetchImpl: async () => ({
        status: 200,
        async json() { return {}; },
      }),
    });

    await main(deps);

    assert.ok(execCalls.length >= 1, 'execFile should be called on darwin');
    const keychainCall = execCalls[0];
    assert.equal(keychainCall.cmd, 'security');
    assert.ok(Array.isArray(keychainCall.args));
    assert.ok(keychainCall.args.includes('find-generic-password'));
    assert.ok(keychainCall.args.includes('-s'));
    assert.ok(keychainCall.args.includes('Claude Code-credentials'));
    assert.ok(keychainCall.args.includes('-w'));
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T5.4 darwin: keychain error → file fallback
  // -------------------------------------------------------------------------
  it('T5.4 darwin: keychain error → file fallback used', async () => {
    const { deps, fetchCalls, exits } = makeDeps({
      env: ENV_ALWAYS_STALE,
      stdin: async () => UPS,
      platform: 'darwin',
      initialFs: { [CREDS_PATH]: makeCredsJson('fallback-file-token') },
      now: () => new Date(FIXED_NOW_MS),
      execFileImpl: (_cmd, _args, _opts, cb) => {
        // Simulate keychain error.
        cb(new Error('keychain access denied'), '');
        return { on() {} };
      },
      fetchImpl: async () => ({
        status: 200,
        async json() { return {}; },
      }),
    });

    await main(deps);

    // Fetch must have been called (file fallback worked).
    assert.ok(fetchCalls.length >= 1, 'file fallback should allow fetch');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T5.5 darwin: keychain timeout (err.killed = true) → file fallback
  // -------------------------------------------------------------------------
  it('T5.5 darwin: keychain timeout (err.killed=true) → file fallback', async () => {
    const { deps, fetchCalls, exits } = makeDeps({
      env: ENV_ALWAYS_STALE,
      stdin: async () => UPS,
      platform: 'darwin',
      initialFs: { [CREDS_PATH]: makeCredsJson('timeout-fallback-token') },
      now: () => new Date(FIXED_NOW_MS),
      execFileImpl: (_cmd, _args, _opts, cb) => {
        // Simulate a killed/timed-out process.
        const err = Object.assign(new Error('killed'), { killed: true });
        cb(err, '');
        return { on() {} };
      },
      fetchImpl: async () => ({
        status: 200,
        async json() { return {}; },
      }),
    });

    await main(deps);

    assert.ok(fetchCalls.length >= 1, 'file fallback after timeout should allow fetch');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T5.6 darwin: both keychain and file missing → fail-soft exit 0, empty output
  // -------------------------------------------------------------------------
  it('T5.6 darwin: keychain error + no file → fail-soft exit 0, empty stdout/stderr', async () => {
    const { deps, stdout, stderr, exits, fetchCalls } = makeDeps({
      env: ENV_ALWAYS_STALE,
      stdin: async () => UPS,
      platform: 'darwin',
      initialFs: {}, // No creds file.
      now: () => new Date(FIXED_NOW_MS),
      execFileImpl: (_cmd, _args, _opts, cb) => {
        cb(new Error('no keychain item'), '');
        return { on() {} };
      },
    });

    await main(deps);

    assert.equal(exits[0], 0, 'missing creds → fail-soft exit 0');
    assert.equal(stdout.length, 0, 'empty stdout when creds missing');
    assert.equal(stderr.length, 0, 'empty stderr when creds missing');
    assert.equal(fetchCalls.length, 0, 'no fetch when creds missing');
  });

  // -------------------------------------------------------------------------
  // T5.7 linux: missing credentials file → fail-soft exit 0
  // -------------------------------------------------------------------------
  it('T5.7 linux: missing credentials file → fail-soft exit 0, empty output', async () => {
    const { deps, stdout, stderr, exits, fetchCalls } = makeDeps({
      env: ENV_ALWAYS_STALE,
      stdin: async () => UPS,
      platform: 'linux',
      initialFs: {}, // No creds file.
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length, 0);
    assert.equal(fetchCalls.length, 0);
  });

  // -------------------------------------------------------------------------
  // T5.8 darwin: keychain returns empty string → file fallback
  // -------------------------------------------------------------------------
  it('T5.8 darwin: keychain returns empty string → file fallback', async () => {
    const { deps, fetchCalls, exits } = makeDeps({
      env: ENV_ALWAYS_STALE,
      stdin: async () => UPS,
      platform: 'darwin',
      initialFs: { [CREDS_PATH]: makeCredsJson('empty-keychain-fallback') },
      now: () => new Date(FIXED_NOW_MS),
      execFileImpl: (_cmd, _args, _opts, cb) => {
        cb(null, '   '); // whitespace only → trimmed → empty string
        return { on() {} };
      },
      fetchImpl: async () => ({
        status: 200,
        async json() { return {}; },
      }),
    });

    await main(deps);

    assert.ok(fetchCalls.length >= 1, 'empty keychain output → file fallback → fetch');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T5.9 darwin: SIGKILL timeout (err.signal='SIGKILL') → file fallback
  // -------------------------------------------------------------------------
  it('T5.9 darwin: SIGKILL timeout signal → file fallback', async () => {
    const { deps, fetchCalls, exits } = makeDeps({
      env: ENV_ALWAYS_STALE,
      stdin: async () => UPS,
      platform: 'darwin',
      initialFs: { [CREDS_PATH]: makeCredsJson('sigkill-fallback') },
      now: () => new Date(FIXED_NOW_MS),
      execFileImpl: (_cmd, _args, _opts, cb) => {
        const err = Object.assign(new Error('SIGKILL'), { signal: 'SIGKILL' });
        cb(err, '');
        return { on() {} };
      },
      fetchImpl: async () => ({
        status: 200,
        async json() { return {}; },
      }),
    });

    await main(deps);

    assert.ok(fetchCalls.length >= 1, 'SIGKILL fallback → fetch');
    assert.equal(exits[0], 0);
  });
});
