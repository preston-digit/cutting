// Digit operations for the CUTTING feature.
//
// Named, allowlisted GraphQL operations — the only way this module talks to
// Digit. See ../../../SCHEMA_NOTES.md for how each of these was confirmed
// against the live schema, and for why this module (not Digit) is the sole
// keeper of a roll's dimensions: Digit's quantityInStock is ft² only, and
// splitSerializedInventory moves ft² between labels without ever touching a
// label's Roll Length / Roll Width custom fields.
import { digitRequest } from "../../core/digit.js";
export { parseDimensionText, formatFeetInches } from "./dimensions.js";
import { parseDimensionText, roundDecimalFeet } from "./dimensions.js";

const CUTTING_STEP_NAME = process.env.CUTTING_STEP_NAME || "Cut to Size";

// --- Custom field id resolution (org-specific — never hardcode) -----------
const CUSTOM_FIELD_NAMES = [
  "Roll Length",
  "Roll Width",
  "Piece Type",
  "Parent Roll",
  "Owner",
];

let customFieldCache = null; // { "Roll Length": { id, type }, ... }
let pieceTypeOptionCache = null; // { "Cut Piece": optionId, "Remnant": optionId, ... }

const CUSTOM_FIELDS_QUERY = `
  query {
    inventoryCustomFields(connection: { first: 100 }) {
      nodes { id name type options { id value } }
    }
  }
`;

async function loadCustomFieldCache() {
  const data = await digitRequest(CUSTOM_FIELDS_QUERY);
  const byName = {};
  const pieceTypeOptions = {};
  for (const f of data.inventoryCustomFields.nodes) {
    byName[f.name] = { id: f.id, type: f.type };
    if (f.name === "Piece Type") {
      for (const opt of f.options || []) {
        // live option values are themselves prefixed, e.g. "Piece Type: Cut Piece"
        const short = opt.value.split(":").pop().trim();
        pieceTypeOptions[short] = opt.id;
      }
    }
  }
  customFieldCache = byName;
  pieceTypeOptionCache = pieceTypeOptions;
}

async function getCustomFieldId(name) {
  if (!customFieldCache || !customFieldCache[name]) await loadCustomFieldCache();
  const field = customFieldCache[name];
  if (!field) throw new Error(`Digit custom field "${name}" not found (context: inventory)`);
  return field.id;
}

async function getPieceTypeOptionId(label) {
  if (!pieceTypeOptionCache || !pieceTypeOptionCache[label]) await loadCustomFieldCache();
  const id = pieceTypeOptionCache[label];
  if (!id) throw new Error(`Digit "Piece Type" option "${label}" not found`);
  return id;
}

/**
 * Reverse of getCustomFieldId — given a custom field id (as found on a
 * label template's cf_<id> binding key), returns the field's name so its
 * live value can be looked up in readInventoryCustomFields()'s `.raw` map.
 * Used only by the label renderer (labelTemplate.js/labelRenderer.js) to
 * resolve template bindings against live inventory custom fields.
 */
export async function getCustomFieldNameById(id) {
  if (!customFieldCache) await loadCustomFieldCache();
  for (const [name, field] of Object.entries(customFieldCache)) {
    if (field.id === id) return name;
  }
  return null;
}

// --- Custom field read/write helpers ---------------------------------------
// Bare numbers only — see SCHEMA_NOTES.md ("write bare numbers" correction).
// Reads stay lenient (parseDimensionText, in ./dimensions.js) since older
// records in this org are inconsistently formatted, INCLUDING real
// feet-and-inches notation (13'-2") seen on live customer tags — see
// dimensions.js's header comment and dimensions.test.js.

// Some fields' stored/option values redundantly repeat the field's own name
// as a prefix — and not always the FULL name: live-confirmed cases are
// "Owner: The Dixie Group" (full name "Owner"), "Parent: mi_..." (field is
// "Parent Roll", but the prefix is only its first word), and Piece Type's
// option values are literally named "Piece Type: Cut Piece" etc. Checking
// the full field name AND each of its individual words catches all three
// without hardcoding any one field.
function stripFieldNamePrefix(fieldName, value) {
  if (typeof value !== "string") return value;
  const candidates = [fieldName, ...fieldName.split(/\s+/).filter(Boolean)];
  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^\\s*${escaped}\\s*:\\s*`, "i");
    if (pattern.test(value)) return value.replace(pattern, "").trim();
  }
  return value.trim();
}

// The org intends to move roll goods from ft² to yd² eventually — nothing in
// this module may hardcode a unit string. Every quantity's unit comes from
// Item.defaultStockUom (symbol/name/type), fetched alongside the item on
// every query that returns one. `type: "area"` confirms the quantity is an
// area measurement (live-confirmed: roll items report
// { symbol: "ft²", name: "Square Feet", type: "area" }); a linear unit
// ("ft", "yd") is derived from the area symbol for Roll Length/Width display
// since Digit has no separate linear-UoM field for these custom fields.
export function itemUom(item) {
  const uom = item?.defaultStockUom;
  if (!uom) return null;
  return { symbol: uom.symbol, name: uom.name, type: uom.type };
}

// CANONICAL UNIT-BASIS RULE (see SCHEMA_NOTES.md's "Canonical unit-basis
// rule" section): Roll Length/Roll Width carry NO unit metadata of their
// own and none will be added — a bare number in these fields is always
// denominated in the linear unit implied by the item's defaultStockUom.
// This table is the SINGLE source of that mapping — every other place that
// needs a linear unit or a unit-conversion factor (display formatting, the
// geometry boundary's requireLinearUnit() below, the ratio-aware
// unit-mismatch check, migrate-dimension-units.js) goes through it rather
// than re-deriving one. Extend this table when the org adds a new
// defaultStockUom; never guess a mapping for an unrecognized one.
const AREA_UNIT_TABLE = {
  "ft²": { linear: "ft", ftPerUnit: 1 },
  "sq ft": { linear: "ft", ftPerUnit: 1 },
  "sqft": { linear: "ft", ftPerUnit: 1 },
  "yd²": { linear: "yd", ftPerUnit: 3 },
  "sq yd": { linear: "yd", ftPerUnit: 3 },
  "sqyd": { linear: "yd", ftPerUnit: 3 },
  "m²": { linear: "m", ftPerUnit: 3.28084 },
  "sq m": { linear: "m", ftPerUnit: 3.28084 },
  "sqm": { linear: "m", ftPerUnit: 3.28084 },
};

function areaUnitTableEntry(areaSymbol) {
  if (!areaSymbol) return null;
  return AREA_UNIT_TABLE[String(areaSymbol).trim().toLowerCase()] || null;
}

/**
 * Linear unit implied by an area UoM symbol, from AREA_UNIT_TABLE — display
 * use only. Returns null for an unrecognized symbol (e.g. a count unit like
 * "ea", or a genuinely new area unit not yet added to the table) rather than
 * guessing; callers that need a hard guarantee (the geometry boundary) must
 * use requireLinearUnit() instead, which throws.
 */
export function deriveLinearUnitSymbol(areaSymbol) {
  return areaUnitTableEntry(areaSymbol)?.linear ?? null;
}

/**
 * Asserts the item's defaultStockUom resolves to a recognized linear unit
 * and returns it — call this at the top of any geometry path (the cut
 * commit) before doing arithmetic with Roll Length/Width. Throws rather
 * than silently assuming feet, per the canonical unit-basis rule: an
 * unrecognized area unit means this module cannot safely interpret the
 * dimension custom fields at all.
 */
export function requireLinearUnit(item) {
  const uom = itemUom(item);
  const entry = areaUnitTableEntry(uom?.symbol);
  if (!entry) {
    throw new Error(
      `Item's stock UoM "${uom?.symbol ?? "(none)"}" is not a recognized area unit ` +
        `(see AREA_UNIT_TABLE in digitOps.js) — cannot determine what linear unit Roll ` +
        `Length/Roll Width are denominated in. Add this unit to AREA_UNIT_TABLE before ` +
        `cutting this item.`
    );
  }
  return entry.linear;
}

// Every pairwise ratio of two recognized area units' ft-equivalent factors,
// squared — i.e. the "if these dimensions were measured in one unit but
// quantityInStock is denominated in another, what ratio would that produce"
// set (9/1-9 for ft<->yd, ~10.76/1-10.76 for ft<->m, etc.), derived from
// AREA_UNIT_TABLE rather than hardcoded so a newly added unit is covered
// automatically. Same-unit pairs (ratio 1) are dropped — that's not a
// mismatch signature, it's agreement.
const KNOWN_UNIT_MISMATCH_AREA_RATIOS = (() => {
  const factors = [...new Set(Object.values(AREA_UNIT_TABLE).map((e) => e.ftPerUnit))];
  const ratios = new Set();
  for (const a of factors) {
    for (const b of factors) {
      const r = (a / b) ** 2;
      if (Math.abs(r - 1) > 0.001) ratios.add(r);
    }
  }
  return [...ratios];
})();

const UNIT_MISMATCH_RATIO_TOLERANCE = 0.03; // 3%

/**
 * True if impliedArea/quantityInStock lands within tolerance of a known
 * unit-conversion square — i.e. the mismatch looks like the dimensions and
 * quantityInStock were recorded in two different (but both recognized)
 * units, not just a data-entry error. See withParsedDimensions() in
 * routes.js, which uses this to decide whether an out-of-sync piece stays
 * selectable (generic bad data, ack-and-proceed) or is blocked outright
 * (probable unit mismatch, needs a fix in Digit first).
 */
export function isUnitMismatchRatio(quantityInStock, impliedArea) {
  if (!quantityInStock || !impliedArea) return false;
  const ratio = impliedArea / quantityInStock;
  return KNOWN_UNIT_MISMATCH_AREA_RATIOS.some((r) => Math.abs(ratio - r) / r <= UNIT_MISMATCH_RATIO_TOLERANCE);
}

/**
 * ft-equivalent factor for one unit of the given linear unit symbol ("ft",
 * "yd", "m"), from AREA_UNIT_TABLE — used only by
 * scripts/migrate-dimension-units.js to compute a conversion factor between
 * two linear units. Returns null for an unrecognized symbol.
 */
export function linearUnitFtPerUnit(linearSymbol) {
  const entry = Object.values(AREA_UNIT_TABLE).find((e) => e.linear === linearSymbol);
  return entry ? entry.ftPerUnit : null;
}

/** Linear unit symbols this module recognizes — for CLI usage/validation messages. */
export function recognizedLinearUnits() {
  return [...new Set(Object.values(AREA_UNIT_TABLE).map((e) => e.linear))];
}

// WarehouseLocationType enum (live-confirmed): bin, transit, workCenter,
// unassigned, userDefined (deprecated alias of bin). Only bin/userDefined
// are real, pickable storage — "transit" is Digit's system-generated
// in-flight-transfer location and "unassigned"/"workCenter" are likewise
// not places material can be picked from. Confirmed via schema, not by
// string-matching a location's name/code.
const REAL_STORAGE_BIN_TYPES = new Set(["bin", "userDefined"]);
export function isRealStorageBin(locationType) {
  return REAL_STORAGE_BIN_TYPES.has(locationType);
}

export function readInventoryCustomFields(inventory) {
  const byName = {};
  for (const f of inventory.customFields || []) {
    const raw = f.fieldValueText ?? f.fieldValueOption?.value ?? null;
    byName[f.fieldName] = stripFieldNamePrefix(f.fieldName, raw);
  }
  return {
    rollLength: parseDimensionText(byName["Roll Length"]),
    rollWidth: parseDimensionText(byName["Roll Width"]),
    owner: byName["Owner"] || null,
    parentRoll: byName["Parent Roll"] || null,
    pieceType: byName["Piece Type"] || null,
    raw: byName,
  };
}

/**
 * The UNSTRIPPED stored value of a custom field — screen display goes
 * through readInventoryCustomFields() above (which strips the redundant
 * "Owner: "/"Piece Type: " prefix some of this org's field/option values
 * carry, for a cleaner UI), but the printed tag must not: Digit's own
 * Reprint of the same template renders the raw stored value verbatim
 * ("Piece Type: Remnant", "Owner: The Dixie Group"), so this app's render
 * has to match that field-for-field rather than diverge based on who
 * printed it. Used only by labelRenderer.js — never call this for anything
 * shown on screen.
 */
export function rawCustomFieldValue(inventory, fieldName) {
  const field = (inventory.customFields || []).find((f) => f.fieldName === fieldName);
  if (!field) return null;
  return field.fieldValueText ?? field.fieldValueOption?.value ?? null;
}

const UPDATE_INVENTORY_CUSTOM_FIELDS_MUTATION = `
  mutation ($input: UpdateSerializedInventoryInput!) {
    updateSerializedInventory(input: $input) {
      inventory {
        id
        quantityInStock
        scanCodeSerialNumber
        customFields { fieldName fieldValueText fieldValueOption { value } }
      }
    }
  }
`;

/**
 * Write Roll Length / Roll Width (bare numbers) and, optionally, Piece Type
 * and Parent Roll on a label. Called once per label per commit, in the same
 * step group as the split/creation that changed its quantity — see
 * SCHEMA_NOTES.md's "sole keeper of dimensional truth" section.
 *
 * rollLength/rollWidth are rounded (roundDecimalFeet, dimensions.js) before
 * being stringified — subtracting/summing decimal-feet values upstream
 * (e.g. sourceLength - cutLength) routinely lands on IEEE 754 noise like
 * 13.299999999999999; this is the one place every dimension write funnels
 * through, so it's the right place to kill that noise once rather than at
 * every call site that does dimension arithmetic.
 */
export async function writeInventoryDimensions(
  inventoryId,
  { rollLength, rollWidth, pieceType, parentRollScancode }
) {
  const customFields = [];
  if (rollLength != null) {
    customFields.push({ fieldId: await getCustomFieldId("Roll Length"), fieldValueText: String(roundDecimalFeet(rollLength)) });
  }
  if (rollWidth != null) {
    customFields.push({ fieldId: await getCustomFieldId("Roll Width"), fieldValueText: String(roundDecimalFeet(rollWidth)) });
  }
  if (pieceType) {
    customFields.push({
      fieldId: await getCustomFieldId("Piece Type"),
      fieldValueOptionId: await getPieceTypeOptionId(pieceType),
    });
  }
  if (parentRollScancode) {
    customFields.push({ fieldId: await getCustomFieldId("Parent Roll"), fieldValueText: parentRollScancode });
  }

  const data = await digitRequest(UPDATE_INVENTORY_CUSTOM_FIELDS_MUTATION, {
    input: { inventoryId, customFields },
  });
  return data.updateSerializedInventory.inventory;
}

// --- Split a serialized inventory label ------------------------------------
const SPLIT_SERIALIZED_INVENTORY_MUTATION = `
  mutation ($input: SplitSerializedInventoryInput!) {
    splitSerializedInventory(input: $input) {
      originalInventory { id quantityInStock scanCodeSerialNumber }
      newInventory {
        id
        quantityInStock
        scanCodeSerialNumber
        scanCodeNumber
        warehouseLocation { id locationCode }
      }
    }
  }
`;

/** One call = one new label. The cutting commit calls this up to twice — see SCHEMA_NOTES.md §1. */
export async function splitSerializedInventory(inventoryId, quantityToSplit, warehouseLocationId) {
  const data = await digitRequest(SPLIT_SERIALIZED_INVENTORY_MUTATION, {
    input: { inventoryId, quantityToSplit, warehouseLocationId },
  });
  return data.splitSerializedInventory;
}

// --- Move a label to a bin (also usable standalone, outside a split) -------
const MOVE_INVENTORY_MUTATION = `
  mutation ($input: UpdateSerializedInventoryInput!) {
    updateSerializedInventory(input: $input) {
      inventory { id warehouseLocation { id locationCode } }
    }
  }
`;

export async function moveInventoryToBin(inventoryId, warehouseLocationId) {
  const data = await digitRequest(MOVE_INVENTORY_MUTATION, {
    input: { inventoryId, warehouseLocationId },
  });
  return data.updateSerializedInventory.inventory;
}

// --- Pick inventory into a manufacturing order ------------------------------
const PICK_JOB_ITEM_MUTATION = `
  mutation ($input: PickJobItemInput!) {
    pickJobItem(input: $input) {
      pickedJobItem { id quantity inventory { id } job { id } }
    }
  }
`;

export async function pickJobItem(jobId, inventoryId, quantityFloat) {
  const data = await digitRequest(PICK_JOB_ITEM_MUTATION, {
    input: { jobId, inventoryId, quantityFloat },
  });
  return data.pickJobItem.pickedJobItem;
}

// --- Start / complete a work order ------------------------------------------
const UPDATE_WORK_ORDER_MUTATION = `
  mutation ($input: UpdateWorkOrderInput!) {
    updateWorkOrder(input: $input) {
      workOrder { id status completedQuantity expectedQuantity }
    }
  }
`;

export async function startWorkOrder(workOrderId) {
  const data = await digitRequest(UPDATE_WORK_ORDER_MUTATION, {
    input: { workOrderId, status: "IN_PROGRESS" },
  });
  return data.updateWorkOrder.workOrder;
}

export async function completeWorkOrder(workOrderId, completedQuantity) {
  const data = await digitRequest(UPDATE_WORK_ORDER_MUTATION, {
    input: { workOrderId, status: "COMPLETED", completedQuantity },
  });
  return data.updateWorkOrder.workOrder;
}

// --- Cutting queue -----------------------------------------------------------
const OPERATIONS_QUERY = `
  query ($search: String) {
    operations(search: $search) { nodes { id name operationStatus } }
  }
`;

let cuttingOperationIdCache = null;

async function getCuttingOperationId() {
  if (cuttingOperationIdCache) return cuttingOperationIdCache;
  const data = await digitRequest(OPERATIONS_QUERY, { search: CUTTING_STEP_NAME });
  const op = data.operations.nodes.find((o) => o.name === CUTTING_STEP_NAME);
  if (!op) throw new Error(`Digit operation "${CUTTING_STEP_NAME}" not found (CUTTING_STEP_NAME)`);
  cuttingOperationIdCache = op.id;
  return op.id;
}

const WORK_ORDERS_QUERY = `
  query ($operationIds: [ID!], $statuses: [WorkOrderStatus!]) {
    workOrders(
      operationIds: $operationIds
      statuses: $statuses
      connection: { first: 200 }
    ) {
      totalCount
      nodes {
        id
        workOrderNumber
        status
        expectedQuantity
        completedQuantity
        warehouseLocation { id locationCode }
        job {
          id
          jobNumber
          documentNumber
          targetQuantity
          notes
          item { id name sku defaultStockUom { symbol name type } }
          salesOrder {
            id
            orderNumber
            requestedDeliveryDate
            customer { name }
          }
        }
      }
    }
  }
`;

/** Sorted by ship-by date ascending, nulls (no linked SO) last — see SCHEMA_NOTES.md. */
export async function getCuttingQueue() {
  const operationId = await getCuttingOperationId();
  const data = await digitRequest(WORK_ORDERS_QUERY, {
    operationIds: [operationId],
    statuses: ["NOT_STARTED", "IN_PROGRESS"],
  });
  const rows = data.workOrders.nodes.map((wo) => ({
    workOrderId: wo.id,
    workOrderNumber: wo.workOrderNumber,
    status: wo.status,
    expectedQuantity: wo.expectedQuantity,
    completedQuantity: wo.completedQuantity,
    jobId: wo.job?.id,
    moNumber: wo.job?.documentNumber || wo.job?.jobNumber,
    itemName: wo.job?.item?.name,
    itemSku: wo.job?.item?.sku,
    itemUom: itemUom(wo.job?.item),
    targetQuantity: wo.job?.targetQuantity,
    salesOrderNumber: wo.job?.salesOrder?.orderNumber || null,
    customerName: wo.job?.salesOrder?.customer?.name || null,
    shipByDate: wo.job?.salesOrder?.requestedDeliveryDate || null,
  }));
  rows.sort((a, b) => {
    if (!a.shipByDate && !b.shipByDate) return 0;
    if (!a.shipByDate) return 1;
    if (!b.shipByDate) return -1;
    return new Date(a.shipByDate) - new Date(b.shipByDate);
  });
  return rows;
}

// --- Work order / job detail (cut screen header) ----------------------------
const WORK_ORDER_DETAIL_QUERY = `
  query ($workOrderId: ID!) {
    workOrder(workOrderId: $workOrderId) {
      id
      workOrderNumber
      status
      expectedQuantity
      completedQuantity
      warehouseLocation { id locationCode }
      job {
        id
        jobNumber
        documentNumber
        targetQuantity
        notes
        createdOn
        createdBy { id profile { fullName } }
        item { id name sku defaultStockUom { symbol name type } }
        manufacturingLocationAddress { id title }
        bom {
          id
          items(connection: { first: 50 }) {
            nodes { id quantity item { id name sku defaultStockUom { symbol name type } } }
          }
        }
        salesOrder {
          id
          orderNumber
          requestedDeliveryDate
          customer { name }
        }
      }
    }
  }
`;

export async function getWorkOrderDetail(workOrderId) {
  const data = await digitRequest(WORK_ORDER_DETAIL_QUERY, { workOrderId });
  return data.workOrder;
}

// --- Scan resolution ---------------------------------------------------------
const FETCH_BY_SERIAL_NUMBER_QUERY = `
  query ($serialNumber: String!) {
    fetchBySerialNumber(input: { serialNumber: $serialNumber }) {
      result {
        __typename
        ... on Inventory {
          id
          quantityInStock
          scanCodeSerialNumber
          scanCodeNumber
          item { id name defaultStockUom { symbol name type } }
          warehouseLocation { id locationCode type }
          customFields { fieldName fieldValueText fieldValueOption { value } }
        }
      }
    }
  }
`;

/**
 * Trim whitespace and strip non-printing/control characters from a decoded
 * scan value before any lookup — USB-wedge scanners and camera decodes can
 * append a trailing newline/carriage-return or other control bytes that
 * would otherwise make an exact match silently fail.
 */
export function sanitizeScanValue(value) {
  return String(value ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

/** A value shaped like a Digit scancode (scanCodeSerialNumber) — must resolve exactly, never via fuzzy search. */
export function looksLikeScancode(value) {
  return /^(mi|rcv|splt|job)_/.test(value);
}

/** Resolves a scanned barcode. Barcodes encode scanCodeSerialNumber, not the human Label #. */
export async function resolveScannedSerial(serialNumber) {
  let data;
  try {
    data = await digitRequest(FETCH_BY_SERIAL_NUMBER_QUERY, { serialNumber });
  } catch (err) {
    if (/no result found/i.test(err.message)) return null;
    throw err;
  }
  const result = data.fetchBySerialNumber.result;
  if (!result || result.__typename !== "Inventory") return null;
  return result;
}

// Live-confirmed via schema introspection: Query.inventories takes an
// itemIds filter (in addition to search/trackingMethod/connection), so the
// "available material" list can go straight to Digit for exactly the BOM
// component item(s) rather than paging through everything and filtering
// client-side.
const INVENTORIES_BY_ITEM_QUERY = `
  query ($itemIds: [ID!], $first: Int!) {
    inventories(
      itemIds: $itemIds
      trackingMethod: [serialized]
      minQuantityInStock: 0.01
      connection: { first: $first }
    ) {
      nodes {
        id
        quantityInStock
        scanCodeSerialNumber
        scanCodeNumber
        item { id name defaultStockUom { symbol name type } }
        warehouseLocation { id locationCode type }
        customFields { fieldName fieldValueText fieldValueOption { value } }
      }
    }
  }
`;

const AVAILABLE_MATERIAL_PAGE_SIZE = 200;

/** Every in-stock serialized label of the given BOM component item(s) — see routes.js's /available-material. */
export async function getInventoriesForItems(itemIds) {
  if (!itemIds.length) return [];
  const data = await digitRequest(INVENTORIES_BY_ITEM_QUERY, {
    itemIds,
    first: AVAILABLE_MATERIAL_PAGE_SIZE,
  });
  return data.inventories.nodes;
}

const SEARCH_INVENTORIES_QUERY = `
  query ($search: String, $first: Int!) {
    inventories(
      search: $search
      trackingMethod: [serialized]
      connection: { first: $first }
    ) {
      nodes {
        id
        quantityInStock
        scanCodeSerialNumber
        scanCodeNumber
        item { id name defaultStockUom { symbol name type } }
        warehouseLocation { id locationCode type }
        customFields { fieldName fieldValueText fieldValueOption { value } }
      }
    }
  }
`;

// A bare number typed/scanned as "Label #9" or "#9" or "9" all mean the same
// lookup — strip the label prefix and punctuation so all three resolve.
function normalizeLabelQuery(term) {
  return (term || "")
    .trim()
    .replace(/^label/i, "")
    .replace(/^\s*#\s*/, "")
    .trim();
}

// inventories() has no scanCodeNumber filter, so an exact Label # lookup has
// to pull enough of the org's serialized inventory to guarantee it's in the
// page, then filter client-side by strict equality — never falls through to
// a fuzzy text search, which was matching arbitrary substrings (timestamps
// embedded in other labels' scancodes) and returning a wall of unrelated
// results for a bare number.
const LABEL_NUMBER_LOOKUP_PAGE_SIZE = 500;
const TEXT_SEARCH_PAGE_SIZE = 20;

/**
 * Manual fallback search by label number (scanCodeNumber) or item name.
 * Returns { matchType, results } — matchType tells the caller whether this
 * was an exact "Label #N" lookup (safe to auto-apply a single result) or a
 * free-text search (never auto-apply; always show as a pick list, even for
 * a single row — see SCHEMA_NOTES.md's scan-resolution rules).
 */
export async function searchInventories(term) {
  const normalized = normalizeLabelQuery(term);
  const asNumber = Number(normalized);
  const isExactLabelNumber = normalized !== "" && /^\d+$/.test(normalized);

  if (isExactLabelNumber) {
    const data = await digitRequest(SEARCH_INVENTORIES_QUERY, {
      search: null,
      first: LABEL_NUMBER_LOOKUP_PAGE_SIZE,
    });
    const results = data.inventories.nodes.filter(
      (n) => n.scanCodeNumber === asNumber && n.quantityInStock > 0
    );
    return { matchType: "exact_label_number", results };
  }

  const data = await digitRequest(SEARCH_INVENTORIES_QUERY, {
    search: normalized,
    first: TEXT_SEARCH_PAGE_SIZE,
  });
  // Zero-quantity labels have already been fully consumed into a job and
  // can't be cut from again — exclude them rather than show a dead end.
  const results = data.inventories.nodes.filter((n) => n.quantityInStock > 0);
  return { matchType: "text_search", results };
}

const INVENTORY_BY_ID_QUERY = `
  query ($inventoryId: ID) {
    inventory(inventoryId: $inventoryId) {
      id
      quantityInStock
      scanCodeSerialNumber
      scanCodeNumber
      lotNumber
      createdAt
      item { id name sku defaultStockUom { symbol name type } }
      warehouseLocation { id locationCode type }
      customFields { fieldName fieldValueText fieldValueOption { value } }
    }
  }
`;

export async function getInventoryById(inventoryId) {
  const data = await digitRequest(INVENTORY_BY_ID_QUERY, { inventoryId });
  return data.inventory;
}

// --- Deleting serialized inventory (used only by scripts/reset-demo-data.js) ---
// Live-confirmed via schema introspection: a real delete mutation exists
// (not previously needed by the cutting flow itself, which only ever
// splits/moves inventory). Digit still enforces referential integrity —
// deleting a label picked into a job/order comes back with
// blockingLinkedRecords rather than succeeding, which the caller must
// surface rather than silently ignore.
const DELETE_SERIALIZED_INVENTORIES_MUTATION = `
  mutation ($input: DeleteSerializedInventoriesInput!) {
    deleteSerializedInventories(input: $input) {
      results {
        inventoryId
        success
        errorMessage
        blockingLinkedRecords {
          salesOrders { id }
          manufacturingOrders { id }
        }
      }
    }
  }
`;

export async function deleteSerializedInventories(inventoryIds) {
  const data = await digitRequest(DELETE_SERIALIZED_INVENTORIES_MUTATION, {
    input: { inventoryIds },
  });
  return data.deleteSerializedInventories.results;
}

// --- Warehouse locations (bins) ---------------------------------------------
const WAREHOUSE_LOCATIONS_QUERY = `
  query ($search: String) {
    warehouseLocations(search: $search, types: [bin], connection: { first: 25 }) {
      nodes { id locationCode }
    }
  }
`;

// Remnants must go to a "bin"-type location — splitSerializedInventory
// rejects work-center locations (live-confirmed: "Inventory can only be
// split to a bin location"). This filter keeps the remnant-bin picker to
// valid choices only.
export async function searchWarehouseLocations(search) {
  const data = await digitRequest(WAREHOUSE_LOCATIONS_QUERY, { search });
  return data.warehouseLocations.nodes;
}

export async function resolveWarehouseLocationByName(name) {
  const nodes = await searchWarehouseLocations(name);
  const match = nodes.find((n) => n.locationCode === name);
  if (!match) throw new Error(`Digit warehouse location "${name}" not found`);
  return match;
}

// --- Resolving a pickable bin for a job's manufacturing address -----------
// pickJobItem requires the inventory's bin to share the same Address as the
// job's manufacturingLocationAddress — NOT to literally sit in the work
// center location shown on the work order (that's a workCenter-type
// location; Digit's split/update mutations both reject workCenter targets
// outright: "Inventory can only be split/assigned to a bin location"). See
// SCHEMA_NOTES.md.
const WAREHOUSE_LOCATIONS_BY_ADDRESS_QUERY = `
  query ($addressId: ID!) {
    warehouseLocations(addressId: $addressId, types: [bin], connection: { first: 5 }) {
      nodes { id locationCode }
    }
  }
`;

export async function resolvePickableBinForAddress(addressId) {
  const data = await digitRequest(WAREHOUSE_LOCATIONS_BY_ADDRESS_QUERY, { addressId });
  const bin = data.warehouseLocations.nodes[0];
  if (!bin) throw new Error(`No bin-type warehouse location found under manufacturing address ${addressId}`);
  return bin;
}
