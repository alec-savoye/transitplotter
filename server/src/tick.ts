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
import type { RoutingGraph } from "./routing/graph.js";

export function startLoops(
  stat: StaticData,
  broadcaster: Broadcaster,
  feedStore: FeedStore,
  graph: RoutingGraph
) {
  async function poll() {
    try {
      const feed = await fetchAllFeeds();
      feedStore.set(feed); // keep latest feed for arrivals lookups
      const active = buildActiveLegs(feed, stat);

      // Ferries (GPS-based); tolerate failures without dropping subway data.
      let ferry: typeof active = [];
      try {
        ferry = await fetchFerryLegs(stat);
      } catch (e) {
        console.error("ferry poll error", e);
      }

      const legs = buildTrainLegs([...active, ...ferry], graph);
      broadcaster.broadcast({ t: Date.now(), legs });
      console.log(
        `polled feeds: ${feed.length} subway trips + ${ferry.length} ferries -> ${legs.length} legs`
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
}
