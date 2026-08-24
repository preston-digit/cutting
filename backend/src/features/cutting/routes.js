// CUTTING feature routes.
//
// Postgres owns ONLY the local cut_events audit trail (see
// db/migrations/0001_cutting.sql) — everything else is read live from Digit
// through the allowlisted operations in digitOps.js.
import { Router } from "express";
import { assertDb } from "../../core/db.js";
import {
  getCuttingQueue,
  getWorkOrderDetail,
  resolveScannedSerial,
  searchInventories,
  getInventoryById,
  readInventoryCustomFields,
  splitSerializedInventory,
  writeInventoryDimensions,
  pickJobItem,
  startWorkOrder,
  completeWorkOrder,
  searchWarehouseLocations,
  resolveWarehouseLocationByName,
  resolvePickableBinForAddress,
  sanitizeScanValue,
  looksLikeScancode,
} from "./digitOps.js";

const router = Router();

const REMNANT_BIN_NAME = process.env.REMNANT_BIN_NAME || "Remnant Storage";
const AREA_MISMATCH_TOLERANCE = 0.01; // 1%, see SCHEMA_NOTES.md

function withParsedDimensions(inventory) {
  const dims = readInventoryCustomFields(inventory);
  const area = inventory.quantityInStock;
  let areaMismatch = null;
  if (dims.rollLength != null && dims.rollWidth != null) {
    const impliedArea = dims.rollLength * dims.rollWidth;
    const diff = Math.abs(impliedArea - area);
    const pctOff = impliedArea === 0 ? (area === 0 ? 0 : 1) : diff / impliedArea;
    areaMismatch = {
      outOfSync: pctOff > AREA_MISMATCH_TOLERANCE,
      quantityInStock: area,
      impliedArea,
      pctOff,
    };
  }
  return {
    id: inventory.id,
    scancode: inventory.scanCodeSerialNumber,
    labelNumber: inventory.scanCodeNumber,
    quantityInStock: area,
    itemId: inventory.item?.id,
    itemName: inventory.item?.name,
    binId: inventory.warehouseLocation?.id,
    binName: inventory.warehouseLocation?.locationCode,
    rollLength: dims.rollLength,
    rollWidth: dims.rollWidth,
    owner: dims.owner,
    parentRoll: dims.parentRoll,
    pieceType: dims.pieceType,
    areaMismatch,
  };
}

// GET /api/cutting/queue
router.get("/queue", async (_req, res, next) => {
  try {
    res.json(await getCuttingQueue());
  } catch (err) {
    next(err);
  }
});

// Pieces actually committed against this work order so far — the ONLY
// correct input to "complete work order", never job.targetQuantity (that's
// the goal, not what's actually been cut). Counts every cut_events row
// regardless of session, since the table is the durable record.
async function getCutCount(workOrderId) {
  const db = assertDb();
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM cut_events WHERE work_order_id = $1 AND status = 'completed'`,
    [workOrderId]
  );
  return rows[0]?.n || 0;
}

// GET /api/cutting/work-orders/:id
router.get("/work-orders/:id", async (req, res, next) => {
  try {
    const wo = await getWorkOrderDetail(req.params.id);
    if (!wo) return res.status(404).json({ error: "Work order not found" });
    const cutCount = await getCutCount(wo.id);
    res.json({
      workOrderId: wo.id,
      workOrderNumber: wo.workOrderNumber,
      status: wo.status,
      expectedQuantity: wo.expectedQuantity,
      completedQuantity: wo.completedQuantity,
      cutCount,
      binId: wo.warehouseLocation?.id,
      binName: wo.warehouseLocation?.locationCode,
      jobId: wo.job?.id,
      moNumber: wo.job?.documentNumber || wo.job?.jobNumber,
      itemId: wo.job?.item?.id,
      itemName: wo.job?.item?.name,
      itemSku: wo.job?.item?.sku,
      targetQuantity: wo.job?.targetQuantity,
      moNotes: wo.job?.notes || null,
      createdBy: wo.job?.createdBy?.profile?.fullName || null,
      createdOn: wo.job?.createdOn || null,
      salesOrderNumber: wo.job?.salesOrder?.orderNumber || null,
      customerName: wo.job?.salesOrder?.customer?.name || null,
      shipByDate: wo.job?.salesOrder?.requestedDeliveryDate || null,
      bomComponents: (wo.job?.bom?.items?.nodes || []).map((n) => ({
        itemId: n.item.id,
        itemName: n.item.name,
        itemSku: n.item.sku,
        quantity: n.quantity,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Records every scan/search attempt — resolved or not — so a floor failure
// ("I scanned it and nothing happened") is diagnosable after the fact from
// the raw value actually decoded. Logging failures never fail the request.
async function logScanAttempt({ workOrderId, rawValue, sanitizedValue, method, outcome, resolvedInventoryId, matchCount, errorMessage }) {
  try {
    const db = assertDb();
    await db.query(
      `INSERT INTO scan_attempts
         (work_order_id, raw_value, sanitized_value, resolution_method, outcome, resolved_inventory_id, match_count, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [workOrderId || null, rawValue, sanitizedValue, method, outcome, resolvedInventoryId || null, matchCount ?? null, errorMessage || null]
    );
  } catch (err) {
    console.error("Failed to log scan attempt:", err.message);
  }
}

// GET /api/cutting/scan/:serial — barcode resolution (scancode, not Label #).
// Exact scancode match ONLY — a scanned/camera-decoded value never falls
// through to a fuzzy search (a barcode is either the right label or it
// isn't; guessing is worse than failing loudly). See SCHEMA_NOTES.md.
router.get("/scan/:serial", async (req, res, next) => {
  const rawValue = req.params.serial;
  const sanitizedValue = sanitizeScanValue(rawValue);
  const workOrderId = req.query.workOrderId || null;
  try {
    const inventory = await resolveScannedSerial(sanitizedValue);
    if (!inventory) {
      await logScanAttempt({ workOrderId, rawValue, sanitizedValue, method: "exact_scancode", outcome: "not_found" });
      return res.status(404).json({ error: `No label found for scancode "${sanitizedValue}"` });
    }
    await logScanAttempt({
      workOrderId, rawValue, sanitizedValue, method: "exact_scancode", outcome: "resolved",
      resolvedInventoryId: inventory.id,
    });
    res.json(withParsedDimensions(inventory));
  } catch (err) {
    await logScanAttempt({ workOrderId, rawValue, sanitizedValue, method: "exact_scancode", outcome: "not_found", errorMessage: err.message });
    next(err);
  }
});

// GET /api/cutting/search?q=... — manual fallback by Label # or item name.
// Never used for a scancode-shaped value — that must go through /scan
// above. Returns { matchType, results }; the frontend only auto-applies a
// single result when matchType is an exact Label # match, never for a text
// search (see SCHEMA_NOTES.md).
router.get("/search", async (req, res, next) => {
  const rawValue = req.query.q || "";
  const sanitizedValue = sanitizeScanValue(rawValue);
  const workOrderId = req.query.workOrderId || null;
  try {
    const { matchType, results } = await searchInventories(sanitizedValue);
    const outcome = results.length === 0 ? "not_found" : matchType === "exact_label_number" && results.length === 1 ? "resolved" : "shown_for_selection";
    await logScanAttempt({
      workOrderId, rawValue, sanitizedValue, method: matchType, outcome,
      resolvedInventoryId: outcome === "resolved" ? results[0].id : undefined,
      matchCount: results.length,
    });
    res.json({ matchType, results: results.map(withParsedDimensions) });
  } catch (err) {
    await logScanAttempt({ workOrderId, rawValue, sanitizedValue, method: "text_search", outcome: "not_found", errorMessage: err.message });
    next(err);
  }
});

// GET /api/cutting/bins?q=... — remnant bin selector
router.get("/bins", async (req, res, next) => {
  try {
    const nodes = await searchWarehouseLocations(req.query.q || "");
    res.json(nodes.map((n) => ({ id: n.id, name: n.locationCode })));
  } catch (err) {
    next(err);
  }
});

// GET /api/cutting/bins/default — resolves REMNANT_BIN_NAME, a convenience
// default only. Not finding it is a config/data fact, not a server error —
// this is a 404 with a readable message, never a 500, so a missing/wrong
// REMNANT_BIN_NAME never breaks the screen: the operator just picks a bin.
router.get("/bins/default", async (_req, res) => {
  try {
    const bin = await resolveWarehouseLocationByName(REMNANT_BIN_NAME);
    res.json({ id: bin.id, name: bin.locationCode });
  } catch (err) {
    res.status(404).json({
      error: `REMNANT_BIN_NAME "${REMNANT_BIN_NAME}" does not match any bin in this org — pick a remnant bin manually.`,
    });
  }
});

function writeEvent(res, event) {
  res.write(JSON.stringify(event) + "\n");
  if (res.flush) res.flush();
}

// POST /api/cutting/work-orders/:id/commit
// Streams one NDJSON line per checklist step as it executes, so the frontend
// can render a live checklist. Stops at the first failure — no retries.
router.post("/work-orders/:id/commit", async (req, res, next) => {
  const workOrderId = req.params.id;
  const {
    sourceInventoryId,
    cutWidth,
    cutLength,
    remnantBinId,
    remnantBinName,
    operatorName,
  } = req.body || {};

  if (!sourceInventoryId || !cutWidth || !cutLength) {
    return res.status(400).json({ error: "sourceInventoryId, cutWidth, and cutLength are required" });
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  const steps = [];
  let failedStep = null;

  async function runStep(key, label, fn) {
    if (failedStep) {
      const skipped = { key, label, status: "skipped" };
      steps.push(skipped);
      writeEvent(res, skipped);
      return null;
    }
    writeEvent(res, { key, label, status: "running" });
    try {
      const result = await fn();
      const done = { key, label, status: "ok", detail: result?.detail, digit: result?.digit };
      steps.push(done);
      writeEvent(res, done);
      return result?.value ?? null;
    } catch (err) {
      const failed = { key, label, status: "error", error: err.message };
      steps.push(failed);
      failedStep = key;
      writeEvent(res, failed);
      return null;
    }
  }

  try {
    const wo = await getWorkOrderDetail(workOrderId);
    if (!wo) {
      res.status(404).end(JSON.stringify({ error: "Work order not found" }) + "\n");
      return;
    }
    const jobId = wo.job?.id;

    const source = await getInventoryById(sourceInventoryId);
    const sourceDims = readInventoryCustomFields(source);
    const sourceScancode = source.scanCodeSerialNumber;
    const sourceWidth = sourceDims.rollWidth;
    const sourceLength = sourceDims.rollLength;
    // pickJobItem requires the working piece's bin to share the job's
    // manufacturingLocationAddress — not to literally sit in the work-center
    // location shown on the work order (workCenter-type locations can't hold
    // inventory at all; split/update both reject them). See SCHEMA_NOTES.md.
    const manufacturingAddressId = wo.job?.manufacturingLocationAddress?.id;
    if (!manufacturingAddressId) {
      throw new Error("Job has no manufacturingLocationAddress — cannot resolve a pickable bin");
    }
    const workingPieceBin = await resolvePickableBinForAddress(manufacturingAddressId);
    const workingPieceBinId = workingPieceBin.id;

    const cutArea = Number(cutWidth) * Number(cutLength);
    const hasSideRemnant = sourceWidth != null && Number(cutWidth) < sourceWidth;
    const remnantWidth = hasSideRemnant ? sourceWidth - Number(cutWidth) : null;
    const remnantLength = hasSideRemnant ? Number(cutLength) : null;
    const remnantArea = hasSideRemnant ? remnantWidth * remnantLength : 0;
    const sourceWidthAfter = sourceWidth;
    const sourceLengthAfter = sourceLength != null ? sourceLength - Number(cutLength) : null;

    let workingPiece = null;
    let remnant = null;

    await runStep("splitWorkingPiece", `Split working piece (${cutArea} ft²) from label ${source.scanCodeNumber}`, async () => {
      const result = await splitSerializedInventory(sourceInventoryId, cutArea, workingPieceBinId);
      workingPiece = result.newInventory;
      return { detail: `Created label #${workingPiece.scanCodeNumber} (${workingPiece.scanCodeSerialNumber})`, digit: result };
    });

    await runStep("writeWorkingPieceDimensions", "Write dimensions on working piece", async () => {
      if (!workingPiece) throw new Error("Working piece was not created — nothing to write dimensions to");
      const digit = await writeInventoryDimensions(workingPiece.id, {
        rollLength: cutLength,
        rollWidth: cutWidth,
        pieceType: "Cut Piece",
        parentRollScancode: sourceScancode,
      });
      return { detail: `Roll Length=${cutLength}, Roll Width=${cutWidth}`, digit };
    });

    if (hasSideRemnant) {
      let resolvedRemnantBinId = remnantBinId;
      await runStep("splitRemnant", `Split side remnant (${remnantArea.toFixed(2)} ft²)`, async () => {
        if (!resolvedRemnantBinId && remnantBinName) {
          const bin = await resolveWarehouseLocationByName(remnantBinName);
          resolvedRemnantBinId = bin.id;
        }
        if (!resolvedRemnantBinId) throw new Error("No remnant bin resolved");
        const result = await splitSerializedInventory(sourceInventoryId, remnantArea, resolvedRemnantBinId);
        remnant = result.newInventory;
        return { detail: `Created label #${remnant.scanCodeNumber} (${remnant.scanCodeSerialNumber})`, digit: result };
      });

      await runStep("writeRemnantDimensions", "Write dimensions on remnant", async () => {
        if (!remnant) throw new Error("Remnant label was not created — nothing to write dimensions to");
        const digit = await writeInventoryDimensions(remnant.id, {
          rollLength: remnantLength,
          rollWidth: remnantWidth,
          pieceType: "Remnant",
          parentRollScancode: sourceScancode,
        });
        return { detail: `Roll Length=${remnantLength}, Roll Width=${remnantWidth}`, digit };
      });
    }

    await runStep("writeSourceDimensions", "Update source label's remaining dimensions", async () => {
      const digit = await writeInventoryDimensions(sourceInventoryId, {
        rollLength: sourceLengthAfter,
        rollWidth: sourceWidthAfter,
      });
      return { detail: `Roll Length=${sourceLengthAfter}, Roll Width=${sourceWidthAfter}`, digit };
    });

    await runStep("pickWorkingPiece", "Pick working piece into the manufacturing order", async () => {
      if (!workingPiece) throw new Error("Working piece was not created — cannot pick");
      if (!jobId) throw new Error("Work order has no linked job to pick into");
      const digit = await pickJobItem(jobId, workingPiece.id, cutArea);
      return { detail: `Picked ${cutArea} ft² into job ${jobId}`, digit };
    });

    await runStep("startWorkOrder", "Start work order", async () => {
      if (wo.status === "IN_PROGRESS" || wo.status === "COMPLETED") {
        return { detail: `Already ${wo.status} — no change needed` };
      }
      const digit = await startWorkOrder(workOrderId);
      return { detail: "Status set to IN_PROGRESS", digit };
    });

    const status = failedStep ? "partial_failure" : "completed";

    let cutEventId = null;
    try {
      const db = assertDb();
      const { rows } = await db.query(
        `INSERT INTO cut_events (
           operator_name, work_order_id, work_order_number, job_id, mo_number,
           source_inventory_id, source_scancode, source_width_before, source_length_before,
           cut_width, cut_length, cut_area,
           has_side_remnant, remnant_width, remnant_length, remnant_area, remnant_bin_id, remnant_bin_name,
           source_width_after, source_length_after,
           working_piece_inventory_id, working_piece_scancode,
           remnant_inventory_id, remnant_scancode,
           status, failed_step, steps
         ) VALUES ($1,$2,$3,$4,$5, $6,$7,$8,$9, $10,$11,$12, $13,$14,$15,$16,$17,$18, $19,$20, $21,$22, $23,$24, $25,$26,$27)
         RETURNING id`,
        [
          operatorName || null, workOrderId, wo.workOrderNumber, jobId, wo.job?.documentNumber || wo.job?.jobNumber,
          sourceInventoryId, sourceScancode, sourceWidth, sourceLength,
          cutWidth, cutLength, cutArea,
          hasSideRemnant, remnantWidth, remnantLength, remnantArea, remnantBinId || null, remnantBinName || null,
          sourceWidthAfter, sourceLengthAfter,
          workingPiece?.id || null, workingPiece?.scanCodeSerialNumber || null,
          remnant?.id || null, remnant?.scanCodeSerialNumber || null,
          status, failedStep, JSON.stringify(steps),
        ]
      );
      cutEventId = rows[0].id;
    } catch (dbErr) {
      writeEvent(res, { key: "auditLog", label: "Record local audit log", status: "error", error: dbErr.message });
    }

    writeEvent(res, {
      key: "summary",
      status,
      failedStep,
      cutEventId,
      workingPiece: workingPiece
        ? { id: workingPiece.id, scancode: workingPiece.scanCodeSerialNumber, labelNumber: workingPiece.scanCodeNumber }
        : null,
      remnant: remnant
        ? { id: remnant.id, scancode: remnant.scanCodeSerialNumber, labelNumber: remnant.scanCodeNumber }
        : null,
    });
    res.end();
  } catch (err) {
    writeEvent(res, { key: "fatal", status: "error", error: err.message });
    res.end();
  }
});

// POST /api/cutting/work-orders/:id/complete
router.post("/work-orders/:id/complete", async (req, res, next) => {
  try {
    const { completedQuantity } = req.body || {};
    const wo = await completeWorkOrder(req.params.id, completedQuantity);
    res.json(wo);
  } catch (err) {
    next(err);
  }
});

// GET /api/cutting/history — most recent cuts, newest first
router.get("/history", async (req, res, next) => {
  try {
    const db = assertDb();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { rows } = await db.query(
      "SELECT * FROM cut_events ORDER BY occurred_at DESC LIMIT $1",
      [limit]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export const cutting = { basePath: "/api/cutting", router };
