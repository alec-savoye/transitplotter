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
import { fetchTrafficEstimate, refreshCalibration } from "./traffic.js";
import { CALIBRATION_INTERVAL_MS } from "./feeds.js";
import type { RoutingGraph } from "./routing/graph.js";
import type { TrackRecordStore } from "./trackrecord.js";
import type { InterpErrorStore } from "./interp.js";
import type { CountStore } from "./counts.js";
import type { TrainLeg } from "@transitplotter/shared";

/** How often to flush the track-record tally to disk (ms). */
const TRACK_FLUSH_INTERVAL_MS = 60_000;

/** Predicted delay (s) at/above which a vehicle counts as "delayed" — matches
 *  the track-record late threshold and the HUD's "delayed" tally. */
const LATE_THRESHOLD_S = 120;

export function startLoops(
  stat: StaticData,
  broadcaster: Broadcaster,
  feedStore: FeedStore,
  graph: RoutingGraph,
  trackRecords: TrackRecordStore,
  interpErrors: InterpErrorStore,
  counts: CountStore
) {
  // Previous broadcast's legs, kept to measure how well they predicted the
  // vehicle positions revealed by the next refresh.
  let prevLegs: TrainLeg[] = [];

  async function poll() {
    try {
      const feed = await fetchAllFeeds();
      feedStore.set(feed); // keep latest feed for arrivals lookups
      const active = buildActiveLegs(feed, stat, graph);

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

      // Estimated cars on NYC roads (synthesized from live traffic speeds).
      // Tolerate failures like bus/ferry — leave `cars` undefined this poll.
      let cars: number | undefined;
      try {
        cars = (await fetchTrafficEstimate()).cars;
      } catch (e) {
        console.error("traffic poll error", e);
      }

      const legs = buildTrainLegs([...active, ...ferry, ...bus], graph);
      // Measure how well the previous broadcast predicted these positions.
      interpErrors.ingest(prevLegs, legs);
      prevLegs = legs;
      // Tally on-time/late history into the spatial mesh (persisted over time).
      trackRecords.ingest(legs);
      // Record per-mode active + delayed counts for the 48h HUD charts. Active
      // counts come from the pre-merge arrays; delayed counts (predicted delay
      // ≥ 120s) are tallied from the built legs, where `dly` is available.
      let subwayDelayed = 0,
        busDelayed = 0,
        ferryDelayed = 0;
      for (const l of legs) {
        if ((l.dly ?? 0) < LATE_THRESHOLD_S) continue;
        const mode = l.mode ?? "subway";
        if (mode === "bus") busDelayed++;
        else if (mode === "ferry") ferryDelayed++;
        else subwayDelayed++;
      }
      counts.record({
        subway: active.length,
        bus: bus.length,
        ferry: ferry.length,
        subwayDelayed,
        busDelayed,
        ferryDelayed,
        cars: cars ?? 0,
      });
      broadcaster.broadcast({ t: Date.now(), legs, cars });
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

  // Derive the car-estimate calibration from CRZ now, then refresh daily.
  refreshCalibration();

  poll();
  pollAlerts();
  setInterval(poll, POLL_INTERVAL_MS);
  setInterval(pollAlerts, ALERTS_POLL_INTERVAL_MS);
  setInterval(() => trackRecords.flush(), TRACK_FLUSH_INTERVAL_MS);
  setInterval(() => interpErrors.flush(), TRACK_FLUSH_INTERVAL_MS);
  setInterval(() => counts.flush(), TRACK_FLUSH_INTERVAL_MS);
  setInterval(refreshCalibration, CALIBRATION_INTERVAL_MS);
}
