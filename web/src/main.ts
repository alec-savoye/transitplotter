import "maplibre-gl/dist/maplibre-gl.css";
import type { ServerMessage, RouteMeta } from "@transitplotter/shared";
import { createMap, addLayers } from "./basemap.js";
import { TrainLayer } from "./trains.js";
import { SERVER_HTTP, SERVER_WS } from "./config.js";

const hud = document.getElementById("hud")!;

async function main() {
  const map = createMap("map");
  await new Promise<void>((r) => map.on("load", () => r()));
  await addLayers(map, SERVER_HTTP);

  // fetch route metadata for colors
  let routes: RouteMeta[] = [];
  try {
    routes = await (await fetch(`${SERVER_HTTP}/routes`)).json();
  } catch {
    console.warn("could not fetch /routes; using default colors");
  }

  const trainLayer = new TrainLayer(map, routes);

  connect(trainLayer);
}

function connect(trainLayer: TrainLayer) {
  const ws = new WebSocket(SERVER_WS);
  ws.onopen = () => (hud.textContent = "connected");
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage;
    trainLayer.update(msg);
    hud.textContent = `${msg.trains.length} trains`;
  };
  ws.onclose = () => {
    hud.textContent = "disconnected — reconnecting…";
    setTimeout(() => connect(trainLayer), 2000);
  };
  ws.onerror = () => ws.close();
}

main();
