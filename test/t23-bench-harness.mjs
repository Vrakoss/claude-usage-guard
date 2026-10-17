/**
 * T23 — the hook-form timing harness is committed and safe (issue #18)
 *
 * README "Hook form" and the 0.10.0 CHANGELOG entry cite medians measured with
 * scripts/bench-hook-forms.mjs. This file pins that the harness is in the repo
 * and stays dev tooling:
 *   - zero dependencies: it imports Node built-ins only;
 *   - no machine-specific paths (drive letters, user home directories);
 *   - no credential reads and no network: it never names the credentials file,
 *     the Keychain lookup, fetch or a network module, and every spawned guard
 *     runs against a seeded fresh cache in a throwaway home, so the guard takes
 *     its cache-hit path and never reaches the token or the endpoint;
 *   - never wired into hooks/hooks.json, and importing it does nothing;
 *   - the docs that cite the timings name the harness.
 *
 * T23.11 spawns the harness for real (exec form only, one round) with an outer
 * home that holds a hard-blocking cache. If the harness ever stopped isolating
 * the home, the guard would read that cache, exit 2 on the Bash payload, and the
 * harness would abort, so the test goes red.
 *
 * T23.13 runs the harness against a copy of the guard whose cache schema version
 * has drifted, so the guard rejects the seed and takes its cache-miss path. The
 * harness's seed probe must catch that and abort before timing; without the probe
 * the run would exit 0 and print "cache hit" medians, so the test goes red.
 *
 * T23.14 runs the harness against a copy of the guard that writes a stray file
 * into its ~/.claude on every call. The harness's home check must abort before
 * timing; without the check the run would exit 0 and print medians.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateCache,
  parseWindows,
  evaluateThresholds,
  readConfig,
  CACHE_SCHEMA_VERSION,
} from '../scripts/usage-guard.mjs';

const BENCH_PATH = fileURLToPath(new URL('../scripts/bench-hook-forms.mjs', import.meta.url));
const BENCH_URL = new URL('../scripts/bench-hook-forms.mjs', import.meta.url).href;
const readRepo = (name) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

// Loaded up front (top-level await works on Node >= 18); a missing file leaves
// an empty namespace so T23.1 reports the real cause instead of an import crash.
const exitCodeBefore = process.exitCode;
const bench = existsSync(BENCH_PATH) ? await import(BENCH_URL) : {};

/** Returns the source with comments removed (for code-only scans). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

describe('T23 timing harness — committed, zero-deps, portable', () => {
  it('T23.1 scripts/bench-hook-forms.mjs exists and documents its usage in a header comment', () => {
    assert.ok(existsSync(BENCH_PATH), 'scripts/bench-hook-forms.mjs must be committed');
    const src = readFileSync(BENCH_PATH, 'utf8');
    const header = /^(?:#![^\n]*\n)?\/\*\*([\s\S]*?)\*\//.exec(src);
    assert.ok(header, 'the file must open with a /** ... */ header comment');
    assert.match(header[1], /Usage:/);
    assert.match(header[1], /node scripts\/bench-hook-forms\.mjs/);
    assert.match(header[1], /--no-shell/);
    assert.match(header[1], /BENCH_BASH/);
  });

  it('T23.2 imports Node built-ins only (zero dependencies)', () => {
    const src = readFileSync(BENCH_PATH, 'utf8');
    const specs = [
      ...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    assert.ok(specs.length > 0, 'expected at least one import');
    for (const spec of specs) assert.match(spec, /^node:/, `non-built-in import ${spec}`);
    assert.doesNotMatch(stripComments(src), /\bimport\s*\(\s*[^'"\s]/, 'no computed imports');
  });

  it('T23.3 carries no machine-specific paths', () => {
    const src = readFileSync(BENCH_PATH, 'utf8');
    assert.doesNotMatch(src, /\b[A-Za-z]:[\\/]/, 'no drive-letter paths');
    assert.doesNotMatch(src, /Program Files/i);
    assert.doesNotMatch(src, /\/(?:Users|home)\/[A-Za-z]/, 'no user home paths');
    assert.doesNotMatch(src, /\btmp\/bench/, 'no scratch-dir usage line');
  });

  it('T23.4 never reads credentials or calls the network', () => {
    const code = stripComments(readFileSync(BENCH_PATH, 'utf8'));
    assert.doesNotMatch(code, /\bfetch\s*\(/);
    assert.doesNotMatch(code, /node:(?:https?|http2|net|tls|dns|dgram)\b/);
    assert.doesNotMatch(code, /credentials/i);
    assert.doesNotMatch(code, /find-generic-password|Keychain/i);
    assert.doesNotMatch(code, /accessToken|refreshToken/);
  });

  it('T23.5 is dev tooling: not wired into hooks.json, not imported by the guard', () => {
    assert.doesNotMatch(readRepo('hooks/hooks.json'), /bench/i);
    assert.doesNotMatch(readRepo('scripts/usage-guard.mjs'), /bench-hook-forms/);
    const pkg = JSON.parse(readRepo('package.json'));
    assert.equal(Object.hasOwn(pkg, 'dependencies'), false);
    assert.equal(Object.hasOwn(pkg, 'devDependencies'), false);
  });
});

describe('T23 timing harness — pure helpers', () => {

  it('T23.6 importing the harness runs nothing (exports only)', () => {
    assert.equal(process.exitCode, exitCodeBefore);
    for (const name of ['parseArgs', 'median', 'gitBashCandidates', 'buildSeedCache', 'benchEnv']) {
      assert.equal(typeof bench[name], 'function', `${name} must be exported`);
    }
  });

  it('T23.7 parseArgs: default 15 runs, a run count, --no-shell; rejects bad input', () => {
    assert.deepEqual(bench.parseArgs([]), { runs: 15, shell: true });
    assert.deepEqual(bench.parseArgs(['7']), { runs: 7, shell: true });
    assert.deepEqual(bench.parseArgs(['--no-shell', '3']), { runs: 3, shell: false });
    assert.deepEqual(bench.parseArgs(['1000']), { runs: 1000, shell: true });
    for (const bad of [['0'], ['1001'], ['abc'], ['2.5'], ['-1'], ['--bogus'], ['3', '4']]) {
      assert.throws(() => bench.parseArgs(bad), /usage/i, `${JSON.stringify(bad)} must be rejected`);
    }
  });

  it('T23.8 median of odd and even samples; gitBashCandidates derives Git Bash from git', () => {
    assert.equal(bench.median([3, 1, 2]), 2);
    assert.equal(bench.median([4, 1, 3, 2]), 2.5);
    const sample = ['C:', 'Program Files', 'Git', 'mingw64', 'libexec', 'git-core'].join('/');
    const got = bench.gitBashCandidates(sample);
    assert.ok(got.length >= 1);
    for (const c of got) assert.match(c.replace(/\\/g, '/'), /\/Git\/(?:usr\/)?bin\/bash\.exe$/);
    assert.deepEqual(bench.gitBashCandidates(''), []);
  });

  it('T23.9 the seeded cache is valid, fresh under the bench TTL and below every threshold', () => {
    const nowMs = Date.UTC(2026, 9, 17, 12, 0, 0);
    const seed = bench.buildSeedCache(nowMs);
    assert.equal(seed.schemaVersion, CACHE_SCHEMA_VERSION);
    const clean = validateCache(seed, nowMs + 1);
    assert.ok(clean && clean.fetchedAt === nowMs, 'guard must accept the seed as a fetch');
    const env = bench.benchEnv({ PATH: 'p', CLAUDE_USAGE_GUARD: 'off' }, '/h', '/r');
    const cfg = readConfig(env);
    // acquireData's cache-hit test: now - fetchedAt < ttlMs, for a long bench run too.
    assert.ok(cfg.ttlMs >= 3600 * 1000, 'bench TTL must cover a long run');
    assert.equal(cfg.off, false, 'an inherited CLAUDE_USAGE_GUARD=off must be dropped');
    assert.equal(cfg.debug, false);
    const { level } = evaluateThresholds(parseWindows(clean, new Date(nowMs + 1)), cfg);
    assert.equal(level, 'ok');
    // The seed probe's cache must block, or the probe could not prove a cache hit.
    const probe = validateCache(bench.buildSeedCache(nowMs, bench.PROBE_UTILIZATION), nowMs + 1);
    assert.ok(probe && probe.fetchedAt === nowMs, 'guard must accept the probe seed as a fetch');
    const probeEval = evaluateThresholds(parseWindows(probe, new Date(nowMs + 1)), cfg);
    assert.equal(probeEval.level, 'hard', 'the probe seed must hard-block');
  });

  it('T23.10 benchEnv isolates the home and drops every inherited guard setting', () => {
    const env = bench.benchEnv(
      { PATH: 'p', HOME: '/real', USERPROFILE: 'C:/real', CLAUDE_USAGE_GUARD_DEBUG: '1',
        CLAUDE_USAGE_GUARD_HARD: '1' },
      '/tmp/h', '/repo',
    );
    assert.equal(env.HOME, '/tmp/h');
    assert.equal(env.USERPROFILE, '/tmp/h');
    assert.equal(env.PATH, 'p');
    assert.equal(env.CLAUDE_PLUGIN_ROOT, '/repo');
    assert.deepEqual(
      Object.keys(env).filter((k) => k.startsWith('CLAUDE_USAGE_GUARD')),
      ['CLAUDE_USAGE_GUARD_TTL'],
    );
  });
});

describe('T23 timing harness — end to end', () => {
  it('T23.11 one exec-form round runs isolated from the real home and prints medians', () => {
    const outer = mkdtempSync(join(tmpdir(), 'cug-bench-outer-'));
    try {
      const claude = join(outer, '.claude');
      mkdirSync(claude);
      const now = Date.now();
      // A hard-blocking cache plus a fake credentials file in the OUTER home:
      // reaching either means the harness leaked the real home into the guard.
      const blocking = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        fetchedAt: now,
        failedAt: null,
        windows: { five_hour: { utilization: 99, resets_at: new Date(now + 3600e3).toISOString() } },
      };
      writeFileSync(join(claude, 'usage-guard-cache.json'), JSON.stringify(blocking));
      writeFileSync(join(claude, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}');
      const before = readdirSync(claude).sort();
      const res = spawnSync(process.execPath, [BENCH_PATH, '1', '--no-shell'], {
        env: { ...process.env, HOME: outer, USERPROFILE: outer, CLAUDE_USAGE_GUARD_TTL: '86400' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(res.status, 0, `harness failed: ${res.stderr}`);
      assert.match(res.stdout, /^exec\s+median \d+\.\d ms/m);
      assert.match(res.stdout, /^bareNode\s+median \d+\.\d ms/m);
      assert.doesNotMatch(res.stdout, /^shell\b/m, '--no-shell must skip the shell form');
      assert.deepEqual(readdirSync(claude).sort(), before, 'outer home must be untouched');
      assert.deepEqual(
        JSON.parse(readFileSync(join(claude, 'usage-guard-cache.json'), 'utf8')),
        blocking,
      );
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('T23.13 a seed the guard does not honor aborts the run before any timing', () => {
    const root = mkdtempSync(join(tmpdir(), 'cug-bench-drift-'));
    try {
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'scripts', 'bench-hook-forms.mjs'), readFileSync(BENCH_PATH, 'utf8'));
      // A guard copy whose cache schema has drifted: it rejects the harness's seed
      // and takes the cache-miss path. The Keychain branch is switched off so the
      // miss cannot reach a real macOS login; the temp home holds no credentials
      // file, so the miss ends with no data and the guard allows the call.
      let guard = readRepo('scripts/usage-guard.mjs');
      const schemaLine = `export const CACHE_SCHEMA_VERSION = ${CACHE_SCHEMA_VERSION};`;
      // Line endings vary with the checkout (core.autocrlf), hence \r?\n.
      const keychainBranch = /if \(deps\.platform === 'darwin'\) \{(\r?\n\s*raw = await readTokenFromKeychain)/g;
      assert.equal(guard.split(schemaLine).length, 2, 'guard declares CACHE_SCHEMA_VERSION once');
      assert.equal([...guard.matchAll(keychainBranch)].length, 1, 'guard has one Keychain branch');
      guard = guard
        .replace(schemaLine, `export const CACHE_SCHEMA_VERSION = ${CACHE_SCHEMA_VERSION + 1};`)
        .replace(keychainBranch, 'if (false) {$1');
      writeFileSync(join(root, 'scripts', 'usage-guard.mjs'), guard);

      const res = spawnSync(process.execPath, [join(root, 'scripts', 'bench-hook-forms.mjs'), '1', '--no-shell'], {
        env: process.env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(res.status, 1, `harness must abort, got ${res.status}: ${res.stdout}`);
      assert.match(res.stderr, /^exec: seed probe got status 0\b/m);
      assert.doesNotMatch(res.stdout, /median/, 'no timings may be printed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('T23.14 a guard that writes into the bench home aborts the run before any timing', () => {
    const root = mkdtempSync(join(tmpdir(), 'cug-bench-dirty-'));
    try {
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'scripts', 'bench-hook-forms.mjs'), readFileSync(BENCH_PATH, 'utf8'));
      // A guard copy that drops a stray file into its ~/.claude on every call but
      // otherwise behaves (the probe still blocks, timed calls still allow). Only
      // the harness's home check can catch it. The write is confined to a home
      // the harness made (basename ug-bench-*) so a broken isolation can never
      // touch the real ~/.claude.
      const guard = readRepo('scripts/usage-guard.mjs');
      const firstImport = "import { fileURLToPath } from 'node:url';";
      assert.equal(guard.split(firstImport).length, 2, 'guard has one node:url import line');
      const stray = [
        "import { writeFileSync as strayWrite } from 'node:fs';",
        "import { homedir as strayHome } from 'node:os';",
        "import { basename as strayBase, join as strayJoin } from 'node:path';",
        "if (strayBase(strayHome()).startsWith('ug-bench-')) {",
        "  strayWrite(strayJoin(strayHome(), '.claude', 'stray.txt'), 'x');",
        '}',
      ].join('\n');
      writeFileSync(
        join(root, 'scripts', 'usage-guard.mjs'),
        guard.replace(firstImport, `${firstImport}\n${stray}`),
      );

      const res = spawnSync(process.execPath, [join(root, 'scripts', 'bench-hook-forms.mjs'), '1', '--no-shell'], {
        env: process.env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(res.status, 1, `harness must abort, got ${res.status}: ${res.stdout}`);
      assert.match(res.stderr, /^exec: the guard changed the bench home\b/m);
      assert.doesNotMatch(res.stdout, /median/, 'no timings may be printed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('T23 docs cite the committed harness', () => {
  it('T23.12 README "Hook form" and the CHANGELOG name scripts/bench-hook-forms.mjs', () => {
    const readme = readRepo('README.md');
    const start = readme.indexOf('\n### Hook form');
    assert.ok(start >= 0, 'README has a "### Hook form" section');
    const end = readme.indexOf('\n#', start + 1);
    assert.match(readme.slice(start, end), /`scripts\/bench-hook-forms\.mjs`/);
    assert.match(readRepo('CHANGELOG.md'), /`scripts\/bench-hook-forms\.mjs`/);
  });
});
