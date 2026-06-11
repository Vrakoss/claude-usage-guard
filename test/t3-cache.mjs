/**
 * T3 — Cache behaviour
 *
 * TTL fresh  → no fetch called
 * Stale      → fetch called
 * Corrupt    → treated as miss (fetch called), no crash
 * Negative   → no fetch, fail-soft
 * Atomic write: temp file written then rename called
 * Written cache passes its own validateCache
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main, validateCache } from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCacheJson,
  makeNegativeCacheJson,
  makeCredsJson,
  CACHE_PATH,
  CREDS_PATH,
  CLAUDE_DIR,
  FIXED_NOW_MS,
  RESET_IN_3H,
  RESET_IN_8H,
} from './helpers.mjs';

const TTL_S = 60; // 60 second TTL used in all T3 tests
const TTL_MS = TTL_S * 1000;

function makeEnv() {
  return {
    CLAUDE_USAGE_GUARD_WARN: '80',
    CLAUDE_USAGE_GUARD_HARD: '95',
    CLAUDE_USAGE_GUARD_TTL: String(TTL_S),
  };
}

const UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit' });

// ---------------------------------------------------------------------------
// T3.1 Fresh cache → no fetch
// ---------------------------------------------------------------------------

describe('T3 — Cache', () => {
  it('T3.1 fresh cache (within TTL) → no fetch called', async () => {
    // fetchedAt == FIXED_NOW_MS, now == FIXED_NOW_MS → age=0 < TTL
    const cache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 30, resets_at: RESET_IN_3H },
    });

    const { deps, fetchCalls, exits } = makeDeps({
      env: makeEnv(),
      stdin: async () => UPS,
      initialFs: { [CACHE_PATH]: cache },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(fetchCalls.length, 0, 'fresh cache should not trigger a fetch');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T3.2 Stale cache → fetch called
  // -------------------------------------------------------------------------
  it('T3.2 stale cache (beyond TTL) → fetch called', async () => {
    // fetchedAt = FIXED_NOW_MS - 2*TTL_MS (stale), now = FIXED_NOW_MS
    const staleAt = FIXED_NOW_MS - 2 * TTL_MS;
    const cache = makeCacheJson(staleAt, {
      five_hour: { utilization: 30, resets_at: RESET_IN_3H },
    });

    // Need creds for the fetch path.
    const { deps, fetchCalls, exits } = makeDeps({
      env: makeEnv(),
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('test-token'),
      },
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

    assert.ok(fetchCalls.length >= 1, 'stale cache should trigger a fetch');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T3.3 Corrupt JSON cache → treated as miss (fetch called), no crash
  // -------------------------------------------------------------------------
  it('T3.3 corrupt JSON cache → treated as miss, fetch called, no crash', async () => {
    const { deps, fetchCalls, exits } = makeDeps({
      env: makeEnv(),
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: '{INVALID JSON>>>',
        [CREDS_PATH]: makeCredsJson('test-token'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return {};
        },
      }),
    });

    await main(deps);

    assert.ok(fetchCalls.length >= 1, 'corrupt cache should trigger a fetch (treated as miss)');
    assert.equal(exits[0], 0, 'corrupt cache must not crash — fail-soft exit 0');
  });

  // -------------------------------------------------------------------------
  // T3.4 Negative cache (failedAt < 5min ago) → no fetch, fail-soft exit 0
  // -------------------------------------------------------------------------
  it('T3.4 negative cache (failedAt < 5min ago) → no fetch called, exit 0', async () => {
    // failedAt = FIXED_NOW_MS - 60_000 (1 minute ago), within 5min window
    const failedAt = FIXED_NOW_MS - 60_000;
    const cache = makeNegativeCacheJson(failedAt, null, {});

    const { deps, fetchCalls, exits } = makeDeps({
      env: makeEnv(),
      stdin: async () => UPS,
      initialFs: { [CACHE_PATH]: cache },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(fetchCalls.length, 0, 'negative cache should suppress fetch');
    assert.equal(exits[0], 0, 'negative cache path must exit 0 (fail-soft)');
  });

  // -------------------------------------------------------------------------
  // T3.5 Negative cache expired (>5min ago) → fetch IS called
  // -------------------------------------------------------------------------
  it('T3.5 expired negative cache (failedAt > 5min ago) → fetch called', async () => {
    const FIVE_MIN_MS = 300_000;
    const failedAt = FIXED_NOW_MS - FIVE_MIN_MS - 1000; // just over 5min ago
    const cache = makeNegativeCacheJson(failedAt, null, {});

    const { deps, fetchCalls, exits } = makeDeps({
      env: makeEnv(),
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('test-token'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return {};
        },
      }),
    });

    await main(deps);

    assert.ok(fetchCalls.length >= 1, 'expired negative cache should trigger fetch');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T3.6 Atomic write: temp file written THEN rename called (not direct write)
  // -------------------------------------------------------------------------
  it('T3.6 cache write is atomic: temp file written then renamed to final path', async () => {
    const staleAt = FIXED_NOW_MS - 2 * TTL_MS;
    const cache = makeCacheJson(staleAt, {});

    const { deps, fakeFs, exits } = makeDeps({
      env: makeEnv(),
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('test-token'),
      },
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

    // A temp file should have been written.
    const tmpWrites = fakeFs.writes.filter((w) => w.path.includes('.tmp'));
    assert.ok(tmpWrites.length >= 1, 'should write a .tmp file');

    // A rename should have been called.
    assert.ok(fakeFs.renames.length >= 1, 'should rename temp to final cache path');

    // The final rename target should be the cache path.
    const finalRename = fakeFs.renames.find((r) => r.to === CACHE_PATH);
    assert.ok(finalRename, 'rename target must be the cache path');

    // The temp source should be in the same directory.
    assert.ok(finalRename.from.startsWith(CLAUDE_DIR), 'temp file must be in .claude dir');
    assert.ok(finalRename.from.includes('.tmp'), 'source should be a .tmp file');

    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T3.7 Written cache passes validateCache
  // -------------------------------------------------------------------------
  it('T3.7 written cache content passes validateCache — sound round-trip', async () => {
    const staleAt = FIXED_NOW_MS - 2 * TTL_MS;
    const cache = makeCacheJson(staleAt, {});

    const { deps, fakeFs, exits } = makeDeps({
      env: makeEnv(),
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('test-token'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return {
            five_hour: { utilization: 50, resets_at: RESET_IN_3H },
            seven_day: { utilization: 20, resets_at: RESET_IN_8H },
          };
        },
      }),
    });

    await main(deps);

    // Find the tmp write (that's what gets rename'd to the cache).
    const tmpWrite = fakeFs.writes.find((w) => w.path.includes('.tmp'));
    assert.ok(tmpWrite, 'should have a tmp write');

    const parsed = JSON.parse(tmpWrite.content);
    const validated = validateCache(parsed);
    assert.ok(validated !== null, 'written cache must pass validateCache');
    assert.ok(typeof validated.fetchedAt === 'number');
    assert.ok(Number.isFinite(validated.fetchedAt));

    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T3.8 Cache miss (no file) → fetch called
  // -------------------------------------------------------------------------
  it('T3.8 missing cache file → fetch called (miss path)', async () => {
    const { deps, fetchCalls, exits } = makeDeps({
      env: makeEnv(),
      stdin: async () => UPS,
      // No CACHE_PATH in initialFs.
      initialFs: { [CREDS_PATH]: makeCredsJson('test-token') },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return {};
        },
      }),
    });

    await main(deps);

    assert.ok(fetchCalls.length >= 1, 'missing cache → fetch');
    assert.equal(exits[0], 0);
  });

  // -------------------------------------------------------------------------
  // T3.9 Temp filename contains the pid (concurrent-hook collision guard)
  // -------------------------------------------------------------------------
  it('T3.9 tmp filename includes pid so concurrent hook processes cannot collide', async () => {
    const staleAt = FIXED_NOW_MS - 2 * TTL_MS;
    const cache = makeCacheJson(staleAt, {});

    const { deps, fakeFs, exits } = makeDeps({
      env: makeEnv(),
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: cache,
        [CREDS_PATH]: makeCredsJson('test-token'),
      },
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

    const tmpWrite = fakeFs.writes.find((w) => w.path.includes('.tmp'));
    assert.ok(tmpWrite, 'should write a .tmp file');
    // helpers.mjs makeDeps uses pid 4242.
    assert.ok(tmpWrite.path.includes('.4242.'), 'tmp filename must embed the pid');
    assert.equal(exits[0], 0);
  });
});
