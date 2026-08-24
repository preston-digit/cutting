// Cleans up test artifacts accumulated in the demo org while exercising the
// cutting flow (smoke-cut.js runs, manual testing): inflated cut counts on
// specific work orders, and/or specific serialized inventory labels created
// as 1×1 test splits/slivers.
//
// SAFE BY DEFAULT: with no --confirm flag, this ONLY reports what it would
// change — no row is deleted locally, no mutation is sent to Digit. Nothing
// happens to Digit at all without --confirm, and the script prints exactly
// what it did (or would do) either way.
//
// Usage:
//   node scripts/reset-demo-data.js --work-order-ids=<id1>,<id2> [--confirm]
//   node scripts/reset-demo-data.js --labels=<labelNumber1>,<labelNumber2> [--confirm]
//   node scripts/reset-demo-data.js --work-order-ids=... --labels=... [--confirm]
//
// --work-order-ids   Digit work order ids (the same ids used as
//                     SMOKE_WORK_ORDER_ID) — clears cut_events and
//                     scan_attempts rows for these work orders so cutCount
//                     resets to what Digit itself reports.
// --labels            Label numbers (scanCodeNumber, e.g. the "#33" on a
//                     printed label) to delete from Digit's serialized
//                     inventory. Resolved to inventory ids first; a label
//                     already picked into a job/order comes back from Digit
//                     as blocked rather than deleted, and is reported as
//                     such — this script never forces a blocked deletion.
//
// Deliberately does NOT default to "all work orders" or "all test-looking
// labels" — every id/label acted on must be named explicitly on the command
// line, so a bare invocation can never wipe more than intended.
import { pool, runMigrations } from "../src/core/db.js";
import { searchInventories, deleteSerializedInventories } from "../src/features/cutting/digitOps.js";

function parseArgs(argv) {
  const args = { workOrderIds: [], labels: [], confirm: false };
  for (const arg of argv) {
    if (arg === "--confirm") args.confirm = true;
    else if (arg.startsWith("--work-order-ids=")) {
      args.workOrderIds = arg.slice("--work-order-ids=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--labels=")) {
      args.labels = arg
        .slice("--labels=".length)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
  }
  return args;
}

async function reportCutEventsAndScanAttempts(workOrderIds) {
  if (!workOrderIds.length) return { cutEvents: [], scanAttempts: 0 };
  const { rows: cutEvents } = await pool.query(
    `SELECT work_order_id, work_order_number, count(*)::int AS n
     FROM cut_events WHERE work_order_id = ANY($1) GROUP BY work_order_id, work_order_number`,
    [workOrderIds]
  );
  const { rows: scanRows } = await pool.query(
    `SELECT count(*)::int AS n FROM scan_attempts WHERE work_order_id = ANY($1)`,
    [workOrderIds]
  );
  return { cutEvents, scanAttempts: scanRows[0]?.n || 0 };
}

async function resolveLabels(labelNumbers) {
  const resolved = [];
  const notFound = [];
  for (const labelNumber of labelNumbers) {
    // searchInventories() already does the exact-scanCodeNumber lookup path
    // used by the cut screen's manual search — reused here rather than
    // reimplementing it.
    const { results } = await searchInventories(String(labelNumber));
    const match = results.find((n) => n.scanCodeNumber === labelNumber);
    if (match) {
      resolved.push({
        labelNumber,
        inventoryId: match.id,
        scancode: match.scanCodeSerialNumber,
        itemName: match.item?.name,
        quantityInStock: match.quantityInStock,
      });
    } else {
      notFound.push(labelNumber);
    }
  }
  return { resolved, notFound };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.workOrderIds.length && !args.labels.length) {
    console.error(
      "Nothing to do — pass --work-order-ids=<id1>,<id2> and/or --labels=<n1>,<n2>.\n" +
        "Nothing is acted on implicitly; every id/label must be named explicitly.\n\n" +
        "Usage: node scripts/reset-demo-data.js --work-order-ids=<id1>,<id2> --labels=<n1>,<n2> [--confirm]"
    );
    process.exit(1);
  }

  await runMigrations();

  console.log(`Mode: ${args.confirm ? "EXECUTE (--confirm passed)" : "DRY RUN (pass --confirm to execute)"}\n`);

  // --- Work orders: cut_events / scan_attempts -------------------------------
  if (args.workOrderIds.length) {
    const { cutEvents, scanAttempts } = await reportCutEventsAndScanAttempts(args.workOrderIds);
    console.log("Work orders:", args.workOrderIds.join(", "));
    if (cutEvents.length === 0) {
      console.log("  No cut_events rows found for these work order ids.");
    } else {
      for (const row of cutEvents) {
        console.log(`  cut_events: ${row.n} row(s) for WO${row.work_order_number ?? "?"} (${row.work_order_id})`);
      }
    }
    console.log(`  scan_attempts: ${scanAttempts} row(s) for these work order ids`);

    if (args.confirm) {
      const { rowCount: deletedCutEvents } = await pool.query(
        "DELETE FROM cut_events WHERE work_order_id = ANY($1)",
        [args.workOrderIds]
      );
      const { rowCount: deletedScanAttempts } = await pool.query(
        "DELETE FROM scan_attempts WHERE work_order_id = ANY($1)",
        [args.workOrderIds]
      );
      console.log(`  DELETED: ${deletedCutEvents} cut_events row(s), ${deletedScanAttempts} scan_attempts row(s).`);
    } else {
      console.log("  Would delete the above rows. Re-run with --confirm to execute.");
    }
    console.log("");
  }

  // --- Labels: serialized inventory in Digit ---------------------------------
  if (args.labels.length) {
    const { resolved, notFound } = await resolveLabels(args.labels);
    console.log("Labels:", args.labels.join(", "));
    if (notFound.length) {
      console.log(`  Not found (already gone, or never existed): ${notFound.join(", ")}`);
    }
    for (const r of resolved) {
      console.log(`  Label #${r.labelNumber} (${r.scancode}) — ${r.itemName}, ${r.quantityInStock} in stock`);
    }

    if (!resolved.length) {
      console.log("  Nothing resolvable to delete.");
    } else if (args.confirm) {
      const results = await deleteSerializedInventories(resolved.map((r) => r.inventoryId));
      for (const result of results) {
        const label = resolved.find((r) => r.inventoryId === result.inventoryId);
        const tag = `Label #${label?.labelNumber ?? "?"} (${label?.scancode ?? result.inventoryId})`;
        if (result.success) {
          console.log(`  DELETED: ${tag}`);
        } else {
          const blocked = result.blockingLinkedRecords;
          const reason = blocked
            ? `blocked — linked to ${blocked.salesOrders?.length || 0} sales order(s), ${blocked.manufacturingOrders?.length || 0} manufacturing order(s)`
            : result.errorMessage || "unknown error";
          console.log(`  NOT deleted: ${tag} — ${reason}`);
        }
      }
    } else {
      console.log("  Would attempt to delete the above from Digit. Re-run with --confirm to execute.");
    }
  }
}

main()
  .then(() => pool?.end())
  .catch((err) => {
    console.error("reset-demo-data failed:", err);
    process.exit(1);
  });
