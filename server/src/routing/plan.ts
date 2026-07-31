// Journey search over the routing graph: Dijkstra with a per-boarding transfer
// penalty. Origin/destination are arbitrary coordinates; we snap each to the
// nearest station(s) with a short walking access/egress leg.
//
// Search states are (station, routeAboard) so that continuing on the same route
// is free while switching routes costs a transfer penalty.

import type { Itinerary, ItineraryLeg } from "@transitplotter/shared";
import type { StaticData } from "../static/load.js";
import type { RoutingGraph } from "./graph.js";

const baseStop = (id: string) => (id.endsWith("N") || id.endsWith("S") ? id.slice(0, -1) : id);

/** Fixed cost (seconds) added per transfer to discourage extra boardings. */
const TRANSFER_PENALTY_S = 300;
/** Assumed walking speed (m/s) for access/egress; max snap distance (m). */
const WALK_SPEED = 1.35;
const MAX_SNAP_M = 1200;
/** How many nearby stations to consider at each end. */
const SNAP_K = 4;

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

function stationName(stat: StaticData, base: string): string {
  return (
    stat.stops.get(base)?.name ??
    stat.stops.get(`${base}N`)?.name ??
    stat.stops.get(`${base}S`)?.name ??
    base
  );
}

function nearestStations(
  stat: StaticData,
  graph: RoutingGraph,
  lat: number,
  lon: number
): { id: string; dist: number }[] {
  const out: { id: string; dist: number }[] = [];
  for (const base of graph.stations) {
    const c = stationCoord(stat, base);
    if (!c) continue;
    const d = haversine(lat, lon, c[0], c[1]);
    if (d <= MAX_SNAP_M) out.push({ id: base, dist: d });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, SNAP_K);
}

interface Node {
  station: string;
  route: string | null; // route aboard (null before first boarding)
}
const nkey = (n: Node) => `${n.station}|${n.route ?? ""}`;

interface Back {
  prevKey: string | null; // predecessor state key (null = access start)
  station: string;
  route: string | null;
  edgeRoute: string | null; // route ridden to reach this node (null = access)
  rideSeconds: number; // seconds for that edge (or access walk)
}

export function planJourney(
  stat: StaticData,
  graph: RoutingGraph,
  origin: { name: string; lat: number; lon: number },
  destination: { name: string; lat: number; lon: number }
): Itinerary | null {
  const starts = nearestStations(stat, graph, origin.lat, origin.lon);
  const goals = nearestStations(stat, graph, destination.lat, destination.lon);
  if (starts.length === 0 || goals.length === 0) return null;
  const goalEgress = new Map(goals.map((g) => [g.id, g.dist / WALK_SPEED]));

  const dist = new Map<string, number>();
  const back = new Map<string, Back>();
  const pq: { cost: number; key: string; node: Node }[] = [];
  const push = (cost: number, node: Node) => {
    pq.push({ cost, key: nkey(node), node });
    pq.sort((a, b) => a.cost - b.cost);
  };

  for (const s of starts) {
    const access = s.dist / WALK_SPEED;
    const node: Node = { station: s.id, route: null };
    const k = nkey(node);
    dist.set(k, access);
    back.set(k, {
      prevKey: null,
      station: s.id,
      route: null,
      edgeRoute: null,
      rideSeconds: access,
    });
    push(access, node);
  }

  let bestKey: string | null = null;
  let bestCost = Infinity;

  while (pq.length) {
    const cur = pq.shift()!;
    if (cur.cost > (dist.get(cur.key) ?? Infinity)) continue;

    const egress = goalEgress.get(cur.node.station);
    if (egress != null) {
      const total = cur.cost + egress;
      if (total < bestCost) {
        bestCost = total;
        bestKey = cur.key;
      }
    }

    for (const e of graph.ride.get(cur.node.station) ?? []) {
      const penalty =
        cur.node.route !== null && cur.node.route !== e.route ? TRANSFER_PENALTY_S : 0;
      const nc = cur.cost + e.seconds + penalty;
      const next: Node = { station: e.to, route: e.route };
      const nk = nkey(next);
      if (nc < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nc);
        back.set(nk, {
          prevKey: cur.key,
          station: e.to,
          route: e.route,
          edgeRoute: e.route,
          rideSeconds: e.seconds,
        });
        push(nc, next);
      }
    }

    // Walking transfers to nearby stations (a different physical platform of the
    // same complex). Resets the "route aboard" to null so the next boarding
    // counts as a transfer.
    for (const e of graph.transfer.get(cur.node.station) ?? []) {
      const nc = cur.cost + e.seconds;
      const next: Node = { station: e.to, route: null };
      const nk = nkey(next);
      if (nc < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nc);
        back.set(nk, {
          prevKey: cur.key,
          station: e.to,
          route: null,
          edgeRoute: null, // walk; not a ride leg
          rideSeconds: e.seconds,
        });
        push(nc, next);
      }
    }
  }

  if (!bestKey) return null;

  // Walk back-pointers to build the ordered edge chain.
  const chain: Back[] = [];
  let k: string | null = bestKey;
  while (k) {
    const b = back.get(k);
    if (!b) break;
    chain.push(b);
    k = b.prevKey;
  }
  chain.reverse();

  return assembleItinerary(stat, chain, origin, destination, bestCost);
}

function assembleItinerary(
  stat: StaticData,
  chain: Back[],
  origin: { name: string; lat: number; lon: number },
  destination: { name: string; lat: number; lon: number },
  totalSeconds: number
): Itinerary {
  const legs: ItineraryLeg[] = [];
  let cur: ItineraryLeg | null = null;
  let prevStation: string | null = null;

  for (const b of chain) {
    if (b.edgeRoute === null) {
      // access node: just remember where we start riding from
      prevStation = b.station;
      continue;
    }
    const from = prevStation ?? b.station;
    if (!cur || cur.route !== b.edgeRoute) {
      if (cur) legs.push(cur);
      cur = {
        kind: "ride",
        route: b.edgeRoute,
        color: stat.routes.get(b.edgeRoute)?.color ?? "#666666",
        fromId: from,
        fromName: stationName(stat, from),
        toId: b.station,
        toName: stationName(stat, b.station),
        stops: [from, b.station],
        numStops: 1,
        seconds: b.rideSeconds,
      };
    } else {
      cur.toId = b.station;
      cur.toName = stationName(stat, b.station);
      cur.stops.push(b.station);
      cur.numStops += 1;
      cur.seconds += b.rideSeconds;
    }
    prevStation = b.station;
  }
  if (cur) legs.push(cur);

  const transfers = Math.max(0, legs.filter((l) => l.kind === "ride").length - 1);
  return {
    seconds: Math.round(totalSeconds),
    transfers,
    legs,
    origin,
    destination,
  };
}
