import { useEffect, useState } from "react";
import { getQueue } from "./api.js";

const POLL_INTERVAL_MS = 30_000;

function StatusPill({ status }) {
  if (status === "IN_PROGRESS") return <span className="pill pill--blue">In Progress</span>;
  return <span className="pill pill--neutral">Not Started</span>;
}

function formatShipBy(dateStr) {
  if (!dateStr) return <span className="muted">—</span>;
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function CuttingQueue({ nav }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getQueue();
        if (!cancelled) {
          setRows(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div style={{ padding: "var(--space-5)" }}>
      <div className="breadcrumb">Work orders</div>
      <div className="page-title-row">
        <h1 className="page-title">Cutting queue</h1>
      </div>
      <div className="page-subtitle" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Work orders at the Cut to Size step, sorted by ship-by date. Refreshes every 30s.</span>
        <span className="link" onClick={() => nav("cutting.history")}>Cut history</span>
      </div>

      {error && <div className="checklist-error-box" style={{ marginBottom: "var(--space-4)" }}>{error}</div>}

      {rows === null && !error && <div className="muted">Loading…</div>}

      {rows !== null && (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-head-row">
            <div className="col-checkbox" />
            <div className="col">WO #</div>
            <div className="col">MO #</div>
            <div className="col">Item</div>
            <div className="col">Target qty</div>
            <div className="col">Sales order</div>
            <div className="col">Ship by</div>
            <div className="col">Status</div>
          </div>
          {rows.length === 0 && (
            <div className="row" style={{ cursor: "default" }}>
              <div className="col-checkbox" />
              <div className="col muted">No work orders waiting at this step.</div>
            </div>
          )}
          {rows.map((r) => (
            <div
              key={r.workOrderId}
              className="row"
              onClick={() => nav("cutting.cut", { workOrderId: r.workOrderId })}
            >
              <div className="col-checkbox" />
              <div className="col">WO{r.workOrderNumber}</div>
              <div className="col">{r.moNumber}</div>
              <div className="col">{r.itemName}</div>
              <div className="col mono">{r.targetQuantity} ea</div>
              <div className="col">{r.salesOrderNumber || <span className="muted">—</span>}</div>
              <div className="col">{formatShipBy(r.shipByDate)}</div>
              <div className="col">
                <StatusPill status={r.status} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
