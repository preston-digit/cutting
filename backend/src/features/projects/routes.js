// PROJECTS feature routes (EXAMPLE — delete with the feature).
//
// A feature exports { basePath, router }. Postgres stores ONLY the local
// `projects` row (Digit references + cached display fields); live SO/job data is
// fetched from Digit on demand via the allowlisted ops in digitOps.js.
import { Router } from "express";
import { assertDb } from "../../core/db.js";
import { getOrder, deriveContractValue, createJob } from "./digitOps.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const db = assertDb();
    const { rows } = await db.query(
      "SELECT * FROM projects ORDER BY created_at DESC"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Create a project FROM a Digit sales order: read the SO, derive cached fields,
// persist only references.
router.post("/from-order/:orderId", async (req, res, next) => {
  try {
    const db = assertDb();
    const order = await getOrder(req.params.orderId);
    if (!order) return res.status(404).json({ error: "Sales order not found" });

    const { name, pm, programmer, classification } = req.body || {};
    const { rows } = await db.query(
      `INSERT INTO projects
         (name, customer_name, pm, programmer, status, classification,
          contract_value, digit_so_id, digit_job_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        name || order.projectName || order.orderNumber,
        order.customer?.name || null,
        pm || null,
        programmer || null,
        "active",
        classification || null,
        deriveContractValue(order),
        order.id,
        [],
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Live sales order for a project (proxied from Digit, not cached locally).
router.get("/:id/order", async (req, res, next) => {
  try {
    const db = assertDb();
    const { rows } = await db.query(
      "SELECT digit_so_id FROM projects WHERE id = $1",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Project not found" });
    const order = await getOrder(rows[0].digit_so_id);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// Create a job in Digit for an order line, then record its id on the project.
router.post("/:id/jobs", async (req, res, next) => {
  try {
    const db = assertDb();
    const { itemId, salesOrderId, salesOrderItemRowId } = req.body || {};
    if (!itemId) return res.status(400).json({ error: "itemId is required" });

    const job = await createJob({ itemId, salesOrderId, salesOrderItemRowId });
    const { rows } = await db.query(
      `UPDATE projects
         SET digit_job_ids = array_append(digit_job_ids, $1), updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [job.id, req.params.id]
    );
    res.status(201).json({ job, project: rows[0] });
  } catch (err) {
    next(err);
  }
});

export const projects = { basePath: "/api/projects", router };
