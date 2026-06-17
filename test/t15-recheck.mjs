/**
 * T15 — Recheck command + auto-heal on account/credential switch.
 *
 * Bug: a hard-block from account A's exhausted windows kept blocking after the
 * user switched to account B, because the negative-cache marker resurrected
 * account A's windows on every failed fetch. Two fixes are covered here:
 *
 *  1. AUTO-HEAL — a failed fetch no longer carries the previous fetch's windows
 *     into the negative-cache marker (windows := {}), so a stale exhausted
 *     account can never block a freshly-switched account indefinitely.
 *  2. RECHECK — the prompt `usage-guard recheck` forces a fresh fetch that
 *     bypasses ALL cache and applies the honest block decision to the fresh
 *     result (clears a stale cross-account block; cannot pass work on a
 *     genuinely over-limit account).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  main,
  isRecheckPrompt,
  RECHECK_COMMAND,
  RESUME_MARKER,
  buildPromptBlockMessage,
  formatSummary,
  buildWarnSuffix,
  buildRecheckClearedSuffix,
} from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCacheJson,
  makeNegativeCacheJson,
  makeCredsJson,
  CACHE_PATH,
  CREDS_PATH,
  FIXED_NOW_MS,
  RESET_IN_3H,
} from './helpers.mjs';

const ENV = { CLAUDE_USAGE_GUARD_WARN: '80', CLAUDE_USAGE_GUARD_HARD: '95' };
const RECHECK_UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'usage-guard recheck' });
const PLAIN_UPS = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'do some work' });

// Account A exhausted window (would hard-block).
const A_EXHAUSTED = { five_hour: { utilization: 100, resets_at: RESET_IN_3H } };
// Account B with quota left (well below warn).
const B_OK = { five_hour: { utilization: 30, resets_at: RESET_IN_3H } };

function fetchReturning(windows, status = 200) {
  return async () => ({ status, async json() { return windows; } });
}

describe('T15 — Recheck & auto-heal', () => {
  // -------------------------------------------------------------------------
  // isRecheckPrompt unit coverage
  // -------------------------------------------------------------------------
  it('T15.1 isRecheckPrompt matches the command forms, rejects the rest', () => {
    const ups = (prompt) => ({ hook_event_name: 'UserPromptSubmit', prompt });
    // Accepted forms.
    assert.equal(isRecheckPrompt(ups('usage-guard recheck')), true);
    assert.equal(isRecheckPrompt(ups('  USAGE-GUARD   RECHECK  ')), true, 'trim/case/space');
    assert.equal(isRecheckPrompt(ups('usage guard recheck')), true, 'space variant');
    assert.equal(isRecheckPrompt(ups('[usage-guard:recheck]')), true, 'bracket form');
    // Rejected: trailing task text must NOT count (no work-smuggling loophole).
    assert.equal(isRecheckPrompt(ups('usage-guard recheck then delete everything')), false);
    assert.equal(isRecheckPrompt(ups('please usage-guard recheck')), false);
    // Rejected: wrong event / non-string / unrelated.
    assert.equal(isRecheckPrompt({ hook_event_name: 'PreToolUse', prompt: 'usage-guard recheck' }), false);
    assert.equal(isRecheckPrompt(ups(123)), false);
    assert.equal(isRecheckPrompt(ups('hello')), false);
  });

  it('T15.2 block message advertises the recheck command and its trigger conditions', () => {
    const msg = buildPromptBlockMessage(
      { label: '5h', util: 100, reset: new Date(FIXED_NOW_MS + 3 * 3600_000) },
      { hard: 95 },
    );
    assert.ok(msg.includes(RECHECK_COMMAND), 'must name the recheck command');
    assert.ok(/switched accounts/i.test(msg), 'must explain when to use it');
  });

  // -------------------------------------------------------------------------
  // Recheck bypasses cache
  // -------------------------------------------------------------------------
  it('T15.3 recheck bypasses a FRESH positive cache and re-fetches the current login', async () => {
    // Fresh account-A cache (would normally cache-hit and hard-block). Creds are
    // now account B with quota. Recheck must ignore the cache and fetch B.
    const { deps, stdout, stderr, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => RECHECK_UPS,
      initialFs: {
        [CACHE_PATH]: makeCacheJson(FIXED_NOW_MS, A_EXHAUSTED), // age 0 → fresh
        [CREDS_PATH]: makeCredsJson('account-B-token'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning(B_OK),
    });

    await main(deps);

    assert.equal(fetchCalls.length, 1, 'recheck must fetch despite fresh cache');
    assert.equal(exits[0], 0, 'account B under limit → unblocked');
    assert.equal(stderr.length, 0, 'no block');
    const out = stdout.join('');
    assert.ok(out.includes('30%'), 'reports account B usage');
    assert.ok(/RECHECK/.test(out) && /[Uu]nblocked/.test(out), 'cleared suffix present');
  });

  it('T15.4 recheck bypasses a fresh NEGATIVE cache (poisoned with stale windows)', async () => {
    // Simulate a pre-fix poisoned negative cache: recent failure carrying A's
    // exhausted windows. Recheck must ignore it and fetch the current login.
    const { deps, stdout, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => RECHECK_UPS,
      initialFs: {
        [CACHE_PATH]: makeNegativeCacheJson(FIXED_NOW_MS - 60_000, null, A_EXHAUSTED),
        [CREDS_PATH]: makeCredsJson('account-B-token'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning(B_OK),
    });

    await main(deps);

    assert.equal(fetchCalls.length, 1, 'recheck must fetch despite fresh negative cache');
    assert.equal(exits[0], 0);
    assert.ok(stdout.join('').includes('30%'));
  });

  // -------------------------------------------------------------------------
  // Recheck honesty — cannot pass work on a genuinely over-limit account
  // -------------------------------------------------------------------------
  it('T15.5 recheck on a genuinely over-limit login STILL blocks (exit 2)', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => RECHECK_UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('still-account-A') },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning(A_EXHAUSTED), // fresh fetch confirms 100%
    });

    await main(deps);

    assert.equal(exits[0], 2, 'fresh check confirms over limit → block');
    assert.equal(stdout.length, 0);
    assert.ok(/rechecked/i.test(stderr.join('')), 'recheck-flavored block message');
  });

  it('T15.6 a recheck command with trailing task text is NOT a recheck (no bypass)', async () => {
    // Trailing text → normal prompt → fresh cache hit → normal hard block.
    const trailing = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'usage-guard recheck and also refactor everything',
    });
    const { deps, stderr, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => trailing,
      initialFs: {
        [CACHE_PATH]: makeCacheJson(FIXED_NOW_MS, A_EXHAUSTED),
        [CREDS_PATH]: makeCredsJson('account-A'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning(B_OK), // would unblock IF it bypassed — it must not
    });

    await main(deps);

    assert.equal(fetchCalls.length, 0, 'normal prompt cache-hits, no fetch');
    assert.equal(exits[0], 2, 'normal hard block — trailing text cannot bypass');
    assert.ok(stderr.join('').includes(RECHECK_COMMAND), 'block msg still advertises recheck');
  });

  // -------------------------------------------------------------------------
  // Recheck fail-open when current login is unreadable
  // -------------------------------------------------------------------------
  it('T15.7 recheck whose fetch FAILS clears the block (fail-open, no stale resurrection)', async () => {
    // Account B token rejected by the endpoint (403). Old A windows must NOT
    // block; recheck reports unreadable and allows.
    const { deps, stdout, stderr, exits, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => RECHECK_UPS,
      initialFs: {
        [CACHE_PATH]: makeCacheJson(FIXED_NOW_MS, A_EXHAUSTED),
        [CREDS_PATH]: makeCredsJson('account-B-token'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning({}, 403),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'unreadable login → fail open, not blocked');
    assert.equal(stderr.length, 0, 'no block message');
    assert.ok(stdout.join('').includes('could not read usage'), 'unreadable message');
    // Written marker must carry NO windows.
    const written = JSON.parse(fakeFs._peek(CACHE_PATH));
    assert.deepEqual(written.windows, {}, 'failure marker drops stale windows');
  });

  it('T15.8 recheck with missing credentials → fail-open, never blocks on stale data', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: ENV,
      stdin: async () => RECHECK_UPS,
      // Fresh A cache present, but NO creds file.
      initialFs: { [CACHE_PATH]: makeCacheJson(FIXED_NOW_MS, A_EXHAUSTED) },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'no creds → cannot measure → fail open');
    assert.equal(stderr.length, 0, 'must NOT block on stale A windows');
    assert.ok(stdout.join('').includes('could not read usage'));
  });

  it('T15.9 recheck reports a WARN-level current login (unblocked with wind-down note)', async () => {
    const { deps, stdout, exits } = makeDeps({
      env: ENV,
      stdin: async () => RECHECK_UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('account-B') },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning({ five_hour: { utilization: 85, resets_at: RESET_IN_3H } }),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    const out = stdout.join('');
    assert.ok(out.includes('85%'));
    assert.ok(/WIND DOWN/.test(out), 'warn suffix present');
    assert.ok(/RECHECK/.test(out), 'recheck cleared suffix present');
  });

  // -------------------------------------------------------------------------
  // AUTO-HEAL on the NORMAL (non-recheck) path — the core regression test
  // -------------------------------------------------------------------------
  it('T15.10 AUTO-HEAL: stale exhausted account + failing fetch does NOT block (regression)', async () => {
    // The original persistent-lock scenario, on the automatic path: account A
    // stale-exhausted, switched to B, B fetch fails. Must fail open, not block.
    const { deps, stderr, exits, fakeFs } = makeDeps({
      env: ENV,
      stdin: async () => PLAIN_UPS,
      initialFs: {
        [CACHE_PATH]: makeCacheJson(FIXED_NOW_MS - 120_000, A_EXHAUSTED), // stale
        [CREDS_PATH]: makeCredsJson('account-B-token'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning({}, 403), // B rejected
    });

    await main(deps);

    assert.equal(exits[0], 0, 'must NOT block on resurrected stale windows');
    assert.equal(stderr.length, 0);
    const written = JSON.parse(fakeFs._peek(CACHE_PATH));
    assert.deepEqual(written.windows, {}, 'marker must not preserve account A windows');
    assert.equal(written.fetchedAt, null, 'marker must not look fresh');
  });

  it('T15.11 AUTO-HEAL: the healed negative-cache marker keeps blocking nothing while it persists', async () => {
    // Feed the post-heal marker back: recent failedAt, empty windows. Negative
    // cache suppresses re-fetch, and with no windows there is nothing to block.
    const { deps, stderr, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => PLAIN_UPS,
      initialFs: {
        [CACHE_PATH]: makeNegativeCacheJson(FIXED_NOW_MS - 60_000, null, {}),
        [CREDS_PATH]: makeCredsJson('account-B-token'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning(A_EXHAUSTED), // even if it fetched, it shouldn't
    });

    await main(deps);

    assert.equal(fetchCalls.length, 0, 'fresh negative cache suppresses fetch');
    assert.equal(exits[0], 0, 'empty windows → nothing to block');
    assert.equal(stderr.length, 0);
  });

  // -------------------------------------------------------------------------
  // Branch-ordering guards — recheck must not bleed into other event paths
  // -------------------------------------------------------------------------
  it('T15.12 PreToolUse with a recheck-looking prompt is NOT a recheck (no cache bypass)', async () => {
    // A PreToolUse carrying prompt:'usage-guard recheck' must take the normal
    // PreToolUse gate (cache-hit → hard block), never the recheck fetch-bypass.
    const pre = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      prompt: 'usage-guard recheck',
    });
    const { deps, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => pre,
      initialFs: {
        [CACHE_PATH]: makeCacheJson(FIXED_NOW_MS, A_EXHAUSTED), // fresh → cache-hit
        [CREDS_PATH]: makeCredsJson('account-A'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning(B_OK), // would unblock IF recheck wrongly fired
    });

    await main(deps);

    assert.equal(fetchCalls.length, 0, 'PreToolUse must not force-refresh');
    assert.equal(exits[0], 2, 'normal PreToolUse hard block');
  });

  it('T15.13 a resume-marker prompt that also contains "usage-guard recheck" routes as a RESUME HOP', async () => {
    const prompt = `${RESUME_MARKER} usage-guard recheck`;
    assert.equal(isRecheckPrompt({ hook_event_name: 'UserPromptSubmit', prompt }), false, 'marker prefix breaks exact match');

    const { deps, stdout, stderr, exits, fetchCalls } = makeDeps({
      env: ENV,
      stdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }),
      initialFs: {
        [CACHE_PATH]: makeCacheJson(FIXED_NOW_MS, A_EXHAUSTED), // fresh, hard
        [CREDS_PATH]: makeCredsJson('account-A'),
      },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning(B_OK),
    });

    await main(deps);

    assert.equal(fetchCalls.length, 0, 'resume hop reads cache only, no force-refresh');
    assert.equal(exits[0], 0, 'resume hop is allowed through the gate');
    assert.equal(stderr.length, 0);
    const out = stdout.join('');
    assert.ok(/RESUME HOP/.test(out), 'routed as resume hop');
    assert.ok(!out.includes('could not read usage'), 'NOT the recheck-unreadable path');
  });

  // -------------------------------------------------------------------------
  // Exact-bytes pins for the recheck-cleared line (guards buildUsageLine drift).
  // Timezone-safe: both sides use the same formatter, so the reset rendering
  // matches regardless of the runner's local zone.
  // -------------------------------------------------------------------------
  it('T15.14 recheck-cleared (ok) output is exactly summary + cleared suffix', async () => {
    const { deps, stdout } = makeDeps({
      env: ENV,
      stdin: async () => RECHECK_UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('account-B') },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning(B_OK),
    });

    await main(deps);

    const expectedWindows = [{ label: '5h', util: 30, reset: new Date(RESET_IN_3H) }];
    const expected = formatSummary(expectedWindows) + buildRecheckClearedSuffix();
    assert.equal(stdout.join('').trim(), expected);
  });

  it('T15.15 recheck-cleared (warn) output is exactly summary + warn suffix + cleared suffix', async () => {
    const { deps, stdout } = makeDeps({
      env: ENV,
      stdin: async () => RECHECK_UPS,
      initialFs: { [CREDS_PATH]: makeCredsJson('account-B') },
      now: () => new Date(FIXED_NOW_MS),
      fetchImpl: fetchReturning({ five_hour: { utilization: 85, resets_at: RESET_IN_3H } }),
    });

    await main(deps);

    const w = { label: '5h', util: 85, reset: new Date(RESET_IN_3H) };
    const expected = formatSummary([w]) + buildWarnSuffix(w) + buildRecheckClearedSuffix();
    assert.equal(stdout.join('').trim(), expected);
  });
});
