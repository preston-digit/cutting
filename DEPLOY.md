# Deploying the cutting module

Backend → Heroku. Frontend → static hosting on GoDaddy cPanel. Local dev
(`docker compose up --build`) keeps working unchanged after everything below
— the production-only bits (`PORT`, `DATABASE_SSL`) are additive env vars
with safe local defaults.

## Backend → Heroku

This is a monorepo — `backend/` isn't the repo root, so a plain `git push
heroku main` won't find `package.json`. The simplest fix is to push only the
`backend/` subtree as the root of what Heroku sees:

1. **Create the app and Postgres addon:**

   ```bash
   heroku create your-cutting-module-api
   heroku addons:create heroku-postgresql:mini -a your-cutting-module-api
   ```

   The addon sets `DATABASE_URL` automatically — you don't set it by hand.

2. **Set config vars:**

   ```bash
   heroku config:set -a your-cutting-module-api \
     DIGIT_API_URL=https://api.digit-software.com/graphql \
     DIGIT_API_TOKEN=da_... \
     CORS_ORIGIN=https://your-godaddy-domain.com \
     DATABASE_SSL=true \
     CUTTING_STEP_NAME="Cut to Size" \
     REMNANT_BIN_NAME="Remnant Storage" \
     DIGIT_APP_BASE_URL=https://app.digit-software.com
   ```

   `DATABASE_SSL=true` is required here — Heroku Postgres requires SSL with a
   cert chain the `pg` client won't validate by default; the backend only
   sets `rejectUnauthorized: false` when this flag is on (see
   `backend/src/core/db.js`), so local docker-compose Postgres (no SSL) is
   unaffected.

   `CORS_ORIGIN` must exactly match the GoDaddy origin the frontend is
   served from (scheme + host, no trailing slash) or the browser will block
   every request the frontend makes.

3. **Push only `backend/` as the deployed root:**

   ```bash
   heroku git:remote -a your-cutting-module-api
   git subtree push --prefix backend heroku main
   ```

   Re-run the same `git subtree push` command for every subsequent deploy —
   it only pushes the current state of `backend/`, so it's safe to repeat.

4. **Confirm it's up:**

   ```bash
   curl https://your-cutting-module-api.herokuapp.com/api/health
   curl https://your-cutting-module-api.herokuapp.com/api/health/db
   ```

   Migrations in `backend/db/migrations/` apply automatically on every boot
   (see `backend/src/core/db.js` / `runMigrations()`) — nothing extra to run.

   The app binds `process.env.PORT` (Heroku sets this) with a fallback to
   `BACKEND_PORT` for local dev, and binds `0.0.0.0` explicitly — both
   required by Heroku's routing layer (`backend/src/index.js`).

**Alternative to `git subtree push`:** if you'd rather deploy from CI or
GitHub Actions without subtree pushes, use a monorepo buildpack (e.g.
[`heroku-buildpack-monorepo`](https://github.com/lstoll/heroku-buildpack-monorepo))
ahead of the Node buildpack, with `APP_BASE=backend` set as a config var — it
copies `backend/*` to the build root before the Node buildpack runs. Subtree
push is simpler for a solo/small-team workflow and needs no extra buildpack,
so it's the default recommendation above.

## Frontend → GoDaddy cPanel (static hosting)

1. **Build with the Heroku backend's URL baked in:**

   ```bash
   cd frontend
   VITE_API_URL=https://your-cutting-module-api.herokuapp.com npm run build
   ```

   This produces `frontend/dist/` — a static bundle (`index.html` + assets).
   `VITE_API_URL` is baked in at build time (Vite env vars are inlined at
   build, not read at runtime), so rebuild and re-upload whenever the backend
   URL changes.

2. **Upload to cPanel:**

   - cPanel → **File Manager** → navigate to `public_html/` (or a subfolder
     if the module lives at a sub-path, e.g. `public_html/cutting/`).
   - Upload and extract the contents of `frontend/dist/` there (the contents
     of `dist/`, not the `dist/` folder itself — `index.html` should sit
     directly in `public_html/`).
   - Alternatively, upload via FTP/SFTP with the same target path.

3. **Confirm the CORS origin matches:** the domain (and path, if the module
   lives at `https://yourdomain.com/cutting/`) the module is actually served
   from must exactly match the Heroku backend's `CORS_ORIGIN` config var —
   revisit step 2 of the backend section if you change the GoDaddy domain or
   path after the fact.

4. **Reload:** since this is a static bundle (no server-side process on
   GoDaddy), there's nothing to restart — the new files are live as soon as
   they're uploaded. Hard-refresh the browser to bypass any cached bundle.

## Local dev

Unchanged — `docker compose up --build`, per the main [README.md](README.md).
`PORT` is never set locally (only `BACKEND_PORT`), and `DATABASE_SSL` is
unset/`false`, so the backend binds `4001` with no SSL against the compose
Postgres service exactly as before.
