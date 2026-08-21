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

**Live data finding — format convention, not a schema constraint:** existing
`Roll Length` / `Roll Width` values in this org are stored as free text like
`"Length: 66.7 ft"` and `"Width: 15 ft "` (note trailing space in the sample),
not bare numbers. These are `text`-type custom fields with no numeric
validation, so the *app* owns the convention. **Decision:** to stay consistent
with existing records (in case anything downstream in Digit parses this text),
new/updated values are written in the same `"Length: {n} ft"` / `"Width: {n} ft"`
format, and read back by stripping the label/unit and parsing the float. This is
noted here per the "closest working path" instruction — flag if the team wants
a different convention.

## 5. Moving an inventory label to a bin

**Exposed.** Same `updateSerializedInventory` mutation, just the
`warehouseLocationId` field: `updateSerializedInventory({ inventoryId, warehouseLocationId })`.
Also settable inline as part of a split's `warehouseLocationId` (the new label
lands in the target bin at creation, no separate move call needed for split
outputs). Resolve a bin id from a human-readable name (e.g. `REMNANT_BIN_NAME`)
via `Query.warehouseLocations(locationCode: "<name>")`.

## 6. Printing a label

**Not exposed as a direct API endpoint.** Searched the full schema for
`print`/`label`/`pdf` fields on every type. Found only:
`CustomLabelConfigurations` / `CustomLabelConfigurationDetails` / `LabelDetails`
(label **template configuration**, not a render/print action), and three
unrelated PDF generators (`generateSalesOrderPdf`, `generatePurchaseOrderPdf`,
`generateQuotePdf` — sales order / PO / quote documents, not inventory labels).
There is no `printSerializedInventoryLabel` or equivalent.

**Resolved path:** per the spec's fallback instruction, the "print" buttons open
Digit's own UI in a new tab rather than faking a print via the API. The exact
Digit frontend URL pattern for a serialized-inventory record's print view isn't
discoverable from the GraphQL schema (it's a frontend route, not an API
concept), so it's made configurable rather than hardcoded: `DIGIT_APP_BASE_URL`
+ `DIGIT_INVENTORY_PRINT_PATH_TEMPLATE` (default
`/inventory/{inventoryId}/print`) in the backend env, used to build the URL the
frontend opens with `window.open(url, "_blank")`. **This template is a best
guess and needs to be confirmed/corrected against the real Digit UI** — flagging
prominently since it's the one piece not verifiable via the API.

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
