# ERP Module Template (Digit)

A base template for building ERP modules that embed inside Digit's ERP shell
(side-nav link / iframe). One template, many apps: a reusable **core** plus
swappable **feature** modules, each touching whatever Digit module it needs.

Monorepo: React (Vite) frontend, Node.js (Express) backend that proxies Digit's
GraphQL API via allowlisted server-side operations, and PostgreSQL holding only
this app's local data. Orchestrated with Docker Compose for local development.

```
.
├── frontend/
│   └── src/
│       ├── core/       reusable: Shell (frozen-URL), view registry, api client, design tokens
│       └── features/   per-module screens; each registers its views
├── backend/
│   ├── src/
│   │   ├── core/       reusable: Digit GraphQL client, db pool + migration runner
│   │   └── features/   per-module routes + Digit operations
│   └── db/migrations/  ordered .sql, applied on startup
├── docker-compose.yml
├── .env.example
└── README.md
```

The `projects` feature (frontend + backend + `0001_projects.sql`) is a **worked
example** — delete it for a clean app, or copy it as a starting point.

## Starting a new module from this template

This repo (`Digit-AI-Projects/app-template`) is the template. Each new module
lives in its own repo, cloned from it.

1. **Create the GitHub repo** — github.com → `Digit-AI-Projects` → New
   repository. Name it after the module (e.g. `inventory-module`). Leave it
   **empty** (no README, no `.gitignore`).

2. **Clone the template into the new module's folder.** `git clone` pulls only
   tracked files, so you never copy a stale `node_modules`, a leftover `.env`,
   or another app's token. Use the **HTTPS** URL (the `https://github.com/...`
   form) — it authenticates with your GitHub login and avoids SSH-key setup:

   ```bash
   git clone https://github.com/Digit-AI-Projects/app-template.git ~/Sites/inventory-module
   cd ~/Sites/inventory-module
   ```

3. **Detach it from the template and point it at the new repo:**

   ```bash
   rm -rf .git
   git init
   git branch -M main
   git remote add origin https://github.com/Digit-AI-Projects/inventory-module.git
   git add .
   git commit -m "initial commit from template"
   git push -u origin main
   ```

4. **Each developer clones and sets up their own `.env`:**

   ```bash
   git clone https://github.com/Digit-AI-Projects/inventory-module.git
   cd inventory-module
   cp .env.example .env        # then set DIGIT_API_TOKEN — see Environment variables
   ```

   **Open the module in its own new VS Code window** (File → New Window, then
   open the cloned folder — or run `code .` from the repo). Confirm the window's
   title/Explorer shows the new module (e.g. `inventory-module`), *not* the
   template or another module — a fresh window keeps each module isolated.

   `.env` is gitignored and **never pushed**, so everyone creates their own each
   time. Keep the real token values in a shared secret store (1Password, a
   private Notion page) — never commit them.

5. **Remove the example feature** for a clean module — delete
   `backend/src/features/projects/`, `frontend/src/features/projects/`, and
   `backend/db/migrations/0001_projects.sql`, then remove the `projects` line in
   both `backend/src/features/index.js` and `frontend/src/features/index.js`
   (each is marked with an `EXAMPLE — remove this line` comment).

6. **Start the stack** with `docker compose up --build`, then open
   http://localhost:3000. See [Getting started](#getting-started) for details.

7. **Build** — open Claude Code and describe your module.

## Ports

| Service   | URL                     |
| --------- | ----------------------- |
| Frontend  | http://localhost:3000   |
| Backend   | http://localhost:4001   |
| Postgres  | localhost:5432          |

## Architecture conventions

These hold for every app built from this template:

- **Credentials are server-side only.** The Digit bearer token lives in the
  backend (`DIGIT_API_TOKEN`) and never reaches the browser. The frontend calls
  our Express routes; `backend/src/core/digit.js` proxies to Digit's GraphQL
  endpoint. The demo auth is a single shared token — replace it with a signed
  per-user handshake before real use.
- **Allowlisted Digit operations.** The frontend never sends GraphQL. Each
  feature defines named operations server-side (`features/<name>/digitOps.js`)
  and exposes specific routes. The server controls exactly what Digit calls are
  possible.
- **Frozen URL.** The frontend is a true SPA — no router, no History API, no
  hash/query navigation. The current view is in-memory state in the Shell
  (`core/Shell.jsx`); a refresh resets to the home view. The only URL read is a
  cosmetic `?pm=<name>`.
- **Postgres owns only local data.** Sales orders, items, jobs, materials, etc.
  all live in Digit. Local tables store references (Digit IDs) + cached display
  fields — never copies. Each feature owns its tables via a migration.
- **Pinned design.** Tokens in `frontend/src/core/design-tokens.css` mirror
  Digit's look (Inter, ~40px rows, status pills) with no outer chrome. See
  `frontend/DESIGN.md`.

## Adding a feature (a new Digit module)

1. **Backend** — create `backend/src/features/<name>/`:
   - `digitOps.js` — the named GraphQL operations, calling `digitRequest()`.
   - `routes.js` — an Express router; export `{ basePath, router }`.
   - Register it in `backend/src/features/index.js`.
   - Add `backend/db/migrations/000N_<name>.sql` for any local tables.
2. **Frontend** — create `frontend/src/features/<name>/`:
   - Screen components that receive `{ nav, pm, ...params }` from the Shell.
   - `api.js` — helpers built on `core/api.js`.
   - `index.js` — call `registerView("<name>.<screen>", Component)`.
   - Import it in `frontend/src/features/index.js`.
3. Navigate between screens with `nav("<name>.<screen>", params)` — never touch
   the URL.

The Digit schema is introspectable, so you can discover the queries/mutations a
new module needs against `https://api.digit-software.com/graphql`.

## Digit API (GraphQL)

Single endpoint `POST https://api.digit-software.com/graphql`, `Authorization:
Bearer <token>`. The example projects feature implements two operations
(`backend/src/features/projects/digitOps.js`):

- **Read sales order** — items are embedded; contract value is derived as
  Σ(item.cost.costAmount × quantity) for cached display only.
- **Create job** — `CreateJobInput` requires `itemId` (the PRODUCT item id),
  `type`, `priority`, `packingType`, `status`. New jobs default to
  `PRODUCTION` / `NORMAL` / `STANDARD_PACKING` / `NOT_STARTED`.

### Routes (always present)

| Method | Route            | Purpose                        |
| ------ | ---------------- | ------------------------------ |
| GET    | `/api/health`    | `{ "status": "ok" }`           |
| GET    | `/api/health/db` | Verifies Postgres connectivity |

Plus whatever each mounted feature adds (the example adds `/api/projects/*`).

## Getting started

1. Copy the example env file and fill in the Digit token:

   ```bash
   cp .env.example .env
   # set DIGIT_API_TOKEN=da_...   (server-side only)
   ```

2. Build and start everything:

   ```bash
   docker compose up --build
   ```

   The backend applies `backend/db/migrations/*.sql` on startup (tracked in a
   `_migrations` table) before serving. It waits for Postgres to be healthy.

3. Open the app:

   - Frontend: http://localhost:3000
   - Health check: http://localhost:4001/api/health → `{ "status": "ok" }`

4. Stop the stack (add `-v` to also wipe the Postgres volume):

   ```bash
   docker compose down
   ```

## Development notes

- `frontend/src`, `backend/src`, and `backend/db` are bind-mounted, so edits —
  including new migrations — are picked up on reload/restart without a rebuild
  (Vite HMR; the backend has a `dev` script using `node --watch`).
- CORS is restricted to `CORS_ORIGIN` (the frontend origin). Update it if the
  host app embeds the module from a different origin.

## Environment variables

See [.env.example](.env.example). Key ones:

| Variable              | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `DATABASE_URL`         | Backend → Postgres connection string                   |
| `DIGIT_API_URL`        | Digit GraphQL endpoint                                 |
| `DIGIT_API_TOKEN`      | Digit bearer token — **server-side only**              |
| `CORS_ORIGIN`          | Origin allowed by the backend's CORS policy            |
| `VITE_API_URL`         | Base URL the browser uses to call **our** backend      |
| `CUTTING_STEP_NAME`    | Digit routing step the cutting queue watches (default `Cut to Size`) |
| `REMNANT_BIN_NAME`     | Default bin for side remnants (changeable per-cut in the UI) |
| `DIGIT_APP_BASE_URL`   | Digit's own frontend — used for the "open serialized inventory list to reprint a label" link (see SCHEMA_NOTES.md) |

## Smoke test (cutting commit flow)

`backend/scripts/smoke-cut.js` is a regression check for the commit flow — it
runs a real commit against the running backend's actual HTTP endpoint (not a
reimplementation), then verifies the result independently against Digit and
the local `cut_events` table: three labels at the right ft², dimensions
written on all three (working piece, remnant, and the shortened source),
areas reconciling exactly, the working piece picked into the MO at the right
quantity, the work order moved to `IN_PROGRESS`, and a `cut_events` row
carrying the raw Digit responses for each step.

This is the way to prove the backend still works after a change without
clicking through the UI — run it any time you touch `backend/src/features/cutting/`.

```bash
docker compose exec \
  -e SMOKE_WORK_ORDER_ID=<a real, not-yet-completed work order id> \
  -e SMOKE_SOURCE_INVENTORY_ID=<a serialized label id with Roll Length/Width set> \
  -e SMOKE_CUT_WIDTH=5 \
  -e SMOKE_CUT_LENGTH=5 \
  -e SMOKE_REMNANT_BIN_ID=<a bin id — only required if cutWidth < the source's Roll Width> \
  backend node scripts/smoke-cut.js
```

It prints a `PASS`/`FAIL` line per check and a final pass/fail summary, and
exits non-zero on any failure (suitable for CI). **It performs a real cut
against real Digit data** — point it at dummy/test records, not production
inventory, since it actually splits the source label and picks the working
piece into the given MO.
