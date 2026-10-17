/**
 * T19 — hooks/hooks.json contract (issue #11)
 *
 * The PreToolUse hook is matched on every tool EXCEPT a small denylist of
 * read-only / wind-down tools, via a JavaScript-RegExp negative lookahead. A
 * denylist (not an allowlist) keeps every tool Claude Code adds later gated, and
 * keeps ScheduleWakeup matched without listing it. Ungating the hand-back tools
 * (SubagentHandback, StructuredOutput) lets a hard-blocked sub-agent actually
 * return the resume brief the block message asks for.
 *
 * Every hook runs in EXEC form (issue #14): `"command": "node"` plus
 * `"args": ["${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs"]`. Claude Code spawns
 * node directly with no shell, which skips the Git Bash process that shell form
 * starts on Windows. Exec form needs Claude Code >= 2.1.139: older clients strip
 * the unknown `args` key and run a bare `node` that evaluates the hook JSON on
 * stdin as a script -> SyntaxError, exit 1 -> non-blocking error, i.e. the guard
 * is off. The owner ruled such clients out of scope (issue #14); the README
 * documents it as a residual.
 *
 * The sub-agent HARD block message names the hand-back tools (HANDBACK_TOOLS)
 * as still usable; T19.10-T19.12 tie that message to the matcher so the two
 * cannot drift apart (the message once claimed "All tools are gated").
 *
 * Pure: reads the JSON file and imports the guard module (zero I/O on import),
 * so it runs in every CI cell.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDBACK_TOOLS, buildToolBlockMessage, buildResumeHopSuffix } from '../scripts/usage-guard.mjs';

const HOOKS_PATH = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url));
const config = JSON.parse(readFileSync(HOOKS_PATH, 'utf8'));

const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'SessionStart'];
const EXEC_COMMAND = 'node';
const EXEC_ARGS = ['${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs'];
const HOOK_KEYS = ['args', 'command', 'timeout', 'type'];
const FORBIDDEN_KEYS = ['shell', 'async', 'asyncRewake', 'if', 'onFailure'];
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
// A shell-form hook command: `node` followed by the script in one string (any or
// no quoting, JSON-escaped quotes included), or the script itself as `command`.
const SHELL_FORM_PATTERNS = [
  /\bnode\s+\\?["']?\$\{CLAUDE_PLUGIN_ROOT\}/,
  /"command"\s*:\s*"(?:node\s|\$\{CLAUDE_PLUGIN_ROOT\})/,
];

// Copy of the documented matcher classification (code.claude.com/docs/en/hooks):
// "*" / "" / omitted -> match all; only [A-Za-z0-9_\- ,|] -> exact name or a list
// split on "|" / ","; anything else -> unanchored JS RegExp tested with .test().
const EXACT_CHARSET = /^[A-Za-z0-9_\- ,|]*$/;
function isRegexMatcher(matcher) {
  return typeof matcher === 'string' && matcher !== '*' && matcher !== '' &&
    !EXACT_CHARSET.test(matcher);
}
function matches(matcher, name) {
  if (matcher === undefined || matcher === '*' || matcher === '') return true;
  if (EXACT_CHARSET.test(matcher)) {
    return matcher.split(/[|,]/).map((s) => s.trim()).includes(name);
  }
  return new RegExp(matcher).test(name);
}

const UNGATED = [
  'Read', 'Grep', 'Glob', 'LSP', 'ToolSearch', 'TodoWrite', 'TaskOutput',
  'TaskStop', 'SubagentHandback', 'StructuredOutput',
];
const GATED = [
  'ScheduleWakeup', 'Agent', 'Task', 'Bash', 'PowerShell', 'Write', 'Edit',
  'MultiEdit', 'NotebookEdit', 'Workflow', 'WebFetch', 'WebSearch', 'Skill',
  'SendMessage', 'Monitor', 'AskUserQuestion', 'mcp__github__create_issue',
  'mcp__plugin_x_srv__tool',
  'FutureTool', // fail-safe: an unknown/new tool stays gated
  // Anchoring: only the exact ungated names are exempt.
  'mcp__fs__Read', 'ReadX', 'XRead', 'Read ', 'readx', 'StructuredOutputX',
];

function soleHook(event) {
  const groups = config.hooks[event];
  assert.ok(Array.isArray(groups), `${event} must be an array`);
  assert.equal(groups.length, 1, `${event} must have exactly one matcher group`);
  assert.ok(Array.isArray(groups[0].hooks), `${event} group must have hooks[]`);
  assert.equal(groups[0].hooks.length, 1, `${event} must have exactly one hook`);
  return { group: groups[0], hook: groups[0].hooks[0] };
}

describe('T19 hooks.json — event wiring', () => {
  it('T19.1 wires exactly UserPromptSubmit, PreToolUse and SessionStart', () => {
    assert.deepEqual(Object.keys(config).sort(), ['hooks']);
    assert.deepEqual(Object.keys(config.hooks).sort(), [...EVENTS].sort());
  });

  for (const event of EVENTS) {
    it(`T19.2 ${event}: one exec-form command hook running the guard, timeout 20`, () => {
      const { hook } = soleHook(event);
      assert.equal(hook.type, 'command');
      assert.equal(hook.command, EXEC_COMMAND);
      assert.deepEqual(hook.args, EXEC_ARGS);
      assert.equal(hook.timeout, 20);
    });

    it(`T19.3 ${event}: no shell/async/asyncRewake/if/onFailure keys`, () => {
      const { hook } = soleHook(event);
      for (const key of FORBIDDEN_KEYS) {
        assert.equal(Object.hasOwn(hook, key), false, `${event} hook must not set "${key}"`);
      }
      assert.deepEqual(Object.keys(hook).sort(), HOOK_KEYS, `${event} hook keys`);
    });

    it(`T19.15 ${event}: one unquoted script path that exists`, () => {
      const { hook } = soleHook(event);
      // `command` itself is pinned to exactly 'node' by T19.2.
      assert.ok(Array.isArray(hook.args) && hook.args.length === 1);
      // Each args element is passed verbatim (no shell), so quotes would be literal.
      assert.doesNotMatch(hook.args[0], /["'\s]/);
      assert.ok(hook.args[0].startsWith('${CLAUDE_PLUGIN_ROOT}/'));
      const resolved = join(PLUGIN_ROOT, hook.args[0].slice('${CLAUDE_PLUGIN_ROOT}/'.length));
      assert.ok(existsSync(resolved), `${resolved} must exist in the plugin`);
    });
  }

  it('T19.4 UserPromptSubmit and SessionStart carry no matcher', () => {
    assert.equal(Object.hasOwn(soleHook('UserPromptSubmit').group, 'matcher'), false);
    assert.equal(Object.hasOwn(soleHook('SessionStart').group, 'matcher'), false);
  });
});

describe('T19 hooks.json — PreToolUse denylist matcher', () => {
  const { matcher } = soleHook('PreToolUse').group;

  it('T19.5 matcher is a string on the RegExp path (cannot silently become an allowlist)', () => {
    assert.equal(typeof matcher, 'string');
    assert.ok(isRegexMatcher(matcher), 'matcher must contain a non-exact-charset character');
    assert.doesNotThrow(() => new RegExp(matcher));
  });

  it('T19.6 matcher is anchored at the start (a denylist lookahead, not a substring search)', () => {
    assert.ok(matcher.startsWith('^(?!'), 'matcher must start with a ^(?! negative lookahead');
  });

  for (const name of GATED) {
    it(`T19.7 gates ${JSON.stringify(name)}`, () => {
      assert.equal(matches(matcher, name), true);
    });
  }

  for (const name of UNGATED) {
    it(`T19.8 does not gate ${name}`, () => {
      assert.equal(matches(matcher, name), false);
    });
  }

  it('T19.9 the matches() helper follows the documented classification', () => {
    assert.equal(matches('*', 'Anything'), true);
    assert.equal(matches('', 'Anything'), true);
    assert.equal(matches(undefined, 'Anything'), true);
    assert.equal(matches('Read|Grep', 'Grep'), true);
    assert.equal(matches('Read, Grep', 'Grep'), true);
    assert.equal(matches('Read|Grep', 'mcp__fs__Read'), false);
    assert.equal(matches('Read|Grep', 'ReadX'), false);
    assert.equal(matches('Edit.*', 'NotebookEdit'), true); // regex path is unanchored
  });
});

describe('T19 sub-agent block message agrees with the matcher', () => {
  const { matcher } = soleHook('PreToolUse').group;
  const now = new Date(Date.UTC(2026, 10, 15, 12, 0, 0));
  const worst = { label: '5h', util: 99, reset: new Date(now.getTime() + 2 * 3600 * 1000) };
  const msg = buildToolBlockMessage(worst, now, true);

  it('T19.10 HANDBACK_TOOLS is exactly SubagentHandback and StructuredOutput', () => {
    assert.deepEqual([...HANDBACK_TOOLS], ['SubagentHandback', 'StructuredOutput']);
    assert.ok(Object.isFrozen(HANDBACK_TOOLS));
  });

  for (const name of HANDBACK_TOOLS) {
    it(`T19.11 hand-back tool ${name} is ungated and named in the sub-agent message`, () => {
      assert.equal(matches(matcher, name), false, `${name} must not be gated by hooks.json`);
      assert.ok(msg.includes(name), `sub-agent message must name ${name}`);
    });
  }

  it('T19.12 sub-agent message no longer claims every tool is gated', () => {
    assert.doesNotMatch(msg, /all tools are gated/i);
    assert.match(msg, /hand-back tools \(SubagentHandback, StructuredOutput\) are NOT/);
    assert.match(msg, /resume brief to your caller/);
    assert.match(msg, /ScheduleWakeup is NOT available/);
  });

  // Both main-thread branches: reset within 6h (self-sleep pause) and reset
  // more than 6h out (wrap-up). Each case first proves it hit its own branch,
  // then that none of the sub-agent hand-back wording leaked into it.
  const weekly = { label: '7d', util: 99, reset: new Date(now.getTime() + 3 * 24 * 3600 * 1000) };
  for (const [name, w, branchMark] of [
    ['reset within 6h', worst, /call ScheduleWakeup \(exempt from this gate\)/],
    ['reset more than 6h out', weekly, /Wrap up: summarize state for the user/],
  ]) {
    it(`T19.13 main-thread message (${name}) carries no hand-back wording`, () => {
      const main = buildToolBlockMessage(w, now, false);
      assert.match(main, branchMark, 'must exercise the intended main-thread branch');
      assert.ok(!main.includes('hand-back'), 'main-thread message must not mention hand-back');
      assert.doesNotMatch(main, /resume brief to your caller/);
      assert.doesNotMatch(main, /sub-agent:/i);
      for (const tool of HANDBACK_TOOLS) {
        assert.ok(!main.includes(tool), `main-thread message must not name ${tool}`);
      }
    });
  }

  it('T19.14 resume-hop suffix no longer claims every other tool is gated', () => {
    const suffix = buildResumeHopSuffix(worst, now);
    assert.doesNotMatch(suffix, /all other tools are gated/i);
    assert.match(suffix, /Work tools \(shell, edits, web, agents, MCP\) stay gated/);
  });
});

describe('T19 docs agree with the exec-form wiring (issue #14)', () => {
  const readDoc = (name) =>
    readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

  /** Returns the README text from "## Install" up to the next "## " heading. */
  function installSection(readme) {
    const start = readme.indexOf('\n## Install');
    assert.ok(start >= 0, 'README has an "## Install" section');
    const end = readme.indexOf('\n## ', start + 1);
    return readme.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
  }

  it('T19.16 README install section states the Claude Code >= 2.1.139 requirement', () => {
    assert.match(installSection(readDoc('README.md')), /\*\*Requires Claude Code ≥ 2\.1\.139\.?\*\*/);
  });

  it('T19.17 README install section says an older client leaves the guard OFF', () => {
    const install = installSection(readDoc('README.md'));
    assert.match(install, /bare `node`/);
    assert.match(install, /exits 1/);
    assert.match(install, /non-blocking hook error/);
    assert.match(install, /guard is \*\*OFF\*\*/);
  });

  it('T19.18 README and CLAUDE.md contain no shell-form hook command string', () => {
    for (const name of ['README.md', 'CLAUDE.md']) {
      const text = readDoc(name).replace(/\s+/g, ' ');
      for (const re of SHELL_FORM_PATTERNS) assert.doesNotMatch(text, re, name);
    }
    assert.match(readDoc('CLAUDE.md'), /\*\*exec form\*\*/);
  });

  it('T19.19 the shell-form patterns catch the old wiring and spare exec form (self-check)', () => {
    const caught = [
      '"command": "node \\"${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs\\""',
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs"',
      "node '${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs'",
      'node ${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs',
      '"command": "${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs"',
      '"command" : "node scripts/usage-guard.mjs"',
    ];
    for (const s of caught) {
      assert.ok(SHELL_FORM_PATTERNS.some((re) => re.test(s)), `${s} must be flagged`);
    }
    const spared = [
      '"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs"]',
      'runs the installed `scripts/usage-guard.mjs` with `node`',
      'On Windows, shell form would start a Git Bash process first',
    ];
    for (const s of spared) {
      assert.ok(!SHELL_FORM_PATTERNS.some((re) => re.test(s)), `${s} must pass`);
    }
  });

  it('T19.20 README install section warns that a .cmd/.bat node shim leaves the guard off', () => {
    // The note sits in the same paragraph as the Node >= 18 requirement.
    const para = readDoc('README.md')
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.replace(/\s+/g, ' '))
      .find((p) => /Node\.js \*\*≥ 18\*\*/.test(p));
    assert.ok(para, 'README states the Node.js >= 18 requirement');
    assert.match(para, /`node\.exe`/);
    assert.match(para, /`\.cmd`/);
    assert.match(para, /`\.bat`/);
    assert.match(para, /non-blocking/);
    assert.match(para, /guard is \*\*OFF\*\*/);
  });
});
