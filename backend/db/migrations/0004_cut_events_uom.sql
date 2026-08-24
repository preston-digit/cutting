-- Records the area unit symbol (e.g. "ft²") active at the time of the cut,
-- captured from the source item's Digit-defined defaultStockUom rather than
-- hardcoded, so history renders correctly even after the org's base unit
-- changes (e.g. a future move to yd²) without needing a backfill or a code
-- change to interpret old rows. See SCHEMA_NOTES.md / digitOps.js's
-- itemUom()/deriveLinearUnitSymbol().

ALTER TABLE cut_events ADD COLUMN IF NOT EXISTS area_uom_symbol TEXT;
