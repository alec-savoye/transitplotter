# AGENTS.md — session context & working notes

This file is **for AI coding agents (and humans resuming this work)**. It is
*not* a replacement for `README.md` (what the app is / how to run it) or
`MAINTENANCE.md` (how it hangs together / how to fix it). Read those first. This
file captures **session-specific context, decisions, and gotchas** that would
bloat those docs but are valuable when picking the work back up.

> Keep this file append-oriented. When you finish a work session, add a dated
> entry under "Session log" describing what changed and why. Don't rewrite
> history; correct it with a new note if something was wrong.

---

## How to operate in this repo (environment)

- **Docker only. Nothing is installed on the host.** Node/tsx/vite all run in
  containers. Do not try to `npm install` or run `node`/`tsc` on the host.
- **The user wants rebuilds done for them.** Standing instruction from the user:
  > "please do `docker compose up -d --build` every time I request a change that
  > requires doing that so I don't have to."
  So: after any change to server/shared/web source that needs a container
  rebuild to take effect, run:
  ```bash
  docker compose up -d --build server web
  ```
  (The server runs `tsx watch`, so trivial edits hot-reload; but rebuild when in
  doubt, after dependency/Dockerfile changes, or to force a clean restart.)
- **Typecheck gates** (there are no unit tests). Run both before declaring done:
  ```bash
  docker compose exec -T web    sh -c 'cd /app && node_modules/typescript/bin/tsc --noEmit -p web/tsconfig.json'
  docker compose exec -T server sh -c 'cd /app && node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json'
  ```
- **Ports:** UI http://localhost:5173, API http://localhost:8090 (host) → 8080
  (container). Health: `curl -s http://localhost:8090/health` → `ok`.
- **Persistent data lives OFF the repo**, bind-mounted from `GTFS_CACHE_HOST`.
  On this deployment that is:
  ```
  /srv/active-raid/LIBRARIES/247/transitplotter
  ```
  It contains `gtfs_static.sqlite`, `track_records.json`, `visits.json`,
  `interp_errors.json`, `counts.json`, and the containers' `node_modules`.
- **`.env` (gitignored) on this box** sets `BUS_API_KEY`, `VITE_ALLOWED_HOSTS`
  (`train.alecsavoye.com`), and `GTFS_CACHE_HOST` (the path above).
- **Inspecting stores without Node on the host:** use `python3` /
  `curl`, or run node *inside* the container, e.g.:
  ```bash
  docker compose exec -T server node -e '...'
  ```

---

## Project shape (one-paragraph refresher)

npm monorepo, 3 workspaces: `shared/` (pure TS wire contract + `kinematics.ts`
runtime math, imported as raw `.ts`), `server/` (Node via `tsx`, polls MTA
feeds, serves HTTP+WS from `ws.ts`), `web/` (Vite + MapLibre, dumb renderer).
The subway realtime feed has **no coordinates**, so the server derives each
train's current *leg* (track slice + schedule times) and the browser
interpolates smooth positions client-side (trapezoidal profile + follower;
see MAINTENANCE.md §6.5). Buses/ferries carry GPS. See `README.md` "Source
layout" for the full file map.

---

## Session log

### 2026-08 — Track-record delay bug, mode-fair coloring, decayed storage

Worked three related requests. All changes typechecked and deployed via
`docker compose up -d --build server web`.

**1. Bug: track-record tiles reported ~0% delays everywhere.**
- Root cause in `server/src/bus.ts`: it read schedule deviation from
  `stopTimeUpdate.arrival.delay` / `.departure.delay`, but the MTA Bus Time
  (OneBusAway) feed **never populates those stop-level fields** — protobuf
  decodes the absent field to its default `0`, so every bus looked on-time.
- The real deviation is **`tripUpdate.delay`** (trip level). Verified live: all
  ~1,885 trips carried `tripUpdate.delay` (30.9% ≥120s late) while 0 of ~33,814
  `stopTimeUpdate`s had a stop-level delay.
- Why it nuked the whole map: buses are ~**87%** of all track-record
  observations, so the flood of false on-time bus samples dragged each cell's
  blended late rate to ~0.01% → rounds to 0%.
- Fix: read `tripUpdate.delay` and attach it to the chosen next-stop prediction.
  Confirmed `busDelayed` went 0 → ~280 in `/counts`, and WS frames now have bus
  legs with `dly` set.

**2. Mode-fair tile color (user: "average the three percentages").**
- Changed `TrackRecordStore.snapshot()` to color tiles by the **average of the
  per-mode late percentages** (subway & bus weighted equally; only modes with
  observations contribute), via `modeRate()` in `server/src/trackrecord.ts` —
  NOT a raw pooled `(subwayLate+busLate)/(subwayTotal+busTotal)` (which let
  ~87%-of-volume buses swamp subway). Ferries are still untracked (no delay
  signal), so "three percentages" is in practice subway+bus.
- Popups (`web/src/trackrecord-summary.ts`) and the "collecting data" modal
  (`web/src/main.ts`) now show each mode's own % separately.

**3. Poisoned history wiped + collection window changed + bounded storage.**
- **Deleted the poisoned `track_records.json`** (had 40M lifetime obs dominated
  by the buggy on-time bus samples). Procedure that actually works (the server
  flushes on a 60s timer, so you must stop it first):
  ```bash
  docker compose stop server
  rm -f /srv/active-raid/LIBRARIES/247/transitplotter/track_records.json
  docker compose start server
  ```
- **Window shortened 7 → 1 day** (`WINDOW_DAYS = 1`).
- **Storage is now O(cells), not O(observations).** Replaced lifetime integer
  counts with a **time-decayed exponential moving average** per mode: on each
  observation the existing `late`/`total` weights are multiplied by
  `0.5^(dt/DECAY_HALFLIFE_MS)` (half-life 1 day) then the new sample (weight 1)
  is added. Weights converge to a bounded value (~halflife × rate; observed max
  ~52), so the file no longer grows with runtime and the % tracks *recent*
  reliability. A `ready` cell that stops being observed fades back to gray —
  intended. `MIN_READY_WEIGHT` (5) avoids grading a cell off one/two samples.
  Daily trend series pruned to `MAX_HISTORY_DAYS` (14).
- Tallies on the wire (`TrackRecordModeTally.late/total`) are now **rounded
  decayed weights**, not lifetime integers — documented in `shared/src/types.ts`.

**Files touched this session:**
`server/src/{bus,legwire,state,trackrecord}.ts`, `shared/src/types.ts`,
`web/src/{trackrecord-summary,main,basemap,trackrecords}.ts`, plus docs
`README.md` and `MAINTENANCE.md`.

**Docs work also done:** converted the two ASCII diagrams in MAINTENANCE.md to
**mermaid** (`flowchart` for data-flow §3 and a type-map for §6.1); expanded the
wire-contract section (§6) with a full `TrainLeg` field table and per-endpoint
type map; added missing endpoints to the README/MAINTENANCE endpoint lists
(`/admin/health`, `/interp/stats`, `/counts`, etc.); corrected the "no
observability" open-item now that `health.ts` + `/admin/health` exist.

**Uncommitted at session end:** all of the above was left as working-tree
changes (git status showed them unstaged; only `5c85e9d "updates"` predates this
session). Commit when ready.

### 2026-08 (later) — 48h delay charts (borough split, normalize, ≥10min) + mobile UX

Continuation session on the `/counts` HUD charts and mobile layout. All changes
typechecked (`tsc --noEmit` web+server) and deployed via
`docker compose up -d --build`.

**1. Delayed-bus lines split by borough on their own right axis.**
- Added per-borough tallies to the counts sample: server (`tick.ts`) now fills
  `busDelayedBoro` (and `busActiveBoro`) each poll; persisted/loaded in
  `counts.ts`; typed in `shared/src/types.ts` (`Partial<Record<string,number>>`,
  absent on old points). The delay chart draws 5 borough lines on the right Y
  axis (subway+ferry stay on the left) since delayed buses are ~1–2 orders of
  magnitude higher.

**2. "Bus lateness: Count / % of active" normalize toggle.**
- Per-chart button that recomputes the bus lines as `busXDelayedBoro /
  busActiveBoro` on a fixed 0–100 % right axis (`rightMax`/`pct` on the series).
  `busActiveBoro` is the denominator (active buses per borough per sample).

**3. Second delay chart for ≥10 min ("severely delayed").**
- New tier fields `subwayVeryDelayed` / `busVeryDelayed` / `busVeryDelayedBoro`
  / `ferryVeryDelayed` (threshold `VERY_LATE_THRESHOLD_S = 600`, a subset of the
  ≥120s tier). `counts-modal.ts` was refactored so both delay charts share one
  `bindDelayChart(tier, suffix)` with a `DelayTier` accessor
  (`TIER_DELAYED` / `TIER_VERY_DELAYED`); each chart keeps its own independent
  normalize toggle.
- **Caveat:** these per-borough / severe / active fields are only recorded from
  their deploy forward — older points in the rolling 48h window plot as 0 for
  the new series until they age out. Not a bug.

**4. Mobile declutter.**
- Controls now collapse behind a ☰ `#menu-fab` that slides in `#controls`
  (`tp-menu-open` on `<html>`, wired by `setupMobileMenu()` in `main.ts`). HUD
  shrinks to a status chip, legend hidden. Mobile CSS keys off a new
  `tp-mobile-on` class that `config.ts` sets whenever `IS_MOBILE` is effective;
  the rules are duplicated under the `@media` query (auto) and the class
  (forced) because CSS can't OR them. Tapping a top-level control closes the
  menu (bus-borough toggles exempt); tapping the map closes it too.
- Verified with headless Chrome at 390×844 (menu opens/closes, legend+HUD lines
  hidden) and 1400×900 (no menu button, full controls, `<html>` has no mobile
  class). Desktop unchanged.

**Files touched:** `server/src/{tick,counts}.ts`, `shared/src/types.ts`,
`web/src/{counts-modal,config,main}.ts`, `web/index.html`, docs
`README.md` / `MAINTENANCE.md` / `AGENTS.md`. Note interim commit
`b2f549f "is this slop?"` landed mid-session; later edits are working-tree.

---

## Known gotchas / landmines (carry forward)

- **`bus.ts` delay = `tripUpdate.delay`, never stop-level.** If bus delays go to
  zero again, this is the first suspect (see bug #1 above).
- **Deleting a store file requires stopping the server first** — it flushes
  every 60s and on SIGTERM, so a live `rm` gets overwritten. `docker compose
  stop server` → delete → `start`.
- **Track-record tallies are decayed weights, not counts.** Don't reintroduce
  lifetime summing "to be accurate" — that's the O(n) growth we removed and it
  also re-enables the bus-volume-swamps-subway failure mode.
- **`shared/` is imported as raw `.ts` by both sides**; a syntax error there
  breaks server and web at once, and there's no cross-deploy compile gate — keep
  producer/consumer changes in the same commit.
- **`basemap.ts` layer/source ids are string contracts** (`"trackrecords-fill"`,
  `"trains"`, `"buses"`, …). Renaming silently breaks toggles; grep first.
- **No CI.** The two `tsc --noEmit` commands above are the only automated gate.

## Tunable knobs added/changed this session (see MAINTENANCE.md §8 for the full table)

| Constant | File | Value | Note |
| --- | --- | --- | --- |
| `WINDOW_DAYS` | `trackrecord.ts` | `1` | Was 7. Span before a cell colors. |
| `DECAY_HALFLIFE_MS` | `trackrecord.ts` | `86_400_000` | Half-life of per-mode decayed tally; keeps storage bounded. |
| `MIN_READY_WEIGHT` | `trackrecord.ts` | `5` | Min decayed weight before grading a cell. |
| `MAX_HISTORY_DAYS` | `trackrecord.ts` | `14` | Daily trend series prune length. |
