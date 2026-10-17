/**
 * T21 — README prose stays hard-wrapped (issue #13, criterion 5)
 *
 * README prose is hard-wrapped at about 92 columns. An edit that rewrites a
 * paragraph as one long line (as happened twice in "Why these ten") is easy to
 * miss in review, so this test fails on any prose line over MAX_PROSE_WIDTH.
 * Lines that cannot be wrapped are exempt: fenced code blocks, table rows
 * (`|` ...) and image lines (`![`...).
 *
 * Pure: reads README.md only, so it runs in every CI cell.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The wrap target is 92; a few existing lines end with a short code span that
// would look worse broken, so allow a small margin over it.
const MAX_PROSE_WIDTH = 95;

/** Returns "line N (width W)" for every non-exempt prose line wider than `max`. */
export function overlongProseLines(text, max = MAX_PROSE_WIDTH) {
  const hits = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence || /^\s*\|/.test(line) || /^\s*!\[/.test(line)) return;
    if (line.length > max) hits.push(`line ${i + 1} (width ${line.length})`);
  });
  return hits;
}

describe('T21 README prose stays hard-wrapped', () => {
  it('T21.1 no README prose line is wider than MAX_PROSE_WIDTH', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    assert.deepEqual(overlongProseLines(readme), []);
  });

  it('T21.2 the check flags the regressed line and exempts code, tables and images (self-check)', () => {
    const regressed =
      "  developer's measured workload all ten ungated tools together were about 9% of tool calls; the read-only/local subset alone was about 5%,";
    const long = 'x'.repeat(120);
    const sample = [
      'short prose',
      regressed,
      '```text',
      long,
      '```',
      `| ${long} |`,
      `![${long}](a.png)`,
    ].join('\n');
    assert.deepEqual(overlongProseLines(sample), ['line 2 (width 138)']);
  });
});
