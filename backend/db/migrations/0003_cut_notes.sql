-- Free-text operator notes on a cut (a flaw in the material, a mis-measure,
-- a decision to override a warning) — local-only, never written back to
-- Digit. See SCHEMA_NOTES.md.

ALTER TABLE cut_events ADD COLUMN IF NOT EXISTS notes TEXT;
