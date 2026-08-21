import { useEffect, useState } from "react";
import { projectsApi } from "./api.js";

// Registered as the "projects.detail" view. Receives { nav, projectId } from
// the Shell (projectId comes from the nav params set by ProjectList).
export default function ProjectDetail({ nav, projectId }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    projectsApi.getOrder(projectId).then(setOrder).catch((e) => setError(e.message));
  }, [projectId]);

  return (
    <div style={{ padding: "var(--space-4)" }}>
      <span className="link" onClick={() => nav("projects.list")}>← Projects</span>
      <h2>Project #{projectId}</h2>
      {error && <p style={{ color: "crimson" }}>Error: {error}</p>}
      {!order && !error && <p>Loading sales order from Digit…</p>}
      {order && (
        <>
          <p className="muted">SO {order.orderNumber} · {order.customer?.name}</p>
          {order.items?.map((line) => (
            <div key={line.id} className="row">
              <span style={{ flex: 1 }}>{line.item?.name}</span>
              <span className="muted">× {line.quantity}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
