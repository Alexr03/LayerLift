# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

LayerLift is a set of multi-colour 3D-printing tools that end in an OrcaSlicer 3MF with each part
pre-assigned to its AMS slot. **Image to Layers** (the original tool, `#/`) turns a flat-colour
image into a relief, one watertight mesh per filament, built on the server. **Gridfinity**
(`#/gridfinity`) plans drawers, baseplates and bins, built entirely in the browser. Python backend
(`backend/`), React + three.js frontend (`frontend/`), one Docker image.

## Commands

Backend (Python 3.12, managed with uv; run from `backend/`):

```sh
uv sync                                   # create .venv and install deps (incl. dev group)
uv run pytest                             # full suite, about a minute
uv run pytest tests/test_units.py -k mapping          # a subset
uv run pytest "tests/test_acceptance.py::test_bounding_box"   # a single test
uv run uvicorn app.main:app --reload      # API (and built frontend) on :8000
uv lock --check                           # CI runs `uv sync --locked`; keep uv.lock in sync with pyproject.toml
```

Frontend (from `frontend/`): `npm run dev` (Vite on :5173, proxies `/api` to :8000),
`npm run build` (`tsc -b` + Vite; output in `frontend/dist`, which the API serves automatically),
`npm run lint` (oxlint), `npm test` (vitest: the Gridfinity geometry in `src/gridfinity/*.test.ts`,
a few seconds, runs in Node). CI runs build + lint + test. Test files are excluded from `tsc -b`.

Container: `docker build -t layerlift .` then `docker run -p 8000:8000 layerlift`.

Dev with accounts: `docker compose -f docker-compose.dev.yml --env-file .env.dev up -d --build`
(persistent PocketBase on 127.0.0.1:8090; rebuild after migration changes), then run the API with
`uv run uvicorn app.main:app --reload --env-file ../.env.dev`. `.env.dev` is gitignored. Settings
never read an env file on their own, so tests are unaffected.

`tests/test_orca.py` and `frontend/src/gridfinity/orca.test.ts` round-trip an exported 3MF through
the OrcaSlicer CLI; they are skipped unless OrcaSlicer is installed (`ORCA_SLICER` env var or the
default Windows/macOS/Linux paths).

## Releases are driven by commit messages

Every push to `master` that touches code runs `.github/workflows/release.yml`: tests, then the next
version is computed from the latest `vX.Y.Z` tag and **Conventional Commit** subjects since it
(`fix:`/other → patch, `feat:` → minor, `!`/`BREAKING CHANGE` → major, but minor while on 0.x),
with the `-beta` label from `DEFAULT_PRERELEASE`. The image is pushed to Docker Hub
(`<user>/layerlift:<version>`, `:beta`, `:sha-*`) and a GitHub release is created. So a commit
message choice changes the published version; docs-only (`**.md`, `deploy/**`) pushes don't release.
The deployed site (Flux ImagePolicy in a separate fleet-infra repo) picks up new release tags
automatically. The running version comes from `LAYERLIFT_VERSION` (baked in by the Dockerfile
build arg) and is `0.0.0-dev` locally.

## Architecture

### `backend/relief/` — the geometry library (no web dependencies)

The pipeline, orchestrated by `pipeline.build_relief()`:

1. `imageio.load_image` → RGBA (downscaled to `max_image_side`; SVG via resvg, external hrefs refused)
   and `foreground_mask` (alpha, or a background colour detected from the border).
2. `analyse.analyse` → CIELAB k-means on *flat interior* pixels only (anti-aliasing fringe never forms
   clusters), merge clusters closer than ΔE2000 8, then `segment()` lets edge pixels only take a colour
   found in a flat area within 2.5 px. Produces a cluster label map, a **region** map (8-connected
   components per cluster; region ids are what the UI's per-area overrides refer to) and a cluster
   adjacency matrix.
3. `mapping.suggest_mapping` → cluster→filament assignment minimising ΔE2000 plus a penalty for lost
   or invented contrast between clusters (weighted by shared boundary and global share). Exhaustive
   search for small problems, local search otherwise. The weights in `DEFAULT_WEIGHTS` were tuned on
   the Space Turtles fixture; tests assert the resulting mapping.
4. Heights: per filament (`height_mm` or luminance rank), overridable per cluster and per region, all
   snapped to layer multiples. Regions are grouped into **elements** = (filament, z0, z1). Filaments
   with `start_from_bed` and the base filament start at z=0; others sit on the `base_mm` slab.
   `BuildSettings.strategy` changes this: `compact` squeezes distinct heights to one layer apart
   (`squeeze_heights`, no bed starts); `stacked` puts one filament per height band (`stack_bands`,
   extruded by `_extrude_stacked`, where a band covers every element at or above it), so each layer
   is one colour. Pinch resolution takes a `spans_of` callback because the two layouts differ.
5. `geometry`: smooth ×N upscale of the element label map → contours → shapely polygons (mm) →
   `partition()` = exact partition of the silhouette in priority order (tallest, then smallest; the
   largest element takes the remainder) with a morphological opening at `min_feature` (= nozzle), then
   `_hand_off_slivers` gives thin/tiny pieces to the neighbour with the longest shared edge. The
   partition guarantees no gaps/overlaps, which the acceptance tests check.
6. Extrusion with manifold3d (union per filament). `pipeline._resolve_pinches` loops: solids whose
   pieces touch only at an edge (non-manifold once a slicer merges vertices) get a tiny disc handed to
   one element, then everything is re-extruded.
7. `changes.estimate_changes` (DP over layers with optimal colour chaining), `preview` (rasterised
   hill-shaded top view from the 2D footprints, equivalent to a ray cast), `export` (3MF, STL zip, GLB).

`build_relief` accepts a `progress(stage, fraction)` callback used by the web UI's progress bar.

### 3MF format decisions (`export.py`, verified against OrcaSlicer 2.5)

One object with one component per filament part; part names and the `extruder` (slot) live in
`Metadata/model_settings.config`. Deliberately **no** `project_settings.config` (Orca layers it over
generic defaults and would replace the user's printer profile) and **no** `OrcaSlicer` version
metadata (a tagged file without a project config crashes the Orca CLI; untagged it imports as a
third-party 3MF that keeps parts and slots). Don't "fix" either without re-verifying in Orca.

### `backend/app/` — FastAPI service

- CPU work runs in a spawn-based process pool (`pool.WorkerPool`); a task past its timeout kills and
  recreates the pool. Worker entry points are in `worker.py`.
- Analyses are cached in-process (LRU keyed by image hash + options), so `/api/build` usually skips
  re-analysis. The client always re-sends the image; there is no server-side analysis id lookup.
- Builds: `POST /api/builds` starts one in the background; the worker writes `progress.json` into the
  job dir and `GET /api/jobs/{id}/status` reads it. `POST /api/build` is the synchronous variant (used
  by tests). Job outputs live in per-job temp dirs deleted after `job_ttl_seconds`, so the service must
  run as a single replica.
- `protect.py`: Turnstile check → signed session cookie (`require_human`), per-client rate limits,
  and `JobQueue` admission control (global capacity + per-client cap, FIFO position for the UI).
  Client identity is `client_ip()`: `LAYERLIFT_CLIENT_IP_HEADER` (e.g. `CF-Connecting-IP`) if set,
  else the socket address after uvicorn's proxy-header handling. The app writes its own access log
  with that IP (uvicorn's access logger is disabled).
- All settings are `LAYERLIFT_*` env vars (`config.Settings`, cached by `get_settings()`); the README
  has the full table.
- Accounts are optional (`pb.py`, on when `LAYERLIFT_POCKETBASE_URL` is set). Every request resolves
  a `Caller` (IP, PocketBase user from the `Authorization` token via `auth-refresh`, cached 60 s,
  and `Limits` from the `tiers` collection, cached 30 s, falling back to the env settings). Rate
  limits and the job queue key on the account when signed in. `JobSync` writes `jobs` records in
  the background (merged, ordered; failures only log), so PocketBase can never block a build.
  `/pb/*` is a streaming proxy to PocketBase (API, realtime SSE, dashboard), so the browser has
  one origin (bodies are forwarded only when the request has one: an empty chunked DELETE body
  makes PocketBase answer 400). The schema is `deploy/pocketbase/pb_migrations/` (JS migrations, PocketBase
  v0.40); verify rule changes against a real PocketBase, since `test_accounts.py`'s live test
  is skipped without `LAYERLIFT_TEST_POCKETBASE_URL`.

### `frontend/src/gridfinity/` — the Gridfinity tool (no server work)

- `spec.ts` holds the dimensions (from Gridfinity Rebuilt): 42 mm pitch and 7 mm units by default
  (each drawer carries its own `pitch`/`unit`, passed to the builder as a `GridSpec`), the bridge
  height (`BRIDGE_Z`), connection clips (`RAIL`, `CLIP`: measured from Gridfinity Generator's
  connectable baseplate and clip, and checked equal to them; keep them that way), foot /
  baseplate / lip profiles as `[inset, z]` points, holes. `geometry.test.ts` asserts fit against
  them (bin seats in a plate on its chamfers, stacks on a lip, labels fill their pockets), so a
  change to either side must keep those passing.
- `geometry.ts` (`Builder`) builds solids with manifold-3d (WASM): profiles are unions of convex
  hulls between inset rounded rectangles. `mf.ts` patches manifold's classes to track every object
  created inside `scoped()` and free them after; code must return plain meshes (`toMesh`), never
  Manifolds, out of a scope.
- `worker.ts` runs all geometry in a module Web Worker (`client.ts` is the page side, messages in
  `protocol.ts`); it caches bin meshes by design. `vite.config.ts` sets `worker.format = 'es'`,
  and the CSP in `app/main.py` allows `'wasm-unsafe-eval'`; both are required for it to load.
- `export.ts` is a TypeScript port of `relief/export.py`'s 3MF layout (same Orca caveats), plus STL
  and zip. Keep the two in step.
- `types.ts` is the project model: `GfProject` (v2) has a `mode` (`project` = drawer project,
  `bin`, `plate` = made on their own), filaments, and `plates` (each a drawer + placed bins).
  `normaliseProject` clamps anything loaded and converts v1 projects (one drawer + bins). The
  geometry, layout and worker work on a `Scene` (one plate + filaments; `sceneOf`). A drawer is
  sized in cells (`sizeMode: 'cells'`, no margin) or to a measured drawer (`'mm'`); `layout.ts` is drawer maths (grid, margins, splitting the plate for the bed,
  bin issues). Saving is manual: `projects.ts` writes PocketBase `projects` when signed in (migration
  `1758700000_projects.js`, owner-only rules, no cap) or a localStorage list otherwise; the
  working copy (`Draft`, with the JSON as last saved to show "unsaved changes") is always in
  localStorage. `GridfinityStudio` shows a start screen when no draft is open.
- `src/printers.ts` is "My printers" (a `useSyncExternalStore` store): bed sizes and loaded
  filaments per printer, in PocketBase `printers` when signed in (local ones are uploaded on first
  sign-in), else localStorage; the active printer id is per browser. Gridfinity reads the bed and
  slots from it; `FilamentEditor` can load a printer's filaments. Page: `components/PrintersPage.tsx`,
  top-bar `PrinterSwitch`. A label in the bin's own filament is engraved (inlay) or unioned (raised).
- Number inputs use `components/NumberField.tsx`: free typing, clamped on blur/Enter.
- UI: `components/gridfinity/` (`GridfinityStudio` holds state + undo; `Planner` is the SVG
  layout; `PartsViewer` is a three.js view that swaps meshes without moving the camera).
  The studio is lazy-loaded and stays mounted (hidden) once opened.

### `frontend/`

Single-page React app, state in `App.tsx` (the header has a tool switcher); `#/gridfinity[/<id>]`,
`#/projects`, `#/builds` and `#/admin` are hash-routed pages (`GridfinityStudio`, `ProjectsPage`,
`MyBuilds`, `AdminPage`) that use the PocketBase SDK (`pb.ts`, base `/pb`) with realtime
subscriptions. A loading screen (static in `index.html` so it paints before any script, taken over by
`components/Splash.tsx` with the same markup) stays up until `/api/me` and `/api/session` answer, so
the UI never shows guessed or cached account data; it offers a retry if they fail. The SPA route
writes the version and Turnstile key into `index.html` as a `<script id="ll-bootstrap"
type="application/json">` block (`bootstrap.ts`). Hashed `/assets/*` are served immutable;
responses are gzipped (event streams excluded). `plan.ts` **mirrors the backend's height/base rules and
the change-estimate DP** for live feedback before a build — keep it in sync when changing
`pipeline.filament_heights`, the z0/z1 rules in `build_relief`, the strategies, or `changes.py`. The colour map
decodes the analysis `region_map_png` (RGB = region id + 1) into per-pixel region ids for
click-to-override (shift-click selects several). `edits.ts` holds the region edits that need more
than one field (merge into surroundings, using the analysis's per-region `neighbours`; speck tidying)
and the `Edits` snapshot behind undo/redo, which covers mapping, pins, region overrides and colour
heights. `Viewer3D` (three.js) is lazy-loaded; in the editor it also lets you drag a colour's height: it keeps
each part's built z values and remaps the filament's built top (stacked: also its band bottom) to the
height in the current settings, so drags, typed heights and undo all preview live. Saved palettes live in `localStorage`.

## Tests and fixtures

- `tests/fixtures/` holds the Space Turtles logo and the prototype's expected previews. The
  acceptance tests reproduce the prototype with its hand-picked 7-colour palette, which only matches
  when snapped by RGB distance (`analyse(..., palette_metric="rgb")`); the default is CIELAB.
- `conftest.py` builds the 4- and 7-colour results once per session (~10 s each).
- API tests start the real app (process pool included). Tests that start a second app with different
  env (via `get_settings.cache_clear()`) replace the shared app state, so in `test_api.py` the timeout
  test must stay last; `test_protect.py` uses its own `configured` fixture for the same reason.
