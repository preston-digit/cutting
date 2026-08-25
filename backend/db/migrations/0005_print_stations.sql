-- Print stations — one physical label printer per workstation. Local-only
-- concept; Digit has no notion of a print station. The operator picks a
-- station once per device (persisted client-side in localStorage, see
-- CutScreen.jsx); the printer address itself lives here, server-side,
-- keyed by station id, and is never sent to the browser (see routes.js's
-- GET /stations, which returns only name + has_printer).

CREATE TABLE IF NOT EXISTS print_stations (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  printer_address TEXT,             -- null = no printer wired up yet (see print/sink.js's ArtifactSink fallback)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
