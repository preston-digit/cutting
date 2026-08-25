# Handoff — Cutting module (Digit ERP), label printing feature

You are continuing work on `preston-digit/cutting`, a Digit ERP module at `~/Sites/cutting` (local path) that fabricates rugs cut from serialized carpet roll goods, integrating with Digit's GraphQL API. This handoff exists so you can pick up cold without re-deriving decisions already made or re-breaking constraints already established. Read this fully before touching code.

## Stack and layout

React (Vite) frontend, Node.js (Express) backend proxying Digit's GraphQL API through allowlisted server-side operations, PostgreSQL for local-only data (never a copy of Digit data — references + audit trail only). Docker Compose for local dev.

```
backend/
  src/
    core/           digit.js (GraphQL client), db.js (pool + migration runner)
    features/cutting/
      digitOps.js       named Digit GraphQL operations — the ONLY way this app talks to Digit
      dimensions.js     parseDimensionText / formatFeetInches / roundDecimalFeet (unit tested, no Digit dependency)
      dimensions.test.js
      routes.js         Express router — all HTTP endpoints for this feature; also where this
                         feature's config constants live (LABEL_NAME, ALLOW_PRINTLESS_COMMITS,
                         WORKING_PIECE_TYPE) — put new cutting-wide config here, not inline
      labelTemplate.js  reads Carpet-Roll-Tag's layoutJson from Digit (READ ONLY, cached, short TTL)
      labelRenderer.js  walks the Fabric.js object list, resolves bindings, rasterizes to canvas
      barcode.js        live barcode generation (bwip-js), isolated symbology/value config
      print/
        artifact.js     canvas(es) -> PDF/PNG bytes; renderLabelPdf() does multi-page, exact
                         label-sized pages, zero margin, PDF Title metadata — no vector reimplementation,
                         it's the same PNG raster embedded per page
        sink.js          PrintSink interface: ArtifactSink (preview/download only), BrowserPrintSink
                         (DEFAULT — hands bytes to the frontend for the OS print dialog),
                         NetworkPrinterSink (stub, throws "not implemented", selectable only via a
                         station with a printer address — currently unreachable, see below)
  db/migrations/    0001-0006, applied in order on startup (0005 print_stations, 0006 print status cols)
  scripts/
    smoke-cut.js               regression check — real commit against live backend + Digit + cut_events
    reset-demo-data.js         dry-run-by-default cleanup for accumulated test artifacts
    migrate-dimension-units.js dry-run-by-default linear-unit migration for Roll Length/Width
frontend/src/features/cutting/
  CutScreen.jsx     the main screen: scan/search, cut entry, available material, commit checklist.
                    NO station picker — removed entirely, see constraint 8.
  History.jsx       cut_events audit trail + Reprint action (same print pipeline as commit, no station)
  printPdf.js       printPdfBase64() — opens a base64 PDF via a hidden iframe + window.print(),
                    used by both CutScreen's commit flow and History's reprint
  units.js          display formatting (formatArea, formatDimsFeetInches, etc.)
  api.js            typed fetch helpers, one per backend route
SCHEMA_NOTES.md      the living record of every Digit schema fact this app depends on — READ THIS
README.md            setup, smoke test, reset-demo-data, migrate-dimension-units docs
```

**Before writing any code that touches Digit, read `SCHEMA_NOTES.md` in full.** It records every GraphQL type/field/mutation this app depends on, how each was confirmed (introspection + live query), and the reasoning behind every non-obvious architectural choice below. Treat it as more authoritative than your own assumptions about what Digit's schema looks like — verify against it live before trusting a memory of "what the schema has," and before trusting a memory of what THIS APP already does — see the rounding-fix story in constraint 11.

## Non-negotiable constraints (violating any of these is a regression, not a judgment call)

1. **This app is the sole keeper of a roll's linear dimensions.** Digit's `Inventory.quantityInStock` is a single scalar area; `splitSerializedInventory` moves that area between labels without ever touching `Roll Length`/`Roll Width` custom fields. Every commit step that splits a label is immediately followed, in the same operation, by a dimension write for that label — never split without writing dimensions in the same commit.
2. **Canonical unit-basis rule**: `Roll Length`/`Roll Width` carry no unit metadata of their own and none will ever be added. A bare number in these fields is always denominated in the linear unit implied by the item's `defaultStockUom`, via the single mapping table `AREA_UNIT_TABLE` in `digitOps.js` (`deriveLinearUnitSymbol` for display, `requireLinearUnit` — throws — at the geometry boundary). **Never write a unit string into a dimension custom field.** Decimal feet (or decimal-whatever-linear-unit) is the sole internal representation, even though the UI accepts/displays feet-and-inches (see `dimensions.js`) — that conversion happens only at the display/input boundary, never stored.
3. **No write path into a label template's `layoutJson` exists, and none may be added.** `labelTemplate.js` only ever runs a `query`. Editing `Carpet-Roll-Tag` (or any `CustomLabelConfigurationDetails`) is a human action in Digit's own Label Designer UI. If you ever find yourself writing a mutation involving `CustomLabel*` — stop, that's out of scope by design.
4. **Never run `migrate-dimension-units.js` with `--confirm` unless explicitly asked.** The org is currently `ft²` throughout. This script exists and works (dry-run verified against real org data) but executing it is a real, hard-to-reverse Digit write across every in-stock label of the named item(s).
5. **The barcode on a printed label must never be the template's frozen raster.** `Carpet-Roll-Tag`'s own `barCode` object in `layoutJson` is a PNG snapshot from whenever the template was last saved in Digit's Designer. `labelRenderer.js` always calls `barcode.js`'s `generateBarcodePng()` live; never read `obj.src` for a `stampType: "barcode"` object.
6. **Sufficiency is dimensional, never area-only.** `scorePiece()` in `routes.js` returns `sufficient` as strictly `true`/`false`/`null` — `null` means "cannot verify" (unknown piece dims, or only an area target resolved, e.g. from BOM `quantityPerUnit`). An area match alone must never render as a confident "Sufficient" badge; it sorts into the cannot-verify tier (2), never the sufficient tier (0). Single shared predicate — don't reimplement in the frontend.
7. **A print failure must never roll back or invalidate a completed cut, and must never be framed as "needs manual repair in Digit."** Printing happens last in the commit checklist, after every inventory operation has already succeeded. If it fails, the fix is "reprint from History" (`POST /history/:id/reprint`), never a Digit data repair.
8. **BrowserPrintSink is the only live print path — there is no station picker anywhere in the UI.** `resolveSinkForStation()` defaults to `BrowserPrintSink`; a station only matters if it has a `printerAddress`, which switches it to `NetworkPrinterSink` — but nothing in `CutScreen.jsx` or `History.jsx` reads/writes a `stationId` anymore, so that branch is currently unreachable from the app. **Do not re-add a station picker or a "select a station before committing" gate without being asked.** The `print_stations` table, its `/stations` GET/POST routes, `NetworkPrinterSink`, and the backend's `getStationById()` helper are deliberately kept (not deleted) so a real network printer can be wired back in later by reintroducing a `stationId` param — see routes.js's comments at the top of the "Print stations" section and in `print/sink.js`.
9. **A commit is blocked before any split/write if the item has no resolvable label template.** `ALLOW_PRINTLESS_COMMITS` (env var, default `false`/unset) is the only sanctioned bypass, for an org that genuinely doesn't print. Checked once, up front, against `source.item` — never silently no-op a print step for the default case. See routes.js right after `requireLinearUnit(source.item)`.
10. **Working piece + remnant are one print job, not two.** A commit combines both labels into a single multi-page PDF (one page per tag, via `renderLabelPdf()`) through one `sink.deliver()` call, so the operator confirms one print dialog. Reprint is the exception — it's always a single label, single-page PDF, by design (reprinting one lost/smudged tag shouldn't reprint its sibling too).
11. **PDF page setup is exact and undecorated.** Each page is sized to exactly the template's own `labelWidthIn`×`labelHeightIn` (4"×6" for Carpet-Roll-Tag today, but always read from the live template, never hardcoded), zero margin, PDF `Title` metadata set to something useful. **The frontend must always open the rendered bytes as a real `application/pdf` blob resource (see `printPdf.js`'s hidden-iframe approach) — never wrap it in an HTML page.** Chrome's default page decoration (title/URL header, date/page-number footer) only applies to HTML-page printing; printing an actual PDF resource never gets it. This was empirically confirmed by decoding a real rendered PDF's `/MediaBox` and content streams (image-draw operator only, no text-drawing operators at all).
12. **The working piece's printed "Quantity" is the cut area, not `quantityInStock`.** `pickJobItem` zeroes the working piece's live quantity (it now lives on the job) — printing that would read "Quantity 0" on a piece that's physically the full cut area. `renderLabel()` takes an optional `quantityOverride`, used only for the working piece (commit flow: the commit's own `cutArea`; reprint: `cut_events.cut_area`). **The remnant never gets an override** — it's a real, un-picked label and must always show its own live quantity.
13. **The printed tag must use RAW, unstripped custom-field values — never `readInventoryCustomFields()`'s cleaned map.** `readInventoryCustomFields()` strips a redundant field-name prefix some custom field values carry (e.g. `"Piece Type: Remnant"` → `"Remnant"`) for screen display. Digit's own Reprint of the same template shows the raw stored value verbatim. `labelRenderer.js` uses `rawCustomFieldValue(inventory, fieldName)` (digitOps.js) for every custom-field text binding — screen display is untouched and still goes through the stripped version. Don't let these two paths merge back together.
14. **Every dimension write goes through `roundDecimalFeet()`** (dimensions.js, 4 decimal places) inside `writeInventoryDimensions()` (digitOps.js) before stringifying. Plain JS float arithmetic on decimal feet routinely produces noise like `13.299999999999999`; this was **not actually fixed** the first few times it looked like it should have been — verify live data (`Roll Length`/`Roll Width` on a real record) before assuming a "should already be fixed" claim is true.
15. **Physical cut order is crosscut-then-rip** (confirmed with the customer): the operator takes the full-width piece at `cutLength` off the roll first, then rips `cutWidth` from that piece — so a side remnant is only `cutLength` long, and the parent roll's remaining length always decreases by the full `cutLength` regardless of how narrow `cutWidth` is. Its width is unchanged no matter what. Mirrored identically in `routes.js`'s commit handler and `CutScreen.jsx`'s `cut` useMemo — keep them in sync if you touch either.
16. **The working piece's `Piece Type` is `"Cut Rug"` (`WORKING_PIECE_TYPE` constant in routes.js), not `"Cut Piece"` and not `"Finished Rug"`.** Digit auto-generates its own separate finished-good serialized label when the MO's last work order step completes — the label this module creates is that job's INPUT, never the finished output, so it must not read as finished. The remnant is unaffected, still hardcoded `"Remnant"`. **Before writing any new `Piece Type` (or any enum/option) value, fetch the live option list and confirm the exact string exists — `getPieceTypeOptionId()` throws on an unrecognized one, but check first anyway and report before writing.**
17. **Never guess scope on a destructive/migratory script.** Both `reset-demo-data.js` and `migrate-dimension-units.js` are dry-run by default, require `--confirm` to execute, and require explicit ids/scope on every invocation — no "act on everything" mode exists or should be added.

## Domain model quick reference

- **Digit GraphQL**: single endpoint, server-side bearer token (`backend/src/core/digit.js`). Frontend never sends GraphQL directly. **`__schema` introspection queries ignore the requested selection set and always return the entire schema** — harmless, but don't assume a narrow introspection query got a narrow response; it's the full ~900KB dump every time.
- **`Item.defaultStockUom`**: `{symbol, name, type}`. Roll goods report `{symbol: "ft²", type: "area"}` today; org intends an eventual move to `yd²` (not yet done, not to be triggered unless asked).
- **Required-cut resolution chain** (`resolveRequiredCut()`): operator-entered width/length → item-name `"WxL"` regex parse → BOM `quantityPerUnit` as an area-only fallback → nothing. Only the first two produce a real dimensional target.
- **`cut_events` / `scan_attempts` / `print_stations` Postgres tables**: local audit/config only, Digit is the source of truth for everything else. `cut_events.print_station_id` is now always `null` (see constraint 8); `working_piece_print_status/error` and `remnant_print_status/error` are set together as one pair since printing is one combined job now — both `"printed"` or both `"failed"` with the same error, never split.
- **Label template**: `Carpet-Roll-Tag`, a `manual_inventory`-type `CustomLabelConfigurationDetails`, reachable ONLY via `Item.defaultCustomLabelConfigurations.manualInventory`. **Live coverage gap, last audited 2026-08-24**: of 24 true roll-goods items (area-uom, serialized), 18 resolve a template (all of Finch-OCEAN, HANNA, and — confirmed fixed — all of Heirloom including the previously-broken `Heirloom / Wrought Iron`). **6 still don't**: `Astoria Mink` and the whole `BAJA TEST` item family (+4 color variants). Neither currently has any live inventory, so this hasn't bitten yet, but the commit-time gate (constraint 9) will block a cut on any of them the moment they're stocked, until Digit-side config is added.
- **`Piece Type` (singleSelect) live options**: `Mill Roll`, `Cut Piece`, `Remnant`, `Finished Rug`, `Cut Rug` (ids in SCHEMA_NOTES.md). **No code anywhere filters candidate/available-material stock by Piece Type** — this was explicitly audited: `scorePiece()` doesn't read it, the remnant-first sort tie-break only special-cases the literal string `"Remnant"`, and the live Digit queries behind both available-material and scan/search have no Piece Type filter at all. **A `"Cut Rug"` piece (like a `"Cut Piece"` piece before it) shows up as selectable source stock for a future cut** — flagged, not changed, per explicit instruction not to touch that behavior yet.
- **Fabric.js layout rendering**: `labelRenderer.js` treats the template's `layoutJson` (Fabric.js canvas, `labelWidthIn`/`labelHeightIn`, `objects[]`) as live source of truth, walked at render time. DPI 96 (matches the Designer's own coordinate space). Known fidelity gaps: per-character `styles[]` overrides not applied; only `left`/`top` and `center`/`center` origin combos handled. Font is DejaVu Sans (Alpine ships zero fonts by default — registered via the Dockerfile; rebuilding the image without that step gives silently blank label text).
- **Print pipeline, end to end**: `labelTemplate.js` (read layoutJson) → `labelRenderer.js` (`renderLabel()` → canvas, takes `quantityOverride`) → `print/artifact.js` (`renderLabelPdf()`, multi-page/title-aware) → `print/sink.js` (`resolveSinkForStation()` → `BrowserPrintSink` today) → routes.js's single `printLabels` commit step → PDF bytes streamed to the frontend as base64 in a `printPdf` NDJSON event (**deliberately NOT pushed into the `steps` array** — never persisted into `cut_events`, since reprint always re-renders fresh rather than storing bytes) → `printPdf.js`'s `printPdfBase64()` opens it via a hidden iframe pointed at a real `blob:` PDF URL and calls `.print()`.
- **Headless vs. headed browser testing quirk** (worth knowing before you "confirm" a print regression): `window.print()` on a PDF loaded in an iframe does not fire in headless Chromium (no PDF viewer plugin in headless mode) but does fire correctly in a real (headed) Chromium window. If you verify this pipeline with Playwright, run headed, not headless, or you'll chase a phantom bug.
- **Rendering dependencies**: `pdfkit` (pure JS, PDF), `bwip-js` (pure JS, barcode), `@napi-rs/canvas` (native, prebuilt Alpine/musl binaries).

## Verification commands (run these before claiming anything works)

```bash
# Unit tests (Node's built-in runner, zero extra deps) — 8/8 as of this handoff
docker compose exec backend node --test src

# Get a real, currently-open work order id (the one used in past sessions may have rotated out)
curl -s http://localhost:4001/api/cutting/queue

# Get a real source label with remaining Roll Length/Width for that item
curl -s -G "http://localhost:4001/api/cutting/search" --data-urlencode "q=<item name>"

# Smoke test — real commit against live Digit + local DB.
docker compose exec \
  -e SMOKE_WORK_ORDER_ID=<real, not-yet-completed WO id> \
  -e SMOKE_SOURCE_INVENTORY_ID=<serialized label with Roll Length/Width set> \
  -e SMOKE_CUT_WIDTH=<less than source width to get remnant path> \
  -e SMOKE_CUT_LENGTH=<less than source's remaining length> \
  -e SMOKE_REMNANT_BIN_ID=<a real bin id, only if remnant path> \
  backend node scripts/smoke-cut.js

# Frontend build check
docker compose exec frontend sh -c "cd /app && npx vite build"
```

**Important operational note**: the backend container runs `npm start`, not a `--watch` script. `backend/src`, `backend/db`, `backend/scripts` are bind-mounted so edits are picked up **on restart**, not live — run `docker compose restart backend` after any backend edit before testing, or you'll be testing stale code. `backend/package.json`/`Dockerfile` changes need a full `docker compose build backend`.

## What's built and working right now

- Feet-and-inches parsing/display, ratio-aware unit-mismatch detection, `resolveRequiredCut`/`scorePiece` tri-state sufficiency — all from earlier work, unchanged.
- Full label rendering pipeline through **BrowserPrintSink as the default and only live print path** — combined multi-page PDF per commit (one dialog for both tags), exact 4×6in pages with zero margin/no header-footer/page-number, PDF Title metadata, reprint using the identical pipeline for a single tag.
- Pre-flight label-template gate blocking a commit before any Digit write (constraint 9), with `ALLOW_PRINTLESS_COMMITS` as the only sanctioned bypass.
- Working piece's printed Quantity correctly shows cut area (not the post-pick zero); remnant unaffected.
- Printed tag matches Digit's own Reprint field-for-field (raw, unstripped custom field values).
- `roundDecimalFeet()` wired into the one write funnel — verified live that Digit's own mutation-response echo now shows clean values (e.g. `"9.9"`, not `"9.899999999999997"`).
- Station picker fully removed from the UI; confirmed via a real headed-browser Playwright run that no station is selected, passed, or required anywhere in the commit/reprint path, and that `window.print()` actually fires with both tags in one PDF.
- Working piece `Piece Type` is `"Cut Rug"` (verified against live Digit option list before writing), remnant still `"Remnant"` — downstream audit confirmed and documented that nothing filters candidate stock by Piece Type (a pre-existing gap, not introduced or fixed by this change).
- All of the above verified repeatedly: 8/8 unit tests, 19/19 and 15/15 smoke checks (both paths), multiple real commits against live Digit with rendered PDFs decoded and eyeballed, a real headed-browser end-to-end run.

## Suggested next steps (not started, your call whether/how to pursue)

- Real printer protocol for `NetworkPrinterSink` (ZPL over raw TCP socket is the likely fit) — still stubbed, throws a clear "not implemented" error. The table/routes/helper it needs are all still in place (constraint 8).
- `Astoria Mink` / `BAJA TEST` family still have no `manualInventory` label config in Digit — worth a spot check once that's fixed org-side (nothing here needs to change, the gate will just stop blocking them).
- Whether `Piece Type` should ever exclude a piece from being re-selected as source stock (e.g. `"Cut Rug"`/`"Finished Rug"` shouldn't be re-cut) is an open, explicitly-not-yet-addressed question — see the domain model note above.
- `History.jsx`'s dimension columns still render in decimal feet, not feet-inches.
- No station-management UI beyond the raw `POST /stations` endpoint — moot for now since the operator flow never touches stations at all.

## Style/process notes specific to this collaborator

- They read `SCHEMA_NOTES.md` as the authoritative log and expect it kept current — add new findings there with the date and method, the same way every prior entry was recorded.
- They explicitly enumerate constraints up front and expect literal compliance — when a task says "do not change X," that's read strictly (an entire task was scoped around "don't touch screen display, printed tag only"). Call out in your final report if a constraint created a real conflict rather than silently working around it.
- **"Confirm X is already in effect" is not a formality — check it for real, and say so plainly if it isn't.** The rounding fix was assumed-fixed and wasn't; caught it by reading the actual write-path code and live data before reporting back, rather than assuming a prior claim was true.
- Before writing any enum/option value to Digit, fetch the live option list and confirm the exact string exists first — this is now an established practice (Piece Type: Cut Rug), not a one-off.
- They ask for verification as a first-class deliverable — real command output, real IDs, real before/after numbers, real decoded PDFs (page count, `/MediaBox`, rendered PNGs), not descriptions of what a test would show. Report findings even when they're not what was asked for, rather than smoothing them over.
- When asked to centralize a config value ("put it with the other config, not inline in multiple files"), look for where this feature already keeps such constants (routes.js, alongside `LABEL_NAME`/`ALLOW_PRINTLESS_COMMITS`) rather than inventing a new location.
