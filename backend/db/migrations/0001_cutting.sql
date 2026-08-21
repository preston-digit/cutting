-- CUTTING feature.
--
-- Postgres owns ONLY this local audit trail. Digit remains the source of
-- truth for inventory, jobs, and work orders — this table stores references
-- (Digit ids/scancodes) plus the parsed numeric dimensions and raw responses
-- for each cut, so a failed Digit write still leaves a local trail of the
-- intended-correct values (see SCHEMA_NOTES.md).

CREATE TABLE IF NOT EXISTS cut_events (
  id                        SERIAL PRIMARY KEY,
  occurred_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  operator_name             TEXT,

  work_order_id             TEXT NOT NULL,
  work_order_number         INTEGER,
  job_id                    TEXT,
  mo_number                 TEXT,

  source_inventory_id       TEXT NOT NULL,
  source_scancode           TEXT,
  source_width_before       NUMERIC(10,2),
  source_length_before      NUMERIC(10,2),

  cut_width                 NUMERIC(10,2) NOT NULL,
  cut_length                NUMERIC(10,2) NOT NULL,
  cut_area                  NUMERIC(10,2) NOT NULL,

  has_side_remnant          BOOLEAN NOT NULL DEFAULT false,
  remnant_width             NUMERIC(10,2),
  remnant_length            NUMERIC(10,2),
  remnant_area              NUMERIC(10,2),
  remnant_bin_id             TEXT,
  remnant_bin_name          TEXT,

  source_width_after        NUMERIC(10,2),
  source_length_after       NUMERIC(10,2),

  working_piece_inventory_id TEXT,
  working_piece_scancode    TEXT,
  remnant_inventory_id      TEXT,
  remnant_scancode          TEXT,

  status                    TEXT NOT NULL,      -- 'completed' | 'partial_failure'
  failed_step               TEXT,                -- key of the step that failed, if any
  steps                      JSONB NOT NULL,      -- ordered array of {key, label, status, detail, error} incl. raw Digit responses

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cut_events_work_order_id_idx ON cut_events (work_order_id);
CREATE INDEX IF NOT EXISTS cut_events_occurred_at_idx ON cut_events (occurred_at DESC);
