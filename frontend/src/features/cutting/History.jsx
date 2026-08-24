import { useEffect, useState } from "react";
import { getHistory } from "./api.js";

function StatusPill({ status }) {
  if (status === "completed") return <span className="pill pill--green">Completed</span>;
  return <span className="pill pill--neutral">Partial failure</span>;
}

export default function History({ nav }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getHistory()
      .then(setEvents)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div style={{ padding: "var(--space-5)" }}>
      <div className="breadcrumb">
        <span className="link" onClick={() => nav("cutting.queue")}>Work orders</span>
        <span className="sep">›</span>
        <span>Cut history</span>
      </div>
      <div className="page-title-row">
        <h1 className="page-title">Cut history</h1>
      </div>
      <div className="page-subtitle">Most recent cuts first — the local audit trail for every commit.</div>

      {error && <div className="checklist-error-box">{error}</div>}
      {events === null && !error && <div className="muted">Loading…</div>}

      {events !== null && (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-head-row">
            <div className="col">When</div>
            <div className="col">Operator</div>
            <div className="col">WO / MO</div>
            <div className="col">Source label</div>
            <div className="col">Cut</div>
            <div className="col">Working piece</div>
            <div className="col">Remnant</div>
            <div className="col">Status</div>
            <div className="col">Notes</div>
          </div>
          {events.length === 0 && (
            <div className="row" style={{ cursor: "default" }}>
              <div className="col muted">No cuts recorded yet.</div>
            </div>
          )}
          {events.map((e) => (
            <div key={e.id} className="row" style={{ cursor: "default", height: "auto", padding: "var(--space-3)" }}>
              <div className="col">{new Date(e.occurred_at).toLocaleString()}</div>
              <div className="col">{e.operator_name || <span className="muted">—</span>}</div>
              <div className="col">
                WO{e.work_order_number}
                <div className="muted">{e.mo_number}</div>
              </div>
              <div className="col">
                {e.source_scancode}
                <div className="muted mono">
                  {e.source_width_before} × {e.source_length_before} ft → {e.source_width_after} × {e.source_length_after} ft
                </div>
              </div>
              <div className="col mono">
                {e.cut_width} × {e.cut_length} ft ({e.cut_area} ft²)
                {e.has_side_remnant && (
                  <div className="muted">remnant {e.remnant_width} × {e.remnant_length} ft ({e.remnant_area} ft²)</div>
                )}
              </div>
              <div className="col">{e.working_piece_scancode || <span className="muted">—</span>}</div>
              <div className="col">{e.remnant_scancode || <span className="muted">—</span>}</div>
              <div className="col">
                <StatusPill status={e.status} />
                {e.failed_step && <div className="muted">failed at {e.failed_step}</div>}
              </div>
              <div className="col">{e.notes || <span className="muted">—</span>}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
