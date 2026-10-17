/**
 * T22 — CLAUDE.md's test-file convention matches test/ (issue #13)
 *
 * The CLAUDE.md "Tests:" bullet states the numbered range (`t1`–`tN`) and names
 * every test file that does not build its fakes from `test/helpers.mjs`. Adding
 * a test file without updating that sentence made the claim false twice, so
 * this test checks both parts against the directory listing:
 *   - N equals the highest number among test/t<N>-*.mjs files;
 *   - every test file that does not import './helpers.mjs' is named.
 *
 * Pure: reads CLAUDE.md and the test/ listing only, so it runs in every CI cell.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));
const CLAUDE_MD = fileURLToPath(new URL('../CLAUDE.md', import.meta.url));
const HELPERS_IMPORT = /from\s+['"]\.\/helpers\.mjs['"]/;

/** Returns the CLAUDE.md bullet that documents the test conventions. */
export function testsBullet(text) {
  const line = text.split(/\r?\n/).find((l) => l.startsWith('- Tests:'));
  assert.ok(line, 'CLAUDE.md has no "- Tests:" bullet');
  return line;
}

/** Returns the upper bound N of the "`t1`–`tN`" range in the bullet, or null. */
export function documentedMax(bullet) {
  const m = /`t1`\s*[–-]\s*`t(\d+)`/.exec(bullet);
  return m ? Number(m[1]) : null;
}

/** Returns the highest N among file names shaped t<N>-*.mjs (letters after N allowed). */
export function highestTestNumber(names) {
  let max = 0;
  for (const name of names) {
    const m = /^t(\d+)[a-z]?-.*\.mjs$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Returns the names in `names` that are not mentioned in `bullet`. */
export function unnamed(bullet, names) {
  return names.filter((name) => !bullet.includes(`\`${name}\``));
}

const files = readdirSync(TEST_DIR).filter((n) => /^t\d+[a-z]?-.*\.mjs$/.test(n)).sort();
const bullet = testsBullet(readFileSync(CLAUDE_MD, 'utf8'));

describe('T22 CLAUDE.md test-file convention matches test/', () => {
  it('T22.1 the documented range ends at the highest-numbered test file', () => {
    assert.equal(documentedMax(bullet), highestTestNumber(files));
  });

  it('T22.2 every test file that does not import helpers.mjs is named as an exception', () => {
    const exceptions = files.filter(
      (name) => !HELPERS_IMPORT.test(readFileSync(TEST_DIR + name, 'utf8')),
    );
    assert.deepEqual(unnamed(bullet, exceptions), []);
  });

  it('T22.3 the checks catch a stale range and a missing exception', () => {
    const stale = '- Tests: numbered files (`t1`–`t20`); exceptions: `t20-docs-privacy.mjs`.';
    assert.notEqual(documentedMax(stale), highestTestNumber(['t20-a.mjs', 't21-b.mjs']));
    assert.deepEqual(unnamed(stale, ['t20-docs-privacy.mjs', 't21-b.mjs']), ['t21-b.mjs']);
    assert.equal(highestTestNumber(['t3b-x.mjs', 't9-y.mjs', 'helpers.mjs']), 9);
  });
});
