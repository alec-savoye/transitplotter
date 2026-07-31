import "maplibre-gl/dist/maplibre-gl.css";
import type { ServerMessage, RouteMeta } from "@transitplotter/shared";
import { createMap, addLayers, setDisruptedRoutes } from "./basemap.js";
import { TrainLayer } from "./trains.js";
import { buildLegend, attachTrainPopup } from "./ui.js";
import { StationPanel } from "./station.js";
import { AlertsUI } from "./alerts.js";
import { TripPlanner } from "./planner.js";
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
  connect(trainLayer);
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
