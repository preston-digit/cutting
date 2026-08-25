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
  getInventoriesForItems,
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
  itemUom,
  deriveLinearUnitSymbol,
  requireLinearUnit,
  isUnitMismatchRatio,
  isRealStorageBin,
} from "./digitOps.js";
import { renderLabel } from "./labelRenderer.js";
import { getLabelTemplateForItem } from "./labelTemplate.js";
import { canvasToArtifact, renderLabelPdf } from "./print/artifact.js";
import { resolveSinkForStation } from "./print/sink.js";

const router = Router();

const REMNANT_BIN_NAME = process.env.REMNANT_BIN_NAME || "Remnant Storage";
const AREA_MISMATCH_TOLERANCE = 0.01; // 1%, see SCHEMA_NOTES.md
const LABEL_NAME = "Carpet-Roll-Tag";
// Defaulted OFF on purpose: a cut that can't produce a tag must never
// complete silently (a piece can't reach the rack untagged). Only orgs that
// genuinely don't print labels should ever set this to "true".
const ALLOW_PRINTLESS_COMMITS = process.env.ALLOW_PRINTLESS_COMMITS === "true";
// The Piece Type this module writes to the label it creates at the cutting
// table (the working piece) — deliberately NOT "Cut Piece" or "Finished
// Rug". Digit generates its own separate serialized finished-good label
// when the MO's last work order step completes; the label created here is
// that job's INPUT, consumed by production, not the finished output — so
// it must not read as finished. "Cut Rug" describes what it physically is
// at creation and stays accurate all the way through production. Verified
// live against Digit's Piece Type option list before this was set (see
// SCHEMA_NOTES.md) — must match one of that field's real option values
// verbatim, checked by getPieceTypeOptionId() (digitOps.js), which throws
// rather than writing an unrecognized value.
const WORKING_PIECE_TYPE = "Cut Rug";

// Which Piece Type values are eligible source stock for a new cut. This is
// an ALLOWLIST, not a blocklist: Digit's Piece Type option list can grow
// over time (see SCHEMA_NOTES.md's live option list), and the safe default
// for a value not on this list — including one added later that this app
// doesn't know about yet — is to exclude it, never to offer it. A piece with
// no Piece Type set at all is excluded the same way (isAllowedSourcePieceType
// treats null/undefined as not-allowed), never treated as implicitly fine.
// "Cut Rug" (this module's own WORKING_PIECE_TYPE) and "Finished Rug" are
// deliberately excluded — both are already split/picked into a job and must
// never be offered as raw material for a different cut.
const SOURCE_PIECE_TYPE_ALLOWLIST = new Set(["Mill Roll", "Remnant", "Cut Piece"]);

function isAllowedSourcePieceType(pieceType) {
  return !!pieceType && SOURCE_PIECE_TYPE_ALLOWLIST.has(pieceType);
}

// --- Print stations ----------------------------------------------------------
// Local-only concept (see db/migrations/0005_print_stations.sql) — printer
// address never leaves the server. GET /stations only ever returns
// name + has_printer.
//
// Nothing in the commit or reprint routes below calls getStationById or
// passes a stationId anymore — the only working print path is
// BrowserPrintSink (see resolveSinkForStation, print/sink.js), and the
// frontend has no station picker. This table, these two routes, and this
// helper are kept in place deliberately (not deleted) so a real network
// printer can be wired up later — reintroduce a stationId param on
// commit/reprint and call getStationById() again — without rebuilding this
// piece from scratch.
async function getStationById(stationId) {
  if (!stationId) return null;
  const db = assertDb();
  const { rows } = await db.query(
    `SELECT id, name, printer_address AS "printerAddress" FROM print_stations WHERE id = $1`,
    [stationId]
  );
  return rows[0] || null;
}

router.get("/stations", async (_req, res, next) => {
  try {
    const db = assertDb();
    const { rows } = await db.query(
      `SELECT id, name, (printer_address IS NOT NULL) AS "hasPrinter" FROM print_stations ORDER BY name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /stations — registers a station once (name always; printerAddress
// optional — a station with no printer configured still lets an operator
// select it, but every print through it falls back to ArtifactSink
// (rendered, not actually dispatched) until an address is set.
router.post("/stations", async (req, res, next) => {
  try {
    const { name, printerAddress } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    const db = assertDb();
    const { rows } = await db.query(
      `INSERT INTO print_stations (name, printer_address) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET printer_address = EXCLUDED.printer_address
       RETURNING id, name, (printer_address IS NOT NULL) AS "hasPrinter"`,
      [name, printerAddress || null]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

function withParsedDimensions(inventory) {
  const dims = readInventoryCustomFields(inventory);
  const area = inventory.quantityInStock;
  let areaMismatch = null;
  if (dims.rollLength != null && dims.rollWidth != null) {
    const impliedArea = dims.rollLength * dims.rollWidth;
    const diff = Math.abs(impliedArea - area);
    const pctOff = impliedArea === 0 ? (area === 0 ? 0 : 1) : diff / impliedArea;
    const outOfSync = pctOff > AREA_MISMATCH_TOLERANCE;
    // Distinguish "these look like they were measured in a different unit
    // than quantityInStock's UoM" (probableUnitMismatch — not selectable,
    // needs a Digit-side fix) from a generic data-entry gap like label #9's
    // 1,000 ft² of pre-existing dummy-data drift (stays selectable with an
    // ack). See isUnitMismatchRatio() in digitOps.js / SCHEMA_NOTES.md.
    const probableUnitMismatch = outOfSync && isUnitMismatchRatio(area, impliedArea);
    areaMismatch = {
      outOfSync,
      probableUnitMismatch,
      quantityInStock: area,
      impliedArea,
      pctOff,
    };
  }
  const uom = itemUom(inventory.item);
  return {
    id: inventory.id,
    scancode: inventory.scanCodeSerialNumber,
    labelNumber: inventory.scanCodeNumber,
    quantityInStock: area,
    itemId: inventory.item?.id,
    itemName: inventory.item?.name,
    areaUom: uom,
    lengthUnitSymbol: uom ? deriveLinearUnitSymbol(uom.symbol) : null,
    binId: inventory.warehouseLocation?.id,
    binName: inventory.warehouseLocation?.locationCode,
    binType: inventory.warehouseLocation?.type,
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
      itemUom: itemUom(wo.job?.item),
      targetQuantity: wo.job?.targetQuantity,
      moNotes: wo.job?.notes || null,
      createdBy: wo.job?.createdBy?.profile?.fullName || null,
      createdOn: wo.job?.createdOn || null,
      salesOrderNumber: wo.job?.salesOrder?.orderNumber || null,
      customerName: wo.job?.salesOrder?.customer?.name || null,
      shipByDate: wo.job?.salesOrder?.requestedDeliveryDate || null,
      // quantityPerUnit is the BOM's per-finished-unit quantity; totalRequired
      // scales that to the job's full target quantity — the operator's
      // answer to "how much of this material do I need for this whole MO."
      bomComponents: (wo.job?.bom?.items?.nodes || []).map((n) => ({
        itemId: n.item.id,
        itemName: n.item.name,
        itemSku: n.item.sku,
        uom: itemUom(n.item),
        quantityPerUnit: n.quantity,
        totalRequired: n.quantity != null && wo.job?.targetQuantity != null ? n.quantity * wo.job.targetQuantity : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Digit has no structured field for a finished item's target cut dimensions
// (item-context custom fields exist for "Roll Length"/"Roll Width" but only
// on roll-goods items, never populated on the finished item itself — see
// SCHEMA_NOTES.md). Closest working path: prefer the operator's own entered
// cutWidth/cutLength (most authoritative — it's literally what's about to be
// cut); else try to parse a "W x L" shape out of the finished item's name
// (e.g. "Rug 5x8"); else fall back to the BOM's quantityPerUnit as a
// required AREA only (no shape judgment possible, just "is there enough
// material"). Returns { width, length, area, source } — width/length are
// null when only an area figure is available.
const DIMENSION_IN_NAME_PATTERN = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i;

function resolveRequiredCut({ cutWidth, cutLength, itemName, quantityPerUnit }) {
  if (cutWidth > 0 && cutLength > 0) {
    return { width: cutWidth, length: cutLength, area: cutWidth * cutLength, source: "operator_entry" };
  }
  const match = itemName ? String(itemName).match(DIMENSION_IN_NAME_PATTERN) : null;
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a > 0 && b > 0) return { width: a, length: b, area: a * b, source: "item_name" };
  }
  if (quantityPerUnit > 0) {
    return { width: null, length: null, area: quantityPerUnit, source: "bom_quantity_per_unit" };
  }
  return { width: null, length: null, area: null, source: "none" };
}

// Sufficiency means the piece's own dimensions can physically yield the
// finished shape, not just that its area is large enough — a 100 × 1 ft
// strip is 100 ft² but can't make a 5 × 8 rug. Checked both ways round
// (width/length aren't a meaningful axis label on a roll) so a piece
// doesn't fail just because its long side happens to map to "width."
//
// sufficient is exactly one of three states — never a boolean derived from
// area alone:
//   true  — verified sufficient: both the piece's dims AND a required
//           width/length are known, and the piece can yield that shape.
//   false — verified insufficient: same as above, but it can't.
//   null  — cannot verify dimensionally: either the piece's own dims are
//           unknown, or no width/length target resolved (only a BOM
//           quantityPerUnit area figure, or nothing at all — see
//           resolveRequiredCut's "bom_quantity_per_unit"/"none" sources).
//           An area-only match is NOT a sufficiency verdict — a 100×1 ft
//           sliver can satisfy an area target while being physically
//           useless for the actual shape needed.
function scorePiece(p, required) {
  const knownDims = p.rollWidth != null && p.rollLength != null;
  const area = knownDims ? p.rollWidth * p.rollLength : null;
  const hasDimensionalTarget = required.width != null && required.length != null;
  let sufficient = null;
  let waste = null;
  if (knownDims && hasDimensionalTarget) {
    sufficient =
      (p.rollWidth >= required.width && p.rollLength >= required.length) ||
      (p.rollWidth >= required.length && p.rollLength >= required.width);
    if (sufficient) waste = area - required.width * required.length;
  }
  // Tiering follows the verdict directly — cannot-verify (sufficient ===
  // null) always sorts last, alongside genuinely-unknown-dims pieces, never
  // into the sufficient tier.
  let tier;
  if (sufficient === true) tier = 0;
  else if (sufficient === false) tier = 1;
  else tier = 2;
  return { ...p, knownDims, area, sufficient, waste, tier, canVerifyDimensionally: hasDimensionalTarget };
}

// GET /api/cutting/work-orders/:id/available-material?cutWidth=&cutLength=
// Every in-stock, really-pickable serialized label of this job's BOM
// component item(s), so the operator can decide which piece to send the
// forklift for instead of scanning blind.
//
// Sort priority (deliberately remnant-first within each tier — the business
// wants existing offcuts consumed before a new roll is opened):
//   1. verified sufficient (known dims, known W×L target), smallest first (least waste)
//   2. verified insufficient (known dims, known W×L target), largest first
//   3. cannot verify — genuinely unknown dims, OR known dims but no W×L
//      target resolved (area-only BOM fallback / no target at all) —
//      always last, never tier 1
router.get("/work-orders/:id/available-material", async (req, res, next) => {
  try {
    const wo = await getWorkOrderDetail(req.params.id);
    if (!wo) return res.status(404).json({ error: "Work order not found" });
    const bomNodes = wo.job?.bom?.items?.nodes || [];
    const itemIds = bomNodes.map((n) => n.item.id);
    const quantityPerUnitByItemId = new Map(bomNodes.map((n) => [n.item.id, n.quantity]));
    const cutWidth = req.query.cutWidth ? Number(req.query.cutWidth) : null;
    const cutLength = req.query.cutLength ? Number(req.query.cutLength) : null;

    const nodes = await getInventoriesForItems(itemIds);
    // "transit"/"workCenter"/"unassigned" locations aren't real, pickable
    // storage (live-confirmed via WarehouseLocationType enum, not by
    // matching a location's name/code) — material sitting in one (e.g. an
    // IN-TRANSIT system bin mid-transfer) can't actually be picked up.
    const pickableNodes = nodes.filter((n) => isRealStorageBin(n.warehouseLocation?.type));
    const allPieces = pickableNodes.map(withParsedDimensions);
    // Allowlist gate (see SOURCE_PIECE_TYPE_ALLOWLIST): a Cut Rug/Finished
    // Rug/unrecognized/missing Piece Type is already committed to another
    // job or of unknown status and must never appear as selectable source
    // stock, no matter how well its dimensions would otherwise score.
    const noPieceTypeCount = allPieces.filter((p) => !p.pieceType).length;
    if (noPieceTypeCount > 0) {
      console.warn(
        `available-material: excluded ${noPieceTypeCount} piece(s) with no Piece Type set (work order ${req.params.id})`
      );
    }
    const pieces = allPieces
      .filter((p) => isAllowedSourcePieceType(p.pieceType))
      .map((p) => {
        const required = resolveRequiredCut({
          cutWidth,
          cutLength,
          itemName: wo.job?.item?.name,
          quantityPerUnit: quantityPerUnitByItemId.get(p.itemId),
        });
        return { ...scorePiece(p, required), requiredCut: required };
      });

    pieces.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === 0) {
        const aw = a.waste ?? a.area ?? Infinity;
        const bw = b.waste ?? b.area ?? Infinity;
        if (aw !== bw) return aw - bw;
      } else if (a.tier === 1) {
        if (a.area !== b.area) return (b.area ?? 0) - (a.area ?? 0); // largest first
      }
      const aRemnant = a.pieceType === "Remnant" ? 0 : 1;
      const bRemnant = b.pieceType === "Remnant" ? 0 : 1;
      return aRemnant - bRemnant;
    });

    res.json({
      requiredCut: pieces[0]?.requiredCut || resolveRequiredCut({
        cutWidth,
        cutLength,
        itemName: wo.job?.item?.name,
        quantityPerUnit: bomNodes[0]?.quantity,
      }),
      pieces,
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
    const piece = withParsedDimensions(inventory);
    if (!isAllowedSourcePieceType(piece.pieceType)) {
      // A direct scan bypasses the available-material list entirely, so the
      // allowlist gate has to be re-checked here too (see
      // SOURCE_PIECE_TYPE_ALLOWLIST) — otherwise an operator could scan a
      // Cut Rug already picked into someone else's job straight past the
      // filtered list and cut into it.
      const typeDescription = piece.pieceType ? `is "${piece.pieceType}"` : "has no Piece Type set";
      await logScanAttempt({
        workOrderId, rawValue, sanitizedValue, method: "exact_scancode", outcome: "rejected_piece_type",
        resolvedInventoryId: inventory.id,
        errorMessage: `Piece Type ${piece.pieceType || "(none)"} is not eligible source stock`,
      });
      return res.status(409).json({
        error: `Label #${piece.labelNumber} ${typeDescription} and cannot be used as source stock for a cut.`,
      });
    }
    await logScanAttempt({
      workOrderId, rawValue, sanitizedValue, method: "exact_scancode", outcome: "resolved",
      resolvedInventoryId: inventory.id,
    });
    res.json(piece);
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
    const allPieces = results.map(withParsedDimensions);
    // Same allowlist gate as available-material (see
    // SOURCE_PIECE_TYPE_ALLOWLIST) — a Cut Rug/Finished Rug/unrecognized/
    // missing Piece Type is dropped from the results list rather than shown
    // as a pickable match, even for an otherwise-exact Label # hit.
    const noPieceTypeCount = allPieces.filter((p) => !p.pieceType).length;
    if (noPieceTypeCount > 0) {
      console.warn(`search: excluded ${noPieceTypeCount} result(s) with no Piece Type set (query "${sanitizedValue}")`);
    }
    const filteredPieces = allPieces.filter((p) => isAllowedSourcePieceType(p.pieceType));
    const outcome = filteredPieces.length === 0 ? "not_found" : matchType === "exact_label_number" && filteredPieces.length === 1 ? "resolved" : "shown_for_selection";
    await logScanAttempt({
      workOrderId, rawValue, sanitizedValue, method: matchType, outcome,
      resolvedInventoryId: outcome === "resolved" ? filteredPieces[0].id : undefined,
      matchCount: filteredPieces.length,
    });
    res.json({ matchType, results: filteredPieces });
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

// PDF metadata title — shown by a PDF viewer/print dialog in place of this
// file's URL (see print/artifact.js's header comment on why that matters).
function labelPdfTitle(inventory) {
  return `${LABEL_NAME} — ${inventory.item?.name ?? "item"} #${inventory.scanCodeNumber} (${inventory.scanCodeSerialNumber})`;
}

// Renders + rasterizes a label for a live inventory record, returning the
// byte artifact plus what's needed for logging/preview. Shared by the
// standalone preview route below and the reprint route.
async function renderLabelArtifact(inventoryId, format) {
  const inventory = await getInventoryById(inventoryId);
  if (!inventory) throw new Error(`Inventory ${inventoryId} not found`);
  const { canvas, widthIn, heightIn, encodedBarcodeValue, resolvedBindings } = await renderLabel({
    item: inventory.item,
    inventory,
  });
  const buffer = await canvasToArtifact(canvas, format, { widthIn, heightIn, title: labelPdfTitle(inventory) });
  return { buffer, encodedBarcodeValue, resolvedBindings, inventory };
}

// GET /api/cutting/labels/:inventoryId/render?format=pdf|png — standalone
// preview/download, independent of the commit flow. Always uses ArtifactSink
// (hands the bytes straight back) — this route never dispatches to a
// physical printer, see /print/sink.js.
router.get("/labels/:inventoryId/render", async (req, res, next) => {
  const format = req.query.format === "png" ? "png" : "pdf";
  try {
    const { buffer } = await renderLabelArtifact(req.params.inventoryId, format);
    res.setHeader("Content-Type", format === "png" ? "image/png" : "application/pdf");
    res.send(buffer);
  } catch (err) {
    next(err);
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
    notes,
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
    // Geometry boundary guard (see SCHEMA_NOTES.md's canonical unit-basis
    // rule): fail the whole commit up front, before any split/write, if this
    // item's stock UoM isn't a recognized area unit — never silently assume
    // Roll Length/Width are in feet.
    requireLinearUnit(source.item);

    // Label-template gate — checked BEFORE any split/write, not at the print
    // step. Printing is opt-in per item in Digit (Item.defaultCustomLabelConfigurations
    // .manualInventory — see SCHEMA_NOTES.md), and variants don't inherit
    // their parent item's config (live-confirmed 2026-08-24), so this recurs
    // every time someone adds a variant without configuring it. A cut that
    // cannot produce a tag must never complete and hand an untagged piece to
    // the rack — block the whole commit here rather than no-op the print
    // step later. ALLOW_PRINTLESS_COMMITS is the only sanctioned bypass, for
    // orgs that genuinely don't print.
    if (!ALLOW_PRINTLESS_COMMITS && !(await getLabelTemplateForItem(source.item.id))) {
      throw new Error(
        `No "${LABEL_NAME}" label template configured for item "${source.item.name}" — commit blocked, this cut cannot produce a tag. ` +
          `Configure a manual-inventory label for this item in Digit's Label Designer, or set ALLOW_PRINTLESS_COMMITS=true if this org does not print labels.`
      );
    }

    const sourceDims = readInventoryCustomFields(source);
    const sourceScancode = source.scanCodeSerialNumber;
    const sourceWidth = sourceDims.rollWidth;
    const sourceLength = sourceDims.rollLength;
    // Captured once here and carried through every "ft²"-shaped message
    // below and onto the cut_events row — never hardcode a unit string, this
    // org's roll items report it live (today "ft²"; the org intends to move
    // to "yd²" eventually and this must follow without a code change).
    const sourceAreaUom = itemUom(source.item);
    const areaUnitLabel = sourceAreaUom?.symbol ? ` ${sourceAreaUom.symbol}` : "";
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

    // PHYSICAL CUT ORDER — confirmed 8/24/2026 with the customer, from the
    // actual floor process (see SCHEMA_NOTES.md, "Confirmed physical cut
    // order"): the operator crosscuts the full-width piece at cutLength off
    // the roll FIRST, then rips cutWidth from THAT piece — so the side
    // remnant is only cutLength long (same length as the cut), and the
    // parent roll always loses the full cutLength regardless of how narrow
    // cutWidth is. The source label's dimension update below must decrement
    // length only and never touch width, regardless of cutWidth — verified
    // by smoke-cut.js's "source label's remaining dimensions" check. Keep
    // this in sync with the mirrored cut math in
    // frontend/src/features/cutting/CutScreen.jsx.
    const cutArea = Number(cutWidth) * Number(cutLength);
    const hasSideRemnant = sourceWidth != null && Number(cutWidth) < sourceWidth;
    const remnantWidth = hasSideRemnant ? sourceWidth - Number(cutWidth) : null;
    const remnantLength = hasSideRemnant ? Number(cutLength) : null;
    const remnantArea = hasSideRemnant ? remnantWidth * remnantLength : 0;
    const sourceWidthAfter = sourceWidth;
    const sourceLengthAfter = sourceLength != null ? sourceLength - Number(cutLength) : null;

    let workingPiece = null;
    let remnant = null;

    await runStep("splitWorkingPiece", `Split working piece (${cutArea}${areaUnitLabel}) from label ${source.scanCodeNumber}`, async () => {
      const result = await splitSerializedInventory(sourceInventoryId, cutArea, workingPieceBinId);
      workingPiece = result.newInventory;
      return { detail: `Created label #${workingPiece.scanCodeNumber} (${workingPiece.scanCodeSerialNumber})`, digit: result };
    });

    await runStep("writeWorkingPieceDimensions", "Write dimensions on working piece", async () => {
      if (!workingPiece) throw new Error("Working piece was not created — nothing to write dimensions to");
      const digit = await writeInventoryDimensions(workingPiece.id, {
        rollLength: cutLength,
        rollWidth: cutWidth,
        pieceType: WORKING_PIECE_TYPE,
        parentRollScancode: sourceScancode,
      });
      return { detail: `Roll Length=${cutLength}, Roll Width=${cutWidth}`, digit };
    });

    if (hasSideRemnant) {
      let resolvedRemnantBinId = remnantBinId;
      await runStep("splitRemnant", `Split side remnant (${remnantArea.toFixed(2)}${areaUnitLabel})`, async () => {
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
      return { detail: `Picked ${cutArea}${areaUnitLabel} into job ${jobId}`, digit };
    });

    await runStep("startWorkOrder", "Start work order", async () => {
      if (wo.status === "IN_PROGRESS" || wo.status === "COMPLETED") {
        return { detail: `Already ${wo.status} — no change needed` };
      }
      const digit = await startWorkOrder(workOrderId);
      return { detail: "Status set to IN_PROGRESS", digit };
    });

    // Printing happens last, after every inventory operation has already
    // succeeded — a print failure here can never roll back or invalidate
    // the cut itself (nothing above this point is undone; see
    // SCHEMA_NOTES.md). Same failure semantics as every other step (stop on
    // first failure, no auto-retry) — the difference is purely in how the
    // frontend frames a failure here: "reprint from History", never "needs
    // manual repair in Digit" (see CutScreen.jsx's repairMessage).
    //
    // Working piece + remnant are one print job, not two — a single
    // multi-page PDF (one page per tag) through one sink.deliver() call, so
    // the operator confirms one print dialog, not two. Both pieces are
    // always the same Digit item as the source (a split never changes
    // Item), so one template-resolved check covers both.
    //
    // No station is selected, passed, or looked up here — the UI no longer
    // offers a station picker (see resolveSinkForStation's header comment
    // in print/sink.js), so this always resolves to BrowserPrintSink.
    let workingPiecePrintStatus = null;
    let workingPiecePrintError = null;
    let remnantPrintStatus = null;
    let remnantPrintError = null;
    let printedPdfBase64 = null;
    let printedPageCount = 0;

    const piecesToPrint = [workingPiece, remnant].filter(Boolean);

    await runStep("printLabels", `Print ${LABEL_NAME} label${piecesToPrint.length > 1 ? "s" : ""}`, async () => {
      if (!piecesToPrint.length) throw new Error("No pieces were created — nothing to print");
      try {
        const fullPieces = await Promise.all(piecesToPrint.map((p) => getInventoryById(p.id)));
        // The commit-wide gate above already blocked this whole cut unless
        // either a template resolved or ALLOW_PRINTLESS_COMMITS is set — the
        // only way to reach this with no template is the latter, so this is
        // a sanctioned no-op, never a silent one.
        if (!(await getLabelTemplateForItem(fullPieces[0].item.id))) {
          return {
            detail: `No "${LABEL_NAME}" label configured for item "${fullPieces[0].item.name}" — nothing to print (ALLOW_PRINTLESS_COMMITS is set).`,
          };
        }
        const rendered = [];
        for (const inv of fullPieces) {
          // The working piece's quantityInStock is already zeroed by
          // pickJobItem (below) by the time this runs — printing that live
          // value would put "Quantity 0" on a tag for a piece that's
          // physically the full cut area. Bind its tag to the cut area
          // instead, which this commit already computed; the remnant is a
          // real, un-picked label, so it keeps showing its own live
          // quantity (no override).
          const quantityOverride = inv.id === workingPiece?.id ? cutArea : undefined;
          const { canvas, widthIn, heightIn, encodedBarcodeValue } = await renderLabel({ item: inv.item, inventory: inv, quantityOverride });
          rendered.push({ inv, canvas, widthIn, heightIn, encodedBarcodeValue });
        }
        const title = `${LABEL_NAME} — ${rendered.map((r) => r.inv.scanCodeSerialNumber).join(", ")}`;
        const buffer = await renderLabelPdf(
          rendered.map((r) => ({ canvas: r.canvas, widthIn: r.widthIn, heightIn: r.heightIn })),
          { title }
        );
        const sink = resolveSinkForStation();
        const result = await sink.deliver({
          buffer,
          format: "pdf",
          meta: { labelName: LABEL_NAME, pageCount: rendered.length },
        });
        workingPiecePrintStatus = "printed";
        if (remnant) remnantPrintStatus = "printed";
        // Not persisted into cut_events.steps (see below, near writeEvent) —
        // reprint always re-renders fresh rather than storing bytes, and
        // this stream-only field would otherwise duplicate the PDF into the
        // audit row on every commit.
        if (result.buffer && result.format === "pdf") {
          printedPdfBase64 = result.buffer.toString("base64");
          printedPageCount = rendered.length;
        }
        const pieceSummaries = rendered
          .map((r) => `#${r.inv.scanCodeNumber} (${r.inv.scanCodeSerialNumber}), barcode "${r.encodedBarcodeValue}"`)
          .join("; ");
        return {
          detail: `${result.detail} — ${pieceSummaries} (browser print dialog — pick a printer)`,
        };
      } catch (err) {
        workingPiecePrintStatus = "failed";
        workingPiecePrintError = err.message;
        if (remnant) {
          remnantPrintStatus = "failed";
          remnantPrintError = err.message;
        }
        throw err;
      }
    });

    // Streamed separately from the checklist steps above (never pushed into
    // `steps`, so it never lands in cut_events — reprint always re-renders
    // fresh rather than storing bytes in the audit trail). The frontend
    // opens this as a real PDF and triggers the browser print dialog once.
    if (printedPdfBase64) {
      writeEvent(res, { key: "printPdf", status: "ok", format: "pdf", pageCount: printedPageCount, pdfBase64: printedPdfBase64 });
    }

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
           status, failed_step, steps, notes, area_uom_symbol,
           print_station_id, working_piece_print_status, working_piece_print_error,
           remnant_print_status, remnant_print_error
         ) VALUES ($1,$2,$3,$4,$5, $6,$7,$8,$9, $10,$11,$12, $13,$14,$15,$16,$17,$18, $19,$20, $21,$22, $23,$24, $25,$26,$27, $28, $29, $30,$31,$32, $33,$34)
         RETURNING id`,
        [
          operatorName || null, workOrderId, wo.workOrderNumber, jobId, wo.job?.documentNumber || wo.job?.jobNumber,
          sourceInventoryId, sourceScancode, sourceWidth, sourceLength,
          cutWidth, cutLength, cutArea,
          hasSideRemnant, remnantWidth, remnantLength, remnantArea, remnantBinId || null, remnantBinName || null,
          sourceWidthAfter, sourceLengthAfter,
          workingPiece?.id || null, workingPiece?.scanCodeSerialNumber || null,
          remnant?.id || null, remnant?.scanCodeSerialNumber || null,
          status, failedStep, JSON.stringify(steps), notes || null, sourceAreaUom?.symbol || null,
          null, workingPiecePrintStatus, workingPiecePrintError, // print_station_id — no station in the commit path anymore
          remnantPrintStatus, remnantPrintError,
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

// POST /api/cutting/history/:cutEventId/reprint — retry a print that failed
// (or reprint a working piece/remnant label at any time). This never
// touches the underlying cut or its inventory operations — those already
// succeeded and this route doesn't re-run any of them, it only re-renders
// and re-delivers a label for a piece this cut already created.
router.post("/history/:cutEventId/reprint", async (req, res, next) => {
  try {
    const { piece } = req.body || {};
    if (piece !== "workingPiece" && piece !== "remnant") {
      return res.status(400).json({ error: `piece must be "workingPiece" or "remnant"` });
    }
    const db = assertDb();
    const { rows } = await db.query("SELECT * FROM cut_events WHERE id = $1", [req.params.cutEventId]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: "Cut event not found" });

    const inventoryId = piece === "workingPiece" ? event.working_piece_inventory_id : event.remnant_inventory_id;
    if (!inventoryId) return res.status(400).json({ error: `This cut has no ${piece} label to reprint` });

    // Same sink resolution and page setup as the commit flow — a reprint is
    // always a single label, so a single-page PDF (see renderLabelPdf). The
    // working piece's quantityInStock is still (and forever) zero post-pick
    // — same quantityOverride reasoning as the commit flow's printLabels
    // step, using the cut_area this event already recorded. The remnant's
    // own inventory record was never picked, so it keeps its live quantity.
    //
    // No station here either — same as commit, this always resolves to
    // BrowserPrintSink (see resolveSinkForStation, print/sink.js).
    const fullInventory = await getInventoryById(inventoryId);
    const quantityOverride = piece === "workingPiece" ? Number(event.cut_area) : undefined;
    const { canvas, widthIn, heightIn, encodedBarcodeValue } = await renderLabel({
      item: fullInventory.item,
      inventory: fullInventory,
      quantityOverride,
    });
    const buffer = await canvasToArtifact(canvas, "pdf", { widthIn, heightIn, title: labelPdfTitle(fullInventory) });
    const sink = resolveSinkForStation();
    const result = await sink.deliver({
      buffer,
      format: "pdf",
      meta: { labelName: LABEL_NAME, inventoryId, scancode: fullInventory.scanCodeSerialNumber },
    });

    const statusCol = piece === "workingPiece" ? "working_piece_print_status" : "remnant_print_status";
    const errorCol = piece === "workingPiece" ? "working_piece_print_error" : "remnant_print_error";
    await db.query(`UPDATE cut_events SET ${statusCol} = $1, ${errorCol} = $2 WHERE id = $3`, ["printed", null, event.id]);

    res.json({
      delivered: true,
      detail:
        `${result.detail} — Label #${fullInventory.scanCodeNumber} (${fullInventory.scanCodeSerialNumber}), barcode encodes "${encodedBarcodeValue}"` +
        " (browser print dialog — pick a printer)",
      // Not persisted — rendered fresh on every reprint, same as the commit
      // flow's printPdf event. Only present when the sink actually hands
      // bytes back (browser/artifact sinks); a real NetworkPrinterSink
      // wouldn't have anything to hand the frontend.
      ...(result.buffer && result.format === "pdf" ? { pdfBase64: result.buffer.toString("base64") } : {}),
    });
  } catch (err) {
    try {
      const db = assertDb();
      const { piece } = req.body || {};
      const statusCol = piece === "workingPiece" ? "working_piece_print_status" : "remnant_print_status";
      const errorCol = piece === "workingPiece" ? "working_piece_print_error" : "remnant_print_error";
      await db.query(`UPDATE cut_events SET ${statusCol} = $1, ${errorCol} = $2 WHERE id = $3`, ["failed", err.message, req.params.cutEventId]);
    } catch {
      // best-effort status update only — the real error still gets returned below
    }
    next(err);
  }
});

export const cutting = { basePath: "/api/cutting", router };
