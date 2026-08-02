import "maplibre-gl/dist/maplibre-gl.css";
import type maplibregl from "maplibre-gl";
import type { ServerMessage, RouteMeta } from "@transitplotter/shared";
import {
  createMap,
  addLayers,
  fitToAllRoutes,
  setDisruptedRoutes,
  setHotspotsVisible,
  setFerriesVisible,
  setBusBoroughs,
  setBusMinZoom,
  setTrackRecordsVisible,
} from "./basemap.js";
import { TrainLayer } from "./trains.js";
import { buildLegend, attachTrainPopup } from "./ui.js";
import { StationPanel } from "./station.js";
import { AlertsUI } from "./alerts.js";
import { TripPlanner } from "./planner.js";
import { attachHotspotSummary } from "./hotspot.js";
import { TrackRecords } from "./trackrecords.js";
import { attachTrackRecordSummary } from "./trackrecord-summary.js";
import { attachAdmin } from "./admin.js";
import { setupCountsModal } from "./counts-modal.js";
import { setupIsolate } from "./isolate.js";
import { SERVER_HTTP, SERVER_WS, VIEW_MODE, cycleViewMode } from "./config.js";

const hud = document.getElementById("hud")!;

/** Whether the estimated car count is shown in the HUD (and passed through to
 *  the 48h chart). Toggled by the "Cars (est.)" control. */
let carsVisible = true;
/** Latest server message, re-rendered when the cars toggle flips. */
let lastMsg: ServerMessage | null = null;

async function main() {
  const map = createMap("map");

  // fetch route metadata for colors before building layers/bullets
  let routes: RouteMeta[] = [];
  try {
    routes = await (await fetch(`${SERVER_HTTP}/routes`)).json();
  } catch {
    console.warn("could not fetch /routes; using default colors");
  }
  const colorById = new Map(routes.map((r) => [r.id, r.color]));
  const colorFor = (id: string) => colorById.get(id) ?? "#666666";

  await new Promise<void>((r) => map.on("load", () => r()));
  const routesGeo = await addLayers(map, SERVER_HTTP, routes);

  // Start top-down, north up, with the whole system in view.
  fitToAllRoutes(map, routesGeo);

  buildLegend(routes);
  attachTrainPopup(map, colorFor);

  const stationPanel = new StationPanel(SERVER_HTTP);
  stationPanel.attach(map);

  // Line-status strip + alerts drawer; dim/dash disrupted routes on the map.
  const allRouteIds = routes.map((r) => r.id);
  const alertsUI = new AlertsUI(SERVER_HTTP, (disrupted) => {
    setDisruptedRoutes(map, allRouteIds, disrupted);
  });
  alertsUI.start();

  // Trip planner (address-to-address). Hidden until toggled from the controls.
  const planner = new TripPlanner(map, SERVER_HTTP);
  setupPlannerToggle(planner);

  const trainLayer = new TrainLayer(map, routes);

  // "Hotspots" toggle — red delay clouds around heavily delayed trains.
  const isHotspotsOn = setupHotspotsToggle(map);
  // Click a hotspot cloud to see why it's flagged (delayed trains summary).
  attachHotspotSummary(map, trainLayer, colorFor, isHotspotsOn);

  // "Track Records" toggle — persisted reliability mesh (green→red). Locked
  // until enough data is collected; clicking a cell explains its color.
  const trackRecords = new TrackRecords(map, SERVER_HTTP);
  trackRecords.start();
  const isTrackRecordsOn = setupTrackRecordsToggle(map, trackRecords);
  attachTrackRecordSummary(map, trackRecords, isTrackRecordsOn);

  // "Ferries" toggle — show/hide NYC Ferry boats.
  setupFerriesToggle(map);

  // "Cars (est.)" toggle — show/hide the estimated car count in the HUD/chart.
  setupCarsToggle();

  // "Buses" per-borough toggles + zoom-gate slider.
  setupBusControls(map);

  // "View" toggle — force Auto/Mobile/Desktop layout + perf profile.
  setupViewToggle();

  // Hidden admin: quadruple-click the map to open the visitor-stats overlay.
  attachAdmin(map, SERVER_HTTP);

  // Double-click/tap the HUD to open the 48h vehicle-count chart.
  setupCountsModal(SERVER_HTTP);

  // "Isolate" — pick a subway/ferry line to show alone with a live stats box.
  setupIsolate(map, routes, trainLayer);

  connect(trainLayer);
}

/** Fire-and-forget visitor beacon so the server can tally visits + IPs. */
function recordVisit() {
  fetch(`${SERVER_HTTP}/visit`, { method: "GET", keepalive: true }).catch(() => {});
}

/** Per-borough bus toggles + a zoom-gate slider. */
function setupBusControls(map: maplibregl.Map) {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".bus-boro")
  );
  const enabled = () =>
    buttons.filter((b) => b.classList.contains("active")).map((b) => b.dataset.boro!);

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      setBusBoroughs(map, enabled());
    });
  }
  setBusBoroughs(map, enabled()); // apply initial (Manhattan + Brooklyn)

  const slider = document.getElementById("bus-zoom") as HTMLInputElement | null;
  const valEl = document.getElementById("bus-zoom-val");
  if (slider) {
    // Debounce the actual layer update. Calling setLayerZoomRange on every
    // slider "input" tick forces MapLibre to re-initialize the symbol layer,
    // which makes the buses flash in and out while dragging. We update the
    // label live but only apply the zoom gate once the drag settles (and skip
    // redundant applies for the same value).
    let applied = Number(slider.value);
    let debounce: number | null = null;
    const apply = (z: number) => {
      if (z === applied) return;
      applied = z;
      setBusMinZoom(map, z);
    };
    slider.addEventListener("input", () => {
      const z = Number(slider.value);
      if (valEl) valEl.textContent = z.toString();
      if (debounce != null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => apply(z), 150);
    });
    // Ensure the final value is applied immediately when the drag ends.
    slider.addEventListener("change", () => {
      if (debounce != null) window.clearTimeout(debounce);
      apply(Number(slider.value));
    });
  }
}

/**
 * Wires the View toggle: cycles Auto → Mobile → Desktop. Forcing a mode
 * persists the choice and reloads so the map's pixelRatio/pitch and the vehicle
 * FPS cap are re-applied cleanly. The button label reflects the current mode.
 */
function setupViewToggle() {
  const btn = document.getElementById("view-toggle");
  if (!btn) return;
  const label =
    VIEW_MODE === "mobile" ? "View: Mobile" : VIEW_MODE === "desktop" ? "View: Desktop" : "View: Auto";
  btn.textContent = label;
  btn.classList.toggle("active", VIEW_MODE !== "auto");
  btn.addEventListener("click", () => cycleViewMode());
}

/** Wires the Trip Planner on/off toggle button (planner starts hidden). */
function setupPlannerToggle(planner: TripPlanner) {
  const btn = document.getElementById("planner-toggle");
  if (!btn) return;
  const render = () => {
    const on = planner.isVisible();
    btn.classList.toggle("active", on);
    btn.textContent = on ? "Trip Planner: On" : "Trip Planner: Off";
  };
  btn.addEventListener("click", () => {
    planner.setVisible(!planner.isVisible());
    render();
  });
  render();
}

/** Wires the ferries on/off toggle button (ferries start visible). */
function setupFerriesToggle(map: maplibregl.Map) {
  const btn = document.getElementById("ferries-toggle");
  if (!btn) return;
  let on = true;
  const render = () => {
    setFerriesVisible(map, on);
    btn.classList.toggle("active", on);
    btn.textContent = on ? "Ferries: On" : "Ferries: Off";
  };
  btn.addEventListener("click", () => {
    on = !on;
    render();
  });
  render();
}

/**
 * Wires the "Cars (est.)" toggle. Flips `carsVisible`, which hides/shows the
 * HUD 🚗 line and tells the 48h chart whether to draw the cars series. The
 * server keeps recording the estimate regardless; this is purely a display
 * preference. Re-renders the HUD immediately from the last message.
 */
function setupCarsToggle() {
  const btn = document.getElementById("cars-toggle");
  if (!btn) return;
  const render = () => {
    btn.classList.toggle("active", carsVisible);
    btn.textContent = carsVisible ? "Cars (est.): On" : "Cars (est.): Off";
  };
  btn.addEventListener("click", () => {
    carsVisible = !carsVisible;
    render();
    if (lastMsg) renderHud(lastMsg);
  });
  render();
}

/** Whether the estimated car count should currently be displayed. */
export function carsShown(): boolean {
  return carsVisible;
}

/**
 * Wires the Track Records toggle. A cell is only colored once it has been
 * observed across at least one full calendar week; cells with less history show
 * light gray. Until *no* cell yet has a week of data (snapshot.ready === false),
 * clicking opens a "Collecting data" modal explaining the wait. Returns a getter
 * for whether the overlay is currently displayed (used to gate cell-click popups).
 */
function setupTrackRecordsToggle(
  map: maplibregl.Map,
  trackRecords: TrackRecords
): () => boolean {
  const btn = document.getElementById("trackrecords-toggle");
  const modal = document.getElementById("tr-modal");
  const closeBtn = modal?.querySelector<HTMLButtonElement>(".tr-close");
  let on = false;

  const render = () => {
    setTrackRecordsVisible(map, on);
    btn?.classList.toggle("active", on);
    if (btn) btn.textContent = on ? "Track Records: On" : "Track Records: Off";
  };

  const showCollecting = () => {
    if (!modal) return;
    const snap = trackRecords.snapshot();
    const windowDays = snap?.windowDays ?? 7;
    const cells = snap?.cells ?? [];

    // Longest observation span across all cells = how close any cell is to a
    // full week of history.
    const now = Date.now();
    let bestDays = 0;
    let late = 0;
    let obs = 0;
    for (const c of cells) {
      if (c.firstObs) bestDays = Math.max(bestDays, (now - c.firstObs) / 86_400_000);
      late += c.subway.late + c.bus.late;
      obs += c.total;
    }
    const frac = Math.min(1, windowDays > 0 ? bestDays / windowDays : 0);

    const prog = modal.querySelector(".tr-prog");
    const bar = modal.querySelector<HTMLElement>(".tr-bar > span");
    const brk = modal.querySelector(".tr-break");
    if (prog)
      prog.innerHTML = `Each grid cell must be observed across at least <b>${windowDays} days</b>
        before its reliability is shown.<br>
        Longest history so far: <b>${bestDays.toFixed(1)}</b> of ${windowDays} days.`;
    if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
    if (brk) {
      brk.innerHTML = obs
        ? `Across <b>${cells.length}</b> area${cells.length === 1 ? "" : "s"} so far,
           <b>${late}</b> of ${obs} observed segment traversals ran late. Cells still
           collecting data appear light gray on the map.`
        : `No observations yet — data accrues as vehicles complete trips.`;
    }
    modal.classList.add("show");
  };

  closeBtn?.addEventListener("click", () => modal?.classList.remove("show"));
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("show");
  });

  btn?.addEventListener("click", () => {
    if (!on && !trackRecords.isReady()) {
      showCollecting();
      return; // not enough data — don't enable the overlay
    }
    on = !on;
    render();
  });

  return () => on;
}

/** Wires the toggle button; returns a getter for the current on/off state. */
function setupHotspotsToggle(map: maplibregl.Map): () => boolean {
  const btn = document.getElementById("hotspots-toggle");
  let on = false;
  if (btn) {
    btn.addEventListener("click", () => {
      on = !on;
      setHotspotsVisible(map, on);
      btn.classList.toggle("active", on);
      btn.textContent = on ? "Hotspots: On" : "Hotspots: Off";
    });
  }
  return () => on;
}

function connect(trainLayer: TrainLayer) {
  hud.innerHTML = `<div class="hud-status connecting">● Connecting…</div>`;
  const ws = new WebSocket(SERVER_WS);

  ws.onopen = () => {
    hud.innerHTML = `<div class="hud-status live">● Connected — waiting for data…</div>`;
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage;
    lastMsg = msg;
    trainLayer.update(msg);
    renderHud(msg);
  };

  ws.onclose = () => {
    hud.innerHTML = `<div class="hud-status down">● Disconnected — reconnecting…</div>`;
    setTimeout(() => connect(trainLayer), 2000);
  };
  ws.onerror = () => ws.close();
}

/** Render a detailed HUD: connection state, per-mode vehicle counts, freshness. */
function renderHud(msg: ServerMessage) {
  let subway = 0;
  let bus = 0;
  let ferry = 0;
  let stalled = 0;
  let delayed = 0;
  for (const l of msg.legs) {
    const mode = l.mode ?? "subway";
    if (mode === "bus") bus++;
    else if (mode === "ferry") ferry++;
    else subway++;
    if ((l.dly ?? 0) >= 120) delayed++;
  }
  // "stalled" is derived client-side from feed staleness; approximate here by
  // legs whose feed header is >90s old.
  const nowSec = Date.now() / 1000;
  for (const l of msg.legs) if (nowSec - l.hts > 90) stalled++;

  hud.innerHTML = `
    <div class="hud-status live">● Live</div>
    <div class="hud-sub hud-lastpush" title="Time since the server last pushed an update">last update: ${lastPushText(msg.t)}</div>
    <div class="hud-line"><b>${msg.legs.length}</b> vehicles</div>
    <div class="hud-modes">
      <span title="Subway trains">🚇 ${subway}</span>
      <span title="Buses (enabled boroughs)">🚌 ${bus}</span>
      <span title="Ferries">⛴ ${ferry}</span>
    </div>
    ${
      msg.cars != null && carsVisible
        ? `<div class="hud-sub" title="Estimated cars on NYC roads (from live traffic speeds)">🚗 ~${msg.cars.toLocaleString()} cars <span class="hud-est">est.</span></div>`
        : ""
    }
    <div class="hud-sub">${delayed} delayed · ${stalled} stalled</div>
    <div class="hud-hint">double-click for 48h history</div>
  `;
}

/** Human-readable "time since the server last pushed" (from `ServerMessage.t`). */
function lastPushText(serverT: number): string {
  const ageSec = Math.max(0, Math.round((Date.now() - serverT) / 1000));
  if (ageSec < 5) return "just now";
  if (ageSec < 60) return `${ageSec}s ago`;
  const min = Math.floor(ageSec / 60);
  const sec = ageSec % 60;
  return `${min}m ${sec}s ago`;
}

// Tick the "last update" line every second so it stays current between pushes,
// which is why the HUD isn't re-rendered continuously.
setInterval(() => {
  if (!lastMsg) return;
  const el = hud.querySelector<HTMLElement>(".hud-lastpush");
  if (el) el.textContent = `last update: ${lastPushText(lastMsg.t)}`;
}, 1000);

recordVisit();
main();
