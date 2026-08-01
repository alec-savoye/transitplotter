# TransitPlotter → asphoto Integration / Transition Plan

> **ARCHIVED — the merge into asphoto is not being pursued.** This document is
> retained for reference only. TransitPlotter runs as its own standalone
> project. See the repo `README.md` for the live architecture.

Audience: the agent merging this repo (`transitplotter/`) into the
`../../photosite/asphoto` project. This document summarizes TransitPlotter, then
lays out how to fold it into asphoto **modularly** with minimal disruption.

Read `README.md` first for full feature/architecture detail. This file focuses
on the interface between the two projects and the migration steps.

---

## 1. What TransitPlotter is (30-second summary)

A live NYC subway map. A backend polls MTA GTFS-realtime feeds and derives each
train's *current leg* (the track segment it's on + schedule times); the browser
interpolates the moving position along the real track geometry. It also serves
station arrivals, service alerts, and an address-to-address trip planner.

- **No API keys** for any MTA feed.
- **Two data classes:** static GTFS (a cached SQLite, stable for weeks) and
  realtime protobuf feeds (polled every 20–60 s, in-memory only).
- **Positions are synthesized** — the MTA feed has no coordinates.

---

## 2. Runtime shape (this is the crux of the integration)

TransitPlotter is a **TypeScript npm-workspaces monorepo** with three packages:

| Package  | Runtime | What it is | asphoto's equivalent |
|----------|---------|------------|----------------------|
| `shared/` | TS types only | wire contract | (none) |
| `server/` | Node + **tsx** (ESM), WebSocket + HTTP | the API/data engine | `server/index.js` (Express, CommonJS) |
| `web/`    | **Vite** SPA (MapLibre GL) | the map UI, needs a build | `public/*.html` (static, no build) |

**Impedance mismatches to plan around:**

1. **Language/module system.** transitplotter server is **TypeScript + ESM**
   run via `tsx`. asphoto is **plain JS + CommonJS + Express 5**. They do not
   share a process today.
2. **Build step.** `web/` must be compiled by Vite into static assets. asphoto
   serves `public/` with no build. A build stage is required.
3. **Native module.** `server` uses **`better-sqlite3`** (native addon).
   asphoto's Dockerfile is `node:22-alpine`; better-sqlite3 on alpine needs
   `apk add --no-cache build-base python3` (or a prebuilt). TransitPlotter's own
   Dockerfile uses `node:22-bookworm-slim` + `python3 make g++`.
4. **Transport.** transitplotter uses a **WebSocket** (train legs) plus HTTP
   JSON. asphoto is HTTP-only. Caddy must proxy the WebSocket (it does by
   default, but the route must exist).
5. **Ports.** transitplotter dev uses 8090 (backend) + 5173 (Vite). asphoto
   publishes **no host ports** and is reached only via Caddy on `caddy_web`.
6. **Off-boot cache.** The static SQLite (~260 MB) must live on the RAID array,
   not the boot drive — same rule asphoto already follows.

---

## 3. Complete module inventory

### `shared/src/types.ts` — the wire contract (import this from both sides)
- `TrainLeg` / `ServerMessage` — WebSocket payload (train legs; browser
  interpolates positions).
- `RouteMeta`, `Arrival`, `StationArrivals`, `ServiceAlert`, `RouteStatus`,
  `Itinerary`, `ItineraryLeg`.

### `server/src/` — the data engine
| File | Responsibility |
|------|----------------|
| `index.ts` | `startServer(port)` — loads static, builds routing graph, starts HTTP+WS, starts poll loops. **This is the embedding entry point.** |
| `ws.ts` | `Broadcaster`: creates the `http.Server` + `WebSocketServer`, and **owns all HTTP route handling** (see §4). |
| `tick.ts` | poll loops: feeds (20 s) → broadcast legs; alerts (60 s). |
| `feeds.ts` | feed URLs + poll intervals. |
| `parse.ts` | fetch + decode GTFS-realtime protobuf (trip updates). |
| `alerts.ts` | fetch + classify service alerts; per-route rollup. |
| `feedstore.ts` | in-memory holder for latest feed + alerts. |
| `state.ts` | realtime + static → `ActiveLeg[]` per train. |
| `legwire.ts` | `ActiveLeg` → compact `TrainLeg` (sliced track polyline). |
| `arrivals.ts` | per-station arrivals board. |
| `routing/graph.ts` | build ride+transfer graph from schedule (at boot). |
| `routing/plan.ts` | Dijkstra journey search → itinerary. |
| `routing/geocode.ts` | address → coord (configurable Nominatim). |
| `static/load.ts` | load SQLite; build canonical route/dir lines. |
| `static/geometry.ts` | project/interpolate along shapes. |

### `web/src/` — the UI (Vite + MapLibre)
`main.ts` (bootstrap), `basemap.ts`, `bullets.ts`, `trains.ts` (client-side
position interpolation), `ui.ts`, `station.ts`, `alerts.ts`, `planner.ts`,
`config.ts` (backend host resolution — **the seam for path/host config**).

### `scripts/build-static.ts`
Downloads the MTA static GTFS ZIP → builds the cached SQLite. Run occasionally,
not at boot. Behind the `tools` compose profile.

---

## 4. The interface asphoto must expose (API surface)

All of these are served by `server/src/ws.ts` today. Whatever integration path
you choose, these must remain reachable (ideally under a `/transit` prefix — see
§6):

| Method | Path | Returns |
|--------|------|---------|
| WS | `/` (upgrade) | `ServerMessage { t, legs: TrainLeg[] }` on each feed refresh |
| GET | `/routes` | `RouteMeta[]` |
| GET | `/geo/routes` | GeoJSON route lines |
| GET | `/geo/stations` | GeoJSON station points (id, name, routes, color) |
| GET | `/station/<id>/arrivals` | `StationArrivals` |
| GET | `/alerts` | `ServiceAlert[]` |
| GET | `/status` | `RouteStatus[]` |
| GET | `/plan?from=..&to=..` | `Itinerary` |
| GET | `/health` | `ok` |

The frontend discovers the backend base URL/WS URL in `web/src/config.ts`
(currently derived from `window.location` + port 8090). **This is the single
file to change** to point the built UI at wherever the API ends up.

---

## 5. External requirements & config

- **Env vars:** `PORT` (server), `GTFS_CACHE_DIR` (SQLite location),
  `GTFS_STATIC_URL` (static source), `GEOCODER_URL` (trip-planner geocoder).
- **Cache dir:** the SQLite must live off-boot. TransitPlotter currently uses a
  bind mount to `/cache`; in asphoto, follow its RAID convention, e.g.
  `/srv/active-raid/LIBRARIES/247/photosite/transit/gtfs_static.sqlite`.
- **Native build deps:** `better-sqlite3` needs a C++ toolchain at
  `npm install` time.
- **Outbound network:** the server needs egress to `api-endpoint.mta.info`
  (feeds) and, for the planner, to the geocoder host.
- **Runtime deps (server):** `gtfs-realtime-bindings`, `protobufjs`,
  `@turf/turf` (currently listed; verify actual usage — geometry is hand-rolled,
  so turf may be removable), `better-sqlite3`, `ws`. **web:** `maplibre-gl`.

---

## 6. Recommended integration: separate service, one Caddy, shared repo

**Recommendation: do NOT rewrite the TS server into asphoto's Express app.**
Keep TransitPlotter as its own container and wire it in at the Caddy layer. This
preserves modularity, avoids a TS↔CJS/ESM rewrite, and keeps the heavy
`better-sqlite3`/MapLibre build out of asphoto's lean image.

### 6a. Directory layout inside asphoto
Vendor this repo as a subdirectory (git subtree/submodule or a plain copy):

```
asphoto/
  server/            (unchanged Express app)
  public/            (unchanged static site)
  transit/           <- this entire monorepo (shared/ server/ web/ scripts/)
  compose.yaml       (add a `transit` service; see 6b)
```

Add a link/button from asphoto's landing page (`public/index.html`) to the
transit UI (a new Caddy route/subdomain).

### 6b. Compose: add a second service on the same network
Add to asphoto's `compose.yaml` (keep asphoto's service as-is):

```yaml
  transit:
    build: ./transit            # uses transit/Dockerfile (bookworm + toolchain)
    command: npm run start --workspace server   # tsx src/index.ts
    restart: unless-stopped
    environment:
      - PORT=8080
      - GTFS_CACHE_DIR=/cache
      - GEOCODER_URL=${GEOCODER_URL:-https://nominatim.openstreetmap.org}
    volumes:
      - /srv/active-raid/LIBRARIES/247/photosite/transit:/cache
    networks:
      web:
        aliases: [transit]
```

The built **web UI** should be served as static files. Two clean options:
- **(A) Serve the SPA from asphoto's Express** (recommended): add a Vite build
  stage that outputs to `asphoto/public/transit/`, and set `web/src/config.ts`
  to reach the API at the Caddy-routed path (e.g. `wss://<host>/transit/ws` and
  `https://<host>/transit/api`). Then asphoto serves the map at `/transit`
  with zero extra containers for the frontend.
- **(B) A third static/nginx container** for the SPA. Simpler build isolation,
  one more container.

### 6c. Caddy routes
TransitPlotter needs its API + WS exposed. Pick **subdomain** (cleanest) or
**path prefix**.

Subdomain:
```
transit.alecsavoye.com {
  reverse_proxy transit:8080          # WS upgrade handled automatically
}
```

Or path-prefix on the main site (needs a small prefix strip; the server’s
routes are currently root-relative):
```
alecsavoye.com {
  handle_path /transit/api/* { reverse_proxy transit:8080 }
  handle /transit/ws         { reverse_proxy transit:8080 }
  reverse_proxy asphoto:3000
}
```
If you use a path prefix, either (i) add a configurable base path to `ws.ts`
route matching, or (ii) rely on Caddy `handle_path` to strip `/transit` before
proxying. Update `web/src/config.ts` to match whichever you choose.

### 6d. Static-data bootstrap
Before first run, populate the cache once (off-boot):
```sh
docker compose --profile tools run --rm build-static   # writes to /cache
```
Schedule a periodic rebuild (cron / systemd timer) every few weeks with
`FORCE=1` to refresh the SQLite.

---

## 7. Alternative: full absorption into the Express app (higher effort)

Only if you want a single process/image. This means:
- Port `server/src/*` from TS/ESM to the asphoto runtime — either compile TS to
  JS at build time (add `tsc`/`tsup`) or rewrite as CommonJS.
- Mount the WebSocket on asphoto's existing `http.Server` (share the `ws`
  `WebSocketServer` with `server.on('upgrade')`), and register the HTTP routes
  as Express handlers under `/transit/api/*`.
- Add `better-sqlite3` (+ alpine build deps) and `maplibre-gl` build to
  asphoto's Dockerfile.
- Reuse asphoto's `express-rate-limit` and static serving.

This yields one deployable but couples the two apps and complicates asphoto's
image. **Not recommended** unless single-process is a hard requirement.

---

## 8. Gotchas / checklist for the merging agent

- [ ] **Dockerfile base:** transit needs bookworm (or alpine + `build-base
      python3`) for `better-sqlite3`. asphoto's alpine image alone will fail to
      build it.
- [ ] **ESM vs CJS:** don't `require()` the transit server from asphoto's CJS
      unless you compile/rewrite it (see §7). The separate-service path (§6)
      sidesteps this entirely.
- [ ] **Config seam:** `web/src/config.ts` is the only place the UI learns the
      API/WS location — set it for the chosen Caddy scheme (subdomain vs prefix)
      and `wss://` under HTTPS.
- [ ] **WebSocket over TLS:** ensure the client uses `wss://` when the page is
      HTTPS; Caddy proxies upgrades transparently.
- [ ] **Cache path:** point `GTFS_CACHE_DIR` at a RAID path; never the boot
      drive. Do not commit the SQLite (it's gitignored here).
- [ ] **No host ports:** match asphoto's model — reach transit only via
      `caddy_web`, don't publish 8090/5173 in prod.
- [ ] **Payload size:** each WS refresh is ~390 KB (legs include geometry).
      Fine for LAN/broadband; consider enabling Caddy compression on the WS
      route if needed.
- [ ] **Rate limiting:** the transit server has none; if publicly exposed, add
      Caddy-level limits (asphoto uses `express-rate-limit` internally — mirror
      that at the proxy for transit).
- [ ] **Landing-page link:** add a Transit entry to asphoto's `VISIT_PAGES` /
      `public/index.html` so users can find it.
- [ ] **`@turf/turf`:** listed in `server/package.json` but geometry is
      hand-rolled in `static/geometry.ts`; verify and drop if unused to slim the
      image.
- [ ] **Verify after wiring:** `GET /transit/api/health` → `ok`; `/routes`
      returns JSON; the map loads, trains move, station click shows arrivals,
      `/plan?from=..&to=..` returns an itinerary.

---

## 9. Suggested migration order

1. Vendor `transitplotter/` into `asphoto/transit/` (subtree or copy).
2. Add the `transit` service + `build-static` profile to asphoto `compose.yaml`;
   point the cache at RAID.
3. Run `build-static` once to populate the SQLite.
4. Choose subdomain vs path prefix; add the Caddy route(s).
5. Build the SPA (into `asphoto/public/transit/` or a static container) and set
   `web/src/config.ts` accordingly.
6. Smoke-test the checklist in §8.
7. Add the landing-page link and a periodic `build-static` refresh job.
```
