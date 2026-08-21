# Digit GraphQL schema notes — cutting module

Introspected live against `DIGIT_API_URL` (`https://api.digit-software.com/graphql`)
using the org's real `DIGIT_API_TOKEN` on 2026-08-21. Every operation below was
confirmed to exist in the introspected schema; queries (not mutations) were also
run against live data to confirm shapes — mutations were **not** executed against
live records during this investigation, to avoid touching real inventory/work
orders before the app exists to use them correctly.

No blockers found. All six capabilities are exposed except label printing, which
is UI-only (flagged below, not faked).

## 1. Split a serialized inventory label into two labels with specified quantities

**Exposed.** `Mutation.splitSerializedInventory(input: SplitSerializedInventoryInput!): SplitSerializedInventoryResponse!`

```graphql
input SplitSerializedInventoryInput {
  inventoryId: ID!
  quantityToSplit: Float!
  warehouseLocationId: ID!
}
type SplitSerializedInventoryResponse {
  originalInventory: Inventory!   # same id/serial, quantityInStock reduced by quantityToSplit
  newInventory: Inventory!        # brand-new id/serial, quantityInStock = quantityToSplit, at warehouseLocationId
}
```

**Important:** one call produces exactly **one** new label. The cutting flow
needs up to two new footprints out of one source roll (the working piece, and
optionally a side remnant), so the commit flow calls this mutation **twice in
sequence** against the same shrinking original:

1. `splitSerializedInventory({ inventoryId: source.id, quantityToSplit: cutArea, warehouseLocationId: workCenterLocationId })`
   → `newInventory` = the working piece (picked into the MO next). `originalInventory` now holds `sourceArea - cutArea`.
2. If there's a side remnant (`cutWidth < sourceWidth`): `splitSerializedInventory({ inventoryId: source.id /* same id, now-reduced */, quantityToSplit: sideRemnantArea, warehouseLocationId: remnantBinId })`
   → `newInventory` = the remnant label. `originalInventory` now holds `sourceArea - cutArea - sideRemnantArea`.

The math is self-consistent: for a full-width crosscut (`cutWidth == sourceWidth`),
step 2 is skipped and the source label just continues at the shorter length — no
remnant label is created, matching the domain rule that a full-width crosscut has
no *side* remnant. For a partial-width cut, after both splits the source label's
remaining `quantityInStock` equals `sourceWidth × (sourceLength − cutLength)`
exactly, which is also written to its `Roll Length`/`Roll Width` custom fields
in step 3.

If either split fails partway, the UI must stop and show exactly what completed
(per the spec) — do not attempt the second split as a "fix" for a failed first
split, and do not retry automatically.

## 2. Picking inventory into a manufacturing order

**Exposed.** `Mutation.pickJobItem(input: PickJobItemInput!): PickedJobItemResponse!`

```graphql
input PickJobItemInput {
  jobId: ID!
  inventoryId: ID
  itemId: ID
  quantityFloat: Float
  costPerUom: CostInput
}
type PickedJobItemResponse { pickedJobItem: PickedJobItem! }
```

Call with `jobId` = the MO's `job.id`, `inventoryId` = the working piece's new
label id (from split step 1), `quantityFloat` = `cutArea`. `costPerUom` omitted
(not specified by the domain).

There's also `unpickJobItem` (rollback, not used by this module's happy path)
and `pickItem`/`pickItemForTransfer` for non-job contexts (not relevant here).

## 3. Starting and completing a work order

**Exposed.** `Mutation.updateWorkOrder(input: UpdateWorkOrderInput!): UpdateWorkOrderResponse!`

```graphql
input UpdateWorkOrderInput {
  workOrderId: ID!
  completedQuantity: Float
  expectedQuantity: Float
  status: WorkOrderStatus   # NOT_STARTED | IN_PROGRESS | PAUSED | COMPLETED
  warehouseLocationId: ID
  equipmentId: ID
  toolId: ID
  profileIds: [ID!]
  stopWorkOrderLogs: WorkOrderLogStopBehavior
}
```

- Start: `updateWorkOrder({ workOrderId, status: IN_PROGRESS })`, only if the
  queried `WorkOrder.status` (a plain `String`, live-confirmed values match the
  enum, e.g. `"NOT_STARTED"`) isn't already `IN_PROGRESS`.
- Complete: `updateWorkOrder({ workOrderId, status: COMPLETED, completedQuantity })`.

## 4. Reading and writing inventory custom field values

**Exposed**, both directions.

- Definitions: `Query.inventoryCustomFields(connection): InventoryCustomFieldConnection!`
  → `nodes: [CustomField!]` with `{ id, name, type, context, options }`.
  Live org fields (`context: inventory`):

  | name         | type         | id (live)                               |
  | ------------ | ------------ | ---------------------------------------- |
  | Roll Length  | text         | `01a00d77-18d6-72bf-8e15-c1270c922619`   |
  | Roll Width   | text         | `01a00b5f-69ca-75d8-ab1a-cc23201753de`   |
  | Piece Type   | singleSelect | `01a00b6a-8c41-75fe-86ea-8cbcbce11a92`   |
  | Parent Roll  | text         | `01a00b4f-d1b3-72ae-b94c-299110a9b2ad`   |
  | Owner        | text         | `01a00b4b-7f58-75dd-8620-0dcb8509bbed`   |

  The backend resolves these ids by name at startup/on demand (don't hardcode —
  IDs are org-specific and could differ per Digit tenant) and caches them.

- Read: `Inventory.customFields: [InventoryCustomFieldValue!]` →
  `{ fieldName, fieldValueText, fieldValueOption, ... }`.

- Write: `updateSerializedInventory(input: { inventoryId, customFields: [UpdateInventoryCustomFieldValueInput!] })`
  where each entry is `{ fieldId, fieldValueText }` for the text fields above.
  Same shape (`CreateInventoryCustomFieldValueInput`) on `createSerializedInventory`,
  but new labels are created by `splitSerializedInventory`, not `createSerializedInventory`,
  so the new labels' custom fields are set with a follow-up `updateSerializedInventory` call.

**Live data finding — format distribution across ~29 roll labels (all
existing serialized inventory in the org, `context: inventory`, `text`-type
fields):** `Roll Length` / `Roll Width` are free text with no numeric
validation, and existing values are **not** consistently formatted:

| Roll Length values seen        | Roll Width values seen     |
| ------------------------------- | --------------------------- |
| `"Length: 66.7 ft"`              | `"Width: 15 ft "` (trailing space) |
| `"Length: 40 ft"`                | `"Width: 15ft"` (no space before unit) |
| `"Length: 100 ft"`               | `"Width: 15 ft"` (clean)    |
| `"Length: 10 ft"`, `"Length: 80 ft"`, `"Length: 50 ft"` | `"Width:"` (empty, ~4 records) |
| `"Length:"` (empty, ~4 records) | `"Width 5 ft"` (no colon, one `splt_` record) |
| `"Length 8 ft"` (no colon, one `splt_` record) | |
| `"xxx"` (one clearly-test record, `job_` prefix) | |

No single canonical format — this is operator free-text, not a structured
field, and past writes are inconsistent (with/without colon, with/without
space, sometimes blank). Bare colon-space-number-space-unit
(`"Length: {n} ft"` / `"Width: {n} ft"`) is the modal format among
well-formed entries, so that's what this module writes on every create/update
for consistency going forward; reads parse leniently (strip everything but the
first number) rather than assuming the app's own format, since older/other
records won't match it exactly.

**Owner** is read-only display in this module (never written) — carrying
whatever inconsistent text is already on the source record isn't this app's
job to fix, and the spec never asks for it to write Owner.

**Piece Type** (`singleSelect`) live option values, needed for step (c) of the
commit:

| option value              | id                                       |
| -------------------------- | ---------------------------------------- |
| `Piece Type: Mill Roll`     | `01a00b6a-8c59-75b6-83ba-a5f051a378d7`   |
| `Piece Type: Cut Piece`     | `01a00b6a-8c59-75b6-83ba-ab8ed28fc9d2`   |
| `Piece Type: Remnant`       | `01a00b6a-8c59-75b6-83ba-ac80a3d0f76c`   |
| `Piece Type: Finished Rug`  | `01a00b6a-8c59-75b6-83ba-b111a306b8e6`   |

The commit flow sets `fieldValueOptionId` = **Cut Piece** on the working piece
label, **Remnant** on the side-remnant label (when created). The source label
keeps its existing Piece Type untouched (it's still the same mill roll, just
shorter).

**Parent Roll** (`text`) is written on both new labels with the source's
`scanCodeSerialNumber`, in the `"Parent: {scancode}"` format seen on the one
live record that actually has a parent recorded (`"Parent: mi_1786932480681"`;
most others are blank — `"Parent: "` — because they're original mill rolls
with no parent).

**Area reconciliation (confirmed exactly, not approximately):**

```
sourceArea            = sourceWidth × sourceLength
cutArea               = cutWidth × cutLength                         (working piece)
sideRemnantArea       = (sourceWidth − cutWidth) × cutLength         (0 if cutWidth == sourceWidth)
remainingSourceArea   = sourceArea − cutArea − sideRemnantArea
                       = sourceWidth × sourceLength − cutLength × sourceWidth
                       = sourceWidth × (sourceLength − cutLength)
```

So after both splits the source label is left at **unchanged width,
length − cutLength** — never a changed width — and
`cutArea + sideRemnantArea + remainingSourceArea == sourceArea` exactly (up to
float rounding), which is also what `quantityInStock` on the three labels sums
to after the two `splitSerializedInventory` calls, since that mutation moves
quantity rather than recomputing it independently.

## 5. Moving an inventory label to a bin

**Exposed.** Same `updateSerializedInventory` mutation, just the
`warehouseLocationId` field: `updateSerializedInventory({ inventoryId, warehouseLocationId })`.
Also settable inline as part of a split's `warehouseLocationId` (the new label
lands in the target bin at creation, no separate move call needed for split
outputs). Resolve a bin id from a human-readable name (e.g. `REMNANT_BIN_NAME`)
via `Query.warehouseLocations(locationCode: "<name>")`.

## 6. Printing a label

**Not exposed as a direct API endpoint, and not a URL-addressable page either
— corrected from an earlier wrong guess in this document.** Searched the full
schema for `print`/`label`/`pdf` fields; found only `CustomLabelConfigurations`
/ `CustomLabelConfigurationDetails` / `LabelDetails` (label **template
configuration**, not a render/print action) and three unrelated PDF generators
(`generateSalesOrderPdf`, `generatePurchaseOrderPdf`, `generateQuotePdf` — SO/
PO/quote documents, not inventory labels). There is no
`printSerializedInventoryLabel` or equivalent, direct or indirect.

**How Digit actually prints a label (confirmed by the user, not discoverable
via the API):** the label is rendered client-side inside Digit's own SPA and
the browser print dialog is fired from a **"Reprint label" button on the
serialized inventory record's drawer**. The URL never changes — it's always
`https://app.digit-software.com/operations/inventory/serialized` — the drawer
is opened by selecting the record inside that page, not by a deep link per
record. So there is no per-record URL to construct, correct or otherwise.

**Resolved path:** this module cannot open a specific record's print view or
trigger printing itself. The post-commit UI instead:
- Opens the serialized inventory list (`DIGIT_APP_BASE_URL` +
  `/operations/inventory/serialized`) in a new tab.
- Shows the new labels' **scancodes** prominently with a copy-to-clipboard
  button (the value the operator needs to find the record — see barcode
  finding below).
- Displays a plain-language instruction: *"Find the label above in the list
  that just opened, then click Reprint label."* Labeled honestly as a manual
  step — the UI never implies the app printed anything.

## Barcode vs. Label # (live finding from a physical label)

The barcode on a printed label encodes the **scancode** string
(`scanCodeSerialNumber`, e.g. `rcv_17873313121232`; other origins carry
`splt_`, `job_`, or `mi_` prefixes per the live samples above), which is
**distinct** from the human-readable **Label #** shown on the label
(e.g. `Label #32` — this is `Inventory.scanCodeNumber`, a plain int).

- **Scanner input must resolve against `scanCodeSerialNumber`** (via
  `fetchBySerialNumber` / `inventory(scanCodeSerialNumber: ...)`), not
  `scanCodeNumber` — the barcode never encodes the Label # digits alone.
- The manual search fallback should accept either: try `scanCodeSerialNumber`
  exact match first, then fall back to `scanCodeNumber` (parsed as int) or a
  free-text `inventories(search: ...)` call for item-name search.
- The source card and the post-commit scancode display both show **both**
  identifiers — scancode (primary, copyable) and `Label #{scanCodeNumber}`
  (secondary, human-readable) — so the operator can cross-check against the
  physical label either way.

## Supporting findings (used across steps 5–7 of the build)

- **Cutting queue source:** `Query.operations(search: "Cut to Size")` resolves
  the operation id (live-confirmed: `"Cut to Size"` exists, `operationStatus: active`).
  `Query.workOrders(operationIds: [id], statuses: [NOT_STARTED, IN_PROGRESS], connection, order)`
  returns the queue. Live-tested against real data (4 matching work orders).
  `WorkOrder` has no direct MO/SO/ship-date fields; those come from
  `WorkOrder.job` → `Job.jobNumber`/`documentNumber`/`targetQuantity`/`item`/`notes`
  → `Job.salesOrder` → `Order.orderNumber`/`requestedDeliveryDate`/`customer.name`.
- **Ship-by date:** the spec calls for sorting the queue by ship-by date. The
  server-side `WorkOrdersOrderInput.by` enum (`WorkOrdersOrderBy`) has no option
  tied to the sales order's `requestedDeliveryDate` (only job-level
  `moTargetComplete` etc.). The queue route fetches unsorted-by-ship-date and
  sorts client-side (backend route) by `job.salesOrder.requestedDeliveryDate`
  ascending, nulls last (jobs without a linked SO, as seen live, sort to the end).
- **BOM component matching:** `Job.bom.items(connection): BomItemsConnection` →
  `nodes: [BomItem!]` with `{ item { id name } }`. Live-confirmed shape. Compare
  the scanned roll's `item.id` against these to warn on a mismatch.
- **Serial scan resolution:** `Query.fetchBySerialNumber(input: { serialNumber }): FetchBySerialNumberResponse!`
  → `result` is a union of `Inventory | WarehouseLocation` (a scanner could pick
  up either a roll's serial or a bin label by mistake) — the route checks
  `__typename` and only accepts `Inventory`. Manual search fallback uses
  `Query.inventories(search: term, connection: { first: 20 })`.
- **Units confirmed live:** the roll items (`Heirloom / Meadow`, etc.) are
  `trackingMethod: serialized` with `defaultStockUom.name: "Square Feet"` —
  matches the domain's ft² quantities.
