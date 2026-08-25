// One-time migration of Roll Length/Roll Width to a new linear unit — e.g.
// after an org-wide Item.defaultStockUom change (ft² -> yd²). See
// SCHEMA_NOTES.md's "Canonical unit-basis rule" for why this is a
// deliberate, explicit operation rather than something the cutting flow
// does automatically: a bare number in these fields has no unit metadata of
// its own, so moving to a new linear unit means REWRITING every existing
// value, not just changing how future ones are interpreted.
//
// SAFE BY DEFAULT, same pattern as reset-demo-data.js: with no --confirm
// flag, this ONLY reports what it would rewrite — no write is sent to
// Digit. Scope is never guessed — every item id acted on must be named
// explicitly with --item-ids (this only migrates the specific item(s) whose
// defaultStockUom actually changed, not "every serialized inventory label
// in the org").
//
// Deliberately does NOT touch quantityInStock. That value is Digit's own,
// under Digit's own UoM (splitSerializedInventory/updateSerializedInventory
// already move/report it correctly regardless of unit) — this app owns only
// the Roll Length/Roll Width custom fields, so only those are in scope here.
//
// Usage:
//   node scripts/migrate-dimension-units.js --item-ids=<id1>,<id2> --from=ft --to=yd [--confirm]
//
// --item-ids   Digit item ids to migrate (required — no default, no "all").
// --from       Linear unit the CURRENT Roll Length/Width values are in.
// --to         Linear unit to rewrite them into. Both must be recognized by
//              AREA_UNIT_TABLE in digitOps.js (today: ft, yd, m).
//
// Refuses to run (reports the offending labels and exits non-zero, without
// writing anything, even under --confirm) if any in-scope label has a
// dimension state or Piece Type it can't interpret: exactly one of Roll
// Length/Roll Width set (not both or neither), or a Piece Type other than
// null/"Cut Piece"/"Remnant" — rather than silently skipping it and leaving
// it half-migrated.
import {
  getInventoriesForItems,
  readInventoryCustomFields,
  writeInventoryDimensions,
  linearUnitFtPerUnit,
  recognizedLinearUnits,
} from "../src/features/cutting/digitOps.js";

// Live-confirmed Piece Type options (see SCHEMA_NOTES.md) plus null (never
// set) — anything else is data this script doesn't understand well enough
// to migrate blindly.
const KNOWN_PIECE_TYPES = new Set([null, "Mill Roll", "Cut Piece", "Remnant", "Finished Rug"]);

function parseArgs(argv) {
  const args = { itemIds: [], from: null, to: null, confirm: false };
  for (const arg of argv) {
    if (arg === "--confirm") args.confirm = true;
    else if (arg.startsWith("--item-ids=")) {
      args.itemIds = arg.slice("--item-ids=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--from=")) args.from = arg.slice("--from=".length).trim();
    else if (arg.startsWith("--to=")) args.to = arg.slice("--to=".length).trim();
  }
  return args;
}

function usageAndExit() {
  console.error(
    "Usage: node scripts/migrate-dimension-units.js --item-ids=<id1>,<id2> --from=<unit> --to=<unit> [--confirm]\n\n" +
      `Recognized linear units: ${recognizedLinearUnits().join(", ")}\n` +
      "Nothing is acted on implicitly — --item-ids, --from, and --to are all required."
  );
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.itemIds.length || !args.from || !args.to) usageAndExit();

  const ftPerFrom = linearUnitFtPerUnit(args.from);
  const ftPerTo = linearUnitFtPerUnit(args.to);
  if (!ftPerFrom || !ftPerTo) {
    console.error(
      `Unrecognized unit — --from="${args.from}" --to="${args.to}". ` +
        `Recognized linear units: ${recognizedLinearUnits().join(", ")}.`
    );
    process.exit(1);
  }
  const factor = ftPerFrom / ftPerTo;

  console.log(`Mode: ${args.confirm ? "EXECUTE (--confirm passed)" : "DRY RUN (pass --confirm to execute)"}`);
  console.log(`Item ids in scope: ${args.itemIds.join(", ")}`);
  console.log(`Rewriting Roll Length/Roll Width from ${args.from} to ${args.to} (factor ${factor})\n`);

  const nodes = await getInventoriesForItems(args.itemIds);
  if (!nodes.length) {
    console.log("No in-stock serialized inventory found for these item ids. Nothing to do.");
    console.log(
      "(Note: this only sees labels with quantityInStock >= 0.01 — a fully-consumed label with " +
        "stale dimensions left over isn't reachable this way.)"
    );
    return;
  }

  const rewritable = [];
  const skipped = [];
  const unrecoverable = [];

  for (const n of nodes) {
    const dims = readInventoryCustomFields(n);
    const hasLength = dims.rollLength != null;
    const hasWidth = dims.rollWidth != null;
    const pieceTypeKnown = KNOWN_PIECE_TYPES.has(dims.pieceType);

    if (!pieceTypeKnown || hasLength !== hasWidth) {
      unrecoverable.push({ n, dims, reason: !pieceTypeKnown ? `unrecognized Piece Type "${dims.pieceType}"` : "only one of Roll Length/Roll Width is set" });
      continue;
    }
    if (!hasLength && !hasWidth) {
      skipped.push({ n, dims });
      continue;
    }
    rewritable.push({
      n,
      dims,
      newLength: dims.rollLength * factor,
      newWidth: dims.rollWidth * factor,
    });
  }

  if (unrecoverable.length) {
    console.log(`REFUSING TO RUN — ${unrecoverable.length} label(s) have a dimension state or Piece Type this script cannot interpret:\n`);
    for (const { n, dims, reason } of unrecoverable) {
      console.log(`  Label #${n.scanCodeNumber} (${n.scanCodeSerialNumber}) — ${reason} (Roll Length=${dims.rollLength}, Roll Width=${dims.rollWidth}, Piece Type=${dims.pieceType})`);
    }
    console.log("\nFix these labels' data in Digit (or narrow --item-ids) before re-running. Nothing was written.");
    process.exit(1);
  }

  console.log(`${skipped.length} label(s) have no dimensions set — nothing to rewrite, skipped:`);
  for (const { n } of skipped) console.log(`  Label #${n.scanCodeNumber} (${n.scanCodeSerialNumber})`);
  console.log("");

  console.log(`${rewritable.length} label(s) would be rewritten:`);
  for (const { n, dims, newLength, newWidth } of rewritable) {
    console.log(
      `  Label #${n.scanCodeNumber} (${n.scanCodeSerialNumber}) [${dims.pieceType || "Mill Roll"}] — ` +
        `Roll Length ${dims.rollLength} -> ${newLength}, Roll Width ${dims.rollWidth} -> ${newWidth}`
    );
  }

  if (!args.confirm) {
    console.log("\nDry run only — re-run with --confirm to write these values to Digit.");
    return;
  }

  console.log("\nWriting...");
  for (const { n, newLength, newWidth } of rewritable) {
    try {
      await writeInventoryDimensions(n.id, { rollLength: newLength, rollWidth: newWidth });
      console.log(`  OK: Label #${n.scanCodeNumber}`);
    } catch (err) {
      console.log(`  FAILED: Label #${n.scanCodeNumber} — ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("migrate-dimension-units failed:", err);
  process.exit(1);
});
