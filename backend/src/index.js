import express from "express";
import cors from "cors";
import { pool, runMigrations } from "./core/db.js";
import { features } from "./features/index.js";

const app = express();
const PORT = process.env.BACKEND_PORT || 4001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

// Allow requests from the frontend dev server (and the host app that embeds it).
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Deeper check: verifies Postgres is reachable.
app.get("/api/health/db", async (_req, res) => {
  if (!pool) return res.status(503).json({ status: "error", db: "not configured" });
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "ok" });
  } catch (err) {
    res.status(503).json({ status: "error", db: err.message });
  }
});

// Mount every registered feature at its basePath.
for (const feature of features) {
  app.use(feature.basePath, feature.router);
}

// Centralized error handler — never leak the Digit token or stack traces.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// Apply migrations before serving so the schema each feature needs exists.
runMigrations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Migration failed, not starting server:", err);
    process.exit(1);
  });
