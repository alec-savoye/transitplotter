// Builds a routable graph from the static GTFS schedule for trip planning.
//
// Nodes are base stations (directional N/S platforms collapsed). Edges:
//   - RIDE: median in-vehicle travel time between consecutive stops on a route,
//           derived from all trips' stop_times.
//   - TRANSFER: walking/waiting between routes at the same station (fixed cost).
// We solve with Dijkstra + a per-boarding penalty to discourage excess
// transfers. This is a schedule-agnostic "typical time" planner (not
// timetable-exact), which is plenty for a live-map trip helper.

import type { StaticData, TripStopTime } from "../static/load.js";

const baseStop = (id: string) => (id.endsWith("N") || id.endsWith("S") ? id.slice(0, -1) : id);

export interface RideEdge {
  to: string; // base station id
  route: string; // route id (base)
  seconds: number; // median travel time
}

export interface TransferEdge {
  to: string; // base station id reachable on foot
  seconds: number; // walking time
}

export interface RoutingGraph {
  /** base station id -> outgoing ride edges. */
  ride: Map<string, RideEdge[]>;
  /** base station id -> nearby stations reachable on foot (transfers). */
  transfer: Map<string, TransferEdge[]>;
  /** base station ids that exist as nodes. */
  stations: Set<string>;
  /**
   * Typical (median) travel time in seconds keyed by "route|fromBase|toBase".
   * Used to estimate how delayed a live leg is vs. its normal schedule.
   */
  typical: Map<string, number>;
}

/** Look up the typical seconds for a segment; direction-agnostic fallback. */
export function typicalSeconds(
  graph: RoutingGraph,
  route: string,
  fromBase: string,
  toBase: string
): number | null {
  const r = route.endsWith("X") ? route.slice(0, -1) : route;
  return (
    graph.typical.get(`${r}|${fromBase}|${toBase}`) ??
    graph.typical.get(`${r}|${toBase}|${fromBase}`) ??
    null
  );
}

/** Max walking distance (m) to treat two distinct stations as a transfer. */
const TRANSFER_MAX_M = 250;
const WALK_SPEED_MPS = 1.35;

function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function stationCoord(stat: StaticData, base: string): [number, number] | null {
  const cands = [
    stat.stops.get(base),
    stat.stops.get(`${base}N`),
    stat.stops.get(`${base}S`),
  ].filter(Boolean) as { lat: number; lon: number }[];
  if (cands.length === 0) return null;
  const lat = cands.reduce((s, c) => s + c.lat, 0) / cands.length;
  const lon = cands.reduce((s, c) => s + c.lon, 0) / cands.length;
  return [lat, lon];
}

/** Median of a numeric array. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Build the graph once at boot. Aggregates travel time across every trip:
 * for each consecutive stop pair (A,B) on the same route we collect
 * dep(A)->arr(B) durations and take the median.
 */
export function buildRoutingGraph(stat: StaticData): RoutingGraph {
  // key "route|from|to" -> durations[]
  const durs = new Map<string, number[]>();
  const stations = new Set<string>();

  for (const [tripId, stops] of stat.tripStops) {
    const trip = stat.trips.get(tripId);
    if (!trip) continue;
    const route = trip.routeId.endsWith("X") ? trip.routeId.slice(0, -1) : trip.routeId;

    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1];
      const b = stops[i];
      const from = baseStop(a.stopId);
      const to = baseStop(b.stopId);
      if (from === to) continue;
      stations.add(from);
      stations.add(to);

      const t0 = a.dep ?? a.arr;
      const t1 = b.arr ?? b.dep;
      if (t0 == null || t1 == null) continue;
      let d = t1 - t0;
      if (d <= 0 || d > 3600) continue; // guard against bad/rollover values
      const key = `${route}|${from}|${to}`;
      let arr = durs.get(key);
      if (!arr) durs.set(key, (arr = []));
      arr.push(d);
    }
  }

  const ride = new Map<string, RideEdge[]>();
  const typical = new Map<string, number>();
  for (const [key, arr] of durs) {
    const [route, from, to] = key.split("|");
    const seconds = Math.round(median(arr));
    let edges = ride.get(from);
    if (!edges) ride.set(from, (edges = []));
    edges.push({ to, route, seconds });
    typical.set(key, seconds);
  }

  // Transfer edges: connect distinct base stations (different lines at the same
  // complex) that are within walking distance. Different services use different
  // stop ids for the same physical station, so without these the graph splits
  // into disconnected per-trunk components.
  const coords: { id: string; lat: number; lon: number }[] = [];
  for (const s of stations) {
    const c = stationCoord(stat, s);
    if (c) coords.push({ id: s, lat: c[0], lon: c[1] });
  }
  const transfer = new Map<string, TransferEdge[]>();
  const addTransfer = (a: string, b: string, sec: number) => {
    let arr = transfer.get(a);
    if (!arr) transfer.set(a, (arr = []));
    arr.push({ to: b, seconds: sec });
  };
  // O(n^2) over ~500 stations is fine at boot.
  for (let i = 0; i < coords.length; i++) {
    for (let j = i + 1; j < coords.length; j++) {
      const d = haversine(coords[i].lat, coords[i].lon, coords[j].lat, coords[j].lon);
      if (d <= TRANSFER_MAX_M) {
        const sec = Math.round(d / WALK_SPEED_MPS) + 60; // walk + platform wait
        addTransfer(coords[i].id, coords[j].id, sec);
        addTransfer(coords[j].id, coords[i].id, sec);
      }
    }
  }

  return { ride, transfer, stations, typical };
}
