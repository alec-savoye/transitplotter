// Merges realtime feed trips with static data into "active legs": for each
// train, the segment it is currently traversing (prev stop -> next stop) with
// the shape + shape distances and predicted times needed to interpolate.
//
// MTA realtime trip ids do NOT reference a static shape_id, and stop_times
// lacks shape_dist_traveled. We instead use a canonical per-route+direction
// "line" (built in load.ts): the representative shape plus every stop projected
// onto it. Given the realtime feed's next stop (and previous, if present) we
// look up their distances along that line and interpolate between them.

import type { FeedTrip } from "./parse.js";
import type { StaticData, Shape } from "./static/load.js";

export interface ActiveLeg {
  tripId: string;
  routeId: string;
  shape: Shape | null;
  headerTs: number; // epoch s, for stall detection

  fromStopId: string;
  toStopId: string;
  departTs: number; // epoch s
  arriveTs: number; // epoch s

  fromDist: number | null; // meters along shape
  toDist: number | null;

  fromLatLon: [number, number] | null; // [lon, lat] fallback
  toLatLon: [number, number] | null;
}

/** Direction from a GTFS-realtime stop id suffix, e.g. "125N" -> "N". */
function stopDir(stopId: string): string | null {
  const c = stopId.slice(-1);
  return c === "N" || c === "S" ? c : null;
}

/**
 * Realtime uses express suffixes (6X, 7X, FX, 5X) that share geometry with the
 * base route. Normalize to the base route id used by static shapes.
 */
function baseRoute(routeId: string): string {
  return routeId.endsWith("X") ? routeId.slice(0, -1) : routeId;
}

export function buildActiveLegs(feed: FeedTrip[], stat: StaticData): ActiveLeg[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const legs: ActiveLeg[] = [];

  for (const t of feed) {
    const su = t.stopUpdates;
    if (su.length === 0) continue;

    // Next stop = first update still in the future; previous = the one before.
    let nextIdx = su.findIndex((s) => (s.arrival ?? s.departure ?? 0) > nowSec);
    if (nextIdx === -1) nextIdx = su.length - 1;

    const to = su[nextIdx];
    const dir = stopDir(to.stopId);
    const rid = baseRoute(t.routeId);
    const line = dir ? stat.lineByRouteDir.get(`${rid}|${dir}`) : undefined;

    // Determine the "from" stop. If the feed lists a prior stop, use it.
    // Otherwise (train's first listed stop is still ahead) fall back to the
    // preceding stop on the canonical line order.
    let fromStopId: string;
    let departTs: number;
    if (nextIdx > 0) {
      const prev = su[nextIdx - 1];
      fromStopId = prev.stopId;
      departTs = prev.departure ?? prev.arrival ?? nowSec;
    } else if (line) {
      const oi = line.order.indexOf(to.stopId);
      fromStopId = oi > 0 ? line.order[oi - 1] : to.stopId;
      // No timestamp for the implicit previous stop; assume it just departed.
      departTs = nowSec;
    } else {
      fromStopId = to.stopId;
      departTs = nowSec;
    }

    const arriveTs = to.arrival ?? to.departure ?? departTs;

    const fromStop = stat.stops.get(fromStopId);
    const toStop = stat.stops.get(to.stopId);
    const fromLatLon: [number, number] | null = fromStop
      ? [fromStop.lon, fromStop.lat]
      : null;
    const toLatLon: [number, number] | null = toStop
      ? [toStop.lon, toStop.lat]
      : null;

    let shape: Shape | null = null;
    let fromDist: number | null = null;
    let toDist: number | null = null;
    if (line) {
      const fd = line.stopDist.get(fromStopId);
      const td = line.stopDist.get(to.stopId);
      if (fd != null && td != null) {
        shape = line.shape;
        fromDist = fd;
        toDist = td;
      }
    }

    legs.push({
      tripId: t.tripId,
      routeId: t.routeId,
      shape,
      headerTs: t.headerTs,
      fromStopId,
      toStopId: to.stopId,
      departTs,
      arriveTs,
      fromDist,
      toDist,
      fromLatLon,
      toLatLon,
    });
  }

  return legs;
}
