import "maplibre-gl/dist/maplibre-gl.css";
import type maplibregl from "maplibre-gl";
import type { ServerMessage, RouteMeta } from "@transitplotter/shared";
import {
  createMap,
  addLayers,
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
import { SERVER_HTTP, SERVER_WS } from "./config.js";

const hud = document.getElementById("hud")!;

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
  await addLayers(map, SERVER_HTTP, routes);

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

  // Trip planner (address-to-address).
  new TripPlanner(map, SERVER_HTTP);

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

  // "Buses" per-borough toggles + zoom-gate slider.
  setupBusControls(map);

  connect(trainLayer);
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
    slider.addEventListener("input", () => {
      const z = Number(slider.value);
      if (valEl) valEl.textContent = z.toString();
      setBusMinZoom(map, z);
    });
  }
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

  const ageSec = Math.max(0, Math.round((Date.now() - msg.t) / 1000));
  const ageText = ageSec < 5 ? "just now" : `${ageSec}s ago`;

  hud.innerHTML = `
    <div class="hud-status live">● Live</div>
    <div class="hud-line"><b>${msg.legs.length}</b> vehicles</div>
    <div class="hud-modes">
      <span title="Subway trains">🚇 ${subway}</span>
      <span title="Buses (enabled boroughs)">🚌 ${bus}</span>
      <span title="Ferries">⛴ ${ferry}</span>
    </div>
    <div class="hud-sub">${delayed} delayed · ${stalled} stalled</div>
    <div class="hud-sub">updated ${ageText}</div>
  `;
}

main();
