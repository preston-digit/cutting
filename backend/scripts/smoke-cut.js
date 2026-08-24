// Regression smoke test for the cutting commit flow — NOT a route, run
// manually or in CI. Exercises the real running backend's HTTP surface for
// the action under test (the commit itself), then verifies the result
// directly against Digit and the local cut_events table so the check is
// independent of what the commit endpoint claims about itself.
//
// Usage (see README.md "Smoke test" section):
//   docker compose exec backend node scripts/smoke-cut.js
//
// Required env vars (set in .env or passed inline):
//   SMOKE_WORK_ORDER_ID        — a real, not-yet-completed work order id
//   SMOKE_SOURCE_INVENTORY_ID  — a serialized label with Roll Length/Width set
// Optional:
//   SMOKE_CUT_WIDTH            (default 5)
//   SMOKE_CUT_LENGTH           (default 5)
//   SMOKE_REMNANT_BIN_ID       — required only if the cut produces a side
//                                remnant (cutWidth < source's Roll Width)
//   BACKEND_URL                (default http://localhost:4001)
import { pool } from "../src/core/db.js";
import { getInventoryById, readInventoryCustomFields, getWorkOrderDetail } from "../src/features/cutting/digitOps.js";
import { digitRequest } from "../src/core/digit.js";

const PICKED_JOB_ITEMS_QUERY = `
  query ($jobId: ID!) {
    job(jobId: $jobId) {
      pickedJobItems(connection: { first: 100 }) {
        nodes { id quantity inventory { id } }
      }
    }
  }
`;

async function getPickedQuantity(jobId, inventoryId) {
  const data = await digitRequest(PICKED_JOB_ITEMS_QUERY, { jobId });
  const match = data.job.pickedJobItems?.nodes?.find((n) => n.inventory?.id === inventoryId);
  return match?.quantity ?? null;
}

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4001";
const WORK_ORDER_ID = process.env.SMOKE_WORK_ORDER_ID;
const SOURCE_INVENTORY_ID = process.env.SMOKE_SOURCE_INVENTORY_ID;
const CUT_WIDTH = Number(process.env.SMOKE_CUT_WIDTH || 5);
const CUT_LENGTH = Number(process.env.SMOKE_CUT_LENGTH || 5);
const REMNANT_BIN_ID = process.env.SMOKE_REMNANT_BIN_ID || null;

const results = [];
function check(label, pass, detail) {
  results.push({ label, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
}

function approxEqual(a, b, tolerance = 0.01) {
  return Math.abs(a - b) <= tolerance;
}

async function main() {
  if (!WORK_ORDER_ID || !SOURCE_INVENTORY_ID) {
    console.error("SMOKE_WORK_ORDER_ID and SMOKE_SOURCE_INVENTORY_ID are required.");
    process.exit(1);
  }

  console.log("Cutting commit flow smoke test");
  console.log(`  work order: ${WORK_ORDER_ID}`);
  console.log(`  source:     ${SOURCE_INVENTORY_ID}`);
  console.log(`  cut:        ${CUT_WIDTH} x ${CUT_LENGTH} ft\n`);

  const woBefore = await getWorkOrderDetail(WORK_ORDER_ID);
  if (!woBefore) {
    console.error(`Work order ${WORK_ORDER_ID} not found in Digit.`);
    process.exit(1);
  }

  const sourceBefore = await getInventoryById(SOURCE_INVENTORY_ID);
  const sourceDimsBefore = readInventoryCustomFields(sourceBefore);
  const sourceQtyBefore = sourceBefore.quantityInStock;
  const sourceWidth = sourceDimsBefore.rollWidth;
  const hasSideRemnant = sourceWidth != null && CUT_WIDTH < sourceWidth;

  if (hasSideRemnant && !REMNANT_BIN_ID) {
    console.error(
      "This cut produces a side remnant (cutWidth < source Roll Width) — set SMOKE_REMNANT_BIN_ID."
    );
    process.exit(1);
  }

  console.log("Running commit against the live backend...\n");
  const res = await fetch(`${BACKEND_URL}/api/cutting/work-orders/${WORK_ORDER_ID}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceInventoryId: SOURCE_INVENTORY_ID,
      cutWidth: CUT_WIDTH,
      cutLength: CUT_LENGTH,
      remnantBinId: REMNANT_BIN_ID,
      operatorName: "smoke-test",
    }),
  });

  const text = await res.text();
  const lines = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const summary = lines.find((l) => l.key === "summary");
  const stepByKey = Object.fromEntries(lines.filter((l) => l.key !== "summary").map((l) => [l.key, l]));

  console.log("--- checklist ---");
  for (const line of lines.filter((l) => l.key !== "summary" && l.status !== "running")) {
    console.log(`  [${line.status}] ${line.key}${line.error ? ": " + line.error : ""}`);
  }
  console.log("");

  check("commit completed (no partial failure)", summary?.status === "completed", summary?.failedStep ? `failed at ${summary.failedStep}` : undefined);
  if (summary?.status !== "completed") {
    console.log("\nSMOKE TEST FAILED — commit did not complete. Aborting further checks.");
    printSummaryAndExit();
    return;
  }

  const workingPieceId = summary.workingPiece?.id;
  const remnantId = summary.remnant?.id;

  // --- Three labels exist with correct ft² and area reconciliation --------
  const [sourceAfter, workingPiece, remnant] = await Promise.all([
    getInventoryById(SOURCE_INVENTORY_ID),
    workingPieceId ? getInventoryById(workingPieceId) : null,
    remnantId ? getInventoryById(remnantId) : null,
  ]);

  const cutArea = CUT_WIDTH * CUT_LENGTH;
  const remnantArea = hasSideRemnant ? (sourceWidth - CUT_WIDTH) * CUT_LENGTH : 0;

  check("working piece exists", !!workingPiece);
  // pickJobItem consumes the working piece's stock into the job, so its
  // quantityInStock correctly drops to 0 once picked — the "was it cutArea
  // ft²" check has to happen against the PickedJobItem, not the label itself.
  const pickedQuantity = workingPiece ? await getPickedQuantity(woBefore.job.id, workingPiece.id) : null;
  check(
    "working piece was picked at cutWidth x cutLength ft²",
    pickedQuantity != null && approxEqual(pickedQuantity, cutArea),
    `picked ${pickedQuantity} vs expected ${cutArea}`
  );
  if (hasSideRemnant) {
    check("remnant label exists", !!remnant);
    check(
      "remnant quantityInStock == (sourceWidth - cutWidth) x cutLength",
      remnant && approxEqual(remnant.quantityInStock, remnantArea),
      remnant ? `${remnant.quantityInStock} vs expected ${remnantArea}` : undefined
    );
  } else {
    check("no side remnant expected (full-width crosscut) and none created", !remnant);
  }

  check(
    "areas reconcile: pickedQuantity + remnant + sourceAfter == sourceBefore",
    approxEqual((pickedQuantity || 0) + (remnant?.quantityInStock || 0) + sourceAfter.quantityInStock, sourceQtyBefore),
    `${pickedQuantity || 0} + ${(remnant?.quantityInStock || 0)} + ${sourceAfter.quantityInStock} vs ${sourceQtyBefore}`
  );

  // --- Dimensions written on all three -------------------------------------
  const workingPieceDims = workingPiece ? readInventoryCustomFields(workingPiece) : null;
  const remnantDims = remnant ? readInventoryCustomFields(remnant) : null;
  const sourceDimsAfter = readInventoryCustomFields(sourceAfter);

  check(
    "working piece dimensions written (Roll Length/Width, bare numbers)",
    workingPieceDims && approxEqual(workingPieceDims.rollLength, CUT_LENGTH) && approxEqual(workingPieceDims.rollWidth, CUT_WIDTH),
    workingPieceDims ? `L=${workingPieceDims.rollLength} W=${workingPieceDims.rollWidth}` : undefined
  );
  check("working piece Piece Type == Cut Piece", workingPieceDims?.pieceType?.includes("Cut Piece"));
  check("working piece Parent Roll == source scancode", workingPieceDims?.parentRoll === sourceBefore.scanCodeSerialNumber);

  if (hasSideRemnant) {
    check(
      "remnant dimensions written",
      remnantDims && approxEqual(remnantDims.rollLength, CUT_LENGTH) && approxEqual(remnantDims.rollWidth, sourceWidth - CUT_WIDTH),
      remnantDims ? `L=${remnantDims.rollLength} W=${remnantDims.rollWidth}` : undefined
    );
    check("remnant Piece Type == Remnant", remnantDims?.pieceType?.includes("Remnant"));
    check("remnant Parent Roll == source scancode", remnantDims?.parentRoll === sourceBefore.scanCodeSerialNumber);
  }

  // Confirmed physical cut order (see SCHEMA_NOTES.md): the parent roll
  // always loses the full cutLength and NEVER changes width, regardless of
  // how narrow cutWidth is (checked against the original sourceWidth, not
  // whatever cutWidth this run happens to use).
  check(
    "source label's remaining dimensions updated (unchanged width, length - cutLength, regardless of cutWidth)",
    approxEqual(sourceDimsAfter.rollWidth, sourceWidth) && approxEqual(sourceDimsAfter.rollLength, sourceDimsBefore.rollLength - CUT_LENGTH),
    `L=${sourceDimsAfter.rollLength} W=${sourceDimsAfter.rollWidth}`
  );

  // --- Picked into the MO, WO in progress ----------------------------------
  const woAfter = await getWorkOrderDetail(WORK_ORDER_ID);
  check(
    "work order is IN_PROGRESS (or already COMPLETED)",
    woAfter.status === "IN_PROGRESS" || woAfter.status === "COMPLETED",
    `status=${woAfter.status}`
  );
  check("pickWorkingPiece step reported ok", stepByKey.pickWorkingPiece?.status === "ok");

  // --- cut_events row with raw responses -----------------------------------
  const { rows } = await pool.query("SELECT * FROM cut_events WHERE id = $1", [summary.cutEventId]);
  const event = rows[0];
  check("cut_events row exists", !!event);
  check("cut_events.status == completed", event?.status === "completed");
  const stepsWithDigitResponses = (event?.steps || []).filter((s) => s.digit);
  check("cut_events.steps includes raw Digit responses", stepsWithDigitResponses.length >= 3, `${stepsWithDigitResponses.length} steps carry a raw response`);

  printSummaryAndExit();
}

function printSummaryAndExit() {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? " (" + f.detail + ")" : ""}`);
    process.exitCode = 1;
  } else {
    console.log("\nSMOKE TEST PASSED.");
  }
  pool?.end();
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exitCode = 1;
  pool?.end();
});
