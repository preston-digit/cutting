// Pure dimension-text parsing — split out from digitOps.js so it has no
// Digit/network dependency and can be unit tested directly (see
// dimensions.test.js).
//
// Field reality (live customer tag, confirmed 2026-08-24): Roll Length/Roll
// Width are sometimes recorded as feet-and-inches ("13'-2\"", "16'-0\""),
// not always decimal feet. The old parser (`Number(match[0])` against the
// first digit run found) silently truncated these to the feet component
// only — "13'-2\"" parsed as 13, dropping 2 inches (0.1667 ft) — which
// overstates how much length is left on the parent roll after every cut
// that touches a feet-and-inches-recorded label. Decimal feet remains the
// SOLE internal representation (see SCHEMA_NOTES.md's canonical unit-basis
// rule) — this parser only widens what TEXT it accepts on the way in;
// nothing downstream, and no write path, ever produces a feet-inches
// string again.

/**
 * Parses Roll Length/Roll Width custom field text into decimal feet.
 * Accepts, in order:
 *   - feet-and-inches: 13'-2", 13' 2", 13'2", 16'-0", 13'  (bare feet-tick)
 *   - decimal or bare feet: 13.5, 13
 *   - legacy noisy text with a unit label baked in (pre-existing dummy data,
 *     e.g. "Length: 40 ft") — first number found, lenient, unchanged from
 *     the original behavior.
 * Returns a decimal-feet Number, or null if nothing usable was found.
 * Never returns a partial/truncated number for text that LOOKS like
 * feet-inches notation (contains an apostrophe) but doesn't fully match —
 * that fails closed to null rather than silently keeping just the feet part.
 */
export function parseDimensionText(text) {
  if (!text) return null;
  const str = String(text).trim();

  if (str.includes("'")) {
    // 13'-2"  |  13' 2"  |  13'2"  |  16'-0"  |  13'
    const match = str.match(/^(\d+(?:\.\d+)?)\s*'\s*-?\s*(\d+(?:\.\d+)?)?\s*"?\s*$/);
    if (!match) return null; // looks like feet-inches but doesn't parse cleanly — never guess
    const feet = Number(match[1]);
    const inches = match[2] != null ? Number(match[2]) : 0;
    if (!Number.isFinite(feet) || !Number.isFinite(inches)) return null;
    return feet + inches / 12;
  }

  // No apostrophe — decimal/bare feet, or legacy noisy text (lenient: first
  // number found anywhere in the string, same as the original behavior).
  const match = str.match(/[\d.]+/);
  return match ? Number(match[0]) : null;
}

/**
 * Rounds a decimal-feet value to kill floating-point representation noise
 * (e.g. 16.7 - 3.4 === 13.299999999999999 in IEEE 754) before it's written
 * to Digit as text — never returns a "clean-looking" number that actually
 * discards real precision. 4 decimal places is ~0.0001 ft (~0.0012 in),
 * far finer than any real roll-goods measurement (whole inches, or
 * decimal-feet legacy data with at most a couple of decimals), so this only
 * ever removes trailing float garbage, never legitimate digits.
 */
export function roundDecimalFeet(value) {
  if (value == null || !Number.isFinite(value)) return value;
  return Math.round(value * 10000) / 10000;
}

/** Decimal feet -> "13'-2\"" for display. Rounds to the nearest whole inch. */
export function formatFeetInches(decimalFeet) {
  if (decimalFeet == null || !Number.isFinite(decimalFeet)) return null;
  const totalInches = Math.round(decimalFeet * 12);
  const sign = totalInches < 0 ? "-" : "";
  const abs = Math.abs(totalInches);
  const feet = Math.floor(abs / 12);
  const inches = abs % 12;
  return `${sign}${feet}'-${inches}"`;
}
