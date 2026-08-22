// Digit operations for the CUTTING feature.
//
// Named, allowlisted GraphQL operations — the only way this module talks to
// Digit. See ../../../SCHEMA_NOTES.md for how each of these was confirmed
// against the live schema, and for why this module (not Digit) is the sole
// keeper of a roll's dimensions: Digit's quantityInStock is ft² only, and
// splitSerializedInventory moves ft² between labels without ever touching a
// label's Roll Length / Roll Width custom fields.
import { digitRequest } from "../../core/digit.js";

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

// --- Custom field read/write helpers ---------------------------------------
// Bare numbers only — see SCHEMA_NOTES.md ("write bare numbers" correction).
// Reads stay lenient (parseDimensionText below) since older/dummy records in
// this org are inconsistently formatted.
export function parseDimensionText(text) {
  if (!text) return null;
  const match = String(text).match(/[\d.]+/);
  return match ? Number(match[0]) : null;
}

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
 */
export async function writeInventoryDimensions(
  inventoryId,
  { rollLength, rollWidth, pieceType, parentRollScancode }
) {
  const customFields = [];
  if (rollLength != null) {
    customFields.push({ fieldId: await getCustomFieldId("Roll Length"), fieldValueText: String(rollLength) });
  }
  if (rollWidth != null) {
    customFields.push({ fieldId: await getCustomFieldId("Roll Width"), fieldValueText: String(rollWidth) });
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
          item { id name sku }
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
        item { id name sku }
        manufacturingLocationAddress { id title }
        bom {
          id
          items(connection: { first: 50 }) {
            nodes { id quantity item { id name sku } }
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
          item { id name }
          warehouseLocation { id locationCode }
          customFields { fieldName fieldValueText fieldValueOption { value } }
        }
      }
    }
  }
`;

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
        item { id name }
        warehouseLocation { id locationCode }
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

/** Manual fallback search by label number (scanCodeNumber) or item name. */
export async function searchInventories(term) {
  const normalized = normalizeLabelQuery(term);
  const asNumber = Number(normalized);
  const isExactLabelNumber = normalized !== "" && /^\d+$/.test(normalized);

  if (isExactLabelNumber) {
    const data = await digitRequest(SEARCH_INVENTORIES_QUERY, {
      search: null,
      first: LABEL_NUMBER_LOOKUP_PAGE_SIZE,
    });
    return data.inventories.nodes.filter(
      (n) => n.scanCodeNumber === asNumber && n.quantityInStock > 0
    );
  }

  const data = await digitRequest(SEARCH_INVENTORIES_QUERY, {
    search: normalized,
    first: TEXT_SEARCH_PAGE_SIZE,
  });
  // Zero-quantity labels have already been fully consumed into a job and
  // can't be cut from again — exclude them rather than show a dead end.
  return data.inventories.nodes.filter((n) => n.quantityInStock > 0);
}

const INVENTORY_BY_ID_QUERY = `
  query ($inventoryId: ID) {
    inventory(inventoryId: $inventoryId) {
      id
      quantityInStock
      scanCodeSerialNumber
      scanCodeNumber
      item { id name }
      warehouseLocation { id locationCode }
      customFields { fieldName fieldValueText fieldValueOption { value } }
    }
  }
`;

export async function getInventoryById(inventoryId) {
  const data = await digitRequest(INVENTORY_BY_ID_QUERY, { inventoryId });
  return data.inventory;
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
