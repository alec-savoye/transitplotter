// Converts internal ActiveLeg[] into the compact TrainLeg[] wire format sent to
// clients. Each TrainLeg carries the segment polyline (real curved track slice
// between the two stops) so the browser can interpolate the live position over
// time without the server streaming per-second updates.

import type { TrainLeg } from "@transitplotter/shared";
import type { ActiveLeg } from "./state.js";
import type { RoutingGraph } from "./routing/graph.js";
import { typicalSeconds } from "./routing/graph.js";

/** Round a coordinate to ~1m precision to shrink the payload. */
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

const baseStop = (id: string) =>
  id.endsWith("N") || id.endsWith("S") ? id.slice(0, -1) : id;

/**
 * Max plausible train speed (m/s). NYC subway tops out well under this; we use
 * it only to reject implausible feed predictions that would otherwise make a
 * train teleport across a long segment in a couple of seconds. ~30 m/s ≈ 67mph.
 */
const MAX_SPEED_MPS = 30;

/** Approximate planar length of a [lng,lat] polyline in meters. */
function pathLengthM(path: [number, number][]): number {
  let L = 0;
  for (let i = 1; i < path.length; i++) {
    const latMid = ((path[i][1] + path[i - 1][1]) / 2) * (Math.PI / 180);
    const dx = (path[i][0] - path[i - 1][0]) * 111_320 * Math.cos(latMid);
    const dy = (path[i][1] - path[i - 1][1]) * 110_540;
    L += Math.hypot(dx, dy);
  }
  return L;
}

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

export function buildTrainLegs(legs: ActiveLeg[], graph: RoutingGraph): TrainLeg[] {
  const out: TrainLeg[] = [];
  for (const leg of legs) {
    const path = legPath(leg);
    if (path.length === 0) continue; // cannot place this train

    let d0 = Math.round(leg.departTs);
    let d1 = Math.round(leg.arriveTs);

    // Guard against bad feed predictions that would make a train teleport:
    // ensure the leg lasts at least as long as covering its path at MAX_SPEED.
    // Without this, a 2s span over a 2km segment renders as ~1000 m/s.
    const lengthM = pathLengthM(path);
    const minDuration = Math.max(1, Math.ceil(lengthM / MAX_SPEED_MPS));
    if (d1 - d0 < minDuration) {
      d1 = d0 + minDuration;
    }

    // Delay estimate. Prefer a feed-reported delay (buses supply arrival.delay);
    // otherwise estimate from the typical (median) segment time (subway, which
    // has no direct delay field). Ferries carry neither, so they stay 0.
    let dly: number | undefined;
    if (leg.delaySec != null) {
      if (leg.delaySec > 0) dly = Math.round(leg.delaySec);
    } else {
      const typical = typicalSeconds(
        graph,
        leg.routeId,
        baseStop(leg.fromStopId),
        baseStop(leg.toStopId)
      );
      if (typical != null) {
        const predicted = leg.arriveTs - leg.departTs;
        const d = Math.round(predicted - typical);
        if (d > 0) dly = d;
      }
    }

    out.push({
      id: leg.tripId,
      r: leg.routeId,
      path,
      d0,
      d1,
      hts: Math.round(leg.headerTs),
      ns: leg.nextStopName ?? undefined,
      dest: leg.destName ?? undefined,
      dly,
      mode: leg.mode && leg.mode !== "subway" ? leg.mode : undefined,
      label: leg.label || undefined,
      boro: leg.boro || undefined,
      spd: leg.speedMps != null && leg.speedMps >= 0 ? Math.round(leg.speedMps * 10) / 10 : undefined,
      vid: leg.vehicleId || undefined,
    });
  }
  return out;
}
