// Converts internal ActiveLeg[] into the compact TrainLeg[] wire format sent to
// clients. Each TrainLeg carries the segment polyline (real curved track slice
// between the two stops) so the browser can interpolate the live position over
// time without the server streaming per-second updates.

import type { TrainLeg } from "@transitplotter/shared";
import type { ActiveLeg } from "./state.js";

/** Round a coordinate to ~1m precision to shrink the payload. */
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Slice a shape's point list to just the portion between fromDist and toDist,
 * returned in travel order as [lng, lat] pairs. Falls back to the two stop
 * coordinates when no shape geometry is available.
 */
function legPath(leg: ActiveLeg): [number, number][] {
  const { shape, fromDist, toDist } = leg;
  if (shape && fromDist != null && toDist != null) {
    const lo = Math.min(fromDist, toDist);
    const hi = Math.max(fromDist, toDist);
    const pts = shape.points;

    // Collect endpoints interpolated exactly at lo/hi plus all points between.
    const between: [number, number][] = [];
    for (const p of pts) {
      if (p.dist >= lo && p.dist <= hi) between.push([r6(p.lon), r6(p.lat)]);
    }
    // Ensure we always have at least the two endpoints.
    if (between.length >= 2) {
      return fromDist <= toDist ? between : between.reverse();
    }
    // Degenerate: fall through to stop coords.
  }
  if (leg.fromLatLon && leg.toLatLon) {
    return [
      [r6(leg.fromLatLon[0]), r6(leg.fromLatLon[1])],
      [r6(leg.toLatLon[0]), r6(leg.toLatLon[1])],
    ];
  }
  if (leg.fromLatLon) {
    const p: [number, number] = [r6(leg.fromLatLon[0]), r6(leg.fromLatLon[1])];
    return [p, p];
  }
  return [];
}

export function buildTrainLegs(legs: ActiveLeg[]): TrainLeg[] {
  const out: TrainLeg[] = [];
  for (const leg of legs) {
    const path = legPath(leg);
    if (path.length === 0) continue; // cannot place this train
    out.push({
      id: leg.tripId,
      r: leg.routeId,
      path,
      d0: Math.round(leg.departTs),
      d1: Math.round(leg.arriveTs),
      hts: Math.round(leg.headerTs),
      ns: leg.nextStopName ?? undefined,
      dest: leg.destName ?? undefined,
    });
  }
  return out;
}
