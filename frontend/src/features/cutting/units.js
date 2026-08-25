// Unit-of-measure formatting helpers — the org intends to move roll goods
// from ft² to yd² eventually, so nothing in this feature may hardcode a unit
// string. Every quantity's unit comes from the backend (ultimately from
// Digit's Item.defaultStockUom), passed through as a `{ symbol, name, type }`
// object or a bare symbol string. These helpers just attach it for display.
// Mirrors deriveLinearUnitSymbol() in backend/src/features/cutting/digitOps.js.

/** "ft²" -> "ft", "sq yd" -> "yd" — best-effort, falls back to the area symbol unchanged. */
export function linearUnitSymbol(areaSymbol) {
  if (!areaSymbol) return null;
  if (areaSymbol.endsWith("²")) return areaSymbol.slice(0, -1);
  const sq = areaSymbol.match(/^sq\.?\s*(.+)$/i);
  if (sq) return sq[1];
  return areaSymbol;
}

/** value + area unit symbol, e.g. formatArea(40, "ft²") -> "40 ft²". No unit known -> bare number. */
export function formatArea(value, areaSymbol) {
  if (value == null) return "—";
  return areaSymbol ? `${value} ${areaSymbol}` : `${value}`;
}

/** value + linear unit symbol derived from the area symbol, e.g. formatLength(5, "ft²") -> "5 ft". */
export function formatLength(value, areaSymbol) {
  if (value == null) return "—";
  const lin = linearUnitSymbol(areaSymbol);
  return lin ? `${value} ${lin}` : `${value}`;
}

/** width × length + linear unit, e.g. formatDims(10, 5, "ft²") -> "10 × 5 ft". */
export function formatDims(width, length, areaSymbol) {
  if (width == null || length == null) return "—";
  const lin = linearUnitSymbol(areaSymbol);
  return lin ? `${width} × ${length} ${lin}` : `${width} × ${length}`;
}

/** value + a count/other unit's bare symbol, e.g. formatQty(2, "ea") -> "2 ea". */
export function formatQty(value, symbol) {
  if (value == null) return "—";
  return symbol ? `${value} ${symbol}` : `${value}`;
}

// Operators measure rolls in feet and inches, not decimal feet — a tape
// reads "13 foot 2", never "13.1667". Decimal feet stays the sole internal
// representation (mirrors backend/src/features/cutting/dimensions.js) —
// these are display/input-only helpers, nothing here is ever written back
// to a Digit custom field as a feet-inches string.

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

/** feet + inches (separate operator inputs) -> decimal feet, or null if neither is a usable number. */
export function combineFeetInches(feet, inches) {
  const f = feet === "" || feet == null ? 0 : Number(feet);
  const i = inches === "" || inches == null ? 0 : Number(inches);
  if (!Number.isFinite(f) || !Number.isFinite(i)) return null;
  if (feet === "" && inches === "") return null;
  return f + i / 12;
}

/** value + linear unit, feet-inches notation when the linear unit is "ft", decimal otherwise. */
export function formatLengthFeetInches(value, areaSymbol) {
  if (value == null) return "—";
  const lin = linearUnitSymbol(areaSymbol);
  if (lin === "ft") return formatFeetInches(value);
  return lin ? `${value} ${lin}` : `${value}`;
}

/** width × length, feet-inches notation when the linear unit is "ft", decimal otherwise. */
export function formatDimsFeetInches(width, length, areaSymbol) {
  if (width == null || length == null) return "—";
  const lin = linearUnitSymbol(areaSymbol);
  if (lin === "ft") return `${formatFeetInches(width)} × ${formatFeetInches(length)}`;
  return lin ? `${width} × ${length} ${lin}` : `${width} × ${length}`;
}
