/**
 * T9 — URL hardening
 *
 * Asserts that regardless of any environment variable set to a malicious URL,
 * the recorded fetch URL is EXACTLY the hardcoded
 * "https://api.anthropic.com/api/oauth/usage".
 *
 * Variables tested: CLAUDE_USAGE_GUARD_URL, ANTHROPIC_BASE_URL, USAGE_URL,
 * ANTHROPIC_API_URL, and arbitrary made-up names — all must be ignored.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCredsJson,
  CREDS_PATH,
  FIXED_NOW_MS,
} from './helpers.mjs';

const EXPECTED_URL = 'https://api.anthropic.com/api/oauth/usage';
const EVIL_URL = 'https://evil.example.com/steal-tokens';

const BASE_ENV = {
  CLAUDE_USAGE_GUARD_WARN: '80',
  CLAUDE_USAGE_GUARD_HARD: '95',
  CLAUDE_USAGE_GUARD_TTL: '0', // always stale → always fetches
};

const UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit' });

async function runWithEnv(extraEnv) {
  const { deps, fetchCalls, exits } = makeDeps({
    env: { ...BASE_ENV, ...extraEnv },
    stdin: async () => UPS,
    initialFs: { [CREDS_PATH]: makeCredsJson('test-token') },
    now: () => new Date(FIXED_NOW_MS),
    fetchImpl: async () => ({
      status: 200,
      async json() { return {}; },
    }),
  });

  await main(deps);

  return { fetchCalls, exits };
}

describe('T9 — URL hardening', () => {
  // -------------------------------------------------------------------------
  // T9.1 CLAUDE_USAGE_GUARD_URL=evil → hardcoded URL still used
  // -------------------------------------------------------------------------
  it('T9.1 CLAUDE_USAGE_GUARD_URL=evil does not redirect fetch', async () => {
    const { fetchCalls } = await runWithEnv({ CLAUDE_USAGE_GUARD_URL: EVIL_URL });

    assert.ok(fetchCalls.length >= 1, 'should have fetched');
    for (const call of fetchCalls) {
      assert.equal(call.url, EXPECTED_URL,
        `fetch URL must be hardcoded, got: ${call.url}`);
    }
  });

  // -------------------------------------------------------------------------
  // T9.2 ANTHROPIC_BASE_URL=evil → hardcoded URL still used
  // -------------------------------------------------------------------------
  it('T9.2 ANTHROPIC_BASE_URL=evil does not redirect fetch', async () => {
    const { fetchCalls } = await runWithEnv({ ANTHROPIC_BASE_URL: EVIL_URL });

    assert.ok(fetchCalls.length >= 1);
    for (const call of fetchCalls) {
      assert.equal(call.url, EXPECTED_URL);
    }
  });

  // -------------------------------------------------------------------------
  // T9.3 USAGE_URL=evil → hardcoded URL still used
  // -------------------------------------------------------------------------
  it('T9.3 USAGE_URL=evil does not redirect fetch', async () => {
    const { fetchCalls } = await runWithEnv({ USAGE_URL: EVIL_URL });

    assert.ok(fetchCalls.length >= 1);
    for (const call of fetchCalls) {
      assert.equal(call.url, EXPECTED_URL);
    }
  });

  // -------------------------------------------------------------------------
  // T9.4 ANTHROPIC_API_URL=evil → hardcoded URL still used
  // -------------------------------------------------------------------------
  it('T9.4 ANTHROPIC_API_URL=evil does not redirect fetch', async () => {
    const { fetchCalls } = await runWithEnv({ ANTHROPIC_API_URL: EVIL_URL });

    assert.ok(fetchCalls.length >= 1);
    for (const call of fetchCalls) {
      assert.equal(call.url, EXPECTED_URL);
    }
  });

  // -------------------------------------------------------------------------
  // T9.5 Multiple evil URL env vars simultaneously → hardcoded URL wins
  // -------------------------------------------------------------------------
  it('T9.5 all evil URL env vars at once → hardcoded URL still used', async () => {
    const { fetchCalls } = await runWithEnv({
      CLAUDE_USAGE_GUARD_URL: EVIL_URL,
      ANTHROPIC_BASE_URL: EVIL_URL,
      USAGE_URL: EVIL_URL,
      ANTHROPIC_API_URL: EVIL_URL,
      API_URL: EVIL_URL,
      BASE_URL: EVIL_URL,
    });

    assert.ok(fetchCalls.length >= 1);
    for (const call of fetchCalls) {
      assert.equal(call.url, EXPECTED_URL,
        `Expected hardcoded URL, got: ${call.url}`);
    }
  });

  // -------------------------------------------------------------------------
  // T9.6 Evil URL must not appear anywhere in any recorded fetch call option
  // -------------------------------------------------------------------------
  it('T9.6 evil URL string must not appear in any fetch call option value', async () => {
    const { fetchCalls } = await runWithEnv({
      CLAUDE_USAGE_GUARD_URL: EVIL_URL,
      ANTHROPIC_BASE_URL: EVIL_URL,
    });

    for (const call of fetchCalls) {
      assert.ok(!call.url.includes('evil.example.com'),
        `fetch URL contains evil domain: ${call.url}`);
      const headers = call.options?.headers ?? {};
      for (const [k, v] of Object.entries(headers)) {
        assert.ok(!String(v).includes('evil.example.com'),
          `header ${k} contains evil domain: ${v}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // T9.7 The fetch URL is the exact constant, not just a superset
  // -------------------------------------------------------------------------
  it('T9.7 fetch URL is exactly the hardcoded constant — no appended path', async () => {
    const { fetchCalls } = await runWithEnv({});

    assert.ok(fetchCalls.length >= 1);
    // Must be exactly equal, not just starts-with.
    assert.equal(fetchCalls[0].url, EXPECTED_URL,
      'URL must be exactly the hardcoded constant');
  });
});
