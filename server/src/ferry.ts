// NYC Ferry realtime -> ActiveLeg[]. Unlike the subway, the ferry feed gives
// real GPS coordinates plus currentStopSequence and per-trip predicted stop
// times. We build a leg from the boat's current position toward its next stop,
// following the trip's shape geometry when available.

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { StaticData, Shape } from "./static/load.js";
import type { ActiveLeg } from "./state.js";
import { projectDistance } from "./static/geometry.js";

const { transit_realtime } = GtfsRealtimeBindings;

const FERRY_BASE = "http://nycferry.connexionz.net/rtt/public/utility/gtfsrealtime.aspx";
export const FERRY_VEHICLES_URL = `${FERRY_BASE}/vehicleposition`;
export const FERRY_TRIPUPDATES_URL = `${FERRY_BASE}/tripupdate`;

/** Namespaced id helper — ferry ids share the "F:" prefix used at load time. */
const F = (id: string) => `F:${id}`;

interface FerryPrediction {
  /** stopId -> arrival epoch seconds (namespaced). */
  arrivals: Map<string, number>;
  /** ordered [stopId, arrivalSec] by sequence. */
  ordered: { stopId: string; arr: number }[];
}

async function decode(url: string) {
  const res = await fetch(url, { headers: { Accept: "application/x-protobuf" } });
  if (!res.ok) {
    console.warn(`ferry feed ${url} -> ${res.status}`);
    return null;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return transit_realtime.FeedMessage.decode(buf);
}

/**
 * Fetch ferry vehicle positions + trip updates and turn them into ActiveLegs
 * that the existing legwire/interpolation path understands.
 */
export async function fetchFerryLegs(stat: StaticData): Promise<ActiveLeg[]> {
  const [vp, tu] = await Promise.all([
    decode(FERRY_VEHICLES_URL),
    decode(FERRY_TRIPUPDATES_URL),
  ]);
  if (!vp) return [];

  // Index trip updates by namespaced trip id.
  const preds = new Map<string, FerryPrediction>();
  for (const e of tu?.entity ?? []) {
    const t = e.tripUpdate;
    if (!t?.trip?.tripId) continue;
    const tripId = F(t.trip.tripId);
    const arrivals = new Map<string, number>();
    const ordered: { stopId: string; arr: number }[] = [];
    for (const s of t.stopTimeUpdate ?? []) {
      const stopId = s.stopId ? F(s.stopId) : "";
      const arr = s.arrival?.time != null ? Number(s.arrival.time) : s.departure?.time != null ? Number(s.departure.time) : null;
      if (!stopId || arr == null) continue;
      arrivals.set(stopId, arr);
      ordered.push({ stopId, arr });
    }
    preds.set(tripId, { arrivals, ordered });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const legs: ActiveLeg[] = [];

  for (const e of vp.entity) {
    const v = e.vehicle;
    if (!v?.position) continue;
    const lat = v.position.latitude;
    const lon = v.position.longitude;
    if (!lat || !lon) continue;

    const tripId = v.trip?.tripId ? F(v.trip.tripId) : "";
    const trip = tripId ? stat.trips.get(tripId) : undefined;
    const routeId = trip?.routeId ?? "";
    const shape = trip?.shapeId ? stat.shapes.get(trip.shapeId) ?? null : null;
    const headerTs = v.timestamp != null ? Number(v.timestamp) : nowSec;
    const label = v.vehicle?.label ?? v.vehicle?.id ?? "";
    const vehicleId = v.vehicle?.id ?? undefined;
    // The ferry feed reports momentary speed (m/s) on the position record.
    const speedMps =
      v.position?.speed != null && Number.isFinite(v.position.speed)
        ? Number(v.position.speed)
        : undefined;

    // Determine the next stop from the trip's stop_times sequence + the boat's
    // currentStopSequence, then find its predicted arrival.
    const stopSeq = stat.tripStops.get(tripId) ?? [];
    const curSeq = v.currentStopSequence ?? 0;
    // Next stop = first scheduled stop at sequence > current (STOPPED_AT means
    // it's at curSeq, heading to curSeq+1). Fall back to last stop.
    let nextStopId: string | null = null;
    if (stopSeq.length) {
      const idx = Math.min(Math.max(curSeq, 1), stopSeq.length) - 0; // seq is 1-based
      nextStopId = stopSeq[Math.min(idx, stopSeq.length - 1)]?.stopId ?? null;
      // If STOPPED_AT the current stop, aim at the following one.
      if (v.currentStatus === transit_realtime.VehiclePosition.VehicleStopStatus.STOPPED_AT) {
        nextStopId = stopSeq[Math.min(curSeq, stopSeq.length - 1)]?.stopId ?? nextStopId;
      }
    }

    const pred = preds.get(tripId);
    const arriveTs =
      (nextStopId ? pred?.arrivals.get(nextStopId) : undefined) ??
      pred?.ordered.find((o) => o.arr > nowSec)?.arr ??
      nowSec + 120; // fallback ETA

    const toStop = nextStopId ? stat.stops.get(nextStopId) : undefined;
    const toLatLon: [number, number] | null = toStop ? [toStop.lon, toStop.lat] : null;

    // Destination = last stop headsign/name.
    const lastStopId = stopSeq[stopSeq.length - 1]?.stopId;
    const destName = lastStopId ? stat.stops.get(lastStopId)?.name ?? null : null;

    // Build a leg from the boat's GPS position toward the next stop. Prefer
    // slicing the shape between the projected current position and next stop so
    // the boat follows the route curve; otherwise straight line.
    let legShape: Shape | null = null;
    let fromDist: number | null = null;
    let toDist: number | null = null;
    if (shape && toLatLon) {
      const pf = projectDistance(shape, lat, lon);
      const pt = projectDistance(shape, toStop!.lat, toStop!.lon);
      if (pf.err < 400 && pt.err < 400 && pf.dist < pt.dist) {
        legShape = shape;
        fromDist = pf.dist;
        toDist = pt.dist;
      }
    }

    legs.push({
      tripId: tripId || `ferry:${e.id}`,
      routeId,
      shape: legShape,
      headerTs,
      fromStopId: "", // ferries: origin is the live GPS point, not a stop id
      toStopId: nextStopId ?? "",
      departTs: nowSec,
      arriveTs: Math.max(arriveTs, nowSec + 15),
      fromDist,
      toDist,
      fromLatLon: [lon, lat],
      toLatLon,
      nextStopName: toStop?.name ?? null,
      destName,
      mode: "ferry",
      label,
      speedMps,
      vehicleId,
    });
  }

  return legs;
}
