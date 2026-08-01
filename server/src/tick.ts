// Orchestration loop:
//   - poll all feeds every POLL_INTERVAL_MS, rebuild active legs, broadcast them
//   - poll alerts every ALERTS_POLL_INTERVAL_MS
//
// Position interpolation happens in the browser: we broadcast the current
// train *legs* (segment polyline + schedule times) only when the feed
// refreshes, instead of streaming computed positions every second.

import type { StaticData } from "./static/load.js";
import { fetchAllFeeds } from "./parse.js";
import { buildActiveLegs } from "./state.js";
import { buildTrainLegs } from "./legwire.js";
import { POLL_INTERVAL_MS, ALERTS_POLL_INTERVAL_MS } from "./feeds.js";
import type { Broadcaster } from "./ws.js";
import { FeedStore } from "./feedstore.js";
import { fetchAlerts } from "./alerts.js";
import { fetchFerryLegs } from "./ferry.js";
import { fetchBusLegs } from "./bus.js";
import type { RoutingGraph } from "./routing/graph.js";
import type { TrackRecordStore } from "./trackrecord.js";

/** How often to flush the track-record tally to disk (ms). */
const TRACK_FLUSH_INTERVAL_MS = 60_000;

export function startLoops(
  stat: StaticData,
  broadcaster: Broadcaster,
  feedStore: FeedStore,
  graph: RoutingGraph,
  trackRecords: TrackRecordStore
) {
  async function poll() {
    try {
      const feed = await fetchAllFeeds();
      feedStore.set(feed); // keep latest feed for arrivals lookups
      const active = buildActiveLegs(feed, stat);

      // Ferries + buses (GPS-based); tolerate failures without dropping subway.
      let ferry: typeof active = [];
      try {
        ferry = await fetchFerryLegs(stat);
      } catch (e) {
        console.error("ferry poll error", e);
      }
      let bus: typeof active = [];
      try {
        bus = await fetchBusLegs(stat);
      } catch (e) {
        console.error("bus poll error", e);
      }

      const legs = buildTrainLegs([...active, ...ferry, ...bus], graph);
      // Tally on-time/late history into the spatial mesh (persisted over time).
      trackRecords.ingest(legs);
      broadcaster.broadcast({ t: Date.now(), legs });
      console.log(
        `polled feeds: ${feed.length} subway trips + ${ferry.length} ferries + ` +
          `${bus.length} buses -> ${legs.length} legs`
      );
    } catch (e) {
      console.error("poll error", e);
    }
  }

  async function pollAlerts() {
    try {
      const alerts = await fetchAlerts();
      feedStore.setAlerts(alerts);
      console.log(`polled alerts: ${alerts.length} active subway alerts`);
    } catch (e) {
      console.error("alerts poll error", e);
    }
  }

  poll();
  pollAlerts();
  setInterval(poll, POLL_INTERVAL_MS);
  setInterval(pollAlerts, ALERTS_POLL_INTERVAL_MS);
  setInterval(() => trackRecords.flush(), TRACK_FLUSH_INTERVAL_MS);
}
