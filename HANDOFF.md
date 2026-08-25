# Handoff — Cutting module (Digit ERP), deployed, print pipeline just rebuilt

You are continuing work on `preston-digit/cutting`, a Digit ERP module at `~/Sites/cutting` (local path) that fabricates rugs cut from serialized carpet roll goods, integrating with Digit's GraphQL API. **This app is now live in production**, embedded in Digit's own UI at `app.digit-software.com`, backend on Heroku, frontend on GoDaddy cPanel. This handoff exists so you can pick up cold without re-deriving decisions already made, re-breaking constraints already established, or repeating incidents that already happened once. Read this fully before touching anything — especially the "Immediate next step" and "Incidents" sections below, which are the most likely things to bite a fresh session that skims.

## Immediate next step — check this first

The most recent deploy (PNG-based print pipeline, replacing the PDF/iframe approach) has been **pushed to both Heroku and the `deploy` branch, but the customer (Preston) had not yet run the cPanel "Update from Remote" pull and permission reset as of the end of the last session.** Before doing anything else:

1. Ask whether the pull has happened. If not, nothing below about "the print fix is live" is true yet for the actual customer-facing site — only the backend (Heroku) and the `deploy` branch (GitHub) have it.
2. Once confirmed pulled, re-run the permission fix in cPanel File Manager (see gotcha #2 in DEPLOY.md) — every fresh clone/pull has landed at `0700` so far; confirm whether this happens on every pull or only fresh clones (this was an open question at end of last session, never conclusively answered because the pull hadn't happened again yet to test it).
3. Then do a full Step-F/Step-G-style verification against the **real embedded Digit context** (not just the local sandbox-replica harness this was diagnosed and fixed against) — render a real label through the deployed, embedded app and visually confirm the print-preview modal shows PNGs correctly and a real print (or print-to-PDF) produces exact-size, zero-margin, two-page output. Everything below about the PNG print path is verified against a **local reproduction of Digit's sandbox**, not yet against the actual live embedded app post-deploy.

## Deployment — where everything lives

- **Backend**: Heroku app `cutting`, team `digit-software`, stack `heroku-24`. URL: `https://cutting-63d2bc51caef.herokuapp.com`. Deployed via `git subtree push --prefix=backend heroku main` (monorepo — Heroku only ever sees `backend/` as the root). Postgres attached (`heroku-postgresql:essential-0`). Full config var list, config-change process, and every gotcha hit along the way: **`DEPLOY.md` is the authoritative, up-to-date source — read it in full before deploying anything.** Do not follow this file's memory of deploy steps; DEPLOY.md was rewritten repeatedly to reflect what actually worked.
- **Frontend**: static build served from `https://digit-software.app/cutting/app/` via cPanel's Git Version Control feature, pulling from this repo's `deploy` branch (an orphan branch — build output only, `index.html` + `assets/`, no source, no `.gitignore`, no `.env`). `VITE_API_URL` is baked in at build time (currently the Heroku URL above) — changing the backend URL means a full rebuild + recommit to `deploy` + a fresh cPanel pull, no way around it.
- **Embedding**: this app runs both standalone (`digit-software.app/cutting/app/` directly) and embedded inside Digit's own UI via an `<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads">`. **The sandbox is confirmed, not assumed** (read directly from Digit's DevTools) — no `allow-popups-to-escape-sandbox`. This is load-bearing for the print pipeline; see below.
- **git remotes**: `origin` → GitHub (`main` = source, `deploy` = orphan build-output branch), `heroku` → Heroku's git endpoint (backend subtree pushes only).

## Incidents this session — read before running any tree-clearing command

**`.env` at the repo root was deleted twice**, by two different "safe-looking" commands, while building the `deploy` branch:
1. First: `find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +` — doesn't know about `.gitignore` at all, deletes everything including untracked-and-ignored files.
2. Second, trying to fix #1 the "git-native" way: `git rm -rf --cached .` + `git clean -fd` — this ALSO deleted `.env`, because `clean -fd` only respects `.gitignore` if a `.gitignore` file is actually present and tracked in the current branch's working tree — and the `deploy` branch, by design, has never contained `.gitignore` (it's build-output-only). No `.gitignore` in scope → `clean -fd` had nothing telling it to spare `.env`.

**The fix that actually works, now the standing method**: `git worktree add ../cutting-deploy deploy`, do all the clearing/copying inside that separate directory (which never contains `.env` at all — it's a different physical path from the main working tree), commit and push from there, then `git worktree remove ../cutting-deploy`. **Never run a bare recursive delete or `git clean` against the main working tree for this or any reason — use a worktree.** This is now documented as gotcha #3 in DEPLOY.md and has been used successfully for the two most recent deploys.

Both times, `.env` was manually recreated by the human (token re-entered from a source outside this session) — **do not attempt to reconstruct `.env` yourself, do not guess `DIGIT_API_TOKEN`, ask the human to set it and confirm only by checking string length, never by reading or printing the value.**

## Stack and layout

React (Vite) frontend, Node.js (Express) backend proxying Digit's GraphQL API through allowlisted server-side operations, PostgreSQL for local-only data (references + audit trail only, never a copy of Digit data). Docker Compose for local dev — **all local dev, including "smoke tests," hits the real live Digit org**, there is no sandbox/staging Digit environment.

```
backend/
  Procfile          web: npm start
  assets/fonts/     DejaVuSans.ttf, DejaVuSans-Bold.ttf, LICENSE — vendored (see constraint 18)
  package-lock.json committed — Heroku's buildpack runs npm ci against it, not npm install
  src/
    core/           digit.js (GraphQL client), db.js (pool + migration runner)
    features/cutting/
      digitOps.js       named Digit GraphQL operations — the ONLY way this app talks to Digit
      dimensions.js     parseDimensionText / formatFeetInches / roundDecimalFeet (unit tested, no Digit dependency)
      dimensions.test.js
      routes.js         Express router — all HTTP endpoints; also where this feature's config
                         constants live (LABEL_NAME, ALLOW_PRINTLESS_COMMITS, WORKING_PIECE_TYPE,
                         SOURCE_PIECE_TYPE_ALLOWLIST) — put new cutting-wide config here, not inline
      labelTemplate.js  reads Carpet-Roll-Tag's layoutJson from Digit (READ ONLY, cached, short TTL)
      labelRenderer.js  walks the Fabric.js object list, resolves bindings, rasterizes to canvas;
                         registers the vendored font at module load (GlobalFonts.registerFromPath)
      barcode.js        live barcode generation (bwip-js), isolated symbology/value config
      print/
        artifact.js     canvas(es) -> PDF/PNG bytes. renderLabelPdf() still exists (multi-page,
                         exact label-sized pages, zero margin) — kept for BrowserPrintSink/future
                         NetworkPrinterSink, but the FRONTEND no longer uses the PDF output (see
                         constraint 11, rewritten). canvasToArtifact(canvas, "png", {}) returns
                         the raw canvas PNG directly — this is what the frontend now uses.
        sink.js          PrintSink interface: ArtifactSink (preview/download only), BrowserPrintSink
                         (DEFAULT — hands bytes to the frontend), NetworkPrinterSink (stub, throws
                         "not implemented" — the real next step, see below)
  db/migrations/    0001-0006, applied in order on startup (0005 print_stations, 0006 print status cols)
  scripts/
    smoke-cut.js               regression check — REAL commit against live Digit + local cut_events.
                                No dry-run mode. Never run against production (no BACKEND_URL override).
    reset-demo-data.js         dry-run-by-default cleanup for accumulated test artifacts
    migrate-dimension-units.js dry-run-by-default linear-unit migration for Roll Length/Width
frontend/src/features/cutting/
  CutScreen.jsx     the main screen: scan/search, cut entry, available material, commit checklist.
                    NO station picker — removed entirely, see constraint 8.
  History.jsx       cut_events audit trail + Reprint action (same print pipeline as commit, no station)
  CuttingQueue.jsx  work-order queue list
  BarcodeScannerModal.jsx  camera barcode scanning — the model this session's print-modal design followed
  printPdf.js       printLabelPages() — REWRITTEN this session, twice. Shows rendered label(s) as
                    PNG <img>s in a visible modal, prints via our OWN window.print() + injected
                    @media print CSS. No PDF, no iframe, no contentWindow reference anywhere. See
                    constraint 11 (rewritten) for exactly why.
  units.js          display formatting (formatArea, formatDimsFeetInches, etc.)
  api.js            typed fetch helpers, one per backend route
docs/
  archive-candidates.md  Digit cleanup/audit list for the customer — 22 orphaned records, 5 smoke-test
                          labels, 3 shortened parent rolls, 2 REAL production cuts (WO145/MO25,
                          WO157/MO27). Append here, don't recreate — read cut_events directly for any
                          new entry, never assume values.
SCHEMA_NOTES.md      the living record of every Digit schema fact this app depends on — READ THIS
DEPLOY.md            the AUTHORITATIVE, current deploy runbook — 5 gotchas, full config var list,
                     the worktree method, everything. Rewritten multiple times to match reality;
                     trust this over your memory of "how deploy went."
README.md            setup, smoke test, reset-demo-data, migrate-dimension-units docs
```

**Before writing any code that touches Digit, read `SCHEMA_NOTES.md` in full.** It records every GraphQL type/field/mutation this app depends on, how each was confirmed, and the reasoning behind every non-obvious architectural choice below. Treat it as more authoritative than your own assumptions — verify against it live before trusting a memory of "what the schema has" or "what this app already does."

**Before deploying anything, read `DEPLOY.md` in full.** Same rule.

## Non-negotiable constraints (violating any of these is a regression, not a judgment call)

1. **This app is the sole keeper of a roll's linear dimensions.** `Inventory.quantityInStock` is a single scalar area; `splitSerializedInventory` moves that area between labels without ever touching `Roll Length`/`Roll Width` custom fields. Every commit step that splits a label is immediately followed, in the same operation, by a dimension write for that label.
2. **Canonical unit-basis rule**: `Roll Length`/`Roll Width` carry no unit metadata of their own. A bare number is always denominated in the linear unit implied by the item's `defaultStockUom` (`deriveLinearUnitSymbol`/`requireLinearUnit` in `digitOps.js`). **Never write a unit string into a dimension custom field.** Decimal feet is the sole internal representation; feet-and-inches conversion happens only at the display/input boundary.
3. **No write path into a label template's `layoutJson` exists, and none may be added.** `labelTemplate.js` only ever runs a `query`. Editing `Carpet-Roll-Tag` is a human action in Digit's own Label Designer.
4. **Never run `migrate-dimension-units.js` with `--confirm` unless explicitly asked.** Real, hard-to-reverse Digit write across every in-stock label of the named item(s).
5. **The barcode on a printed label must never be the template's frozen raster.** Always generated live via `barcode.js`'s `generateBarcodePng()`.
6. **Sufficiency is dimensional, never area-only.** `scorePiece()` returns `sufficient` as strictly `true`/`false`/`null` — `null` means "cannot verify," never a confident "Sufficient" badge from area alone.
7. **A print failure must never roll back or invalidate a completed cut, and must never be framed as "needs manual repair in Digit."** Printing is last in the commit checklist. Fix is "reprint from History," never a Digit data repair.
8. **BrowserPrintSink is the only live print path — no station picker anywhere in the UI.** `print_stations` table/routes/`NetworkPrinterSink`/`getStationById()` deliberately kept (not deleted) for a future real printer — see "Suggested next steps."
9. **A commit is blocked before any split/write if the item has no resolvable label template.** `ALLOW_PRINTLESS_COMMITS` (env var, default `false`) is the only sanctioned bypass. **Currently `false` permanently in production, per explicit instruction.**
10. **Working piece + remnant are one print job, not two.** One commit → one combined print action covering both tags (now: one `window.print()` call with both pages, via the rewritten `printPdf.js` — see constraint 11). Reprint is the exception — always a single label.
11. **REWRITTEN THIS SESSION — the print pipeline is PNG + `window.print()`, not PDF + iframe.** The original design (PDF rendered, opened in a hidden iframe, `iframe.contentWindow.print()` called) is **dead and must not be reintroduced.** Two failures, both confirmed directly, not assumed:
    - `iframe.contentWindow.print()`/`.focus()` threw a cross-origin error when this app runs embedded in Digit's sandboxed iframe, even with `allow-same-origin` present — reaching into a PDF-viewer's `contentWindow` crosses a process boundary the sandbox blocks regardless of tokens.
    - Even with that call removed (a visible, unscripted iframe), **Chrome refuses to instantiate its PDF viewer at all inside any sandboxed ancestor frame** — reproduced independently with a minimal harness matching Digit's exact sandbox list: a PDF-typed blob in a nested iframe is blocked every time ("This page has been blocked by Chrome"), while an identical `text/plain` or `image/png` blob loads fine. This isolates the cause to Chrome's PDF-viewer guest-view mechanism specifically. `window.open()` to a top-level tab hits the identical block (confirmed empirically) unless the opener's sandbox also has `allow-popups-to-escape-sandbox`, which Digit's doesn't.
    - **The fix, now live in `printPdf.js`**: backend sends each rendered piece as a PNG (`canvasToArtifact(canvas, "png", {})` — straight off the same canvas the PDF used to wrap, never rasterized from a PDF), frontend shows them as `<img>` elements in a visible modal, a **Print** button calls our own `window.print()` (same-document, zero cross-frame calls of any kind — confirmed zero `contentWindow` references in the file). A dynamically injected `<style>` sizes `@page` from the template's own `labelWidthIn`/`labelHeightIn` with `margin: 0`, hides all app chrome during print, and gives each page `page-break-after` so multiple tags print as separate pages from one click.
    - **Known, accepted limitation**: `@page` size/margin is a real guarantee but a narrower one than the old PDF path — an operator's print dialog set to "Fit to page" or a non-default paper size/scale can still override it. A PDF page's size couldn't be overridden that way. Not fixed, just known — flagged to the customer already.
    - `renderLabelPdf()`/`canvasToArtifact(canvas, "pdf", ...)`/`BrowserPrintSink` are all still intact in the backend, unused by the frontend now, kept for a future `NetworkPrinterSink`.
12. **The working piece's printed "Quantity" is the cut area, not `quantityInStock`.** `pickJobItem` zeroes the working piece's live quantity — `renderLabel()`'s `quantityOverride` covers this for the working piece only, never the remnant.
13. **The printed tag must use RAW, unstripped custom-field values** — `rawCustomFieldValue()`, never `readInventoryCustomFields()`'s cleaned map. Screen display stays on the stripped version. Don't merge these paths.
14. **Every dimension write goes through `roundDecimalFeet()`** before stringifying. Verify live data before trusting a "should already be fixed" claim about float noise.
15. **Physical cut order is crosscut-then-rip.** Side remnant is only `cutLength` long; parent roll's remaining length always decreases by the full `cutLength`. Mirrored in both `routes.js` and `CutScreen.jsx` — keep in sync.
16. **The working piece's `Piece Type` is `"Cut Rug"`** (`WORKING_PIECE_TYPE` in routes.js). Remnant is `"Remnant"`. Before writing any new enum/option value to Digit, fetch the live option list and confirm the exact string exists first — established practice, not a one-off.
17. **Never guess scope on a destructive/migratory script.** Both `reset-demo-data.js` and `migrate-dimension-units.js` are dry-run by default, require `--confirm`, require explicit scope.
18. **NEW — the DejaVu font is vendored in-repo (`backend/assets/fonts/`), not installed via `apk`.** Heroku's buildpack deploy never reads `backend/Dockerfile` — the dyno ships zero fonts, and without a font registered, printed labels render with **silently blank text**, no error anywhere. `labelRenderer.js` registers both weights at module load via `GlobalFonts.registerFromPath`. License (Bitstream Vera) confirmed to permit this. Don't reintroduce an OS-level font dependency.
19. **NEW — source-stock Piece Type is an allowlist, not a blocklist.** `SOURCE_PIECE_TYPE_ALLOWLIST` in `routes.js` = `Mill Roll`, `Remnant`, `Cut Piece`. Anything else — `Cut Rug`, `Finished Rug`, an unrecognized future value, or **no Piece Type set at all** — is excluded from available-material, scan, and search. A direct scan of a disallowed piece is refused with a 409 naming the piece type, not silently accepted (scan bypasses the list otherwise). Safe-by-default direction: new Digit option values are excluded until explicitly added, never implicitly allowed.
20. **NEW — deploying the `deploy` branch must go through a git worktree, never a bare recursive delete against the main working tree.** See "Incidents" above. `git worktree add ../cutting-deploy deploy`, clear/copy/commit/push inside that directory, `git worktree remove` after.

## Domain model quick reference

- **Digit GraphQL**: single endpoint, server-side bearer token. Frontend never sends GraphQL directly. `__schema` introspection ignores the requested selection set and always returns the full ~900KB schema.
- **`Item.defaultStockUom`**: `{symbol, name, type}`. Roll goods report `{symbol: "ft²", type: "area"}`.
- **Required-cut resolution chain**: operator-entered width/length → item-name `"WxL"` regex → BOM `quantityPerUnit` area-only fallback → nothing.
- **`cut_events` / `scan_attempts` / `print_stations` Postgres tables**: local audit/config only. Production Heroku Postgres currently has **exactly 2 rows** in `cut_events` — both real operator cuts, see `docs/archive-candidates.md` for full detail (WO145/MO25: source #22, working piece #141, remnant #142; WO157/MO27: source #11, working piece #145, remnant #146). Local dev Postgres has many more rows from smoke tests — these are two **separate** databases, don't confuse them.
- **Label template**: `Carpet-Roll-Tag`, `manual_inventory`-type, reachable only via `Item.defaultCustomLabelConfigurations.manualInventory`. As of last audit (2026-08-24): 18/24 true roll-goods items resolve a template; `Astoria Mink` and the `BAJA TEST` family (6 items) don't, but have no live inventory yet.
- **`Piece Type` (singleSelect) live options**: `Mill Roll`, `Cut Piece`, `Remnant`, `Finished Rug`, `Cut Rug`. **Now filtered** by `SOURCE_PIECE_TYPE_ALLOWLIST` (constraint 19) — this used to be unfiltered (a known gap from earlier work), fixed this session's earlier half.
- **Fabric.js layout rendering**: `labelRenderer.js` walks `layoutJson` live at render time, DPI 96. Known fidelity gaps: per-character `styles[]` overrides not applied; only `left`/`top` and `center`/`center` origin combos handled.
- **Print pipeline, end to end (current, PNG-based)**: `labelTemplate.js` (read layoutJson) → `labelRenderer.js` (`renderLabel()` → canvas) → `print/artifact.js`'s `canvasToArtifact(canvas, "png", {})` (raw PNG, no PDF involved) → routes.js's `printLabels` commit step / reprint route → PNG(s) + `widthIn`/`heightIn` sent to frontend as `pages: [...]` in the `printPdf` NDJSON event (commit) or JSON response (reprint) → `printPdf.js`'s `printLabelPages()` shows them as `<img>`s in a modal, prints via our own `window.print()` + injected `@page`/`@media print` CSS.
- **Digit's embedding sandbox** (confirmed via DevTools): `allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads`. No `allow-popups-to-escape-sandbox`. This is why the PDF-viewer path is permanently dead for this embedding — see constraint 11.
- **Headless vs. headed browser testing**: `window.print()`/PDF-viewer behavior differs between headless and headed Chromium (no PDF plugin in headless). If verifying print behavior with Playwright, run headed. For the current PNG path, `page.pdf({ preferCSSPageSize: true })` (Chromium's real print pipeline) is the reliable way to verify `@page` size/margins/page-count without needing a real print dialog.
- **Rendering dependencies**: `pdfkit` (pure JS), `bwip-js` (pure JS), `@napi-rs/canvas` (native, **prebuilt** binaries — `@napi-rs/canvas-linux-x64-gnu` for Heroku's glibc dyno, `-musl` for local Alpine Docker — no compilation, no toolchain needed on either).

## Verification commands

```bash
# Unit tests (Node's built-in runner, zero extra deps) — 8/8 as of this handoff
docker compose exec backend node --test src

# Get a real, currently-open work order id (rotates — don't trust an old one)
curl -s http://localhost:4001/api/cutting/queue

# Smoke test — REAL commit against live Digit + LOCAL DB (not production). No dry-run mode.
docker compose exec \
  -e SMOKE_WORK_ORDER_ID=<real, not-yet-completed WO id> \
  -e SMOKE_SOURCE_INVENTORY_ID=<serialized label with Roll Length/Width set, allowed Piece Type> \
  -e SMOKE_CUT_WIDTH=<less than source width to get remnant path> \
  -e SMOKE_CUT_LENGTH=<less than source's remaining length> \
  -e SMOKE_REMNANT_BIN_ID=<a real bin id, only if remnant path> \
  backend node scripts/smoke-cut.js

# Production Heroku checks (read-only — never write to production Digit)
heroku logs -a cutting -n 50
heroku pg:psql -a cutting -c "SELECT count(*) FROM cut_events;"
heroku config -a cutting   # NEVER print DIGIT_API_TOKEN's or DATABASE_URL's value — redact in any output shown to a human

# Frontend build — ALWAYS in a fresh one-off container, not `exec` into the running dev container
# (docker compose exec into the live dev-server container produces a misleading
#  "Rollup failed to resolve /src/main.jsx" error — see DEPLOY.md gotcha #5)
docker compose run --name <tmp-name> -e VITE_API_URL=<url> frontend sh -c "cd /app && rm -rf dist && npx vite build"
docker cp <tmp-name>:/app/dist /tmp/<somewhere>
docker rm <tmp-name>
```

**Important operational notes**:
- Backend container runs `npm start`, not `--watch`. `backend/src`/`db`/`scripts` are bind-mounted (live on restart, not instantly). **`backend/Dockerfile` and `vite.config.js` are NOT bind-mounted** — either requires a full `docker compose build <service>` before trusting output, not just a restart/exec.
- Local dev's backend talks to the **real live Digit org**, same as production — there's no separate Digit sandbox. Be deliberate about what you commit/split locally.
- The Heroku CLI must be authenticated by the human (`heroku login`) — do not attempt this yourself, do not read/write `~/.netrc`, do not ask for an API key in chat.

## What's built and working right now (verified, not assumed)

- Feet-and-inches parsing/display, ratio-aware unit-mismatch detection, tri-state sufficiency scoring.
- Source-stock Piece Type allowlist (constraint 19) — live-verified: a Cut Rug piece created by this app's own smoke test was confirmed excluded from available-material, search, and direct scan (409 with a clear message) in the same session it was created.
- Full label rendering + PNG-based print pipeline (constraint 11) — verified via Chromium's real print engine: exact 4×6in pages, zero margin, no header/footer text, no image resampling (native 384×576px), two tags print as two separate pages, one click.
- Vendored font (constraint 18) — verified byte-for-byte identical rendered output with system fonts completely absent from the container.
- Pre-flight label-template gate; `ALLOW_PRINTLESS_COMMITS=false` permanently in production.
- Deployed and verified end-to-end at least once (Steps F/G of the deploy, before this session's print-pipeline rewrite): HTTPS, CORS, asset loading, `.git` non-exposure, real label render with visible glyphs, all confirmed against the live Heroku + cPanel deployment. **The print-pipeline rewrite has NOT yet had this same live-embedded verification** — see "Immediate next step."
- Two real production cuts have gone through this app (WO145/MO25, WO157/MO27) — both committed cleanly, both hit the (now-fixed) print-dialog failure that triggered this session's whole diagnosis-and-rewrite arc. Full detail in `docs/archive-candidates.md`.

## Suggested next steps

- **Finish verifying the PNG print pipeline against the real embedded Digit context**, post-cPanel-pull (see "Immediate next step" — this is the actual priority, everything else is secondary).
- Real printer protocol for `NetworkPrinterSink` (ZPL over raw TCP socket is the likely fit — **the barcode must be a native ZPL command, not a rasterized image**, since rasterized bars blur at 203dpi thermal-printer resolution). Table/routes/helper already scaffolded, per constraint 8.
- `Astoria Mink` / `BAJA TEST` family still have no label template in Digit — spot check once fixed org-side.
- Whether `Piece Type` should ever exclude a piece from being re-selected as source stock is now partially addressed by the allowlist (constraint 19) but the original open question (should a `Cut Rug`/`Finished Rug` ever be re-cuttable under some workflow) wasn't re-litigated, just excluded by default.
- `History.jsx`'s dimension columns still render in decimal feet, not feet-inches.
- 22 orphaned no-Piece-Type Digit records, still un-actioned by the customer (`docs/archive-candidates.md`) — this app has no archive mechanism for Digit inventory and isn't expected to build one; purely the customer's call, in Digit's own UI.
- Confirm whether cPanel permissions reset on every pull or only fresh clones (open question, see "Immediate next step").

## Style/process notes specific to this collaborator

- Reads `SCHEMA_NOTES.md` and `DEPLOY.md` as authoritative logs, expects them kept current — add new findings with date/method, same as every prior entry.
- Explicitly enumerates constraints/steps up front and expects literal compliance. Gated, numbered workflows ("Step A... report and stop") are common — do exactly the named step, then actually stop, don't continue into the next one without approval.
- **"Confirm X is already in effect" is not a formality — check it for real.** Multiple times this session, a thing assumed-fixed or assumed-safe wasn't (rounding fix earlier; `git clean -fd` "safety" this session). Read the actual code/state, don't trust a prior claim.
- **Diagnose before proposing a fix, with reproducible evidence, not priors.** When the print pipeline broke a second time (Chrome blocking the PDF viewer entirely, a different failure than the first contentWindow error), the right move was building an independent local reproduction of Digit's exact sandbox and testing each candidate fix empirically — including disproving `window.open` as a fix by testing it, not assuming it would work because `allow-popups` was present.
- Before writing any enum/option value to Digit, fetch the live option list and confirm the exact string exists first.
- Wants real command output, real IDs, real before/after numbers, real decoded artifacts (page counts, `/MediaBox`, pixel-diffs) — not descriptions of what a test would show. Report findings even when unflattering (the `.env` deletions were reported immediately and plainly, both times, before doing anything else).
- Any temporary/throwaway debug code (e.g. a `window.__testHook` used once to feed synthetic data through a real function for testing) must be disclosed as such, reverted immediately after use, and the revert verified (grep the source, grep the built bundle) before moving on.
- Destructive-adjacent operations (clearing a working tree, deleting scripts' guardrails, touching production) get a stop-and-ask by default, even mid-task, even when a previous similar action was already approved — approval doesn't carry forward to a materially different mechanism.
- Never echo, print, or write `DIGIT_API_TOKEN` (or any secret) to any file this session produces. Confirm presence/correctness by length only.
- When asked to centralize config, look for where this feature already keeps such constants (`routes.js`, alongside `LABEL_NAME`/`ALLOW_PRINTLESS_COMMITS`/`SOURCE_PIECE_TYPE_ALLOWLIST`) rather than inventing a new location.
