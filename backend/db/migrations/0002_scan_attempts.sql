-- Audit trail for every scan/search attempt on the cut screen, independent
-- of whether it resolved to a label. A scanned barcode that fails to
-- resolve leaves no cut_events row (no cut happens), so without this table
-- there is no record at all of a scan failure on the floor — this is what
-- makes those diagnosable after the fact (see SCHEMA_NOTES.md).

CREATE TABLE IF NOT EXISTS scan_attempts (
  id                 SERIAL PRIMARY KEY,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  work_order_id      TEXT,

  raw_value          TEXT NOT NULL,
  sanitized_value    TEXT NOT NULL,

  resolution_method  TEXT NOT NULL,   -- 'exact_scancode' | 'exact_label_number' | 'text_search'
  outcome            TEXT NOT NULL,   -- 'resolved' | 'not_found' | 'shown_for_selection'

  resolved_inventory_id TEXT,
  match_count        INTEGER,
  error_message      TEXT
);

CREATE INDEX IF NOT EXISTS scan_attempts_work_order_id_idx ON scan_attempts (work_order_id);
CREATE INDEX IF NOT EXISTS scan_attempts_occurred_at_idx ON scan_attempts (occurred_at DESC);
