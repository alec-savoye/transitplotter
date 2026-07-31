// Fetch + decode all GTFS-realtime feeds into a flat list of "trip legs":
// where each active train currently is (prev stop, departed) and where it's
// going next (next stop, predicted arrival).

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { FEED_URLS } from "./feeds.js";

const { transit_realtime } = GtfsRealtimeBindings;

export interface FeedTrip {
  tripId: string;
  routeId: string;
  /** epoch seconds of the feed header (for stall detection). */
  headerTs: number;
  /** ordered upcoming stop predictions. */
  stopUpdates: {
    stopId: string;
    arrival: number | null; // epoch seconds
    departure: number | null; // epoch seconds
  }[];
}

async function fetchFeed(url: string): Promise<FeedTrip[]> {
  const res = await fetch(url, {
    headers: { Accept: "application/x-protobuf" },
  });
  if (!res.ok) {
    console.warn(`feed ${url} -> ${res.status}`);
    return [];
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const msg = transit_realtime.FeedMessage.decode(buf);
  const headerTs = Number(msg.header?.timestamp ?? Math.floor(Date.now() / 1000));

  const out: FeedTrip[] = [];
  for (const entity of msg.entity) {
    const tu = entity.tripUpdate;
    if (!tu || !tu.trip) continue;
    const tripId = tu.trip.tripId ?? "";
    const routeId = tu.trip.routeId ?? "";
    if (!tripId) continue;

    const stopUpdates = (tu.stopTimeUpdate ?? []).map((s) => ({
      stopId: s.stopId ?? "",
      arrival: s.arrival?.time != null ? Number(s.arrival.time) : null,
      departure: s.departure?.time != null ? Number(s.departure.time) : null,
    }));
    if (stopUpdates.length === 0) continue;

    out.push({ tripId, routeId, headerTs, stopUpdates });
  }
  return out;
}

/** Fetch all feeds in parallel; tolerate individual feed failures. */
export async function fetchAllFeeds(): Promise<FeedTrip[]> {
  const results = await Promise.allSettled(
    Object.values(FEED_URLS).map((u) => fetchFeed(u))
  );
  const trips: FeedTrip[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") trips.push(...r.value);
  }
  return trips;
}
