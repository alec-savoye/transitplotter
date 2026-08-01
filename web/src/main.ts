import "maplibre-gl/dist/maplibre-gl.css";
import type maplibregl from "maplibre-gl";
import type { ServerMessage, RouteMeta } from "@transitplotter/shared";
import { createMap, addLayers, setDisruptedRoutes, setHotspotsVisible, setFerriesVisible } from "./basemap.js";
import { TrainLayer } from "./trains.js";
import { buildLegend, attachTrainPopup } from "./ui.js";
import { StationPanel } from "./station.js";
import { AlertsUI } from "./alerts.js";
import { TripPlanner } from "./planner.js";
import { attachHotspotSummary } from "./hotspot.js";
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

  // "Ferries" toggle — show/hide NYC Ferry boats.
  setupFerriesToggle(map);

  connect(trainLayer);
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
  const ws = new WebSocket(SERVER_WS);
  ws.onopen = () => (hud.textContent = "connected");
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage;
    trainLayer.update(msg);
    hud.textContent = `${msg.legs.length} trains`;
  };
  ws.onclose = () => {
    hud.textContent = "disconnected — reconnecting…";
    setTimeout(() => connect(trainLayer), 2000);
  };
  ws.onerror = () => ws.close();
}

main();
