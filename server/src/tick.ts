// Orchestration loop:
//   - poll all feeds every POLL_INTERVAL_MS, rebuild active legs
//   - every TICK_MS, recompute positions from the current legs and broadcast

import type { StaticData } from "./static/load.js";
import { fetchAllFeeds } from "./parse.js";
import { buildActiveLegs, type ActiveLeg } from "./state.js";
import { computeSnapshots } from "./interpolate.js";
import { POLL_INTERVAL_MS } from "./feeds.js";
import type { Broadcaster } from "./ws.js";

const TICK_MS = 1000;

export function startLoops(stat: StaticData, broadcaster: Broadcaster) {
  let legs: ActiveLeg[] = [];

  async function poll() {
    try {
      const feed = await fetchAllFeeds();
      legs = buildActiveLegs(feed, stat);
      console.log(`polled feeds: ${feed.length} trips -> ${legs.length} active legs`);
    } catch (e) {
      console.error("poll error", e);
    }
  }

  function tick() {
    const trains = computeSnapshots(legs, stat);
    broadcaster.broadcast({ t: Date.now(), trains });
  }

  poll();
  setInterval(poll, POLL_INTERVAL_MS);
  setInterval(tick, TICK_MS);
}
