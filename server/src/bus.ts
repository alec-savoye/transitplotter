// MTA Bus realtime -> ActiveLeg[]. Like ferries, the bus vehicle feed provides
// real GPS coordinates plus stopId, so we build a simple leg from the bus's
// current position toward its next stop (straight line — buses follow streets
// we don't have geometry for, and the segments are short).

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { StaticData } from "./static/load.js";
import type { ActiveLeg } from "./state.js";
import { BUS_API_KEY, BUS_VEHICLES_URL, BUS_TRIPUPDATES_URL } from "./feeds.js";

const { transit_realtime } = GtfsRealtimeBindings;

/** Namespaced id helper — bus ids share the "B:" prefix used at load time. */
const B = (id: string) => `B:${id}`;

/**
 * Classify a bus route id into a borough code for client-side toggling.
 * Prefix-based, matching how riders think of routes:
 *   M/X -> Manhattan, B/BM -> Brooklyn, BX/BXM -> Bronx,
 *   Q/QM -> Queens, S/SIM -> Staten Island.
 */
export function busBorough(routeId: string): string {
  const r = routeId.replace(/^B:/, "").toUpperCase();
  if (r.startsWith("BXM") || r.startsWith("BX")) return "bronx";
  if (r.startsWith("BM") || r.startsWith("B")) return "brooklyn";
  if (r.startsWith("SIM") || r.startsWith("S")) return "statenisland";
  if (r.startsWith("QM") || r.startsWith("Q")) return "queens";
  if (r.startsWith("M") || r.startsWith("X")) return "manhattan";
  return "manhattan";
}

async function decode(url: string) {
  const res = await fetch(url, { headers: { Accept: "application/x-protobuf" } });
  if (!res.ok) {
    console.warn(`bus feed -> ${res.status}`);
    return null;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return transit_realtime.FeedMessage.decode(buf);
}

export async function fetchBusLegs(stat: StaticData): Promise<ActiveLeg[]> {
  if (!BUS_API_KEY) return []; // no key configured -> buses disabled

  const [vp, tu] = await Promise.all([
    decode(BUS_VEHICLES_URL),
    decode(BUS_TRIPUPDATES_URL),
  ]);
  if (!vp) return [];

  // Index trip updates: tripId -> first upcoming arrival (epoch s) + its stopId.
  const nextArr = new Map<string, { stopId: string; arr: number; delay: number | null }>();
  const nowSec = Math.floor(Date.now() / 1000);
  for (const e of tu?.entity ?? []) {
    const t = e.tripUpdate;
    if (!t?.trip?.tripId) continue;
    const tripId = B(t.trip.tripId);
    let best: { stopId: string; arr: number; delay: number | null } | null = null;
    for (const s of t.stopTimeUpdate ?? []) {
      const arr = s.arrival?.time != null ? Number(s.arrival.time) : s.departure?.time != null ? Number(s.departure.time) : null;
      if (arr == null || !s.stopId) continue;
      // arrival.delay (seconds late vs schedule) is provided by the bus feed.
      const delay =
        s.arrival?.delay != null
          ? Number(s.arrival.delay)
          : s.departure?.delay != null
            ? Number(s.departure.delay)
            : null;
      if (arr >= nowSec && (!best || arr < best.arr)) best = { stopId: B(s.stopId), arr, delay };
    }
    if (best) nextArr.set(tripId, best);
  }

  const legs: ActiveLeg[] = [];

  for (const e of vp.entity) {
    const v = e.vehicle;
    if (!v?.position) continue;
    const lat = v.position.latitude;
    const lon = v.position.longitude;
    if (!lat || !lon) continue;

    const routeId = v.trip?.routeId ? B(v.trip.routeId) : "";
    const tripId = v.trip?.tripId ? B(v.trip.tripId) : "";
    const trip = tripId ? stat.trips.get(tripId) : undefined;
    const headerTs = v.timestamp != null ? Number(v.timestamp) : nowSec;
    const vehId = v.vehicle?.id ? v.vehicle.id.replace(/^MTA(?:BC)?[ _]?/i, "") : "";

    // Next stop: prefer the vehicle's own stopId, else the trip update's.
    const pred = tripId ? nextArr.get(tripId) : undefined;
    const nextStopId = (v.stopId ? B(v.stopId) : null) ?? pred?.stopId ?? null;
    const toStop = nextStopId ? stat.stops.get(nextStopId) : undefined;
    const toLatLon: [number, number] | null = toStop ? [toStop.lon, toStop.lat] : null;

    const arriveTs = pred?.arr ?? nowSec + 90;

    // Destination from the trip headsign; fall back to next stop name.
    const destName = trip?.headsign ?? toStop?.name ?? null;

    legs.push({
      tripId: tripId || `bus:${e.id}`,
      routeId,
      shape: null, // no street geometry; straight-line hop to next stop
      headerTs,
      fromStopId: "",
      toStopId: nextStopId ?? "",
      departTs: nowSec,
      arriveTs: Math.max(arriveTs, nowSec + 15),
      fromDist: null,
      toDist: null,
      fromLatLon: [lon, lat],
      toLatLon,
      nextStopName: toStop?.name ?? null,
      destName,
      delaySec: pred?.delay ?? undefined,
      mode: "bus",
      label: routeId.replace(/^B:/, ""),
      boro: busBorough(routeId),
    });
  }

  return legs;
}
