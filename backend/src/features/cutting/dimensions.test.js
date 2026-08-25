import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDimensionText, formatFeetInches, roundDecimalFeet } from "./dimensions.js";

test("parseDimensionText: feet-and-inches forms", () => {
  assert.equal(parseDimensionText(`13'-2"`), 13 + 2 / 12);
  assert.equal(parseDimensionText(`13' 2"`), 13 + 2 / 12);
  assert.equal(parseDimensionText(`13'2"`), 13 + 2 / 12);
  assert.equal(parseDimensionText(`16'-0"`), 16);
  assert.equal(parseDimensionText(`13'`), 13);
});

test("parseDimensionText: real customer tag example (13'-2\" x 16'-0\" = 210.67 ft2 = 23.41 SY)", () => {
  const length = parseDimensionText(`13'-2"`);
  const width = parseDimensionText(`16'-0"`);
  const area = length * width;
  assert.ok(Math.abs(area - 210.6667) < 0.001, `expected ~210.6667, got ${area}`);
  assert.ok(Math.abs(area / 9 - 23.4074) < 0.001, `expected ~23.4074 SY, got ${area / 9}`);
});

test("parseDimensionText: decimal and bare feet", () => {
  assert.equal(parseDimensionText("13.5"), 13.5);
  assert.equal(parseDimensionText("13"), 13);
  assert.equal(parseDimensionText("0"), 0);
});

test("parseDimensionText: legacy noisy dummy data (lenient, first number found)", () => {
  assert.equal(parseDimensionText("Length: 40 ft"), 40);
  assert.equal(parseDimensionText("Width: 15ft"), 15);
  assert.equal(parseDimensionText("Length 8 ft"), 8);
});

test("parseDimensionText: unparseable input returns null, never a partial number", () => {
  assert.equal(parseDimensionText("xxx"), null);
  assert.equal(parseDimensionText(""), null);
  assert.equal(parseDimensionText(null), null);
  assert.equal(parseDimensionText(undefined), null);
  // Looks like feet-inches but malformed — must fail closed, not fall back
  // to "13" (the old fuzzy-fallback behavior would have silently kept the
  // feet-only partial number here).
  assert.equal(parseDimensionText(`13'-2x"`), null);
  assert.equal(parseDimensionText(`'-2"`), null);
  assert.equal(parseDimensionText(`13'-2" extra text`), null);
});

test("formatFeetInches: decimal feet -> feet-inches string", () => {
  assert.equal(formatFeetInches(13 + 2 / 12), `13'-2"`);
  assert.equal(formatFeetInches(16), `16'-0"`);
  assert.equal(formatFeetInches(0), `0'-0"`);
  assert.equal(formatFeetInches(null), null);
});

test("roundDecimalFeet: kills IEEE 754 subtraction noise", () => {
  assert.equal(roundDecimalFeet(16.7 - 3.4), 13.3);
  assert.equal(String(16.7 - 3.4), "13.299999999999999"); // the bug this guards against
  assert.equal(roundDecimalFeet(0.1 + 0.2), 0.3);
});

test("roundDecimalFeet: preserves real precision up to 4 decimals, passes through edge values", () => {
  assert.equal(roundDecimalFeet(13.1234), 13.1234);
  assert.equal(roundDecimalFeet(13.12345), 13.1235);
  assert.equal(roundDecimalFeet(0), 0);
  assert.equal(roundDecimalFeet(null), null);
  assert.equal(roundDecimalFeet(undefined), undefined);
});
