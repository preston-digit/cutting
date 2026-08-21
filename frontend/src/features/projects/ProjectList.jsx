import { useEffect, useState } from "react";
import { health } from "../../core/api.js";
import { projectsApi } from "./api.js";

function StatusPill({ status }) {
  const cls =
    status === "active" ? "pill--active" : status === "closed" ? "pill--closed" : "pill--pending";
  return <span className={`pill ${cls}`}>{status}</span>;
}

// Registered as the "projects.list" view. Receives { nav, pm } from the Shell.
export default function ProjectList({ nav, pm }) {
  const [projects, setProjects] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    health().then(setStatus).catch((e) => setError(e.message));
    projectsApi.list().then(setProjects).catch((e) => setError(e.message));
  }, []);

  return (
    <div style={{ padding: "var(--space-4)" }}>
      <h2 style={{ marginTop: 0 }}>
        Projects{pm && <span className="muted"> · {pm}</span>}
      </h2>
      {status && (
        <p className="muted" style={{ fontSize: "var(--fs-sm)" }}>
          Backend: {status.status}
        </p>
      )}
      {error && <p style={{ color: "crimson" }}>Error: {error}</p>}
      {!projects && !error && <p>Loading…</p>}
      {projects?.length === 0 && <p className="muted">No projects yet.</p>}
      {projects?.map((p) => (
        <div
          key={p.id}
          className="row"
          onClick={() => nav("projects.detail", { projectId: p.id })}
        >
          <span style={{ flex: 1 }}>{p.name}</span>
          <span className="muted" style={{ flex: 1 }}>{p.customer_name || "—"}</span>
          <StatusPill status={p.status} />
        </div>
      ))}
    </div>
  );
}
