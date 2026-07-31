// WebSocket + minimal HTTP server. Broadcasts the latest train legs to all
// connected clients (only when the feed refreshes) and serves route metadata
// and the JSON APIs. Clients interpolate live positions from the legs.

import { WebSocketServer, WebSocket } from "ws";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { ServerMessage, RouteMeta } from "@transitplotter/shared";
import type { StaticData } from "./static/load.js";
import type { FeedStore } from "./feedstore.js";
import { buildStationArrivals } from "./arrivals.js";
import { rollUpStatus } from "./alerts.js";
import type { RoutingGraph } from "./routing/graph.js";
import { planJourney } from "./routing/plan.js";
import { geocode } from "./routing/geocode.js";

export class Broadcaster {
  private wss: WebSocketServer;
  private http;
  private latest: ServerMessage = { t: Date.now(), legs: [] };

  // Precomputed GeoJSON for the static map (built once).
  private routesGeoJson: string;
  private stationsGeoJson: string;

  constructor(
    private stat: StaticData,
    private feedStore: FeedStore,
    private graph: RoutingGraph
  ) {
    this.routesGeoJson = JSON.stringify(buildRoutesGeoJson(stat));
    this.stationsGeoJson = JSON.stringify(buildStationsGeoJson(stat));

    this.http = createServer((req, res) => {
      this.handleHttp(req, res).catch((e) => {
        console.error("http error", e);
        if (!res.headersSent) res.statusCode = 500;
        res.end(JSON.stringify({ error: "internal error" }));
      });
    });
    this.wss = new WebSocketServer({ server: this.http });

    this.wss.on("connection", (ws) => {
      // send the current snapshot immediately on connect
      ws.send(JSON.stringify(this.latest));
    });
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Trip planner: /plan?from=<addr|lat,lon>&to=<addr|lat,lon>
    if (req.url && req.url.startsWith("/plan")) {
      await this.handlePlan(req, res);
      return;
    }
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
    // All active subway alerts.
    if (req.url === "/alerts") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(this.feedStore.getAlerts()));
      return;
    }
    // Per-route rolled-up status for the line-status strip.
    if (req.url === "/status") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(rollUpStatus(this.feedStore.getAlerts(), this.stat)));
      return;
    }
    // Live arrivals board: /station/<stopId>/arrivals
    const m = req.url && /^\/station\/([^/]+)\/arrivals\/?$/.exec(req.url);
    if (m) {
      const stationId = decodeURIComponent(m[1]);
      const arrivals = buildStationArrivals(
        stationId,
        this.feedStore.get(),
        this.stat,
        this.feedStore.getAlerts()
      );
      res.setHeader("Content-Type", "application/json");
      if (!arrivals) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "unknown station" }));
        return;
      }
      res.end(JSON.stringify(arrivals));
      return;
    }
    if (req.url === "/health") {
      res.end("ok");
      return;
    }
    if (req.url === "/" || req.url === "") {
      res.setHeader("Content-Type", "text/plain");
      res.end(
        "TransitPlotter backend (API only).\n" +
          "The map UI is served separately on port 5173.\n\n" +
          "Endpoints: /health /routes /geo/routes /geo/stations /alerts /status\n" +
          "           /station/<id>/arrivals  /plan?from=..&to=..  (+ WebSocket)\n"
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  }

  /** Handle GET /plan?from=..&to=.. : geocode both ends, then plan a journey. */
  private async handlePlan(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url!, "http://localhost");
    const from = url.searchParams.get("from")?.trim();
    const to = url.searchParams.get("to")?.trim();
    if (!from || !to) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "missing from/to" }));
      return;
    }

    const [o, d] = await Promise.all([geocode(from), geocode(to)]);
    if (!o || !d) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "could not geocode origin or destination" }));
      return;
    }

    const itinerary = planJourney(this.stat, this.graph, o, d);
    if (!itinerary) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "no route found" }));
      return;
    }
    res.end(JSON.stringify(itinerary));
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

/** One point per parent station (dedupe N/S platforms), colored by line. */
function buildStationsGeoJson(stat: StaticData): GeoJSON.FeatureCollection {
  const baseStop = (id: string) => (/[NS]$/.test(id) ? id.slice(0, -1) : id);

  // Which routes serve each base station? Derive from the canonical lines.
  const routesByStation = new Map<string, Set<string>>();
  for (const line of stat.lineByRouteDir.values()) {
    const routeId = line.key.split("|")[0];
    for (const stopId of line.stopDist.keys()) {
      const base = baseStop(stopId);
      let set = routesByStation.get(base);
      if (!set) routesByStation.set(base, (set = new Set()));
      set.add(routeId);
    }
  }

  const features: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const s of stat.stops.values()) {
    const base = baseStop(s.id);
    if (seen.has(base)) continue;
    seen.add(base);

    const routeIds = [...(routesByStation.get(base) ?? [])].sort();
    // Pick the first serving route's color as the pin color.
    const primary = routeIds[0];
    const color = (primary && stat.routes.get(primary)?.color) || "#0b60d6";

    features.push({
      type: "Feature",
      properties: {
        id: base, // base station id, for arrivals lookups
        name: s.name,
        routes: routeIds.join(""), // e.g. "456"
        color,
      },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}
