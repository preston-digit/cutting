-- Tracks print outcome per piece on a cut, separately from the cut's own
-- inventory-operation status — a print failure must never read as "the cut
-- needs manual repair in Digit" (see routes.js's commit route and
-- SCHEMA_NOTES.md). NULL means "not attempted" (no side remnant, or this
-- row predates label printing).

ALTER TABLE cut_events
  ADD COLUMN IF NOT EXISTS print_station_id INTEGER REFERENCES print_stations(id),
  ADD COLUMN IF NOT EXISTS working_piece_print_status TEXT, -- 'printed' | 'failed'
  ADD COLUMN IF NOT EXISTS working_piece_print_error TEXT,
  ADD COLUMN IF NOT EXISTS remnant_print_status TEXT,
  ADD COLUMN IF NOT EXISTS remnant_print_error TEXT;
