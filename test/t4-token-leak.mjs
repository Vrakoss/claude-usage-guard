/**
 * T4 — TOKEN-LEAK GUARD (critical security suite)
 *
 * Sentinel token: "SENTINEL-TOKEN-abc123XYZ"
 *
 * Assert:
 *  - Sentinel appears in ZERO recorded outputs (stdout, stderr, every fs write/append)
 *  - Sentinel appears in EXACTLY ONE place: Authorization header of the recorded fetch call
 *  - All error paths (fetch throws, 401, 429, malformed JSON, fs write errors, keychain
 *    errors, debug mode ON) also never leak the token
 *
 * Also tests makeTokenHolder directly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { main, makeTokenHolder } from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCredsJson,
  makeCacheJson,
  CACHE_PATH,
  CREDS_PATH,
  CLAUDE_DIR,
  DEBUG_LOG_PATH,
  FIXED_NOW_MS,
  RESET_IN_3H,
  SENTINEL_TOKEN,
  allRecordedOutput,
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// makeTokenHolder unit tests
// ---------------------------------------------------------------------------

describe('T4 — makeTokenHolder', () => {
  it('T4.0a makeTokenHolder.use() returns the raw value', () => {
    const h = makeTokenHolder(SENTINEL_TOKEN);
    assert.equal(h.use(), SENTINEL_TOKEN);
  });

  it('T4.0b makeTokenHolder.toString() returns "[redacted]"', () => {
    const h = makeTokenHolder(SENTINEL_TOKEN);
    assert.equal(String(h), '[redacted]');
    assert.equal(h.toString(), '[redacted]');
  });

  it('T4.0c JSON.stringify of holder yields "[redacted]"', () => {
    const h = makeTokenHolder(SENTINEL_TOKEN);
    const json = JSON.stringify({ token: h });
    assert.ok(!json.includes(SENTINEL_TOKEN), 'raw token must not appear in JSON.stringify output');
    assert.ok(json.includes('[redacted]'));
  });

  it('T4.0d util.inspect of holder yields "[redacted]"', () => {
    const h = makeTokenHolder(SENTINEL_TOKEN);
    const inspected = inspect(h);
    assert.ok(!inspected.includes(SENTINEL_TOKEN), 'raw token must not appear in util.inspect');
    assert.ok(inspected.includes('[redacted]'));
  });

});

// ---------------------------------------------------------------------------
// Shared assertion: sentinel must not appear in any output channel
// ---------------------------------------------------------------------------

function assertNoTokenLeak(recorders, label = '') {
  const allOutput = allRecordedOutput(recorders);
  for (const output of allOutput) {
    if (typeof output === 'string') {
      assert.ok(!output.includes(SENTINEL_TOKEN),
        `${label} Token sentinel leaked in output: "${output.slice(0, 200)}"`);
    }
  }
}

function assertTokenInAuthHeaderOnly(fetchCalls, label = '') {
  // For successful fetch paths: sentinel should be in exactly one Authorization header.
  let authCount = 0;
  for (const call of fetchCalls) {
    const authHeader = call.options?.headers?.Authorization ?? '';
    if (authHeader.includes(SENTINEL_TOKEN)) {
      authCount++;
    }
    // Token must NOT appear in URL or other headers.
    assert.ok(!call.url.includes(SENTINEL_TOKEN),
      `${label} Token leaked into URL: ${call.url}`);
    const headers = call.options?.headers ?? {};
    for (const [key, val] of Object.entries(headers)) {
      if (key === 'Authorization') continue;
      assert.ok(!String(val).includes(SENTINEL_TOKEN),
        `${label} Token leaked into non-Auth header ${key}: ${val}`);
    }
  }
  return authCount;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV = {
  CLAUDE_USAGE_GUARD_WARN: '80',
  CLAUDE_USAGE_GUARD_HARD: '95',
  CLAUDE_USAGE_GUARD_TTL: '0', // always stale → always fetches
};
const UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit' });

function makeCredsFs() {
  return { [CREDS_PATH]: makeCredsJson(SENTINEL_TOKEN) };
}

// ---------------------------------------------------------------------------
// T4.1 — Happy path: token only in Auth header
// ---------------------------------------------------------------------------

describe('T4 — Token leak guard (integration)', () => {
  it('T4.1 happy path: sentinel in exactly one Auth header, never in stdout/stderr/fs', async () => {
    const { deps, stdout, stderr, exits, fetchCalls, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      initialFs: makeCredsFs(),
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return {
            five_hour: { utilization: 30, resets_at: RESET_IN_3H },
          };
        },
      }),
    });

    await main(deps);

    assertNoTokenLeak({ stdout, stderr, fakeFs }, 'T4.1 happy:');
    const authCount = assertTokenInAuthHeaderOnly(fetchCalls, 'T4.1 happy:');
    assert.equal(authCount, 1, 'sentinel should appear in exactly one Auth header');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T4.2 — fetch throws with error message containing sentinel
  // -------------------------------------------------------------------------
  it('T4.2 fetch throws with error.message containing sentinel: token never in output', async () => {
    const { deps, stdout, stderr, exits, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      initialFs: makeCredsFs(),
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => {
        // Error whose message contains the sentinel — must never reach output.
        throw new Error(`Connection failed: ${SENTINEL_TOKEN}`);
      },
    });

    await main(deps);

    assertNoTokenLeak({ stdout, stderr, fakeFs }, 'T4.2 fetch-throw:');
    assert.equal(exits[0], 0, 'fetch throw must be fail-soft exit 0');
    assert.equal(stdout.length, 0, 'no stdout on fail-soft');
    assert.equal(stderr.length, 0, 'no stderr on fail-soft');
  });

  // -------------------------------------------------------------------------
  // T4.3 — fetch returns 401
  // -------------------------------------------------------------------------
  it('T4.3 fetch 401: sentinel never in output, exit 0', async () => {
    const { deps, stdout, stderr, exits, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      initialFs: makeCredsFs(),
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({ status: 401, async json() { return {}; } }),
    });

    await main(deps);

    assertNoTokenLeak({ stdout, stderr, fakeFs }, 'T4.3 401:');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T4.4 — fetch returns 429
  // -------------------------------------------------------------------------
  it('T4.4 fetch 429: sentinel never in output, exit 0', async () => {
    const { deps, stdout, stderr, exits, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      initialFs: makeCredsFs(),
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({ status: 429, async json() { return {}; } }),
    });

    await main(deps);

    assertNoTokenLeak({ stdout, stderr, fakeFs }, 'T4.4 429:');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T4.5 — fetch returns malformed JSON
  // -------------------------------------------------------------------------
  it('T4.5 fetch malformed JSON response: sentinel never in output, exit 0', async () => {
    const { deps, stdout, stderr, exits, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      initialFs: makeCredsFs(),
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() { throw new Error('Unexpected token'); },
      }),
    });

    await main(deps);

    assertNoTokenLeak({ stdout, stderr, fakeFs }, 'T4.5 malformed-json:');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T4.6 — fs write error
  // -------------------------------------------------------------------------
  it('T4.6 fs write error: sentinel never in output, exit 0', async () => {
    const { deps, stdout, stderr, exits, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      initialFs: makeCredsFs(),
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return { five_hour: { utilization: 30, resets_at: RESET_IN_3H } };
        },
      }),
      fs: {
        ...makeDeps({ initialFs: makeCredsFs() }).fakeFs.fs,
        // Override writeFile to throw (simulating disk error)
        async writeFile(path, content, opts) {
          if (path.includes('.tmp')) {
            throw new Error(`ENOSPC: ${SENTINEL_TOKEN}`);
          }
        },
        async rename() { throw new Error('rename failed'); },
        async readFile(path) {
          if (path.includes('.credentials')) {
            return makeCredsJson(SENTINEL_TOKEN);
          }
          const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          throw err;
        },
        async appendFile() {},
        appendFileSync() {},
      },
    });

    await main(deps);

    assertNoTokenLeak({ stdout, stderr, fakeFs }, 'T4.6 fs-write-error:');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T4.7 — debug mode ON: sentinel still never in debug log
  // -------------------------------------------------------------------------
  it('T4.7 debug mode ON: sentinel never in debug log, stdout, stderr', async () => {
    const { deps, stdout, stderr, exits, fakeFs } = makeDeps({
      env: { ...ENV, CLAUDE_USAGE_GUARD_DEBUG: '1' },
      stdin: async () => UPS,
      initialFs: makeCredsFs(),
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return { five_hour: { utilization: 30, resets_at: RESET_IN_3H } };
        },
      }),
    });

    await main(deps);

    assertNoTokenLeak({ stdout, stderr, fakeFs }, 'T4.7 debug-mode:');
    assert.equal(exits[0], 0);

    // Debug log should exist but contain no sentinel.
    const debugContent = fakeFs._peek(DEBUG_LOG_PATH) ?? '';
    assert.ok(!debugContent.includes(SENTINEL_TOKEN),
      'debug log must not contain sentinel token');
  });

  // -------------------------------------------------------------------------
  // T4.8 — debug mode ON with fetch throw (error message has sentinel)
  // -------------------------------------------------------------------------
  it('T4.8 debug mode + fetch throw (error.message has sentinel): no leak in any channel', async () => {
    const { deps, stdout, stderr, exits, fakeFs } = makeDeps({
      env: { ...ENV, CLAUDE_USAGE_GUARD_DEBUG: '1' },
      stdin: async () => UPS,
      initialFs: makeCredsFs(),
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => {
        throw new Error(`Request failed: ${SENTINEL_TOKEN}`);
      },
    });

    await main(deps);

    assertNoTokenLeak({ stdout, stderr, fakeFs }, 'T4.8 debug+throw:');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T4.9 — keychain returns sentinel (darwin path)
  // -------------------------------------------------------------------------
  it('T4.9 darwin keychain returns sentinel: appears only in Auth header, never in outputs', async () => {
    const { deps, stdout, stderr, exits, fetchCalls, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      platform: 'darwin',
      // No creds file — use keychain only.
      initialFs: {},
      now: () => new Date(FIXED_NOW_MS),
      execFileImpl: (_cmd, _args, _opts, cb) => {
        cb(null, SENTINEL_TOKEN + '\n'); // keychain returns the token
        return { on() {} };
      },
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return { five_hour: { utilization: 30, resets_at: RESET_IN_3H } };
        },
      }),
    });

    await main(deps);

    assertNoTokenLeak({ stdout, stderr, fakeFs }, 'T4.9 darwin-keychain:');
    const authCount = assertTokenInAuthHeaderOnly(fetchCalls, 'T4.9 darwin-keychain:');
    assert.ok(authCount >= 1, 'sentinel should appear in Auth header');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T4.10 — hard block path: token still never leaks (different exit code)
  // -------------------------------------------------------------------------
  it('T4.10 hard-block path: sentinel in exactly one Auth header, not in stderr block message', async () => {
    const { deps, stdout, stderr, exits, fetchCalls, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => UPS,
      initialFs: makeCredsFs(),
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return { five_hour: { utilization: 99, resets_at: RESET_IN_3H } };
        },
      }),
    });

    await main(deps);

    assertNoTokenLeak({ stdout, stderr, fakeFs }, 'T4.10 hard-block:');
    assert.equal(exits[0], 2);
    // Block message in stderr must not contain sentinel.
    for (const line of stderr) {
      assert.ok(!line.includes(SENTINEL_TOKEN));
    }
  });
});
