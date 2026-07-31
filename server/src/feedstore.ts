// Tiny in-memory holder for the most recently parsed feed, shared between the
// poll loop (writer) and HTTP arrivals requests (reader). No persistence — this
// is ephemeral realtime data by design.

import type { FeedTrip } from "./parse.js";
import type { ServiceAlert } from "@transitplotter/shared";

export class FeedStore {
  private latest: FeedTrip[] = [];
  private alerts: ServiceAlert[] = [];

  set(feed: FeedTrip[]) {
    this.latest = feed;
  }

  get(): FeedTrip[] {
    return this.latest;
  }

  setAlerts(alerts: ServiceAlert[]) {
    this.alerts = alerts;
  }

  getAlerts(): ServiceAlert[] {
    return this.alerts;
  }
}
