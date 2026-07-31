// Orchestration loop:
//   - poll all feeds every POLL_INTERVAL_MS, rebuild active legs
//   - every TICK_MS, recompute positions from the current legs and broadcast

import type { StaticData } from "./static/load.js";
import { fetchAllFeeds } from "./parse.js";
import { buildActiveLegs, type ActiveLeg } from "./state.js";
import { computeSnapshots } from "./interpolate.js";
import { POLL_INTERVAL_MS, ALERTS_POLL_INTERVAL_MS } from "./feeds.js";
import type { Broadcaster } from "./ws.js";
import { FeedStore } from "./feedstore.js";
import { fetchAlerts } from "./alerts.js";

const TICK_MS = 1000;

export function startLoops(stat: StaticData, broadcaster: Broadcaster, feedStore: FeedStore) {
  let legs: ActiveLeg[] = [];

  async function poll() {
    try {
      const feed = await fetchAllFeeds();
      feedStore.set(feed); // keep latest feed for arrivals lookups
      legs = buildActiveLegs(feed, stat);
      console.log(`polled feeds: ${feed.length} trips -> ${legs.length} active legs`);
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

  function tick() {
    const trains = computeSnapshots(legs, stat);
    broadcaster.broadcast({ t: Date.now(), trains });
  }

  poll();
  pollAlerts();
  setInterval(poll, POLL_INTERVAL_MS);
  setInterval(pollAlerts, ALERTS_POLL_INTERVAL_MS);
  setInterval(tick, TICK_MS);
}
