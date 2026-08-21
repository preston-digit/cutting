-- PROJECTS feature (EXAMPLE — delete with the feature).
--
-- Postgres owns ONLY local tables. Sales orders, items, jobs, and materials live
-- in Digit — store REFERENCES (Digit IDs) plus cached display fields, never copies.

CREATE TABLE IF NOT EXISTS projects (
  id              SERIAL PRIMARY KEY,
  number          TEXT,
  name            TEXT NOT NULL,
  customer_name   TEXT,                 -- cached display only; source of truth is Digit
  pm              TEXT,                 -- PM is NOT in the Digit API (custom field)
  programmer      TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  classification  TEXT,
  contract_value  NUMERIC(14,2),        -- derived/cached: Σ(item.cost × qty)
  digit_so_id     TEXT,                 -- reference: Digit sales order id
  digit_job_ids   TEXT[] NOT NULL DEFAULT '{}',  -- references: Digit job ids
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_digit_so_id_idx ON projects (digit_so_id);
