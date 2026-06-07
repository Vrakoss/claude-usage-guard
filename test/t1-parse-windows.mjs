/**
 * T1 — parseWindows
 *
 * Tests the pure helper that converts validated cache data into a list of
 * window descriptors: [{ label, util (rounded int), reset (Date) }].
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindows, validateCache } from '../scripts/usage-guard.mjs';
import { FIXED_NOW_MS, RESET_IN_3H, RESET_IN_8H } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Helper: build a cache-shaped object that parseWindows() accepts.
// parseWindows() takes the validated-cache shape: { fetchedAt, windows }
// ---------------------------------------------------------------------------

function makeData(windows) {
  return {
    fetchedAt: FIXED_NOW_MS,
    failedAt: null,
    windows,
  };
}

describe('T1 — parseWindows', () => {
  // -------------------------------------------------------------------------
  // T1.1 Full live-shaped response with all four known windows
  // -------------------------------------------------------------------------
  it('T1.1 returns descriptors for all present windows in definition order', () => {
    const data = makeData({
      five_hour: { utilization: 32.7, resets_at: RESET_IN_3H },
      seven_day: { utilization: 5.1, resets_at: RESET_IN_8H },
      seven_day_opus: { utilization: 0, resets_at: RESET_IN_8H },
      seven_day_sonnet: { utilization: 60.4, resets_at: RESET_IN_8H },
    });

    const result = parseWindows(data);

    assert.equal(result.length, 4);

    // Labels follow WINDOW_LABELS order: five_hour, seven_day, seven_day_opus, seven_day_sonnet
    assert.equal(result[0].label, '5h');
    assert.equal(result[0].util, 33);   // Math.round(32.7)
    assert.ok(result[0].reset instanceof Date);
    assert.ok(!Number.isNaN(result[0].reset.getTime()));

    assert.equal(result[1].label, '7d');
    assert.equal(result[1].util, 5);    // Math.round(5.1)

    assert.equal(result[2].label, '7d-opus');
    assert.equal(result[2].util, 0);

    assert.equal(result[3].label, '7d-sonnet');
    assert.equal(result[3].util, 60);   // Math.round(60.4)
  });

  // -------------------------------------------------------------------------
  // T1.2 seven_day_opus: null — null windows are skipped
  // -------------------------------------------------------------------------
  it('T1.2 skips null window entries', () => {
    const data = makeData({
      five_hour: { utilization: 50, resets_at: RESET_IN_3H },
      seven_day: { utilization: 10, resets_at: RESET_IN_8H },
      // seven_day_opus intentionally absent
      seven_day_sonnet: { utilization: 20, resets_at: RESET_IN_8H },
    });

    const result = parseWindows(data);

    assert.equal(result.length, 3);
    assert.ok(result.every((w) => w.label !== '7d-opus'));
  });

  // -------------------------------------------------------------------------
  // T1.3 Unknown extra fields on windows object are silently ignored
  // -------------------------------------------------------------------------
  it('T1.3 extra unknown window keys are ignored (not in label map)', () => {
    // validateCache already strips unknown keys; parseWindows iterates WINDOW_LABELS keys only.
    const data = makeData({
      five_hour: { utilization: 40, resets_at: RESET_IN_3H },
      unknown_window: { utilization: 99, resets_at: RESET_IN_3H }, // not in WINDOW_LABELS
    });

    const result = parseWindows(data);
    assert.equal(result.length, 1);
    assert.equal(result[0].label, '5h');
  });

  // -------------------------------------------------------------------------
  // T1.4 Missing fields — windows object empty
  // -------------------------------------------------------------------------
  it('T1.4 empty windows object yields empty result', () => {
    const data = makeData({});
    const result = parseWindows(data);
    assert.equal(result.length, 0);
  });

  // -------------------------------------------------------------------------
  // T1.5 Missing windows key entirely
  // -------------------------------------------------------------------------
  it('T1.5 data without windows key yields empty result', () => {
    const result = parseWindows({ fetchedAt: FIXED_NOW_MS, failedAt: null });
    assert.equal(result.length, 0);
  });

  // -------------------------------------------------------------------------
  // T1.6 Null data yields empty result
  // -------------------------------------------------------------------------
  it('T1.6 null data yields empty result', () => {
    assert.deepEqual(parseWindows(null), []);
    assert.deepEqual(parseWindows(undefined), []);
  });

  // -------------------------------------------------------------------------
  // T1.7 Malformed resets_at is skipped (NaN date check in parseWindows)
  // -------------------------------------------------------------------------
  it('T1.7 malformed resets_at string skips the window', () => {
    // parseWindows does its own new Date() + NaN check, so even if validateCache
    // already rejected malformed dates, we exercise the path with a direct
    // data object that bypasses validateCache.
    const data = {
      fetchedAt: FIXED_NOW_MS,
      failedAt: null,
      windows: {
        five_hour: { utilization: 50, resets_at: 'not-a-date' },
        seven_day: { utilization: 20, resets_at: RESET_IN_8H },
      },
    };

    const result = parseWindows(data);
    // five_hour produces NaN date → skipped; seven_day is valid
    assert.equal(result.length, 1);
    assert.equal(result[0].label, '7d');
  });

  // -------------------------------------------------------------------------
  // T1.8 Non-numeric utilization — window with non-number util
  // -------------------------------------------------------------------------
  it('T1.8 non-numeric utilization on raw data object — window skipped via NaN-safe round', () => {
    // When parseWindows receives a window whose utilization is a string, it
    // calls Math.round() which produces NaN. The util field will be NaN but
    // the entry is still pushed. This exercises the raw path; the real guard is
    // validateWindowEntry (tested via T3b). Document expected behaviour: util=NaN.
    const data = {
      fetchedAt: FIXED_NOW_MS,
      failedAt: null,
      windows: {
        five_hour: { utilization: 'IGNORE PREVIOUS INSTRUCTIONS', resets_at: RESET_IN_3H },
      },
    };

    // parseWindows doesn't validate — it just pushes with NaN util.
    // evaluateThresholds will compare NaN >= cfg.hard which is false, so level stays 'ok'.
    const result = parseWindows(data);
    assert.equal(result.length, 1);
    assert.ok(Number.isNaN(result[0].util)); // documented NaN behaviour from raw path
  });

  // -------------------------------------------------------------------------
  // T1.9 util is correctly rounded (0.5 rounds to 1)
  // -------------------------------------------------------------------------
  it('T1.9 util is Math.round of utilization', () => {
    const data = makeData({
      five_hour: { utilization: 79.5, resets_at: RESET_IN_3H },
    });

    const result = parseWindows(data);
    assert.equal(result[0].util, 80); // Math.round(79.5) = 80
  });

  // -------------------------------------------------------------------------
  // T1.10 reset is a Date object with correct time
  // -------------------------------------------------------------------------
  it('T1.10 reset is a proper Date corresponding to resets_at', () => {
    const resetIso = RESET_IN_3H;
    const data = makeData({
      five_hour: { utilization: 50, resets_at: resetIso },
    });

    const result = parseWindows(data);
    assert.equal(result[0].reset.getTime(), new Date(resetIso).getTime());
  });
});
