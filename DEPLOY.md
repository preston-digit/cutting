# Deploying the cutting module

This documents the deploy that is actually live and verified, not an intended
one. Backend → Heroku app `cutting` (team `digit-software`). Frontend →
static hosting on GoDaddy cPanel, served from `https://digit-software.app/cutting/app/`,
kept in sync via cPanel's **Git Version Control** feature pulling from this
repo's `deploy` branch. Local dev (`docker compose up --build`) is unchanged
by any of this.

## Five gotchas that cost real time — read these before doing anything else

### 1. The frontend Docker container serves a stale `vite.config.js`

`docker-compose.yml` only bind-mounts `frontend/src` into the frontend
container — **not** `frontend/vite.config.js` itself. If you edit
`vite.config.js` (e.g. changing `base`) and just re-run `npx vite build`
inside the already-running container, you get a build against the OLD
config baked into the image at the last `docker build`, with no error or
warning that anything is wrong. The symptom: `dist/index.html` references
assets as root-relative `/assets/...` instead of the expected
`/cutting/app/assets/...`, and you won't notice unless you actually check.

**Fix**: after any change to `vite.config.js`, run `docker compose build
frontend` (full image rebuild) before building the bundle, and verify
`docker compose exec frontend cat /app/vite.config.js` shows your change
before trusting the build output.

### 2. cPanel Git Version Control clones land at 0700 and 403 in a way that looks nothing like a permissions problem

When cPanel's Git Version Control feature clones a repo, the cloned
directories and files can come out owned/permissioned as `0700` —
readable only by the owning user, not by Apache. The result is a **403
Forbidden** on every path under the deployed directory: the app root, the
assets directory, `index.html` directly, even the parent directory. It
looks exactly like a wrong branch or a broken build, but it isn't — the
files are correct, Apache just can't read them. `rma/app/` was observed
returning the same 403 at the same time this was diagnosed here and likely
has the identical unfixed permissions issue — worth checking if that
module gets touched again.

**Fix, done once in cPanel File Manager** (no code change, nothing to
commit):
- `cutting/`, `cutting/app/`, `cutting/app/assets/` → **0755**
- `cutting/app/index.html` and every file under `cutting/app/assets/` → **0644**
- `cutting/app/.git/` → **left at 0700, deliberately.** Apache being unable
  to read it is exactly what keeps `/cutting/app/.git/config` (which can
  contain a credential-bearing clone URL) from being served over HTTP.
  Verified after the fix: `/cutting/app/.git/config` and `/cutting/app/.git/HEAD`
  both still return 403.

### 3. Clearing the working tree for the orphan `deploy` branch must NOT be a bare recursive delete

**This actually happened, not a hypothetical**: building the `deploy` branch
the first time, the working tree was cleared with
```bash
find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
```
to wipe everything except `.git` before placing the built output at the
branch root. This command does not know about `.gitignore` and does not
distinguish "tracked, git can restore it" from "ignored, git has never seen
it and cannot bring it back." It deleted `.env` at the repo root along with
everything else. Switching back to `main` afterward restored every
*tracked* file (source, `.gitignore`, `.env.example`, ...) but had nothing
to restore `.env` from, since git never had a copy of it. **It was
unrecoverable** — no stopped container, cache, or git object held the old
value, and the token had to be re-entered by hand.

**Fix — use git's own tooling, which already knows the difference:**
```bash
git checkout --orphan deploy
git rm -rf --cached .
git clean -fd
```
`git rm -rf --cached .` unstages every tracked file (doesn't touch the
working tree yet); `git clean -fd` then removes only *untracked, unignored*
files and directories — anything matching `.gitignore` (`.env`, `node_modules/`,
etc.) is left alone by default. This is the git-native way to get an empty
tree without a bare `rm -rf`. Never run an unscoped recursive delete against
the working tree for this or any other step — if a step seems to call for
one, stop and ask first rather than reaching for `find`/`rm -rf`.

### 4. The print path can't use Chrome's PDF viewer at all inside Digit's embedding

The original print flow rendered a PDF and displayed/printed it via Chrome's
built-in PDF viewer. Confirmed directly (not assumed): Chrome refuses to
instantiate that viewer under any sandboxed ancestor frame, which Digit's
embedding iframe is — `allow-popups-to-escape-sandbox` on Digit's iframe
would let a popup escape that and restore the PDF-viewer path, but that's
Digit's markup, not this repo's. The fix (see `printPdf.js`) prints a PNG
raster via our own `window.print()` and `@page` CSS instead, which sidesteps
the PDF viewer entirely — but be aware an operator's print dialog set to
"Fit to page" (or a non-default scale/paper size) can still override the
`@page` size/margin guarantee, unlike the old PDF path where a page's size
was fixed no matter what the dialog was set to.

### 5. `docker compose exec` into the running dev container vs. `docker compose run` for a one-off build

Running `npx vite build` via `docker compose exec` against the frontend
container while its own `npm run dev` process is still running in the same
container produces a misleading `Rollup failed to resolve "/src/main.jsx"`
error that looks like a real config/source problem — it isn't; the build
and the live dev server are fighting over the same container. Use
`docker compose run --name <tmp-name> ...` (a fresh, separate container) for
any one-off production build, then `docker cp` the result out and remove
the container.

## Backend → Heroku

App: `cutting`, team `digit-software`, stack `heroku-24` (Ubuntu/glibc —
required, see the native-dependency note below).

1. **Procfile** (`backend/Procfile`, committed to `main`):
   ```
   web: npm start
   ```
   Heroku showed zero process types before this existed — without it the
   buildpack has nothing telling it how to start the dyno.

2. **Postgres**, plan pinned deliberately, not chosen freely:
   ```bash
   heroku addons:create heroku-postgresql:essential-0 -a cutting
   ```
   Sets `DATABASE_URL` automatically. Confirm with `heroku config -a cutting`.

3. **Config vars** — set with `heroku config:set -a cutting`:
   ```
   DIGIT_API_URL=https://api.digit-software.com/graphql
   DIGIT_API_TOKEN=<set manually from the terminal, never pasted into a chat window or written to a file>
   CUTTING_STEP_NAME=Cut to Size
   REMNANT_BIN_NAME=WH3-RACK-A
   DIGIT_APP_BASE_URL=https://app.digit-software.com
   ALLOW_PRINTLESS_COMMITS=false
   DATABASE_SSL=true
   CORS_ORIGIN=https://digit-software.app
   ```
   Notes that matter:
   - `DIGIT_API_TOKEN` is set directly on the dyno from a terminal you
     control (`heroku config:set DIGIT_API_TOKEN=... -a cutting`) — it is
     never something an assistant or chat log should see, echo, or store.
   - `CORS_ORIGIN` is **scheme + host only**, no trailing slash, no path —
     `https://digit-software.app`, even though the frontend actually lives
     at a sub-path (`/cutting/app/`). The browser's CORS check is against
     origin, not full URL.
   - `ALLOW_PRINTLESS_COMMITS` stays `false` permanently in production — a
     cut must always produce a printed tag; this is the only sanctioned
     bypass and it's for an org that genuinely doesn't print at all.
   - Do **not** set `PORT` (Heroku injects it) or `BACKEND_PORT` (local-dev
     only). Do not set `BACKEND_URL` or any `SMOKE_*` var on the dyno either
     — those exist only for `scripts/smoke-cut.js`, and leaving them unset
     is a deliberate guardrail against accidentally pointing that script's
     real-commit behavior at production.
   - `DATABASE_SSL=true` is required — Heroku Postgres requires SSL with a
     cert chain the `pg` client won't validate by default; the backend only
     sets `ssl: { rejectUnauthorized: false }` when this flag is on (see
     `backend/src/core/db.js`), so local docker-compose Postgres (no SSL) is
     unaffected.

4. **Vendored font** — `backend/assets/fonts/` ships `DejaVuSans.ttf` and
   `DejaVuSans-Bold.ttf` (plus `LICENSE`), registered at module load in
   `labelRenderer.js` via `@napi-rs/canvas`'s `GlobalFonts.registerFromPath`.
   This is why `backend/Dockerfile` no longer has `apk add font-dejavu
   fontconfig`: this repo deploys to Heroku via a **buildpack** (`git
   subtree push`, below), which never reads the Dockerfile at all — Heroku's
   Node buildpack has no apk/apt step and the dyno ships with zero fonts.
   Without a font registered, every text field on a printed label renders as
   silent blank space, with nothing in the response or logs to catch it.
   Vendoring the actual TTFs means Docker and Heroku resolve identical font
   files from the same repo instead of depending on whatever the OS happens
   to have installed. Verified before removing the `apk add` line: rendered
   the same label with it present, then rebuilt with it removed and
   confirmed the rendered output was byte-for-byte pixel-identical (no
   `/usr/share/fonts` in the image at all afterward).

5. **`@napi-rs/canvas` and the Heroku stack**: this package ships prebuilt
   native binaries as optional deps, including `@napi-rs/canvas-linux-x64-gnu`
   — the variant `heroku-24` (Ubuntu, glibc) needs. No compilation, no
   non-default buildpack required. Confirmed live: the dyno has no
   `node-gyp`/`gcc`/`cc` at all, and the installed `.node` file is a
   stripped prebuilt ELF binary, not something compiled on the fly.

6. **`engines` + lockfile** — `backend/package.json` pins
   `"engines": { "node": "20.x" }` to match `backend/Dockerfile`'s
   `node:20-alpine`, and `backend/package-lock.json` is committed (generated
   inside the `node:20` container, not a newer host Node) so Heroku's
   buildpack runs `npm ci` against pinned versions instead of resolving
   fresh on every deploy.

7. **Push** — this is a monorepo; `backend/` isn't the repo root, so a plain
   `git push heroku main` won't find `package.json`. Push only the
   `backend/` subtree as the deployed root:
   ```bash
   heroku git:remote -a cutting
   git subtree push --prefix=backend heroku main
   ```
   Re-run the same command for every subsequent backend deploy — it only
   pushes the current state of `backend/`, safe to repeat.

8. **Confirm it's up**:
   ```bash
   curl https://cutting-63d2bc51caef.herokuapp.com/api/health
   ```
   Migrations in `backend/db/migrations/` apply automatically on every boot
   (`runMigrations()` in `backend/src/core/db.js`) — nothing extra to run.
   The app binds `process.env.PORT` (Heroku sets this, falls back to
   `BACKEND_PORT` for local dev) and binds `0.0.0.0` explicitly.

**Never** run `backend/scripts/reset-demo-data.js` or
`backend/scripts/migrate-dimension-units.js` against production — not even
in dry-run mode — and never add either to a Procfile or release phase. Both
require explicit `--confirm` and explicit scope for exactly this reason.

## Frontend → GoDaddy cPanel via an orphan `deploy` branch

cPanel cannot run a build. This repo uses a two-branch pattern to work
around that:
- **`main`** holds source — the only branch a human edits.
- **`deploy`** is an orphan branch (no shared history with `main`) whose
  root **is** `frontend/dist/`'s contents — `index.html` and `assets/`,
  nothing else. It is fully regenerated and force-pushed-in-spirit
  (recommitted from scratch) on every frontend deploy, never hand-edited.

cPanel's Git Version Control repository is cloned at
`/home/bb6xqiv35bcb/public_html/cutting/app`, from
`https://github.com/preston-digit/cutting.git`, **checked out on the
`deploy` branch — not `main`.** Checking it out on `main` would serve the
entire source tree (`backend/`, `node_modules/` if installed, source `.jsx`
files) instead of the built static bundle; there would be no build step to
produce anything servable.

1. **Set the Vite base to the sub-path**, in `frontend/vite.config.js`:
   ```js
   base: "/cutting/app/",
   ```
   Leading and trailing slash both required, matching where cPanel serves
   this from and the pattern the `rma`/`ai-brain` modules use on the same
   domain. Without it, built asset URLs default to domain root and 404
   under the sub-path. (See gotcha #1 above — rebuild the Docker image
   after changing this, not just the bundle.)

2. **Build with the live Heroku URL baked in**:
   ```bash
   cd frontend
   VITE_API_URL=https://cutting-63d2bc51caef.herokuapp.com npm run build
   ```
   **`VITE_API_URL` is inlined into the JS bundle at build time** (Vite
   replaces `import.meta.env.VITE_API_URL` with the literal string) — it is
   never read at runtime. This means **any time the backend URL changes,
   the frontend needs a full rebuild, a recommit to `deploy`, a push, and a
   fresh cPanel "Update from Remote" pull.** There is no way to repoint it
   by editing a config file on GoDaddy after the fact.

3. **Build the orphan branch**:
   ```bash
   git checkout --orphan deploy      # only the first time; branch persists after
   git rm -rf --cached .
   git clean -fd                    # git-native clear — see gotcha #3, NOT a bare rm -rf
   # copy frontend/dist/*'s contents to the root
   git add -A
   git commit -m "Deploy: built static output for /cutting/app/"
   git push origin deploy
   git checkout main
   ```
   Before committing: grep the built bundle for `da_`, for
   `DIGIT_API_TOKEN`, and for any other long token-shaped string — the
   Digit token is server-side only and must never reach a browser bundle.
   Confirm `index.html` references assets with the `/cutting/app/` prefix,
   not root-relative `/assets/...` (if it's root-relative, the `base`
   didn't apply — see gotcha #1 — rebuild, don't push). After pushing,
   confirm `main`'s working tree is clean and no build artifacts leaked
   into it.

4. **cPanel pull** — a human runs "Update from Remote" in cPanel's Git
   Version Control UI. Nothing about this step can or should be automated
   from here (no FTP, SSH, or cPanel API access).

5. **File permissions after a fresh clone** — see gotcha #2 above. Check
   this first if the deployed path 403s.

## Local dev

Unchanged — `docker compose up --build`, per the main [README.md](README.md).
`PORT` is never set locally (only `BACKEND_PORT`), `DATABASE_SSL` is
unset/`false`, and `VITE_API_URL` defaults to `http://localhost:4001` — the
backend binds `4001` with no SSL against the compose Postgres service
exactly as before.
