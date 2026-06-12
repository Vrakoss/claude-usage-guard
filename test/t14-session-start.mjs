/**
 * T14 — SessionStart one-time onboarding hint
 *
 * The guard posts a one-time setup note into the first session's context when:
 *  (a) no CLAUDE_USAGE_GUARD* env var is set (not yet configured), AND
 *  (b) the onboarded marker file is absent.
 *
 * The hint is trusted context (SessionStart stdout, not wrapped in a
 * local-command-caveat) so the model can proactively offer to apply it.
 *
 * Invariants tested here:
 *  - Never fetches, never reads credentials, never exits 2.
 *  - Marker written at mode 0o600 after hint is emitted.
 *  - Pre-seeded marker suppresses repeat.
 *  - Any configured CLAUDE_USAGE_GUARD* var suppresses entirely.
 *  - Platform text is correct (darwin vs other).
 *  - Fail-open on every error path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  main,
  isConfigured,
  buildOnboardingMessage,
} from '../scripts/usage-guard.mjs';
import {
  makeDeps,
  makeCacheJson,
  makeCredsJson,
  CACHE_PATH,
  CREDS_PATH,
  CLAUDE_DIR,
  FIXED_NOW_MS,
  RESET_IN_3H,
} from './helpers.mjs';

const ONBOARD_PATH = `${CLAUDE_DIR}/usage-guard-onboarded`;

/** Build a SessionStart stdin payload. */
function sessionStartStdin() {
  return async () =>
    JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's1' });
}

// ---------------------------------------------------------------------------
// T14.1 — pure defaults + no marker → hint emitted, exit 0, no stderr
// ---------------------------------------------------------------------------
describe('T14 — SessionStart onboarding', () => {
  it('T14.1 no marker, no config → stdout contains [usage-guard] and settings.json snippet; exit 0; no stderr', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: {},
      stdin: sessionStartStdin(),
      initialFs: {},
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'must exit 0');
    assert.equal(stderr.length, 0, 'no stderr');
    assert.equal(stdout.length, 1, 'exactly one stdout emission');
    const out = stdout[0];
    assert.ok(out.includes('[usage-guard]'), 'must contain [usage-guard] prefix');
    assert.ok(out.includes('settings.json'), 'must mention settings.json');
    assert.ok(out.includes('CLAUDE_USAGE_GUARD_WARN'), 'must show WARN var');
    assert.ok(out.includes('CLAUDE_USAGE_GUARD_HARD'), 'must show HARD var');
    assert.ok(out.includes('will not repeat'), 'must say it will not repeat');
    assert.ok(out.includes('thresholds'), 'must tell model to offer to apply');
  });

  // -------------------------------------------------------------------------
  // T14.2 — marker written after emit, at mode 0o600
  // -------------------------------------------------------------------------
  it('T14.2 hint emitted → marker written to usage-guard-onboarded at mode 0o600', async () => {
    const { deps, stdout, fakeFs } = makeDeps({
      env: {},
      stdin: sessionStartStdin(),
      initialFs: {},
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    // Hint must have been emitted first.
    assert.equal(stdout.length, 1, 'hint must have been emitted');

    // Exactly one write to the onboard marker path.
    const markerWrites = fakeFs.writes.filter((w) =>
      w.path.endsWith('usage-guard-onboarded'),
    );
    assert.equal(markerWrites.length, 1, 'must write the onboard marker exactly once');
    assert.deepEqual(
      markerWrites[0].options,
      { mode: 0o600 },
      'marker must be written with mode 0o600',
    );
  });

  // -------------------------------------------------------------------------
  // T14.3 — marker pre-seeded → zero stdout, exit 0, no marker rewrite
  // -------------------------------------------------------------------------
  it('T14.3 marker pre-seeded → zero stdout, exit 0, no marker rewrite', async () => {
    const { deps, stdout, stderr, exits, fakeFs } = makeDeps({
      env: {},
      stdin: sessionStartStdin(),
      initialFs: { [ONBOARD_PATH]: 'v1\n' },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 0, 'no stdout when already onboarded');
    assert.equal(stderr.length, 0);
    // No write to the marker (it already existed).
    const markerWrites = fakeFs.writes.filter((w) =>
      w.path.endsWith('usage-guard-onboarded'),
    );
    assert.equal(markerWrites.length, 0, 'must not rewrite the marker');
  });

  // -------------------------------------------------------------------------
  // T14.4 — suppressed when any CLAUDE_USAGE_GUARD* var is set (non-empty)
  // -------------------------------------------------------------------------
  it('T14.4 configured → no stdout (parameterized)', async () => {
    const configuredEnvs = [
      { CLAUDE_USAGE_GUARD_WARN: '70' },
      { CLAUDE_USAGE_GUARD_HARD: '90' },
      { CLAUDE_USAGE_GUARD_TTL: '30' },
      { CLAUDE_USAGE_GUARD_DEBUG: '1' },
      { CLAUDE_USAGE_GUARD_FUTURE: 'some-future-option' }, // unknown prefix var
    ];

    for (const env of configuredEnvs) {
      const { deps, stdout, exits } = makeDeps({
        env,
        stdin: sessionStartStdin(),
        initialFs: {},
        now: () => new Date(FIXED_NOW_MS),
      });
      await main(deps);
      assert.equal(stdout.length, 0, `must suppress hint when env has ${JSON.stringify(env)}`);
      assert.equal(exits[0], 0);
    }
  });

  it('T14.4b empty-string value does NOT suppress (still emits)', async () => {
    // CLAUDE_USAGE_GUARD_WARN='' is present but empty — prefix scan sees it but
    // isConfigured returns false because the value is ''. Hint must still fire.
    const { deps, stdout, exits } = makeDeps({
      env: { CLAUDE_USAGE_GUARD_WARN: '' },
      stdin: sessionStartStdin(),
      initialFs: {},
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0);
    assert.equal(stdout.length, 1, 'empty-string value must not suppress the hint');
  });

  // -------------------------------------------------------------------------
  // T14.5 — platform text
  // -------------------------------------------------------------------------
  it('T14.5 darwin → message includes Keychain and "Claude Code-credentials"', async () => {
    const { deps, stdout } = makeDeps({
      env: {},
      platform: 'darwin',
      stdin: sessionStartStdin(),
      initialFs: {},
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(stdout.length, 1);
    const out = stdout[0];
    assert.ok(out.includes('Keychain'), 'darwin message must mention Keychain');
    assert.ok(
      out.includes('Claude Code-credentials'),
      'darwin message must name the Keychain item',
    );
  });

  it('T14.5b linux → message includes .credentials.json and NOT Keychain', async () => {
    const { deps, stdout } = makeDeps({
      env: {},
      platform: 'linux',
      stdin: sessionStartStdin(),
      initialFs: {},
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(stdout.length, 1);
    const out = stdout[0];
    assert.ok(out.includes('.credentials.json'), 'linux message must mention credentials file');
    assert.ok(!out.includes('Keychain'), 'linux message must NOT mention Keychain');
  });

  // -------------------------------------------------------------------------
  // T14.6 — fail-open on every error path
  // -------------------------------------------------------------------------
  it('T14.6a readFile throws non-ENOENT → treated as not-onboarded, exit 0', async () => {
    // Build a custom fs where readFile throws EPERM instead of ENOENT.
    const { deps, stdout, stderr, exits } = makeDeps({
      env: {},
      platform: 'linux',
      stdin: sessionStartStdin(),
      initialFs: {},
      now: () => new Date(FIXED_NOW_MS),
    });
    // Override fs.readFile to throw a non-ENOENT error for the marker path.
    const originalReadFile = deps.fs.readFile.bind(deps.fs);
    deps.fs = {
      ...deps.fs,
      async readFile(path, enc) {
        if (String(path).endsWith('usage-guard-onboarded')) {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        }
        return originalReadFile(path, enc);
      },
    };

    await main(deps);

    assert.equal(exits[0], 0, 'must exit 0');
    // The inner try/catch around the marker readFile swallows the EPERM too →
    // onboarded = false → the hint IS emitted (deterministic, not "either/or").
    assert.equal(stdout.length, 1, 'EPERM on marker read → not onboarded → hint emitted');
    assert.equal(stderr.length, 0, 'no stderr on fail-open path');
  });

  it('T14.6b marker writeFile throws → exit 0 (hint already emitted)', async () => {
    const { deps, stdout, stderr, exits } = makeDeps({
      env: {},
      platform: 'linux',
      stdin: sessionStartStdin(),
      initialFs: {},
      now: () => new Date(FIXED_NOW_MS),
    });
    // Override writeFile to throw for the marker path.
    const originalWriteFile = deps.fs.writeFile.bind(deps.fs);
    deps.fs = {
      ...deps.fs,
      async writeFile(path, content, opts) {
        if (String(path).endsWith('usage-guard-onboarded')) {
          throw new Error('ENOSPC');
        }
        return originalWriteFile(path, content, opts);
      },
    };

    await main(deps);

    assert.equal(exits[0], 0, 'must exit 0 even if marker write fails');
    // Hint was emitted before the failed write.
    assert.equal(stdout.length, 1, 'hint must have been emitted before marker write');
    assert.equal(stderr.length, 0, 'no stderr');
  });

  it('T14.6c stdout impl throws → exit 0, no stderr', async () => {
    const exits = [];
    const deps = {
      ...makeDeps({
        env: {},
        platform: 'linux',
        stdin: sessionStartStdin(),
        initialFs: {},
        now: () => new Date(FIXED_NOW_MS),
      }).deps,
      stdout: () => { throw new Error('stdout broken'); },
      stderr: () => {},
      exit: (code) => exits.push(code),
    };

    await main(deps);

    assert.equal(exits[0], 0, 'must exit 0 even if stdout throws');
  });

  // -------------------------------------------------------------------------
  // T14.7 — no creds, no network, no exit 2 (even at HARD cache level)
  // -------------------------------------------------------------------------
  it('T14.7 HARD-level cache + SessionStart → exit 0, no fetch, no creds read, no execFile', async () => {
    const hardCache = makeCacheJson(FIXED_NOW_MS, {
      five_hour: { utilization: 99, resets_at: RESET_IN_3H },
    });
    const { deps, stdout, stderr, exits, fetchCalls, execCalls, fakeFs } = makeDeps({
      env: {},
      platform: 'darwin', // most aggressive path
      stdin: sessionStartStdin(),
      initialFs: {
        [CACHE_PATH]: hardCache,
        [CREDS_PATH]: makeCredsJson('tok'),
      },
      now: () => new Date(FIXED_NOW_MS),
    });

    await main(deps);

    assert.equal(exits[0], 0, 'SessionStart must always exit 0');
    assert.equal(fetchCalls.length, 0, 'must never fetch on SessionStart');
    assert.equal(execCalls.length, 0, 'must never invoke execFile (no Keychain probe) on SessionStart');
    // Never reads credentials on this path (seeded but must stay untouched).
    const credsReads = fakeFs.reads.filter((r) => String(r.path).endsWith('.credentials.json'));
    assert.equal(credsReads.length, 0, 'must never read the credentials file on SessionStart');
    assert.equal(stderr.length, 0, 'no stderr');
    // Hint fires (no marker, no config).
    assert.equal(stdout.length, 1, 'hint must be emitted');
  });

  // -------------------------------------------------------------------------
  // T14.8 — unit tests for isConfigured and buildOnboardingMessage
  // -------------------------------------------------------------------------
  describe('T14.8 isConfigured unit tests', () => {
    it('T14.8a empty env → false', () => {
      assert.equal(isConfigured({}), false);
    });

    it('T14.8b CLAUDE_USAGE_GUARD_WARN set → true', () => {
      assert.equal(isConfigured({ CLAUDE_USAGE_GUARD_WARN: '70' }), true);
    });

    it('T14.8c CLAUDE_USAGE_GUARD_HARD set → true', () => {
      assert.equal(isConfigured({ CLAUDE_USAGE_GUARD_HARD: '90' }), true);
    });

    it('T14.8d CLAUDE_USAGE_GUARD_DEBUG set → true', () => {
      assert.equal(isConfigured({ CLAUDE_USAGE_GUARD_DEBUG: '1' }), true);
    });

    it('T14.8e empty-string value → false (empty is treated as unset)', () => {
      assert.equal(isConfigured({ CLAUDE_USAGE_GUARD_WARN: '' }), false);
    });

    it('T14.8f prefix-only match: CLAUDE_USAGE_GUARD_FUTURE → true', () => {
      assert.equal(isConfigured({ CLAUDE_USAGE_GUARD_FUTURE: 'anything' }), true);
    });

    it('T14.8g unrelated env vars → false', () => {
      assert.equal(isConfigured({ PATH: '/usr/bin', HOME: '/home/user', TERM: 'xterm' }), false);
    });

    it('T14.8h CLAUDE_USAGE_GUARD (base var, off) → true', () => {
      // The base var without suffix still starts with CLAUDE_USAGE_GUARD.
      assert.equal(isConfigured({ CLAUDE_USAGE_GUARD: 'off' }), true);
    });
  });

  describe('T14.8 buildOnboardingMessage unit tests', () => {
    it('T14.8i darwin message shape: contains Keychain, no dates, contains DEFAULT thresholds', () => {
      const msg = buildOnboardingMessage('darwin');
      assert.ok(msg.includes('[usage-guard]'), 'must start with [usage-guard]');
      assert.ok(msg.includes('Keychain'), 'darwin must mention Keychain');
      assert.ok(msg.includes('Claude Code-credentials'), 'darwin must name the item');
      assert.ok(msg.includes('80'), 'must include DEFAULT_WARN value');
      assert.ok(msg.includes('95'), 'must include DEFAULT_HARD value');
      assert.ok(msg.includes('will not repeat'), 'must say will not repeat');
      assert.ok(msg.includes('settings.json'), 'must mention settings.json');
      // No dates: timezone-safe — just assert no ISO date pattern.
      assert.ok(!/\d{4}-\d{2}-\d{2}/.test(msg), 'message must not contain ISO dates');
    });

    it('T14.8j non-darwin message shape: no Keychain, has .credentials.json', () => {
      const msg = buildOnboardingMessage('linux');
      assert.ok(!msg.includes('Keychain'), 'non-darwin must NOT mention Keychain');
      assert.ok(msg.includes('.credentials.json'), 'non-darwin must mention credentials file');
      assert.ok(msg.includes('[usage-guard]'), 'must start with [usage-guard]');
      assert.ok(msg.includes('80'), 'must include DEFAULT_WARN value');
      assert.ok(msg.includes('95'), 'must include DEFAULT_HARD value');
    });

    it('T14.8k windows message shape same as linux (no Keychain)', () => {
      const msg = buildOnboardingMessage('win32');
      assert.ok(!msg.includes('Keychain'), 'win32 must NOT mention Keychain');
      assert.ok(msg.includes('.credentials.json'), 'win32 must mention credentials file');
    });
  });
});
