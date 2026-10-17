/**
 * T20 — public docs carry no personal usage volume (issue #13, criterion 8)
 *
 * This repository is public. Workload measurements in the docs may give shares
 * ("~9% of tool calls"), but never the size of one person's usage: no tool-call
 * counts ("215k tool calls", "215k-call workload") and no measurement window
 * ("last 60 days"). T20.1 is the issue's literal acceptance check; T20.2 and
 * T20.3 catch the same kind of figure written with other numbers.
 *
 * Pure: reads the markdown files only, so it runs in every CI cell.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOCS = ['README.md', 'CHANGELOG.md', 'CLAUDE.md'];
const CALL_COUNT = /\b\d[\d,.]*\s*[kKmM]?[\s-]+(?:tool[\s-]+)?calls?\b/;
const USAGE_WINDOW =
  /\b(?:last|past)\s+\d+\s+(?:days|weeks|months)\b|\b\d+\s+(?:days|weeks|months)\s+of\s+(?:usage|history|sessions|transcripts)\b/i;

function readDoc(name) {
  return readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
}

/** Returns "file:line: text" for every line of every doc matching `re`. */
function findLines(re, docs = DOCS) {
  const hits = [];
  for (const name of docs) {
    readDoc(name).split(/\r?\n/).forEach((line, i) => {
      if (re.test(line)) hits.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

describe('T20 public docs carry no personal usage volume', () => {
  it('T20.1 the issue #13 acceptance grep finds nothing in README.md and CHANGELOG.md', () => {
    assert.deepEqual(findLines(/215|214k|60 days/, ['README.md', 'CHANGELOG.md']), []);
  });

  it('T20.2 no tool-call counts (e.g. "215k tool calls", "215k-call workload")', () => {
    assert.deepEqual(findLines(CALL_COUNT), []);
  });

  it('T20.3 no usage measurement window (e.g. "last 60 days", "90 days of usage")', () => {
    assert.deepEqual(findLines(USAGE_WINDOW), []);
  });

  it('T20.4 the patterns catch the figures that were removed (self-check)', () => {
    const removed = [
      "measured workload (215k tool calls from a single developer's last 60 days) all ten ungated",
      'On one measured 215k-call local',
    ];
    assert.ok(CALL_COUNT.test(removed[0]) && USAGE_WINDOW.test(removed[0]));
    assert.ok(CALL_COUNT.test(removed[1]));
    assert.ok(!CALL_COUNT.test('about 9% of tool calls'));
    assert.ok(!CALL_COUNT.test('on 200k valid keys'));
  });
});
