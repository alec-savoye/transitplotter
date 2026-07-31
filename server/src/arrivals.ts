// Builds a per-station live arrivals board from the latest parsed feed.
//
// The realtime feed lists, per active trip, its upcoming stops with predicted
// times. To answer "what's coming to station X?", we scan all trips for stop
// updates whose (directional) stop id belongs to station X and are still in the
// future, then group by direction (N/S) and sort by soonest.

import type { Arrival, StationArrivals, ServiceAlert } from "@transitplotter/shared";
import type { FeedTrip } from "./parse.js";
import type { StaticData } from "./static/load.js";

/** How many arrivals to return per direction. */
const MAX_PER_DIR = 6;
/** Ignore arrivals further out than this (seconds). */
const HORIZON_S = 60 * 30;

const baseStop = (id: string) => (id.endsWith("N") || id.endsWith("S") ? id.slice(0, -1) : id);

export function buildStationArrivals(
  stationId: string,
  feed: FeedTrip[],
  stat: StaticData,
  alerts: ServiceAlert[] = []
): StationArrivals | null {
  const base = baseStop(stationId);
  // Resolve a display name from any platform variant of this station.
  const name =
    stat.stops.get(base)?.name ??
    stat.stops.get(`${base}N`)?.name ??
    stat.stops.get(`${base}S`)?.name ??
    base;

  const nowSec = Math.floor(Date.now() / 1000);
  const north: Arrival[] = [];
  const south: Arrival[] = [];

  for (const t of feed) {
    // Destination = last listed stop name.
    const lastStopId = t.stopUpdates[t.stopUpdates.length - 1]?.stopId;
    const dest = lastStopId ? stat.stops.get(lastStopId)?.name ?? "" : "";

    for (const su of t.stopUpdates) {
      if (baseStop(su.stopId) !== base) continue;
      const eta = su.arrival ?? su.departure ?? 0;
      const inSec = eta - nowSec;
      if (inSec < -30 || inSec > HORIZON_S) continue; // past or too far out

      const express = t.routeId.endsWith("X");
      const arr: Arrival = {
        route: t.routeId,
        color: stat.routes.get(express ? t.routeId.slice(0, -1) : t.routeId)?.color ?? "#666666",
        express,
        eta,
        inSec: Math.max(0, inSec),
        dest,
      };
      const dir = su.stopId.slice(-1);
      if (dir === "N") north.push(arr);
      else if (dir === "S") south.push(arr);
      break; // a trip stops at a station once on its remaining path
    }
  }

  const bySoonest = (a: Arrival, b: Arrival) => a.eta - b.eta;
  north.sort(bySoonest);
  south.sort(bySoonest);

  // Alerts relevant to this station: those naming the station directly, or any
  // route that serves it.
  const routesHere = new Set<string>();
  for (const a of [...north, ...south]) {
    routesHere.add(a.express ? a.route.slice(0, -1) : a.route);
  }
  const stationAlerts = alerts.filter(
    (al) =>
      al.stops.includes(base) ||
      al.routes.some((r) => routesHere.has(r.endsWith("X") ? r.slice(0, -1) : r))
  );

  return {
    id: base,
    name,
    north: north.slice(0, MAX_PER_DIR),
    south: south.slice(0, MAX_PER_DIR),
    alerts: stationAlerts,
  };
}
