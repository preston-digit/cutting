# Digit GraphQL schema notes — cutting module

Introspected live against `DIGIT_API_URL` (`https://api.digit-software.com/graphql`)
using the org's real `DIGIT_API_TOKEN` on 2026-08-21. Every operation below was
confirmed to exist in the introspected schema; queries (not mutations) were also
run against live data to confirm shapes — mutations were **not** executed against
live records during this investigation, to avoid touching real inventory/work
orders before the app exists to use them correctly.

No blockers found. All six capabilities are exposed except label printing, which
is UI-only (flagged below, not faked).

## Core architecture: this module is the sole keeper of dimensional truth

Digit's inventory quantity for a serialized roll is **ft² only** —
`Inventory.quantityInStock` is a single scalar area. `Roll Length` and
`Roll Width` exist **solely** as this org's custom fields; Digit has no native
concept of a roll's linear dimensions, and `splitSerializedInventory` moves
`quantityInStock` between labels **without touching either label's dimension
custom fields at all** (confirmed by the mutation's own input/output shape in
§1 — it takes `quantityToSplit`, nothing about width/length).

That means **every label this module creates or shortens carries a
Digit-native area that's correct automatically (the split mutation handles
that), but dimensions that are correct only if this module writes them** — and
if it doesn't, in Digit's eyes a label just has an area with no length/width
at all, silently wrong for every rug cut from it downstream. Consequently:

- Every commit writes dimensions to **all three** affected labels in the same
  operation that moves their quantity — the working piece, the side remnant
  (when one exists), and **the source label itself**, not just the two new
  ones. The source's area changes via the split call; its `Roll Length` must
  change in the same commit or it silently goes stale (still says the old,
  now-wrong length).
- This is enforced in code, not left to the operator to remember: the commit
  step that performs a split is always immediately followed, in the same
  step group, by the dimension write for that label — see Step 4/6 build
  notes for the exact call sequence and the partial-failure reporting this
  requires (a split can succeed while its paired dimension write fails, and
  the UI must say so explicitly rather than silently leaving a label
  area-correct-but-dimension-stale).
- Because Digit itself has no way to detect a dimension/area mismatch (it
  doesn't relate the two), this module also validates on every scan: if the
  scanned label's `quantityInStock` disagrees with `rollLength × rollWidth` by
  more than 1%, that's a label whose dimensions drifted out of sync with its
  area — almost certainly because it was split by hand in Digit's own UI
  outside this module, bypassing the paired write above. The operator sees
  both figures and must explicitly confirm before cutting from it.

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

**Correction — the ~29 live roll labels surveyed below are all dummy/test data
entered during setup, not a real house convention.** The inconsistent
`"Length: 66.7 ft"` / `"Length 8 ft"` / blank formats are noise, not a
standard to match. **Decision: write bare numbers.** `Roll Length` and
`Roll Width` are written as plain numeric strings (`"66.7"`, `"15"`), no
label, no unit suffix, no colon. `Parent Roll` is written as the bare source
scancode (`"mi_1786932480681"`), not `"Parent: {scancode}"`.

Reads stay lenient regardless (strip anything that isn't part of a number and
parse the first float found) so pre-existing malformed/labelled records
(`"Length: 40 ft"`, empty strings, `"xxx"`) don't crash the source card or the
out-of-sync check below — only new writes are guaranteed clean.

**Canonical unit-basis rule (verification-pass finding, resolved as Option
A).** `Roll Length`/`Roll Width` carry no unit metadata of their own and none
will be added — a bare number in these fields is always denominated in the
linear unit implied by the item's `defaultStockUom` (ft for `ft²`, yd for
`yd²`, m for `m²`). This mapping lives in exactly one place,
`AREA_UNIT_TABLE` in `backend/src/features/cutting/digitOps.js`, read through
`deriveLinearUnitSymbol()` (display, best-effort) and `requireLinearUnit()`
(the geometry boundary — throws rather than assuming feet when an item's
`defaultStockUom` isn't in the table). Never write a unit string into a
dimension custom field under any circumstance — that would silently violate
this rule for every future reader that doesn't parse it out.

Before this was fixed, `deriveLinearUnitSymbol` was a string-stripping
heuristic (`"ft²" -> "ft"`) with no enforcement — a bare `3`/`6` written under
an org that later moved `defaultStockUom` to `yd²` would silently write
`cutArea = 18` as `18 yd²` (correct value: `2 yd²`), a 9× overstatement with
no self-consistency check able to catch it (the mismatch check compares two
numbers derived from the same unconverted inputs). `requireLinearUnit()` is
now called at the top of the commit route, before any split/write, and fails
the whole commit with a named-unit error if the item's stock UoM isn't
recognized — see `AREA_UNIT_TABLE` to add a new one. Migrating existing data
to a new linear unit (e.g. after an org-wide ft²→yd² UoM change) is a
deliberate, explicit, dry-run-by-default operation —
`backend/scripts/migrate-dimension-units.js`, same safety pattern as
`reset-demo-data.js` — never automatic, and it only rewrites `Roll
Length`/`Roll Width`; `quantityInStock` itself is Digit's own value under
Digit's own UoM and is out of scope for this script.

A stored `quantityInStock` that disagrees with `rollLength × rollWidth` by
more than 1% (`areaMismatch.outOfSync`, unchanged) is further classified: if
the ratio between the two lands within ~3% of a known unit-conversion square
(9 or 1/9 for ft↔yd, ~10.76 or its reciprocal for ft↔m — derived generically
from `AREA_UNIT_TABLE`, not hardcoded), it's flagged
`areaMismatch.probableUnitMismatch` and the piece is **not selectable** for a
cut in the UI (no override checkbox — this needs a data fix in Digit, not an
operator ack). Any other mismatch ratio (e.g. label #9 below, genuinely
~1,000 ft² off from bad seed data) keeps the existing generic out-of-sync
warning and stays selectable with an ack checkbox, since that's a data-entry
error, not a unit mix-up.

For reference, the raw distribution actually observed (dummy data, not a
convention to preserve):

| Roll Length values seen        | Roll Width values seen     |
| ------------------------------- | --------------------------- |
| `"Length: 66.7 ft"`              | `"Width: 15 ft "` (trailing space) |
| `"Length: 40 ft"`                | `"Width: 15ft"` (no space before unit) |
| `"Length: 100 ft"`               | `"Width: 15 ft"` (clean)    |
| `"Length: 10 ft"`, `"Length: 80 ft"`, `"Length: 50 ft"` | `"Width:"` (empty, ~4 records) |
| `"Length:"` (empty, ~4 records) | `"Width 5 ft"` (no colon, one `splt_` record) |
| `"Length 8 ft"` (no colon, one `splt_` record) | |
| `"xxx"` (one clearly-test record, `job_` prefix) | |

**Owner** is read-only display in this module (never written) — carrying
whatever inconsistent text is already on the source record isn't this app's
job to fix, and the spec never asks for it to write Owner.

**Read-side prefix stripping applies to every text-ish custom field, not
just Roll Length/Width.** Live-confirmed: `Owner` values are stored as
`"Owner: The Dixie Group"` and `Parent Roll` values as `"Parent:
mi_1786932480681"` — both redundantly repeat (a word of) the field's own
name as a prefix, same pattern as the Roll Length/Width noise above, just
without a trailing unit. `Piece Type`'s `singleSelect` **option values**
have this baked in even harder — the options themselves are literally named
`"Piece Type: Cut Piece"` etc. in this org's config, not something written
per-record. `readInventoryCustomFields()` (`backend/src/features/cutting/digitOps.js`)
strips a leading `"{field name}: "` or `"{any word of the field name}: "`
generically by field name rather than hardcoding per-field, so `owner` reads
`"The Dixie Group"`, `parentRoll` reads `"mi_1786932480681"`, and `pieceType`
reads `"Cut Piece"` — all prefix-free.

**A live 1,000 ft² area/dimension mismatch on label #9 (`mi_1787021264103`,
`Heirloom / Wrought Iron`) was investigated and is confirmed to be pre-existing
dummy data, not a parsing bug.** Direct query of the raw field showed
`Roll Length` stored as exactly `"89"` — no hidden/truncated leading digit.
The label's very first snapshot in this project (before this module ever
wrote to it) already showed `quantityInStock=500` against `Roll Length=100 ×
Roll Width=15 = 1500`, a 1000 ft² gap. That gap is invariant under this
module's own split+dimension-write pairing — every cut removes
`cutLength × width` from both the real quantity and the implied area
identically, so `impliedArea − quantity` never changes as a result of
correct writes. The area-mismatch warning is working as designed;
1,000 ft² of it is inherited from how the dummy data was originally seeded,
not introduced by a bug.

**Piece Type** (`singleSelect`) live option values, needed for step (c) of the
commit:

| option value              | id                                       |
| -------------------------- | ---------------------------------------- |
| `Piece Type: Mill Roll`     | `01a00b6a-8c59-75b6-83ba-a5f051a378d7`   |
| `Piece Type: Cut Piece`     | `01a00b6a-8c59-75b6-83ba-ab8ed28fc9d2`   |
| `Piece Type: Remnant`       | `01a00b6a-8c59-75b6-83ba-ac80a3d0f76c`   |
| `Piece Type: Finished Rug`  | `01a00b6a-8c59-75b6-83ba-b111a306b8e6`   |
| `Piece Type: Cut Rug`       | `01a0363d-1dd9-7248-a6a5-72ae6387fd1b`   |

The commit flow sets `fieldValueOptionId` = **Cut Rug** (`WORKING_PIECE_TYPE`,
routes.js — changed from **Cut Piece** 2026-08-24, see "Piece Type: Cut Piece
→ Cut Rug" below) on the working piece label, **Remnant** on the side-remnant
label (when created). The source label keeps its existing Piece Type
untouched (it's still the same mill roll, just shorter).

**Parent Roll** (`text`) is written on both new labels as the bare source
`scanCodeSerialNumber` (e.g. `mi_1786932480681`, no `"Parent: "` prefix — see
correction above).

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

### Confirmed physical cut order

**Confirmed 8/24/2026 from the customer's floor:** the operator crosscuts
the full-width piece at the requested `cutLength` off the parent roll
*first*, then rips the requested `cutWidth` out of *that* piece *second* —
not the other way around (ripping the width down the full remaining length
of the roll first, then crosscutting). This module's math encodes exactly
that order:

1. Crosscut the source roll at `cutLength` → a `sourceWidth × cutLength`
   piece comes free of the roll.
2. Rip that piece lengthwise at `cutWidth` → the `cutWidth × cutLength`
   working piece, plus a `(sourceWidth − cutWidth) × cutLength` **side**
   remnant (scrap the same length as the cut, narrower than the source).
3. The parent roll is now `sourceWidth × (sourceLength − cutLength)` —
   **unchanged width, shorter by the full `cutLength` regardless of
   `cutWidth`.** Even a very narrow working piece still costs the roll its
   entire crosscut length; there is no assumption that a narrow cut could be
   ripped off the roll's existing width without shortening it.

This was a real business-rule assumption, not just an implementation detail —
had the shop actually ripped the width down the roll's full remaining length
first and crosscut second, the remnant this module creates would have had
the wrong shape (a long, full-length offcut rather than a short,
cut-length-only side remnant), even though the *areas* would still reconcile
exactly either way (the math above is agnostic to cut order for area
purposes — only the remnant's implied length/width split depends on it). Now
that it's confirmed, the source label's dimension write must decrement
length only and never touch width, regardless of `cutWidth` — verified both
by the code (see the mirrored comment in
`backend/src/features/cutting/routes.js`, the authoritative implementation,
and `frontend/src/features/cutting/CutScreen.jsx`, the live preview) and by
`backend/scripts/smoke-cut.js`'s "source label's remaining dimensions
updated" check, which asserts `rollWidth` unchanged and `rollLength`
decremented by exactly `cutLength` after every commit.

## 4b. Live-discovered location constraints on split/pick (found building Step 4)

Two business rules surfaced only by actually running the mutations against
real (dummy) data — neither is visible in the schema shape itself:

1. **`splitSerializedInventory` and `updateSerializedInventory` both reject a
   `workCenter`-type `warehouseLocationId`.** Error text: `"Inventory can only
   be split to a bin location"` / `"Inventory can only be assigned to a bin
   location"`. Only `type: bin` locations are valid targets. A work order's
   own `WorkOrder.warehouseLocation` is typically a `workCenter` (e.g.
   "Fabrication Floor" in this org) — inventory can never be placed there
   directly.
2. **`pickJobItem` requires the inventory's bin to share the same `Address`
   as the job's `manufacturingLocationAddress`** — not to sit in the work
   order's specific `warehouseLocation`. Error text when it doesn't:
   `"Materials must be picked from the manufacturing location assigned to the
   MO."` `WarehouseLocation.address` gives each bin's address; multiple bins
   can share one address (in this org, `FAB-STAGING` shares "Warehouse 1 -
   Fabrication" with the "Fabrication Floor" work center; `WH2-RACK-*` bins
   belong to a different address, "Warehouse 2 - Storage", and are **not**
   pickable into this job even though they're valid split targets).

**Resolved path:** the commit flow resolves a bin via
`warehouseLocations(addressId: job.manufacturingLocationAddress.id, types: [bin])`
and splits the working piece directly into that bin — no separate "move"
step needed once the right bin is targeted from the start. This is
resolved fresh per job (not cached long-term), since different jobs can have
different manufacturing addresses.

**Does the remnant have the same address restriction? No — confirmed live.**
Split a test quantity to `WH2-RACK-A` (address "Warehouse 2 - Storage") from a
label whose job's manufacturing address is "Warehouse 1 - Fabrication" — it
succeeded with no error. The address constraint above is specific to
`pickJobItem` (because the working piece gets picked into the job); the
remnant is never picked into anything, so `splitSerializedInventory`'s only
requirement for it is `type: bin` — any bin, any address. **`REMNANT_BIN_NAME`
does not need to be under the job's manufacturing address** and can be a
purely physical/operational choice (wherever remnants are actually stored on
the floor), independent per-cut and unrelated to which job produced it.

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

### Re-investigated 2026-08-24 — still a blocking gap, this time with the full schema in hand

Re-ran the introspection specifically hunting for a print/label/document
action on serialized inventory (a cutting table producing two new labels per
cut is exactly the workflow this would matter most for). Pulled every field
on every type in the live schema and filtered for `print`/`label`/`pdf`/
`document`/`barcode`/`scancode` by name. Full result, for the record:

- **Query-side**: `documentNumberPrefix(es)`, `generatePurchaseOrderPdf`,
  `generateSalesOrderPdf`, `generateQuotePdf` — none touch inventory labels.
- **Type-side**: every `CustomLabel*`/`LabelDetails` field is **configuration**
  (`labelWidth`, `labelHeight`, `labelAlignment`, `showBarCode`, `layoutJson`,
  etc.) — i.e. what a label template *looks like*, never an action that
  *renders or emits* one for a specific inventory record. `Item.scanCodeSerialNumber`,
  `Inventory.scanCodeNumber`/`scanCodeSerialNumber`/`scanCodeCategory` are
  plain data fields, not print triggers.
- **Mutation-side**: zero matches for `print`/`label`/`pdf` of any kind.

This confirms (rather than merely repeats) the original finding: **there is
no `printSerializedInventoryLabel` mutation, no label-PDF/image query, and no
per-record deep link into Digit's own label UI, direct or indirect.** The gap
is real and this module cannot close it from its side — the manual
"scancode + open list + click Reprint" flow above stays as the working path.

**Blocking gap — recommended exact wording to raise with Digit's engineering
team:**

> We're building a cutting-floor module (via the GraphQL API) that creates
> two new serialized inventory labels per cut and needs to get them printed
> immediately, at the workstation, without the operator leaving our app. We
> introspected the full schema and found `CustomLabelConfigurationDetails` /
> `LabelDetails` (label template configuration) and `generateSalesOrderPdf` /
> `generatePurchaseOrderPdf` / `generateQuotePdf` (document PDFs unrelated to
> inventory), but no equivalent for a **serialized inventory label** — no
> `printSerializedInventoryLabel` mutation, no query that returns a rendered
> label (PDF/image/HTML) for a given `inventoryId`, and no stable per-record
> URL into the serialized-inventory list/drawer (it's always
> `/operations/inventory/serialized` with the record selected client-side,
> never `/operations/inventory/serialized/{id}` or similar).
>
> Could Digit expose either (a) a mutation/query that returns a
> print-ready label document for a given `inventoryId` (respecting the org's
> configured `CustomLabelConfigurationDetails` template), or (b) a stable
> per-record deep link that opens directly to that record's drawer with
> "Reprint label" one click away? Either would let integrations avoid a fully
> manual "open the list, find the record, click Reprint" step per label.

### Superseded — this app now renders and prints its own labels (2026-08-24)

Everything above in this section is still true as a statement about Digit's
API (no print/render mutation or query exists, confirmed twice) — but the
"Resolved path" it describes (open Digit's own serialized-inventory list,
copy the scancode, click Reprint by hand) is no longer what this app does.
`labelRenderer.js` now reads the live `layoutJson` itself and rasterizes it
directly (see "Label templates" section below), so the manual
copy-scancode-and-click-Reprint flow is gone from the UI.

**Printer models at this customer's stations are unknown**, so there's no
socket/ZPL client to write yet (`NetworkPrinterSink` stays a stub — see
`print/sink.js`). The default output path is instead `BrowserPrintSink`: the
backend hands the rendered PDF back to the frontend, which loads it as a
real PDF resource (not wrapped in any HTML page) and calls the browser's own
print() on it, so the operator picks whatever printer is physically at their
station in the native OS/browser print dialog. A commit's working-piece and
remnant tags are combined into a single multi-page PDF (one page per tag,
one `sink.deliver()` call) so the operator confirms one print dialog per
cut, not two.

**Finding worth keeping:** printing a PDF *as a PDF resource* (a blob URL
loaded directly, e.g. in a hidden iframe, then `.print()`'d) never gets
Chrome's default page decoration (title/URL header, date/page-number
footer) — that decoration is an HTML-print-only behavior. The
"document-shaped" printout ops had seen before this pipeline existed (a
timestamp+scancode header, a Digit URL footer, "1/1" page numbering) came
from printing Digit's own inventory-record HTML page, not from anything in
this app's PDF. As long as the frontend always opens the rendered bytes as
an actual `application/pdf` blob and never re-embeds them in an HTML
wrapper, the printed tag stays exactly the rendered artwork, edge to edge,
on a page sized to the template's own `labelWidthIn x labelHeightIn` (4"×6"
for Carpet-Roll-Tag) — verified by decoding a real rendered PDF's
`/MediaBox` (`0 0 288 432` = exactly 4"×6" at 72pt/in) and confirming its
page content streams contain only an image-draw operator, no text-drawing
operators at all.

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
- **Local audit trail as a backstop for Digit write failures:** `cut_events`
  stores the *parsed numeric* source/working-piece/remnant dimensions (not
  just the raw label text) alongside the raw Digit responses for each step.
  Given the sole-keeper-of-dimensional-truth architecture above, if a
  dimension write to Digit fails after its paired split succeeds, this local
  row is the only place the intended correct dimensions survive — it's what
  the "needs manual repair in Digit" checklist message points the operator
  (or a follow-up script) back to.

## Label templates — can the definition be read? (re-introspected 2026-08-24)

**Method:** full `__schema` introspection (all 755 types, every field/arg on
every type), grepped case-insensitively for `label|template|tag|print|zpl|
layout|format|barcode|design` against every type name AND every field name
across every type (not just `Query`/`Mutation` top-level fields, which is
where the earlier pass stopped short) — then, for every match, walked the
full field list of the matched types, cross-checked every OTHER type in the
schema for a field returning one of those types (to find how they're
reachable), and finally fetched a real live template by name to inspect its
actual contents. The full list of all 91 `Query` and all 107 `Mutation`
top-level field names was also dumped and read end-to-end to positively rule
out any render/print entry point outside the label-shaped names.

**Answer: yes, the definition can be read — fully, including layout, not
just metadata.** Type family: `CustomLabelConfigurationDetails` (plus
`CustomLabelConfigurations`, `CustomLabelAddressConfig`,
`CustomLabelOption`, `LabelDetails`, and enums `CustomLabelConfigurationType`
[`receiving`, `production`, `manual_inventory`, `customer`, `item`,
`container`], `CustomLabelConfigurationStatus`, `CustomLabelCustomFieldContext`
[`inventory`, `item`, `address`, `order`], `CustomLabelAlignment`,
`CustomLabelSpacing`). None of these are reachable from a top-level `Query`
field (confirmed by the full 91-name dump above) — the only reachable paths
in the whole schema are:
- `Item.defaultCustomLabelConfigurations: CustomLabelConfigurations!` → its
  `receiving`/`production`/`manualInventory`/`item` fields, each a
  `CustomLabelConfigurationDetails`.
- `Item.allowedProductionLabels: [CustomLabelConfigurationDetails!]!`
- `Shipment.defaultCustomerLabel: CustomLabelConfigurationDetails`

So a template is read by querying an `Item` (or `Shipment`) that references
it, not by id/name directly — there is no `Query.customLabelConfiguration(id)`
or equivalent. **"Carpet-Roll-Tag"** was found this way: scanned 37 items,
found it bound as the `manualInventory` config on every roll-goods item
checked (`Finch-OCEAN`, `HANNA`, `Heirloom`, and their color variants — id
`01a00b55-ee97-75a9-89f6-89ac26d341f2`), `isDefault: true`, `status: active`,
`type: manual_inventory`. (One roll variant, `Heirloom / Wrought Iron`,
came back with all four slots `null` and `allowedProductionLabels: []` —
config resolution is evidently per-item, not automatically inherited by
every variant of a parent item; not investigated further, out of scope here.)

**a) Layout — full element list with positions, not just metadata.** All of
`CustomLabelConfigurationDetails`'s structured fields (`labelWidth`,
`labelHeight`, `showLogo`, `options`, `shipTo`/`shipFrom`, `orgDetails`, etc.)
came back `null` for this template — the entire definition instead lives in
`layoutJson: String`, a serialized Fabric.js canvas (`"version":"1"`,
`labelWidthIn: 4, labelHeightIn: 6` — i.e. a 4"×6" label) holding an
`objects` array of 19 positioned elements, each with `left`/`top`/`width`/
`height`/`scaleX`/`scaleY`/font, etc. `CustomLabelConfigurationDetails`
appears to support two independent authoring paths — an older structured
builder (the `options`/`shipTo`/`labelWidth` fields, presumably what
`receiving`/`production`/`customer` types use) and a newer freeform
Designer format (`layoutJson`) that this org's `manual_inventory` roll tag
uses. Either way it's a real layout the string has to be parsed to use, not
a single flat metadata blob.

**b) Data bindings — three distinct kinds, all via `bindingKey`:**
- **Reserved native bindings** (no `customFieldId`): `orgLogo`, `orgName`,
  `item` (item name), `internalSku`, `lotNumber`, `quantity`
  (`quantityInStock`, previewed as `"360 lbs"` — a stale/generic sample
  value baked in at template-save time, not evidence this org's roll items
  use lbs; live roll items are `ft²`, confirmed elsewhere in this file),
  `createdDate`, `labelNumber` (`scanCodeNumber`), `barCode` (see (d)),
  `detailSerialNumber` (`scanCodeSerialNumber`).
- **Inventory custom fields**, `bindingKey: "cf_<customFieldId>"` with
  explicit `customFieldId` + `customFieldContext: "inventory"` +
  `fieldName`/`fieldLabel` echoing the field's own name.
- **Static design text** (`stampType: "customText"`), not bound to any
  record field at all — literal strings baked into the layout.

**c) Yes — all five of this module's custom fields are already on the
template**, bound by the exact same custom field ids this file already
documents (§ "custom field id resolution"): `Owner`
(`01a00b4b-7f58-75dd-8620-0dcb8509bbed`), `Parent Roll`
(`01a00b4f-d1b3-72ae-b94c-299110a9b2ad`), `Roll Width`
(`01a00b5f-69ca-75d8-ab1a-cc23201753de`), `Piece Type`
(`01a00b6a-8c41-75fe-86ea-8cbcbce11a92`), `Roll Length`
(`01a00d77-18d6-72bf-8e15-c1270c922619`) — matching ids already logged
above. **Consequence for the unit-basis work:** the "ft" appearing next to
Roll Length/Width on the printed tag is baked into the layout as two
`customText` objects (literal string `"ft"`), completely independent of
`Item.defaultStockUom` — migrating this app's dimension data to a new
linear unit (see the "Canonical unit-basis rule" section above) does
**not** update what the physical label prints next to the number. That's a
manual edit in Digit's own Label Designer UI, out of this app's reach
entirely (no mutation touches `layoutJson`).

**d) Barcode — present, but only as a pre-rendered raster, not a live
data-bound symbol.** One object has `stampType: "barcode"`, `type: "Image"`,
`bindingKey: "barCode"`, and a `src` that's a `data:image/png;base64,...`
PNG — i.e. `layoutJson` stores a bitmap snapshot of whatever the barcode
looked like at the moment the template was last saved in Digit's Designer,
not a symbology + value pair this API exposes structurally. The adjacent
text object immediately below it is `detailSerialNumber` (`"SN-891-001"` in
this preview) — strongly suggesting the barcode is meant to encode the
serialized inventory's detail/serial number, but that's an inference from
layout proximity, not something the schema states; **the symbology (looks
1D/linear from its aspect ratio, but can't be confirmed as e.g. Code128 vs.
Code39 from a raster alone) and the live encoded value are not readable via
GraphQL.** Whatever re-renders that image against a specific inventory
record's live serial number at actual print time is Digit's own frontend
logic, not exposed here.

## Label template binding — Inventory side (2026-08-24)

`Inventory` (the serialized-label type this module reads/writes) has no
field at all referencing a label template, config id, or print setting —
full field list checked. Template selection is modeled **per-Item** only
(`Item.defaultCustomLabelConfigurations` / `Item.allowedProductionLabels`)
and **per-Shipment** for customer-facing labels (`Shipment.defaultCustomerLabel`)
— there is no per-org, per-location, or per-inventory-record override
anywhere in the schema. Printing a specific roll's tag, wherever Digit's own
UI does it, must resolve the template through that roll's `Item`, not
anything stored on the `Inventory` record itself.

## Confirming the negative: no render/print path exists (re-confirmed 2026-08-24)

Still true, now confirmed exhaustively rather than by stopping at the first
miss. **Method:** dumped and read every one of the 91 `Query` and 107
`Mutation` top-level field names in full (listed below) — none is
label/template/tag/print/zpl/layout/barcode/format/design-shaped, and none
returns or accepts any of the `CustomLabel*` types identified above (checked
programmatically: every field on every one of the 755 types was scanned for
a return type anywhere in its type chain matching `CustomLabelConfigurations`,
`CustomLabelConfigurationDetails`, `CustomLabelAddressConfig`,
`CustomLabelOption`, `LabelDetails`, or `VariantTemplate` — the only hits
were the four `Item`/`Shipment` read paths listed above; zero mutations
anywhere touch them). Notably, Digit **does** have a working
render-to-artifact pattern elsewhere in the schema —
`generatePurchaseOrderPdf`, `generateQuotePdf`, `generateSalesOrderPdf` all
exist as real `Query` fields — which makes the *absence* of an equivalent
(`generateLabelPdf`, `printLabel`, `renderCustomLabel`, or similar) a
positive signal that it's genuinely not implemented for labels, not a gap
in how thoroughly this was searched. `layoutJson`'s embedded barcode being a
static raster (see (d) above) is consistent with this: there's no
API-reachable rendering step to have produced that image live from data —
it was saved as a bitmap by Digit's own Label Designer UI. **Label
printing/rendering, for this org's Digit instance, is UI-only — there is no
GraphQL query or mutation that renders a label, live-produces a barcode, or
returns a printable artifact for a specific inventory record.** This
finding required inspecting: the full type list (755 types) for
label-shaped names, the full field list of every matched type, the full
field list of every OTHER type for a reference to those types, the full 91
+ 107 top-level `Query`/`Mutation` name list, and the `Inventory` type's
full field list.

## Label-config coverage audit — org-wide (2026-08-24)

After the Heirloom family's `manualInventory` label config was fixed on
Digit's side, re-fetched every `trackingMethod: serialized` item in the org
(`Query.items(connection, trackingMethods: [serialized])`, paginated with
`ConnectionInput.after`/`endCursor` — `totalCount: 28`, one page) and read
`defaultCustomLabelConfigurations.manualInventory` on each. Note for anyone
re-running this: Digit's `__schema` introspection field ignores the
requested selection set and always returns the full schema regardless of
what subfields are asked for — harmless here, but don't assume a narrow
introspection query got a narrow response.

**Result: not fully uniform.** Two populations exist among the 28
serialized items:
- 4 items (`Custom Rug`, `Rug 2x3`, `Rug 5x8`, `Rug 8x10`, `Rug 9x12` — finished-good
  SKUs, `defaultStockUom.type: count`, symbol `ea`) are not roll goods at
  all — not cut from rolls, correctly have no config, out of this app's
  scope.
- 24 items are true roll goods (`defaultStockUom.type: area`, `ft²`, cut
  from serialized rolls). Of those, **18 resolve** a `manualInventory`
  config (id `01a00b55-ee97-75a9-89f6-89ac26d341f2`, "Carpet-Roll-Tag"):
  all of `Finch-OCEAN` (+5 color variants), `HANNA` (+4 color variants), and
  — confirming the fix — all of `Heirloom` (+5 color variants, including
  `Heirloom / Wrought Iron`, previously the one confirmed gap). **6 do
  not**: `Astoria Mink` and `BAJA TEST` (+4 color variants: AZURE, CIDER,
  FRENCH GREY, SPRING GREEN). The Heirloom fix took correctly, but the org
  is not uniform — these 6 are still-open gaps, not test noise (their
  `defaultStockUom` and `trackingMethod` are indistinguishable from the
  working items). Whoever owns the Digit-side config still needs to add
  `manualInventory` to `Astoria Mink` and the `BAJA TEST` item family. This
  app's commit-time gate (see routes.js's pre-flight check before
  `splitWorkingPiece`) will now correctly block a cut on any of these 6
  until that's done, rather than silently no-op the print step.

## Three label-render fixes, live-verified (2026-08-24)

**1. Working-piece tag was printing "Quantity 0".** `pickJobItem` zeroes
the working piece's `quantityInStock` (that quantity now lives on the job,
not the label) — `renderLabel`'s "quantity" binding was reading that
already-zeroed live value. Fixed with an explicit `quantityOverride` param
on `renderLabel` (see labelRenderer.js's `resolveNativeBinding`), used only
for the working piece, sourced from the commit's own `cutArea` (never
hardcoded). The remnant is a real, un-picked label and is never passed an
override. Live-verified on a real cut (label #93, cutArea 14.96 ft²): tag
now reads "Quantity 14.96 ft²"; the remnant (label #94) correctly still
reads its own live "Quantity 36.04 ft²".

**2. Printed tag was diverging from Digit's own Reprint of the same
template.** `readInventoryCustomFields()` strips a redundant field-name
prefix some custom field values carry (`stripFieldNamePrefix`, added for
screen display) — the renderer was reading through that same stripped map
(`dims.raw[fieldName]`), so "Piece Type: Remnant" printed as bare
"Remnant". Digit's own Reprint renders the raw stored value verbatim, no
stripping. Fixed by adding `rawCustomFieldValue(inventory, fieldName)` to
digitOps.js (reads `inventory.customFields` directly, bypassing
`stripFieldNamePrefix` entirely) and switching only the label renderer's
custom-field text path to use it. `readInventoryCustomFields` itself is
unchanged — screen display still gets the cleaned version.
Live-verified: "Piece Type" now renders exactly `Piece Type: Cut Piece` /
`Piece Type: Remnant`, matching the option's raw stored value
(`fieldValueOption.value`) field-for-field. **Correction to this file's
earlier "Owner: The Dixie Group" example** (§ "Custom field id
resolution"): that was true of whatever record it was originally checked
against, but is not universal — live-checked just now on labels #92/93/94
(`Heirloom / Slate`, tracing back to receiving record `rcv_17872842324827`),
`Owner`'s raw `fieldValueText` is plain `"Dixie Group"`, no prefix, no
"The". The fix is mechanism-based (print whatever is actually stored,
unstripped) rather than reconstructing a specific expected string, so it's
correct either way — this is a note for whoever next compares a rendered
tag against Digit's Reprint, so a plain "Dixie Group" isn't mistaken for a
regression.

**3. Rounding at the write boundary — was NOT actually in effect.** Despite
being asked to confirm it, there was no rounding anywhere in the
dimension-write path as of this check — `writeInventoryDimensions` did
`String(rollLength)` directly, and every call site computing
`sourceLengthAfter`/`remnantLength`/`remnantWidth` (routes.js) does plain
JS float arithmetic with no rounding. Live data already showed the
consequence pre-fix: item `Heirloom / Slate`, label #27
(`rcv_17872842324827`), had `Roll Length` stored as
`13.299999999999997`. Added `roundDecimalFeet()` (dimensions.js, unit
tested, 4 decimal places — far finer than any real roll measurement, so
this only ever removes IEEE-754 noise, never legitimate precision) and
wired it into `writeInventoryDimensions` — the single funnel every
dimension write goes through, rather than fixing each arithmetic call site
individually. Live-verified with a real fractional-source cut (same label
#27, cutWidth 4.4 / cutLength 3.4 against a 15×13.299999999999997 source):
Digit's own mutation-response echo confirms `fieldValueText` written was
exactly `"3.4"` (working piece), `"3.4"` (remnant), and `"9.9"` (source —
rounded from the raw `9.899999999999997`), not the previous noise pattern.
One residual cosmetic-only gap, left alone per this task's "don't touch
screen display" instruction: the commit checklist's own `detail` text for
the `writeSourceDimensions` step is built from the pre-round JS variable,
so it can still display something like "Roll Length=9.899999999999997" in
the UI even though the value actually written and echoed back by Digit is
the correctly-rounded `"9.9"` — a display-only string mismatch, not a data
correctness issue.

## Piece Type: Cut Piece → Cut Rug (2026-08-24)

**Why:** Digit generates its own separate serialized finished-good label
when the MO's last work order step completes. The label this module
creates at the cutting table is that job's INPUT, consumed by production —
never the finished rug — so its Piece Type must not read as finished.
"Cut Rug" describes what it physically is at creation and stays accurate
through production, unlike "Cut Piece" (ambiguous) or "Finished Rug"
(actively wrong).

**Verified live before writing anything** (this file's own stated
practice — never write an option value without confirming it exists):
re-fetched `Piece Type`'s option list fresh; `Piece Type: Cut Rug`
(id `01a0363d-1dd9-7248-a6a5-72ae6387fd1b`) is present — see the updated
table above. `getPieceTypeOptionId()` (digitOps.js) already fails closed
(throws) if a requested short label doesn't resolve to a live option id,
so this was never at risk of silently writing an invalid value even before
the live check.

**Change:** `WORKING_PIECE_TYPE` constant (routes.js, alongside `LABEL_NAME`/
`ALLOW_PRINTLESS_COMMITS` — this file's other cutting-wide config) is now
`"Cut Rug"`, used only for the working piece's `writeInventoryDimensions`
call. The remnant is unaffected — still hardcoded `"Remnant"` at its own
call site, untouched by this change.

**Downstream audit — what keys off the Piece Type string, and what changes:**
- `scorePiece()`'s sufficiency scoring (routes.js) never reads `pieceType`
  at all — dimensions only. Unaffected.
- The available-material sort's remnant-first tie-break
  (`a.pieceType === "Remnant" ? 0 : 1`) only special-cases the literal
  string `"Remnant"` — anything else (`"Cut Piece"` before, `"Mill Roll"`,
  and now `"Cut Rug"`) falls into the same "not preferred over an actual
  remnant" bucket it always did. Unaffected — a working piece never
  outranked a real remnant before this change and still doesn't.
- `getInventoriesForItems()`'s live query (`INVENTORIES_BY_ITEM_QUERY`,
  digitOps.js) — the query behind `/available-material` — filters only on
  `itemIds`, `trackingMethod: [serialized]`, and `minQuantityInStock: 0.01`.
  **No Piece Type filter exists, and never has.** So: **yes, a "Cut Rug"
  piece will appear in the available-material list as selectable source
  stock for a future cut** — but this is not a new behavior this rename
  introduces. A "Cut Piece" piece already appeared there identically before
  today; nothing about which pieces are candidate stock changes, only the
  text of the badge/value shown for them. If re-cutting a piece this
  module already cut is meant to be restricted, that's a separate,
  pre-existing gap (also true of the old "Cut Piece" value) — not
  addressed here per this task's explicit "do not change that behavior
  yet."
- `searchInventories()`/scan resolution (digitOps.js) likewise has no
  Piece Type filter — same conclusion, a scanned/searched "Cut Rug" piece
  is selectable as a source exactly as a "Cut Piece" one was.
- Frontend badge (`CutScreen.jsx`'s available-material row) only
  special-cases `"Remnant"` for pill styling; anything else renders as a
  neutral pill showing the raw value. A future working piece's badge will
  read "Cut Rug" instead of "Cut Piece" — a value change, not a new code
  path.
