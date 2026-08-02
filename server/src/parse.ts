// Fetch + decode all GTFS-realtime feeds into a flat list of "trip legs":
// where each active train currently is (prev stop, departed) and where it's
// going next (next stop, predicted arrival).

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { FEED_URLS } from "./feeds.js";
import { health } from "./health.js";

const { transit_realtime } = GtfsRealtimeBindings;

// Register each subway feed group so the admin panel lists them up-front.
for (const [k, url] of Object.entries(FEED_URLS)) {
  health.register(`subway:${k}`, `Subway ${k}`, "Subway", url);
}

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

async function fetchFeed(url: string, key: string): Promise<FeedTrip[]> {
  health.pollStart(key);
  const res = await fetch(url, {
    headers: { Accept: "application/x-protobuf" },
  });
  if (!res.ok) {
    console.warn(`feed ${url} -> ${res.status}`);
    health.fail(key, `HTTP ${res.status}`);
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
  health.ok(key, {
    count: out.length,
    dataTs: headerTs * 1000,
    info: `${msg.entity.length} entities`,
  });
  return out;
}

/** Fetch all feeds in parallel; tolerate individual feed failures. */
export async function fetchAllFeeds(): Promise<FeedTrip[]> {
  const entries = Object.entries(FEED_URLS);
  const results = await Promise.allSettled(
    entries.map(([k, u]) => fetchFeed(u, `subway:${k}`))
  );
  const trips: FeedTrip[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") trips.push(...r.value);
    else health.fail(`subway:${entries[i][0]}`, r.reason);
  });
  return trips;
}
