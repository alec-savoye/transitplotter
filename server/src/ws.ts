// WebSocket + minimal HTTP server. Broadcasts the latest snapshot to all
// connected clients and serves route metadata on request.

import { WebSocketServer, WebSocket } from "ws";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { ServerMessage, RouteMeta } from "@transitplotter/shared";
import type { StaticData } from "./static/load.js";

export class Broadcaster {
  private wss: WebSocketServer;
  private http;
  private latest: ServerMessage = { t: Date.now(), trains: [] };

  // Precomputed GeoJSON for the static map (built once).
  private routesGeoJson: string;
  private stationsGeoJson: string;

  constructor(private stat: StaticData) {
    this.routesGeoJson = JSON.stringify(buildRoutesGeoJson(stat));
    this.stationsGeoJson = JSON.stringify(buildStationsGeoJson(stat));

    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.http });

    this.wss.on("connection", (ws) => {
      // send the current snapshot immediately on connect
      ws.send(JSON.stringify(this.latest));
    });
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url === "/routes") {
      const routes: RouteMeta[] = [...this.stat.routes.values()];
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(routes));
      return;
    }
    if (req.url === "/geo/routes") {
      res.setHeader("Content-Type", "application/json");
      res.end(this.routesGeoJson);
      return;
    }
    if (req.url === "/geo/stations") {
      res.setHeader("Content-Type", "application/json");
      res.end(this.stationsGeoJson);
      return;
    }
    if (req.url === "/health") {
      res.end("ok");
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  }

  broadcast(msg: ServerMessage) {
    this.latest = msg;
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  listen(port: number) {
    this.http.listen(port, () => {
      console.log(`ws+http listening on :${port}`);
    });
  }
}

/** One LineString per representative route+direction shape, colored by route. */
function buildRoutesGeoJson(stat: StaticData): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const line of stat.lineByRouteDir.values()) {
    // key is "<route>|<N|S>"; draw once per shape id.
    if (seen.has(line.shape.id)) continue;
    seen.add(line.shape.id);
    const routeId = line.key.split("|")[0];
    const color = stat.routes.get(routeId)?.color ?? "#888888";
    features.push({
      type: "Feature",
      properties: { route: routeId, color },
      geometry: {
        type: "LineString",
        coordinates: line.shape.points.map((p) => [p.lon, p.lat]),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** One point per parent station (dedupe N/S platforms). */
function buildStationsGeoJson(stat: StaticData): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const s of stat.stops.values()) {
    // Collapse directional platform ids (e.g. "101N"/"101S") to base "101".
    const base = /[NS]$/.test(s.id) ? s.id.slice(0, -1) : s.id;
    if (seen.has(base)) continue;
    seen.add(base);
    features.push({
      type: "Feature",
      properties: { name: s.name },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}
