#!/usr/bin/env node
/**
 * bench-hook-forms.mjs — dev-only timing harness for the hook spawn forms (issues #14, #18).
 *
 * Times one PreToolUse hook call of the guard in each form and prints the median,
 * min and max per form:
 *   shell     shell form through bash: `bash -c 'node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs"'`
 *             (what Claude Code ran before 0.10.0; on Windows that bash is Git Bash)
 *   exec      exec form: `node <plugin>/scripts/usage-guard.mjs`, spawned with no shell
 *             (what hooks/hooks.json uses since 0.10.0)
 *   bareNode  `node -e 0`, the Node start-up floor
 * After three warm-up calls per form, the forms are interleaved round by round so
 * drift in machine load hits every form alike.
 *
 * Usage:
 *   node scripts/bench-hook-forms.mjs [runs] [--no-shell]
 *     runs        rounds per form, an integer 1..1000 (default 15)
 *     --no-shell  skip the shell form (no bash needed)
 *   BENCH_BASH=<path>  the bash for the shell form. Default on Windows:
 *                      CLAUDE_CODE_GIT_BASH_PATH if set, else the Git Bash that
 *                      belongs to the `git` on PATH (from `git --exec-path`).
 *                      Default elsewhere: `bash` on PATH.
 *   `node` must resolve on PATH to a real executable (exec form cannot run a
 *   .cmd/.bat shim, and neither can this harness).
 *
 * Safety: dev tooling only. It is never wired into hooks/hooks.json, and the guard
 * never imports it. Every spawned guard gets HOME/USERPROFILE pointed at a fresh
 * temp directory (deleted afterwards) that holds only a seeded, fresh usage cache
 * well below every threshold, and all inherited CLAUDE_USAGE_GUARD_* settings are
 * dropped. The guard therefore answers from that cache: it never reads the real
 * ~/.claude, never looks up a login token and never calls the network. After every
 * call the harness checks that the call exited 0 with empty stdout and left the
 * temp home byte-for-byte unchanged (a cache miss would have written a marker), and
 * aborts otherwise. Zero dependencies: Node >= 18 built-ins only. Importing this
 * module performs no I/O; the pure helpers are exported for test/t23-bench-harness.mjs.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_RUNS = 15;
const MAX_RUNS = 1000;
const WARMUP_RUNS = 3;
const USAGE = 'usage: node scripts/bench-hook-forms.mjs [runs 1..1000] [--no-shell]';
const CACHE_FILE = 'usage-guard-cache.json';
// Must equal CACHE_SCHEMA_VERSION in usage-guard.mjs (pinned by test T23.9).
const CACHE_SCHEMA_VERSION = 1;
// Far longer than any bench run, so the seeded cache stays a hit throughout.
const BENCH_TTL_SECONDS = '86400';
const HOUR_MS = 3600 * 1000;

/**
 * Parses the command line. Returns { runs, shell }; throws an Error whose
 * message starts with "usage:" on anything it does not understand.
 */
export function parseArgs(argv) {
  let runs = null;
  let shell = true;
  for (const arg of argv) {
    if (arg === '--no-shell') {
      shell = false;
    } else if (/^\d+$/.test(arg) && runs === null) {
      runs = Number(arg);
      if (runs < 1 || runs > MAX_RUNS) throw new Error(USAGE);
    } else {
      throw new Error(USAGE);
    }
  }
  return { runs: runs ?? DEFAULT_RUNS, shell };
}

/** Returns the median of a non-empty array of numbers. */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Returns the Git Bash paths that belong to a Git for Windows install, given the
 * output of `git --exec-path` (<git>/<mingw64|clangarm64>/libexec/git-core).
 */
export function gitBashCandidates(execPath) {
  const trimmed = String(execPath ?? '').trim();
  if (trimmed === '') return [];
  const gitRoot = dirname(dirname(dirname(trimmed)));
  return [join(gitRoot, 'bin', 'bash.exe'), join(gitRoot, 'usr', 'bin', 'bash.exe')];
}

/** Returns a usage cache, fetched at `nowMs`, that is valid and far below every threshold. */
export function buildSeedCache(nowMs) {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    fetchedAt: nowMs,
    failedAt: null,
    windows: {
      five_hour: { utilization: 1, resets_at: new Date(nowMs + 4 * HOUR_MS).toISOString() },
      seven_day: { utilization: 1, resets_at: new Date(nowMs + 72 * HOUR_MS).toISOString() },
    },
  };
}

/**
 * Returns the environment for every spawned call: the inherited one minus every
 * CLAUDE_USAGE_GUARD_* setting, with the home pointed at `home`, the plugin root
 * at `root` and a cache TTL that outlasts the run.
 */
export function benchEnv(env, home, root) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith('CLAUDE_USAGE_GUARD')) out[key] = value;
  }
  out.HOME = home; // POSIX homedir
  out.USERPROFILE = home; // Windows homedir
  out.CLAUDE_PLUGIN_ROOT = root;
  out.CLAUDE_USAGE_GUARD_TTL = BENCH_TTL_SECONDS;
  return out;
}

/** Returns the bash for the shell form, or throws with a hint. */
function resolveBash(env) {
  if (env.BENCH_BASH) return env.BENCH_BASH;
  if (process.platform !== 'win32') return 'bash';
  if (env.CLAUDE_CODE_GIT_BASH_PATH && existsSync(env.CLAUDE_CODE_GIT_BASH_PATH)) {
    return env.CLAUDE_CODE_GIT_BASH_PATH;
  }
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  const found = git.status === 0 ? gitBashCandidates(git.stdout).find((p) => existsSync(p)) : null;
  if (!found) throw new Error('Git Bash not found: set BENCH_BASH or pass --no-shell');
  return found;
}

/** Runs one call, returns its wall time in ms, and aborts on any deviation. */
function timeCall(name, fn, checkHome) {
  const t0 = process.hrtime.bigint();
  const r = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.error) {
    throw new Error(`${name}: spawn failed (${r.error.code ?? 'error'}); is it a real executable on PATH?`);
  }
  if (r.status !== 0 || r.stdout.length !== 0) {
    const err = String(r.stderr ?? '').slice(0, 300);
    throw new Error(`${name}: status ${r.status}, ${r.stdout.length} stdout bytes; stderr: ${err}`);
  }
  checkHome(name);
  return ms;
}

function run(argv, env) {
  const opts = parseArgs(argv);
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
  const posixRoot = root.replace(/\\/g, '/');
  const script = join(root, 'scripts', 'usage-guard.mjs');
  const bash = opts.shell ? resolveBash(env) : null;

  const home = mkdtempSync(join(tmpdir(), 'ug-bench-'));
  try {
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir);
    const seedText = JSON.stringify(buildSeedCache(Date.now()));
    writeFileSync(join(claudeDir, CACHE_FILE), seedText, { mode: 0o600 });
    const runEnv = benchEnv(env, home, posixRoot);
    const payload = JSON.stringify({
      session_id: 'bench',
      transcript_path: join(home, 'transcript.jsonl'),
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    });

    const checkHome = (name) => {
      const top = readdirSync(home);
      const inner = readdirSync(claudeDir);
      const same =
        top.length === 1 && top[0] === '.claude' &&
        inner.length === 1 && inner[0] === CACHE_FILE &&
        readFileSync(join(claudeDir, CACHE_FILE), 'utf8') === seedText;
      if (!same) throw new Error(`${name}: the guard changed the bench home (cache miss?)`);
    };

    const forms = {};
    if (bash) {
      forms.shell = () =>
        spawnSync(bash, ['-c', 'node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs"'], {
          input: payload,
          env: runEnv,
        });
    }
    forms.exec = () => spawnSync('node', [script], { input: payload, env: runEnv });
    forms.bareNode = () => spawnSync('node', ['-e', '0'], { env: runEnv });

    for (const [name, fn] of Object.entries(forms)) {
      for (let i = 0; i < WARMUP_RUNS; i++) timeCall(name, fn, checkHome);
    }
    const samples = Object.fromEntries(Object.keys(forms).map((k) => [k, []]));
    for (let i = 0; i < opts.runs; i++) {
      for (const [name, fn] of Object.entries(forms)) samples[name].push(timeCall(name, fn, checkHome));
    }

    const lines = [
      `node ${process.version} on ${process.platform}, ${opts.runs} runs per form, interleaved, ` +
        'PreToolUse/Bash payload, cache hit',
    ];
    for (const [name, xs] of Object.entries(samples)) {
      const s = [...xs].sort((a, b) => a - b);
      lines.push(
        `${name.padEnd(8)} median ${median(xs).toFixed(1)} ms  ` +
          `min ${s[0].toFixed(1)}  max ${s[s.length - 1].toFixed(1)}`,
      );
    }
    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runningDirectly() {
  try {
    if (!process.argv[1]) return false;
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const self = fileURLToPath(import.meta.url);
    const entry = resolve(process.argv[1]);
    if (norm(self) === norm(entry)) return true;
    return norm(realpathSync(entry)) === norm(realpathSync(self));
  } catch {
    return false;
  }
}

if (runningDirectly()) {
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
    process.exit(1);
  });
  try {
    run(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
