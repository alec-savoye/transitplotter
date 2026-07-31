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

export function startLoops(stat: StaticData, broadcaster: Broadcaster, feedStore: FeedStore) {
  async function poll() {
    try {
      const feed = await fetchAllFeeds();
      feedStore.set(feed); // keep latest feed for arrivals lookups
      const active = buildActiveLegs(feed, stat);
      const legs = buildTrainLegs(active);
      broadcaster.broadcast({ t: Date.now(), legs });
      console.log(`polled feeds: ${feed.length} trips -> ${legs.length} legs broadcast`);
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
