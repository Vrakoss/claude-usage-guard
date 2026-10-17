/**
 * T18 — Generic per-model windows + versioned cache schema (v0.7.0, issue #10)
 *
 * The usage endpoint may return per-model windows beyond the original four
 * (e.g. `seven_day_fable`, or a future `seven_day_xyz`). They must survive into
 * the status line, threshold evaluation (weekly thresholds) and the cache, with
 * the same strict per-entry validation, bounded in number. The cache file is a
 * read-only contract for other tools, so it carries `schemaVersion`; a cache
 * without it (or with an unknown version) is a miss (refetch), never a crash.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  main,
  validateCache,
  parseWindows,
  evaluateThresholds,
  readConfig,
  windowLabelForKey,
  CACHE_SCHEMA_VERSION,
  MAX_WINDOWS,
} from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCacheJson,
  makeCredsJson,
  allRecordedOutput,
  CACHE_PATH,
  CREDS_PATH,
  DEBUG_LOG_PATH,
  FIXED_NOW_MS,
  RESET_IN_3H,
  RESET_IN_8H,
  RESET_PAST,
  SENTINEL_TOKEN,
} from './helpers.mjs';

const UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
const NOW = new Date(FIXED_NOW_MS);

function okResponse(body) {
  return async () => ({
    status: 200,
    async json() {
      return body;
    },
  });
}

/** Run a UserPromptSubmit against a live (fake) fetch with no prior cache. */
async function runFetch(body, extra = {}) {
  const r = makeDeps({
    env: { CLAUDE_USAGE_GUARD_DEBUG: '1', ...(extra.env ?? {}) },
    stdin: async () => UPS,
    initialFs: {
      [CREDS_PATH]: makeCredsJson(extra.token ?? 'tok'),
      ...(extra.initialFs ?? {}),
    },
    fetchImpl: okResponse(body),
  });
  await main(r.deps);
  const cacheText = r.fakeFs._peek(CACHE_PATH);
  const cache = cacheText === undefined ? undefined : JSON.parse(cacheText);
  return { ...r, cache };
}

describe('T18 — key → label derivation', () => {
  it('T18.1 known keys keep their labels; new keys derive 7d-/5h- labels', () => {
    assert.equal(windowLabelForKey('five_hour'), '5h');
    assert.equal(windowLabelForKey('seven_day'), '7d');
    assert.equal(windowLabelForKey('seven_day_opus'), '7d-opus');
    assert.equal(windowLabelForKey('seven_day_sonnet'), '7d-sonnet');
    assert.equal(windowLabelForKey('seven_day_fable'), '7d-fable');
    assert.equal(windowLabelForKey('seven_day_xyz'), '7d-xyz');
    assert.equal(windowLabelForKey('seven_day_oauth_apps'), '7d-oauth-apps');
    assert.equal(windowLabelForKey('five_hour_fable'), '5h-fable');
  });

  it('T18.2 keys outside the strict grammar get no label (dropped)', () => {
    for (const k of [
      'extra_usage',
      'seven_day_',
      'seven_dayx',
      'seven_day_Fable',
      'seven_day_fa-ble',
      'seven_day_fa ble',
      'seven_day__x',
      'seven_day_x_',
      'seven_day_<script>',
      `seven_day_${'a'.repeat(64)}`,
      '__proto__',
      'constructor',
      '',
    ]) {
      assert.equal(windowLabelForKey(k), null, `key ${JSON.stringify(k)} must be rejected`);
    }
  });
});

describe('T18 — seven_day_fable / seven_day_xyz end to end', () => {
  for (const key of ['seven_day_fable', 'seven_day_xyz']) {
    const label = windowLabelForKey(key);

    it(`T18.3 ${key} → ${label} in status line and cache`, async () => {
      const { stdout, exits, cache } = await runFetch({
        five_hour: { utilization: 10, resets_at: RESET_IN_3H },
        seven_day: { utilization: 20, resets_at: RESET_IN_8H },
        [key]: { utilization: 42, resets_at: RESET_IN_8H },
      });
      assert.deepEqual(exits, [0]);
      const line = stdout.join('\n');
      assert.match(line, new RegExp(`${label}: 42% \\(reset `));
      assert.equal(cache.schemaVersion, CACHE_SCHEMA_VERSION);
      assert.deepEqual(cache.windows[key], {
        utilization: 42,
        resets_at: new Date(RESET_IN_8H).toISOString(),
      });
    });

    it(`T18.4 ${key} is evaluated with the WEEKLY thresholds`, () => {
      const cfg = readConfig({});
      const data = validateCache(
        { fetchedAt: FIXED_NOW_MS, failedAt: null, windows: { [key]: { utilization: 92, resets_at: RESET_IN_8H } } },
        FIXED_NOW_MS,
      );
      const windows = parseWindows(data, NOW);
      assert.deepEqual(windows.map((w) => w.label), [label]);
      // 92 >= weekly warn 90 but < weekly hard 95 → warn (base hard 95 would be the same,
      // but base warn 80 vs weekly warn 90 is the discriminator below).
      assert.equal(evaluateThresholds(windows, cfg).level, 'warn');
      const at85 = parseWindows(
        validateCache(
          { fetchedAt: FIXED_NOW_MS, failedAt: null, windows: { [key]: { utilization: 85, resets_at: RESET_IN_8H } } },
          FIXED_NOW_MS,
        ),
        NOW,
      );
      // 85 would warn under the base 5h thresholds (80) but is ok under weekly (90).
      assert.equal(evaluateThresholds(at85, cfg).level, 'ok');
    });

    it(`T18.5 ${key} at the weekly hard limit blocks the prompt`, async () => {
      const { exits, stderr } = await runFetch({
        five_hour: { utilization: 10, resets_at: RESET_IN_3H },
        [key]: { utilization: 97, resets_at: RESET_IN_3H },
      });
      assert.deepEqual(exits, [2]);
      assert.match(stderr.join('\n'), new RegExp(`${label} window at 97%`));
    });
  }

  it('T18.6 five_hour_* windows use the base (5h) thresholds', () => {
    const cfg = readConfig({});
    const data = validateCache(
      { fetchedAt: FIXED_NOW_MS, failedAt: null, windows: { five_hour_fable: { utilization: 85, resets_at: RESET_IN_3H } } },
      FIXED_NOW_MS,
    );
    const windows = parseWindows(data, NOW);
    assert.deepEqual(windows.map((w) => w.label), ['5h-fable']);
    assert.equal(evaluateThresholds(windows, cfg).level, 'warn');
  });
});

describe('T18 — bounded window count', () => {
  it(`T18.7 more than MAX_WINDOWS windows: known kept, excess dropped`, async () => {
    assert.equal(MAX_WINDOWS, 16);
    const body = {};
    // Extra keys FIRST in payload order, so a naive first-N cut would drop the known ones.
    for (let i = 0; i < 40; i++) {
      body[`seven_day_m${String(i).padStart(2, '0')}`] = { utilization: 1, resets_at: RESET_IN_8H };
    }
    body.five_hour = { utilization: 10, resets_at: RESET_IN_3H };
    body.seven_day = { utilization: 20, resets_at: RESET_IN_8H };
    body.seven_day_opus = { utilization: 30, resets_at: RESET_IN_8H };
    body.seven_day_sonnet = { utilization: 40, resets_at: RESET_IN_8H };

    const { exits, cache } = await runFetch(body);
    assert.deepEqual(exits, [0]);
    const keys = Object.keys(cache.windows);
    assert.equal(keys.length, MAX_WINDOWS);
    for (const k of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
      assert.ok(keys.includes(k), `known window ${k} must be kept`);
    }
    // Deterministic: the surviving extras are the lexicographically first ones.
    const extras = keys.filter((k) => k.startsWith('seven_day_m'));
    assert.deepEqual(extras, extras.slice().sort());
    assert.equal(extras[0], 'seven_day_m00');
    assert.equal(extras.length, MAX_WINDOWS - 4);
  });

  it('T18.8 the bound also applies on cache read (poisoned oversized cache file)', () => {
    const windows = {};
    for (let i = 0; i < 100; i++) {
      windows[`seven_day_z${String(i).padStart(3, '0')}`] = { utilization: 1, resets_at: RESET_IN_8H };
    }
    windows.five_hour = { utilization: 99, resets_at: RESET_IN_3H };
    const clean = validateCache({ fetchedAt: FIXED_NOW_MS, failedAt: null, windows }, FIXED_NOW_MS);
    assert.equal(Object.keys(clean.windows).length, MAX_WINDOWS);
    assert.ok(clean.windows.five_hour);
    assert.equal(parseWindows(clean, NOW).length, MAX_WINDOWS);
  });

  it('T18.9 invalid extra entries do not consume the bound', () => {
    const windows = {};
    for (let i = 0; i < 30; i++) {
      windows[`seven_day_a${String(i).padStart(2, '0')}`] = { utilization: 'x', resets_at: RESET_IN_8H };
    }
    windows.seven_day_zeta = { utilization: 5, resets_at: RESET_IN_8H };
    const clean = validateCache({ fetchedAt: FIXED_NOW_MS, failedAt: null, windows }, FIXED_NOW_MS);
    assert.deepEqual(Object.keys(clean.windows), ['seven_day_zeta']);
  });
});

describe('T18 — invalid entries are still dropped', () => {
  const bad = {
    'non-finite utilization (NaN)': { utilization: NaN, resets_at: RESET_IN_8H },
    'non-finite utilization (Infinity)': { utilization: Infinity, resets_at: RESET_IN_8H },
    'string utilization': { utilization: '50', resets_at: RESET_IN_8H },
    'bad date': { utilization: 50, resets_at: 'not a date' },
    'numeric date': { utilization: 50, resets_at: 1_700_000_000 },
    'past resets_at': { utilization: 50, resets_at: RESET_PAST },
    'array entry': [50, RESET_IN_8H],
  };
  for (const [name, entry] of Object.entries(bad)) {
    it(`T18.10 seven_day_fable with ${name} is dropped; valid windows survive`, async () => {
      const { exits, stdout, cache } = await runFetch({
        five_hour: { utilization: 10, resets_at: RESET_IN_3H },
        seven_day_fable: entry,
      });
      assert.deepEqual(exits, [0]);
      assert.ok(!('seven_day_fable' in cache.windows));
      assert.ok(cache.windows.five_hour);
      assert.doesNotMatch(stdout.join('\n'), /7d-fable/);
    });
  }

  it('T18.11 utilization of an extra window is clamped to 0..100', () => {
    const clean = validateCache(
      {
        fetchedAt: FIXED_NOW_MS,
        failedAt: null,
        windows: {
          seven_day_hi: { utilization: 250, resets_at: RESET_IN_8H },
          seven_day_lo: { utilization: -5, resets_at: RESET_IN_8H },
        },
      },
      FIXED_NOW_MS,
    );
    assert.equal(clean.windows.seven_day_hi.utilization, 100);
    assert.equal(clean.windows.seven_day_lo.utilization, 0);
  });

  it('T18.12 a malformed KNOWN window still rejects the whole response (unchanged)', () => {
    const clean = validateCache(
      {
        fetchedAt: FIXED_NOW_MS,
        failedAt: null,
        windows: {
          five_hour: { utilization: 'x', resets_at: RESET_IN_3H },
          seven_day_fable: { utilization: 5, resets_at: RESET_IN_8H },
        },
      },
      FIXED_NOW_MS,
    );
    assert.equal(clean, null);
  });

  it('T18.13 keys outside the grammar are dropped from the cache', async () => {
    const { cache } = await runFetch({
      five_hour: { utilization: 10, resets_at: RESET_IN_3H },
      extra_usage: { utilization: 10, resets_at: RESET_IN_8H },
      'seven_day_<b>': { utilization: 10, resets_at: RESET_IN_8H },
      SEVEN_DAY_X: { utilization: 10, resets_at: RESET_IN_8H },
    });
    assert.deepEqual(Object.keys(cache.windows), ['five_hour']);
  });
});

describe('T18 — cache schemaVersion', () => {
  it('T18.14 written cache has exactly {schemaVersion, fetchedAt, failedAt, windows}', async () => {
    assert.equal(CACHE_SCHEMA_VERSION, 1);
    const { cache } = await runFetch({ five_hour: { utilization: 10, resets_at: RESET_IN_3H } });
    assert.deepEqual(Object.keys(cache), ['schemaVersion', 'fetchedAt', 'failedAt', 'windows']);
    assert.equal(cache.schemaVersion, 1);
    assert.equal(cache.fetchedAt, FIXED_NOW_MS);
    assert.equal(cache.failedAt, null);
  });

  it('T18.15 the negative-cache marker also carries schemaVersion', async () => {
    const r = makeDeps({
      stdin: async () => UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('tok') },
      fetchImpl: async () => ({ status: 500, async json() { return {}; } }),
    });
    await main(r.deps);
    const cache = JSON.parse(r.fakeFs._peek(CACHE_PATH));
    assert.equal(cache.schemaVersion, 1);
    assert.equal(cache.fetchedAt, null);
    assert.equal(cache.failedAt, FIXED_NOW_MS);
  });

  const fresh = {
    five_hour: { utilization: 99, resets_at: RESET_IN_3H },
  };
  const variants = {
    'missing schemaVersion': (o) => { delete o.schemaVersion; return JSON.stringify(o); },
    'unknown schemaVersion 2': (o) => JSON.stringify({ ...o, schemaVersion: 2 }),
    'string schemaVersion "1"': (o) => JSON.stringify({ ...o, schemaVersion: '1' }),
    'null schemaVersion': (o) => JSON.stringify({ ...o, schemaVersion: null }),
  };
  for (const [name, mk] of Object.entries(variants)) {
    it(`T18.16 cache with ${name} is a miss → refetch, no crash`, async () => {
      const base = JSON.parse(makeCacheJson(FIXED_NOW_MS, fresh));
      const r = makeDeps({
        env: { CLAUDE_USAGE_GUARD_TTL: '3600' },
        stdin: async () => UPS,
        initialFs: { [CACHE_PATH]: mk(base), [CREDS_PATH]: makeCredsJson('tok') },
        fetchImpl: okResponse({ five_hour: { utilization: 12, resets_at: RESET_IN_3H } }),
      });
      await main(r.deps);
      assert.equal(r.fetchCalls.length, 1, 'must refetch');
      // The 99% from the unversioned cache must not block; the fresh 12% drives output.
      assert.deepEqual(r.exits, [0]);
      assert.match(r.stdout.join('\n'), /5h: 12%/);
      const rewritten = JSON.parse(r.fakeFs._peek(CACHE_PATH));
      assert.equal(rewritten.schemaVersion, 1);
    });
  }

  it('T18.17 a current-version cache within TTL is a hit (no fetch)', async () => {
    const r = makeDeps({
      env: { CLAUDE_USAGE_GUARD_TTL: '3600' },
      stdin: async () => UPS,
      initialFs: {
        [CACHE_PATH]: makeCacheJson(FIXED_NOW_MS, {
          five_hour: { utilization: 12, resets_at: RESET_IN_3H },
          seven_day_fable: { utilization: 33, resets_at: RESET_IN_8H },
        }),
        [CREDS_PATH]: makeCredsJson('tok'),
      },
    });
    await main(r.deps);
    assert.equal(r.fetchCalls.length, 0);
    assert.match(r.stdout.join('\n'), /7d-fable: 33%/);
  });

  it('T18.18 unversioned cache with creds missing: fail-open, no crash, no block', async () => {
    const base = JSON.parse(makeCacheJson(FIXED_NOW_MS, fresh));
    delete base.schemaVersion;
    const r = makeDeps({
      env: { CLAUDE_USAGE_GUARD_TTL: '3600' },
      stdin: async () => UPS,
      initialFs: { [CACHE_PATH]: JSON.stringify(base) },
    });
    await main(r.deps);
    assert.deepEqual(r.exits, [0]);
    assert.equal(r.stderr.length, 0);
  });
});

describe('T18 — token never leaks via the new windows path', () => {
  it('T18.19 sentinel token absent from stdout, stderr, cache and debug log', async () => {
    const r = await runFetch(
      {
        five_hour: { utilization: 10, resets_at: RESET_IN_3H },
        seven_day_fable: { utilization: 97, resets_at: RESET_IN_3H },
        seven_day_xyz: { utilization: 50, resets_at: RESET_IN_8H },
        [`seven_day_${SENTINEL_TOKEN}`]: { utilization: 50, resets_at: RESET_IN_8H },
      },
      { token: SENTINEL_TOKEN },
    );
    assert.deepEqual(r.exits, [2]);
    for (const part of allRecordedOutput(r)) {
      assert.ok(!String(part).includes(SENTINEL_TOKEN), 'sentinel token leaked');
    }
    assert.ok(r.fakeFs._peek(DEBUG_LOG_PATH) !== undefined, 'debug log was exercised');
  });
});
