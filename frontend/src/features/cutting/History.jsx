import { useEffect, useState } from "react";
import { getHistory, reprintLabel } from "./api.js";
import { formatArea, formatDims } from "./units.js";
import { printPdfBase64 } from "./printPdf.js";

function StatusPill({ status }) {
  if (status === "completed") return <span className="pill pill--green">Completed</span>;
  return <span className="pill pill--neutral">Partial failure</span>;
}

// Reprint is deliberately available regardless of whether the original
// print step failed — a physical label can be lost, smudged, or misprinted
// long after a clean commit, and there's nothing Digit-side to "fix" either
// way (see CutScreen.jsx's repairMessage). null print status just means
// "not attempted" (no side remnant, or a pre-print-feature row).
function ReprintButton({ cutEventId, piece, printStatus, printError }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function handleReprint() {
    setBusy(true);
    setResult(null);
    try {
      const res = await reprintLabel(cutEventId, piece);
      setResult({ ok: true, detail: res.detail });
      if (res.pdfBase64) {
        printPdfBase64(res.pdfBase64, {
          onError: (err) => setResult({ ok: false, detail: `Rendered but couldn't open the print dialog: ${err.message}` }),
        });
      }
    } catch (err) {
      setResult({ ok: false, detail: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {printStatus === "failed" && <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>Print failed: {printError}</div>}
      <button className="btn btn--secondary" style={{ padding: "2px 8px", fontSize: "var(--fs-sm)" }} onClick={handleReprint} disabled={busy}>
        {busy ? "Printing…" : "Reprint"}
      </button>
      {result && (
        <div className={result.ok ? "muted" : "checklist-error-box"} style={{ fontSize: "var(--fs-sm)", marginTop: 2 }}>
          {result.detail}
        </div>
      )}
    </div>
  );
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
                  {formatDims(e.source_width_before, e.source_length_before, e.area_uom_symbol)} → {formatDims(e.source_width_after, e.source_length_after, e.area_uom_symbol)}
                </div>
              </div>
              <div className="col mono">
                {formatDims(e.cut_width, e.cut_length, e.area_uom_symbol)} ({formatArea(e.cut_area, e.area_uom_symbol)})
                {e.has_side_remnant && (
                  <div className="muted">remnant {formatDims(e.remnant_width, e.remnant_length, e.area_uom_symbol)} ({formatArea(e.remnant_area, e.area_uom_symbol)})</div>
                )}
              </div>
              <div className="col">
                {e.working_piece_scancode || <span className="muted">—</span>}
                {e.working_piece_inventory_id && (
                  <ReprintButton
                    cutEventId={e.id}
                    piece="workingPiece"
                    printStatus={e.working_piece_print_status}
                    printError={e.working_piece_print_error}
                  />
                )}
              </div>
              <div className="col">
                {e.remnant_scancode || <span className="muted">—</span>}
                {e.remnant_inventory_id && (
                  <ReprintButton
                    cutEventId={e.id}
                    piece="remnant"
                    printStatus={e.remnant_print_status}
                    printError={e.remnant_print_error}
                  />
                )}
              </div>
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
