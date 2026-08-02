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
import type { TrackRecordStore } from "./trackrecord.js";
import type { InterpErrorStore } from "./interp.js";
import { VisitStore, clientIp } from "./visits.js";
import type { CountStore } from "./counts.js";
import { health } from "./health.js";

/** Admin-page password. Override via ADMIN_PASSWORD env; defaults to "CONFIG". */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "CONFIG";

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
    private graph: RoutingGraph,
    private trackRecords: TrackRecordStore,
    private visits: VisitStore,
    private interpErrors: InterpErrorStore,
    private counts: CountStore
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
    // Visitor beacon: record one page visit + the visitor's (public) IP.
    if (req.url === "/visit") {
      this.visits.record(clientIp(req));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // Admin: password check (gates the UI). Body/query `password`.
    if (req.url && req.url.startsWith("/admin/login")) {
      await this.handleAdminLogin(req, res);
      return;
    }
    // Admin: visitor stats. Requires the admin key via header or ?key=.
    if (req.url && req.url.startsWith("/admin/stats")) {
      if (!this.adminAuthed(req)) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(this.visits.stats()));
      return;
    }
    // Admin: external data-source health (endpoint status). Requires the key.
    if (req.url && req.url.startsWith("/admin/health")) {
      if (!this.adminAuthed(req)) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(health.snapshot()));
      return;
    }
    // Track records: persisted on-time/late history bucketed into a spatial mesh.
    if (req.url === "/trackrecords") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(this.trackRecords.snapshot()));
      return;
    }
    // Per-cell historical series (% lateness vs. date): /trackrecords/history?key=..
    if (req.url && req.url.startsWith("/trackrecords/history")) {
      const url = new URL(req.url, "http://localhost");
      const key = url.searchParams.get("key")?.trim();
      res.setHeader("Content-Type", "application/json");
      if (!key) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "missing key" }));
        return;
      }
      const hist = this.trackRecords.history(key);
      if (!hist) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "unknown cell" }));
        return;
      }
      res.end(JSON.stringify(hist));
      return;
    }
    // Interpolation-error metrics: how well the motion model predicts position.
    if (req.url === "/interp/stats") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(this.interpErrors.stats()));
      return;
    }
    // Rolling 48h vehicle-count series (subway/bus/ferry) for the HUD chart.
    if (req.url === "/counts") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(this.counts.series()));
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
          "Endpoints: /health /routes /geo/routes /geo/stations /trackrecords /counts /visit /alerts /status\n" +
          "           /station/<id>/arrivals  /plan?from=..&to=..  (+ WebSocket)\n"
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  }

  /** Whether a request carries the correct admin key (header or ?key=). */
  private adminAuthed(req: IncomingMessage): boolean {
    const key = ADMIN_PASSWORD;
    const hdr = req.headers["x-admin-key"];
    if (typeof hdr === "string" && hdr === key) return true;
    if (req.url) {
      const url = new URL(req.url, "http://localhost");
      if (url.searchParams.get("key") === key) return true;
    }
    return false;
  }

  /** POST/GET /admin/login?password=.. -> { ok } if the password is correct. */
  private async handleAdminLogin(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Content-Type", "application/json");
    let password = "";
    const url = new URL(req.url!, "http://localhost");
    password = url.searchParams.get("password") ?? "";
    if (!password && req.method === "POST") {
      password = await new Promise<string>((resolve) => {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          try {
            resolve(JSON.parse(body).password ?? "");
          } catch {
            resolve("");
          }
        });
      });
    }
    if (password === ADMIN_PASSWORD) {
      res.end(JSON.stringify({ ok: true, key: ADMIN_PASSWORD }));
    } else {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "wrong password" }));
    }
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
      properties: { route: routeId, color, mode: "subway" },
      geometry: {
        type: "LineString",
        coordinates: line.shape.points.map((p) => [p.lon, p.lat]),
      },
    });
  }

  // Ferry route lines: ferries have no N/S direction, so pick the longest shape
  // per ferry route id straight from trips -> shapes.
  const ferryShapeByRoute = new Map<string, string>();
  for (const trip of stat.trips.values()) {
    if (stat.routeAgency.get(trip.routeId) !== "ferry" || !trip.shapeId) continue;
    const cur = ferryShapeByRoute.get(trip.routeId);
    const curLen = cur ? stat.shapes.get(cur)?.length ?? 0 : -1;
    const thisLen = stat.shapes.get(trip.shapeId)?.length ?? 0;
    if (thisLen > curLen) ferryShapeByRoute.set(trip.routeId, trip.shapeId);
  }
  for (const [routeId, shapeId] of ferryShapeByRoute) {
    const shape = stat.shapes.get(shapeId);
    if (!shape) continue;
    features.push({
      type: "Feature",
      properties: {
        route: routeId,
        color: stat.routes.get(routeId)?.color ?? "#0a3d62",
        mode: "ferry",
      },
      geometry: {
        type: "LineString",
        coordinates: shape.points.map((p) => [p.lon, p.lat]),
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

    // Tag by agency prefix so the client can layer/zoom-gate each mode.
    const isFerry = s.id.startsWith("F:");
    const isBus = s.id.startsWith("B:");
    const mode = isFerry ? "ferry" : isBus ? "bus" : "subway";

    const routeIds = [...(routesByStation.get(base) ?? [])].sort();
    const primary = routeIds[0];
    const color = isFerry
      ? "#0a3d62"
      : isBus
        ? "#1b7fc4"
        : (primary && stat.routes.get(primary)?.color) || "#0b60d6";

    features.push({
      type: "Feature",
      properties: {
        id: base, // base station id, for arrivals lookups
        name: s.name,
        routes: routeIds.join(""), // e.g. "456"
        color,
        mode,
      },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}
