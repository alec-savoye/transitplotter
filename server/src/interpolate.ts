// Given the current active legs, compute each train's position right now.

import type { TrainSnapshot, TrainStatus } from "@transitplotter/shared";
import type { StaticData } from "./static/load.js";
import type { ActiveLeg } from "./state.js";
import { pointAtDistance, bearing } from "./static/geometry.js";

/** If the feed header is this many seconds ahead of movement, treat as stalled. */
const STALL_THRESHOLD_S = 90;

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

export function computeSnapshots(legs: ActiveLeg[], stat: StaticData): TrainSnapshot[] {
  const nowSec = Date.now() / 1000;
  const out: TrainSnapshot[] = [];

  for (const leg of legs) {
    const span = leg.arriveTs - leg.departTs;
    let f = span > 0 ? (nowSec - leg.departTs) / span : 1;
    f = Math.max(0, Math.min(1, f));

    let status: TrainStatus = "moving";
    if (f <= 0) status = "stopped";
    if (nowSec * 1000 - leg.headerTs * 1000 > STALL_THRESHOLD_S * 1000) {
      status = "stalled";
    }

    let lng: number, lat: number, brg: number;

    const shape = leg.shape;
    if (shape && leg.fromDist != null && leg.toDist != null) {
      // Interpolate along real track geometry between the two stop distances.
      const dist = lerp(leg.fromDist, leg.toDist, f);
      const p = pointAtDistance(shape, dist);
      lng = p.lng;
      lat = p.lat;
      brg = p.brg;
    } else if (leg.fromLatLon && leg.toLatLon) {
      // Fallback: straight line between stop coordinates.
      lng = lerp(leg.fromLatLon[0], leg.toLatLon[0], f);
      lat = lerp(leg.fromLatLon[1], leg.toLatLon[1], f);
      brg = bearing(leg.fromLatLon[1], leg.fromLatLon[0], leg.toLatLon[1], leg.toLatLon[0]);
    } else if (leg.fromLatLon) {
      lng = leg.fromLatLon[0];
      lat = leg.fromLatLon[1];
      brg = 0;
    } else {
      continue; // no way to place this train
    }

    out.push({
      id: leg.tripId,
      r: leg.routeId,
      lng,
      lat,
      brg,
      s: status,
      ns: leg.nextStopName ?? undefined,
      eta: Math.round(leg.arriveTs),
      dest: leg.destName ?? undefined,
    });
  }

  return out;
}
