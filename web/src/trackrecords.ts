// Client for the "Track Records" reliability overlay. Periodically fetches the
// server's persisted on-time/late tally, keeps the latest snapshot, and builds
// a GeoJSON of colored mesh-cell rectangles that basemap's trackrecords layer
// renders (green = reliable, red = often late).

import type maplibregl from "maplibre-gl";
import type { TrackRecordSnapshot, TrackRecordCell } from "@transitplotter/shared";
import { emptyFC } from "./basemap.js";

/** How often to refresh the tally from the server (ms). */
const REFRESH_MS = 30_000;

export class TrackRecords {
  private latest: TrackRecordSnapshot | null = null;
  private timer: number | null = null;

  constructor(
    private map: maplibregl.Map,
    private serverHttp: string,
  ) {}

  /** Start periodic polling. Returns immediately; first fetch runs async. */
  start() {
    this.refresh();
    this.timer = window.setInterval(() => this.refresh(), REFRESH_MS);
  }

  stop() {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** Whether at least one cell has a full week of data (any color to show). */
  isReady(): boolean {
    return this.latest?.ready ?? false;
  }

  /** Latest snapshot (for the "collecting data" summary + click rationale). */
  snapshot(): TrackRecordSnapshot | null {
    return this.latest;
  }

  /** Find the cell whose rectangle contains a coordinate, if any. */
  cellAt(lng: number, lat: number): TrackRecordCell | null {
    const snap = this.latest;
    if (!snap) return null;
    const [latStep, lonStep] = snap.cellStep;
    for (const c of snap.cells) {
      if (
        lat >= c.lat - latStep / 2 &&
        lat < c.lat + latStep / 2 &&
        lng >= c.lon - lonStep / 2 &&
        lng < c.lon + lonStep / 2
      ) {
        return c;
      }
    }
    return null;
  }

  private async refresh() {
    try {
      const snap: TrackRecordSnapshot = await (
        await fetch(`${this.serverHttp}/trackrecords`)
      ).json();
      this.latest = snap;
      this.render(snap);
    } catch {
      // Leave the previous snapshot in place on transient failures.
    }
  }

  /** Build cell rectangles and push them to the map source. */
  private render(snap: TrackRecordSnapshot) {
    const src = this.map.getSource("trackrecords") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!src) return;

    const [latStep, lonStep] = snap.cellStep;
    const fc = emptyFC();
    for (const c of snap.cells) {
      const w = lonStep / 2;
      const h = latStep / 2;
      fc.features.push({
        type: "Feature",
        properties: {
          key: c.key,
          rate: c.rate,
          total: c.total,
          ready: c.ready,
          firstObs: c.firstObs,
          lastObs: c.lastObs,
          subwayLate: c.subway.late,
          subwayTotal: c.subway.total,
          busLate: c.bus.late,
          busTotal: c.bus.total,
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [c.lon - w, c.lat - h],
              [c.lon + w, c.lat - h],
              [c.lon + w, c.lat + h],
              [c.lon - w, c.lat + h],
              [c.lon - w, c.lat - h],
            ],
          ],
        },
      });
    }
    src.setData(fc);
  }
}
