// Loads the committed GTFS static SQLite into in-memory structures and
// precomputes per-shape geometry with cumulative distances so we can find a
// train's position along the track quickly at runtime.

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RouteMeta } from "@transitplotter/shared";
import { projectDistance } from "./geometry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Read from the off-boot-drive cache. GTFS_CACHE_DIR is set in the container;
// falls back to a local .cache dir for standalone runs.
const CACHE_DIR =
  process.env.GTFS_CACHE_DIR ?? join(__dirname, "..", "..", "..", ".cache");
const DB_PATH = join(CACHE_DIR, "gtfs_static.sqlite");

export interface ShapePoint {
  lat: number;
  lon: number;
  /** Cumulative distance from shape start, in meters. */
  dist: number;
}

export interface Shape {
  id: string;
  points: ShapePoint[];
  /** Total length in meters. */
  length: number;
}

export interface TripStatic {
  tripId: string;
  routeId: string;
  shapeId: string;
  directionId: number | null;
  headsign?: string;
}

export interface StopStatic {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/** A stop within a trip, with schedule times (seconds since service midnight). */
export interface TripStopTime {
  stopId: string;
  shapeDist: number | null;
  arr: number | null;
  dep: number | null;
}

/** Canonical ordered stops for a route+direction, projected onto a shape. */
export interface RouteDirLine {
  key: string; // "<route>|<N|S>"
  shape: Shape; // representative (longest) shape
  /** stopId -> distance along `shape` (meters). */
  stopDist: Map<string, number>;
  /** ordered stopIds by distance. */
  order: string[];
}

export interface StaticData {
  routes: Map<string, RouteMeta>;
  stops: Map<string, StopStatic>;
  trips: Map<string, TripStatic>;
  shapes: Map<string, Shape>;
  /** trip_id -> ordered stop times. */
  tripStops: Map<string, TripStopTime[]>;
  /** "<routeId>|<N|S>" -> candidate shapes (RT trip ids don't name a shape). */
  shapesByRouteDir: Map<string, Shape[]>;
  /** "<routeId>|<N|S>" -> canonical line used for interpolation. */
  lineByRouteDir: Map<string, RouteDirLine>;
  /** route_id -> agency ("subway" | "ferry"). */
  routeAgency: Map<string, string>;
}

/**
 * Shape ids encode route + direction with one or more dots before the
 * direction letter, e.g. "5..N08R" -> 5/N, "GS.N01R" -> GS/N, "SI..S03R" -> SI/S.
 */
function shapeRouteDir(shapeId: string): { route: string; dir: string } | null {
  const m = /^(.+?)\.+([NS])/.exec(shapeId);
  if (!m) return null;
  return { route: m[1], dir: m[2] };
}

// Haversine distance in meters.
function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function loadStatic(): StaticData {
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `GTFS static DB not found at ${DB_PATH}. Run \`docker compose run --rm build-static\` first.`
    );
  }
  const db = new Database(DB_PATH, { readonly: true });

  // routes
  const routes = new Map<string, RouteMeta>();
  const routeAgency = new Map<string, string>();
  for (const r of db
    .prepare(`SELECT route_id, route_short_name, route_long_name, route_color, agency FROM routes`)
    .all() as any[]) {
    routes.set(r.route_id, {
      id: r.route_id,
      color: r.route_color ? `#${r.route_color}` : "#888888",
      name: r.route_long_name || r.route_short_name || r.route_id,
    });
    routeAgency.set(r.route_id, r.agency ?? "subway");
  }

  // stops (only those with coordinates)
  const stops = new Map<string, StopStatic>();
  for (const s of db
    .prepare(`SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops WHERE stop_lat IS NOT NULL`)
    .all() as any[]) {
    stops.set(s.stop_id, {
      id: s.stop_id,
      name: s.stop_name,
      lat: s.stop_lat,
      lon: s.stop_lon,
    });
  }

  // trips
  const trips = new Map<string, TripStatic>();
  for (const t of db
    .prepare(`SELECT trip_id, route_id, shape_id, direction_id FROM trips`)
    .all() as any[]) {
    trips.set(t.trip_id, {
      tripId: t.trip_id,
      routeId: t.route_id,
      shapeId: t.shape_id,
      directionId: t.direction_id,
    });
  }

  // shapes: build ordered points and compute cumulative distances.
  const shapes = new Map<string, Shape>();
  const shapeRows = db
    .prepare(`SELECT shape_id, seq, lat, lon, dist FROM shapes ORDER BY shape_id, seq`)
    .all() as any[];
  let cur: Shape | null = null;
  for (const row of shapeRows) {
    if (!cur || cur.id !== row.shape_id) {
      cur = { id: row.shape_id, points: [], length: 0 };
      shapes.set(row.shape_id, cur);
    }
    const pts = cur.points;
    let dist: number;
    if (row.dist != null) {
      dist = row.dist;
    } else if (pts.length === 0) {
      dist = 0;
    } else {
      const prev = pts[pts.length - 1];
      dist = prev.dist + haversine(prev.lat, prev.lon, row.lat, row.lon);
    }
    pts.push({ lat: row.lat, lon: row.lon, dist });
    cur.length = dist;
  }

  // stop_times -> tripStops (now including scheduled arr/dep seconds-of-day)
  const tripStops = new Map<string, TripStopTime[]>();
  const stRows = db
    .prepare(
      `SELECT trip_id, stop_id, seq, shape_dist, arr, dep FROM stop_times ORDER BY trip_id, seq`
    )
    .all() as any[];
  for (const row of stRows) {
    let arr = tripStops.get(row.trip_id);
    if (!arr) {
      arr = [];
      tripStops.set(row.trip_id, arr);
    }
    arr.push({
      stopId: row.stop_id,
      shapeDist: row.shape_dist,
      arr: row.arr ?? null,
      dep: row.dep ?? null,
    });
  }

  db.close();

  // Index shapes by route+direction so we can pick a plausible shape for a
  // realtime trip (whose id doesn't reference a static shape_id directly).
  const shapesByRouteDir = new Map<string, Shape[]>();
  for (const shape of shapes.values()) {
    const rd = shapeRouteDir(shape.id);
    if (!rd) continue;
    const key = `${rd.route}|${rd.dir}`;
    let arr = shapesByRouteDir.get(key);
    if (!arr) shapesByRouteDir.set(key, (arr = []));
    arr.push(shape);
  }

  // Build a canonical line per route+direction: pick the longest shape as the
  // representative geometry, gather every stop served by that route+dir (from
  // static trips), and project each stop onto the shape to get its distance.
  // This lets us order stops and locate a train even when the realtime feed
  // only lists upcoming stops.
  const stopsByRouteDir = new Map<string, Set<string>>();
  for (const trip of trips.values()) {
    if (!trip.shapeId) continue;
    const rd = shapeRouteDir(trip.shapeId);
    if (!rd) continue;
    const key = `${rd.route}|${rd.dir}`;
    let set = stopsByRouteDir.get(key);
    if (!set) stopsByRouteDir.set(key, (set = new Set()));
    for (const st of tripStops.get(trip.tripId) ?? []) set.add(st.stopId);
  }

  const lineByRouteDir = new Map<string, RouteDirLine>();
  for (const [key, candidates] of shapesByRouteDir) {
    const shape = candidates.reduce((a, b) => (b.length > a.length ? b : a));
    const stopIds = stopsByRouteDir.get(key);
    if (!stopIds) continue;
    const stopDist = new Map<string, number>();
    for (const sid of stopIds) {
      const s = stops.get(sid);
      if (!s) continue;
      stopDist.set(sid, projectDistance(shape, s.lat, s.lon).dist);
    }
    const order = [...stopDist.keys()].sort(
      (a, b) => stopDist.get(a)! - stopDist.get(b)!
    );
    lineByRouteDir.set(key, { key, shape, stopDist, order });
  }

  return {
    routes,
    stops,
    trips,
    shapes,
    tripStops,
    shapesByRouteDir,
    lineByRouteDir,
    routeAgency,
  };
}
