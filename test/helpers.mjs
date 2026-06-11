/**
 * test/helpers.mjs — shared fake-deps factory for usage-guard tests.
 *
 * All I/O channels are recorded in-memory. Real network, real fs, and real
 * timers are never touched. Each call to makeDeps() returns a completely
 * isolated environment.
 */

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Fixed epoch milliseconds used as the "current time" baseline. */
export const FIXED_NOW_MS = 1_700_000_000_000; // 2023-11-14 22:13:20 UTC

/**
 * Returns a `now` function that always returns the same fixed Date (or an
 * offset from it).
 */
export function fixedNow(offsetMs = 0) {
  return () => new Date(FIXED_NOW_MS + offsetMs);
}

// ---------------------------------------------------------------------------
// In-memory fake filesystem
// ---------------------------------------------------------------------------

/**
 * Create a fake fs with a simple in-memory store.
 *
 * @param {Record<string,string>} initial  - pre-populated file paths → content
 * @returns {{ fs, writes, reads, renames, appends, appendSyncs }}
 */
export function makeFakeFs(initial = {}) {
  const store = { ...initial };
  const writes = []; // { path, content, options }
  const reads = []; // { path }
  const renames = []; // { from, to }
  const appends = []; // { path, content, options, sync: bool }

  const fs = {
    async readFile(path, _enc) {
      reads.push({ path });
      const p = normPath(path);
      if (Object.prototype.hasOwnProperty.call(store, p)) {
        return store[p];
      }
      const err = Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      throw err;
    },
    async writeFile(path, content, options) {
      const p = normPath(path);
      writes.push({ path: p, content, options });
      store[p] = typeof content === 'string' ? content : String(content);
    },
    async rename(from, to) {
      const fp = normPath(from);
      const tp = normPath(to);
      renames.push({ from: fp, to: tp });
      if (Object.prototype.hasOwnProperty.call(store, fp)) {
        store[tp] = store[fp];
        delete store[fp];
      }
    },
    async appendFile(path, content, options) {
      const p = normPath(path);
      appends.push({ path: p, content, options, sync: false });
      store[p] = (store[p] ?? '') + (typeof content === 'string' ? content : String(content));
    },
    appendFileSync(path, content, options) {
      const p = normPath(path);
      appends.push({ path: p, content, options, sync: true });
      store[p] = (store[p] ?? '') + (typeof content === 'string' ? content : String(content));
    },
    // Test helper: peek at current store content without recording a read.
    _peek(path) {
      return store[normPath(path)];
    },
  };

  return { fs, writes, reads, renames, appends, store };
}

function normPath(p) {
  // Normalise to forward slashes for cross-platform key consistency.
  return String(p).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// makeDeps — the main test factory
// ---------------------------------------------------------------------------

/**
 * Build a complete fake deps object.
 *
 * @param {object} overrides  - partial overrides merged on top of defaults
 * @returns {{ deps, stdout, stderr, exits, fetchCalls, execCalls, fakeFs }}
 */
export function makeDeps(overrides = {}) {
  const stdoutLines = [];
  const stderrLines = [];
  const exits = [];
  const fetchCalls = []; // { url, options }

  const fakeFs = makeFakeFs(overrides.initialFs ?? {});

  // Default happy-path creds file: no real token by default.
  // Callers set a sentinel token by supplying initialFs.

  const defaultDeps = {
    fetchImpl: async (_url, _opts) => {
      fetchCalls.push({ url: _url, options: _opts });
      // Default: return empty-window 200 response.
      return {
        status: 200,
        async json() {
          return {};
        },
      };
    },
    fs: fakeFs.fs,
    execFileImpl: (_cmd, _args, _opts, cb) => {
      const call = { cmd: _cmd, args: _args, opts: _opts };
      execCalls.push(call);
      // Default: keychain error (non-darwin tests don't invoke this).
      cb(new Error('no keychain'), '');
      return { on() {} };
    },
    platform: 'linux',
    env: {},
    stdin: async () => '',
    stdout: (s) => stdoutLines.push(s),
    stderr: (s) => stderrLines.push(s),
    now: fixedNow(),
    homedir: () => '/home/testuser',
    pid: 4242,
    exit: (code) => exits.push(code),
  };

  const execCalls = [];

  // Merge: allow per-test overrides of top-level keys.
  const deps = {
    ...defaultDeps,
    ...overrides,
    // fs is always from fakeFs unless overridden explicitly.
    fs: overrides.fs ?? fakeFs.fs,
    env: { ...(overrides.env ?? {}) },
  };

  // Re-wire fetchImpl so we always record calls even if the caller supplies
  // a custom fetchImpl.
  if (overrides.fetchImpl) {
    const inner = overrides.fetchImpl;
    deps.fetchImpl = (url, opts) => {
      fetchCalls.push({ url, options: opts });
      return inner(url, opts);
    };
  } else {
    deps.fetchImpl = (url, opts) => {
      fetchCalls.push({ url, options: opts });
      return defaultDeps.fetchImpl(url, opts);
    };
  }

  // Re-wire execFileImpl similarly.
  if (overrides.execFileImpl) {
    const inner = overrides.execFileImpl;
    deps.execFileImpl = (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args, opts });
      return inner(cmd, args, opts, cb);
    };
  } else {
    deps.execFileImpl = (cmd, args, opts, cb) => {
      execCalls.push({ cmd, args, opts });
      return defaultDeps.execFileImpl(cmd, args, opts, cb);
    };
  }

  // Expose _peek at the top level of the returned fakeFs recorder,
  // so tests can do `fakeFs._peek(path)` directly.
  fakeFs._peek = fakeFs.fs._peek.bind(fakeFs.fs);

  return {
    deps,
    stdout: stdoutLines,
    stderr: stderrLines,
    exits,
    fetchCalls,
    execCalls,
    fakeFs,
  };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Build a valid cache JSON string from a window map.
 * @param {number} fetchedAt
 * @param {object} windows - { five_hour: { utilization, resets_at }, ... }
 */
export function makeCacheJson(fetchedAt, windows = {}) {
  return JSON.stringify({ fetchedAt, failedAt: null, windows });
}

/**
 * Build a negative-cache JSON string (fetch recently failed).
 */
export function makeNegativeCacheJson(failedAt, fetchedAt = null, windows = {}) {
  return JSON.stringify({ fetchedAt, failedAt, windows });
}

/** Build a credentials file JSON with a given access token. */
export function makeCredsJson(accessToken) {
  return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'do-not-read' } });
}

/** Home dir used by default in tests. */
export const HOME = '/home/testuser';
export const CLAUDE_DIR = `${HOME}/.claude`;
export const CACHE_PATH = `${CLAUDE_DIR}/usage-guard-cache.json`;
export const DEBUG_LOG_PATH = `${CLAUDE_DIR}/usage-guard-debug.log`;
export const CREDS_PATH = `${CLAUDE_DIR}/.credentials.json`;

// A reset time safely in the future (3 hours from FIXED_NOW_MS).
export const RESET_IN_3H = new Date(FIXED_NOW_MS + 3 * 60 * 60 * 1000).toISOString();
// A reset time in the future but > 6 hours (8 hours from FIXED_NOW_MS).
export const RESET_IN_8H = new Date(FIXED_NOW_MS + 8 * 60 * 60 * 1000).toISOString();
// A reset time just barely in the future (1 minute from FIXED_NOW_MS).
export const RESET_IN_1MIN = new Date(FIXED_NOW_MS + 60_000).toISOString();
// A reset time already in the past (window has reset; data is stale).
export const RESET_PAST = new Date(FIXED_NOW_MS - 60_000).toISOString();

// Sentinel token used for leak-detection tests.
export const SENTINEL_TOKEN = 'SENTINEL-TOKEN-abc123XYZ';

/**
 * Collect all recorded string content from every recording channel.
 * Used by T4 to assert the sentinel never leaks.
 */
export function allRecordedOutput({ stdout, stderr, fakeFs }) {
  const parts = [];
  for (const s of stdout) parts.push(s);
  for (const s of stderr) parts.push(s);
  // All fs writes (including debug log appends).
  for (const w of fakeFs.writes) parts.push(w.content);
  for (const a of fakeFs.appends) parts.push(a.content);
  return parts;
}
