/**
 * T12 — Entry-point detection (e2e: real process spawn)
 *
 * runningDirectly() is not exported (it reads process.argv/import.meta), so it
 * is exercised end-to-end: spawn the real script and assert main() actually
 * ran. Signal: with CLAUDE_USAGE_GUARD=off and DEBUG=1, main() writes a
 * `guard_off` line to <home>/.claude/usage-guard-debug.log before exiting —
 * no network, no credentials touched. A broken entry-point check exits 0 with
 * no log (fail-open hides it), which is exactly the regression we pin here.
 *
 * Regression (audit #1): the old `fileURLToPath(import.meta.url) ===
 * resolve(argv[1])` compare failed when the script was reached through a
 * symlink/junction (ESM resolves the entry to its realpath; argv[1] keeps the
 * link path), silently disabling the guard.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Spawn the guard with an isolated home dir; return debug log + exit code. */
function runGuard(scriptPath) {
  const home = mkdtempSync(join(tmpdir(), 'cug-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  try {
    const res = spawnSync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        HOME: home, // POSIX homedir
        USERPROFILE: home, // Windows homedir
        CLAUDE_USAGE_GUARD: 'off', // exit before stdin/creds/network
        CLAUDE_USAGE_GUARD_DEBUG: '1', // guard_off line proves main() ran
      },
      input: '',
      encoding: 'utf8',
      timeout: 15_000,
    });
    const logPath = join(home, '.claude', 'usage-guard-debug.log');
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', log };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('T12 — Entry-point detection (e2e)', () => {
  // -------------------------------------------------------------------------
  // T12.1 Direct path: main() runs (baseline for T12.2)
  // -------------------------------------------------------------------------
  it('T12.1 direct invocation: main() runs (guard_off logged), exit 0, silent', () => {
    const script = join(REPO_ROOT, 'scripts', 'usage-guard.mjs');
    const { status, stdout, stderr, log } = runGuard(script);

    assert.equal(status, 0);
    assert.equal(stdout, '', 'guard=off must be silent');
    assert.equal(stderr, '', 'guard=off must be silent');
    assert.ok(log.includes('guard_off'),
      'main() must have run when the script is the direct entry point');
  });

  // -------------------------------------------------------------------------
  // T12.2 Symlinked/junctioned install path: main() still runs
  // -------------------------------------------------------------------------
  it('T12.2 invocation through a symlinked directory: main() still runs', (t) => {
    const linkParent = mkdtempSync(join(tmpdir(), 'cug-link-'));
    const link = join(linkParent, 'plugin');
    try {
      try {
        // 'junction' works unprivileged on Windows; the type arg is ignored
        // on POSIX.
        symlinkSync(REPO_ROOT, link, 'junction');
      } catch {
        // Symlink creation can be denied (restricted CI sandbox) — skip
        // rather than fail; T12.1 still covers the direct path.
        t.skip('cannot create symlink/junction in this environment');
        return;
      }

      const script = join(link, 'scripts', 'usage-guard.mjs');
      const { status, log } = runGuard(script);

      assert.equal(status, 0);
      assert.ok(log.includes('guard_off'),
        'main() must run when reached through a symlink — argv[1] keeps the ' +
        'link path while import.meta.url is the realpath');
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  });
});
