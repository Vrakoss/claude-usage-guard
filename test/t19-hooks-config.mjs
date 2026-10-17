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
 * Every hook stays in SHELL form (`command` string, no `args`). Exec form
 * (`command` + `args`) only exists from Claude Code 2.1.139; older clients strip
 * the unknown `args` key and run a bare `node` that evaluates the hook JSON on
 * stdin as a script -> SyntaxError, exit 1 -> non-blocking error, i.e. the guard
 * is silently off. Plugins cannot declare an enforced minimum client version, so
 * exec form is not shipped (see the issue #11 supervisor ruling).
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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HANDBACK_TOOLS, buildToolBlockMessage, buildResumeHopSuffix } from '../scripts/usage-guard.mjs';

const HOOKS_PATH = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url));
const config = JSON.parse(readFileSync(HOOKS_PATH, 'utf8'));

const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'SessionStart'];
const SHELL_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.mjs"';
const FORBIDDEN_KEYS = ['args', 'shell', 'async', 'asyncRewake', 'if', 'onFailure'];

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
    it(`T19.2 ${event}: one shell-form command hook running the guard, timeout 20`, () => {
      const { hook } = soleHook(event);
      assert.equal(hook.type, 'command');
      assert.equal(hook.command, SHELL_COMMAND);
      assert.equal(hook.timeout, 20);
    });

    it(`T19.3 ${event}: no args/shell/async/asyncRewake/if/onFailure keys`, () => {
      const { hook } = soleHook(event);
      for (const key of FORBIDDEN_KEYS) {
        assert.equal(Object.hasOwn(hook, key), false, `${event} hook must not set "${key}"`);
      }
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
