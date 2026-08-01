// Client-side position engine. The server sends each train's *leg* (segment
// polyline + schedule times) only when the feed refreshes (~20s). This class
// interpolates the live position along that polyline every animation frame, so
// motion is smooth and the server no longer streams per-second updates.

import type maplibregl from "maplibre-gl";
import type { ServerMessage, TrainLeg, TrainStatus, RouteMeta } from "@transitplotter/shared";
import { emptyFC } from "./basemap.js";

/** If the feed header is this many seconds stale, treat the train as stalled. */
const STALL_THRESHOLD_S = 90;

/** A leg delayed by at least this many seconds counts toward a hotspot. */
const HOTSPOT_DELAY_S = 120;
/** Delay (seconds) that maps to full hotspot intensity. */
const HOTSPOT_MAX_S = 600;

interface Leg {
  r: string;
  ns?: string;
  dest?: string;
  d0: number; // depart epoch s
  d1: number; // arrive epoch s
  hts: number; // feed header epoch s
  dly: number; // estimated delay seconds (0 if on time/unknown)
  /** Polyline points [lng,lat]. */
  pts: [number, number][];
  /** Cumulative planar distance at each point (arbitrary units). */
  cum: number[];
  /** Total length. */
  len: number;
  /** epoch ms when this leg was received (for stall clock). */
  recvMs: number;
}

interface Sample {
  lng: number;
  lat: number;
  brg: number;
  status: TrainStatus;
}

function buildCum(pts: [number, number][]): { cum: number[]; len: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    cum[i] = cum[i - 1] + Math.hypot(dx, dy);
  }
  return { cum, len: cum[cum.length - 1] || 0 };
}

function bearing(a: [number, number], b: [number, number]): number {
  const φ1 = (a[1] * Math.PI) / 180;
  const φ2 = (b[1] * Math.PI) / 180;
  const Δλ = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** A train's current rendered state, exposed for hotspot summaries. */
export interface LiveTrain {
  id: string;
  route: string;
  lng: number;
  lat: number;
  dly: number; // delay seconds
  status: TrainStatus;
  ns: string; // next stop
  dest: string;
  /** Feed header time (epoch seconds) = when this delay was last observed. */
  asOf: number;
}

export class TrainLayer {
  private legs = new Map<string, Leg>();
  private colors = new Map<string, string>();
  /** Latest rendered position/state per train, refreshed each frame. */
  private live = new Map<string, LiveTrain>();

  constructor(private map: maplibregl.Map, routes: RouteMeta[]) {
    for (const r of routes) this.colors.set(r.id, r.color);
    requestAnimationFrame(() => this.frame());
  }

  /**
   * Delayed/stalled trains within `radiusM` meters of a coordinate, sorted by
   * delay descending. Powers the hotspot click summary.
   */
  delayedNear(lng: number, lat: number, radiusM: number): LiveTrain[] {
    const out: LiveTrain[] = [];
    for (const t of this.live.values()) {
      const delayed = t.dly >= HOTSPOT_DELAY_S || t.status === "stalled";
      if (!delayed) continue;
      const latMid = ((t.lat + lat) / 2) * (Math.PI / 180);
      const dx = (t.lng - lng) * 111_320 * Math.cos(latMid);
      const dy = (t.lat - lat) * 110_540;
      if (Math.hypot(dx, dy) <= radiusM) out.push(t);
    }
    out.sort((a, b) => b.dly - a.dly);
    return out;
  }

  /** Ingest a fresh batch of legs from the server. */
  update(msg: ServerMessage) {
    const recvMs = Date.now();
    const seen = new Set<string>();
    for (const l of msg.legs) {
      seen.add(l.id);
      const pts = l.path;
      const { cum, len } = buildCum(pts);
      this.legs.set(l.id, {
        r: l.r,
        ns: l.ns,
        dest: l.dest,
        d0: l.d0,
        d1: l.d1,
        hts: l.hts,
        dly: l.dly ?? 0,
        pts,
        cum,
        len,
        recvMs,
      });
    }
    // Drop trains no longer reported.
    for (const id of [...this.legs.keys()]) {
      if (!seen.has(id)) this.legs.delete(id);
    }
  }

  /** Interpolate a leg's position at wall-clock time `nowSec` (epoch seconds). */
  private sample(l: Leg, nowSec: number): Sample {
    const span = l.d1 - l.d0;
    let f = span > 0 ? (nowSec - l.d0) / span : 1;
    f = Math.max(0, Math.min(1, f));

    let status: TrainStatus = "moving";
    if (f <= 0) status = "stopped";
    // Stall detection: feed header significantly older than now.
    if (nowSec - l.hts > STALL_THRESHOLD_S) status = "stalled";

    const pts = l.pts;
    if (pts.length === 1) {
      return { lng: pts[0][0], lat: pts[0][1], brg: 0, status };
    }

    const target = f * l.len;
    // Binary search the cumulative array for the segment containing `target`.
    let lo = 0;
    let hi = l.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (l.cum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = l.cum[i] - l.cum[i - 1] || 1;
    const t = (target - l.cum[i - 1]) / segLen;
    return {
      lng: a[0] + (b[0] - a[0]) * t,
      lat: a[1] + (b[1] - a[1]) * t,
      brg: bearing(a, b),
      status,
    };
  }

  private frame() {
    const now = performance.now();
    const nowSec = Date.now() / 1000;

    // Slow pulse for the stalled-train ring (~2.5s period).
    if (this.map.getLayer("trains-halo")) {
      const phase = (Math.sin((now / 1250) * Math.PI) + 1) / 2; // 0..1
      this.map.setPaintProperty("trains-halo", "circle-stroke-opacity", 0.25 + 0.6 * phase);
      this.map.setPaintProperty("trains-halo", "circle-radius", 11 + 4 * phase);
    }

    const src = this.map.getSource("trains") as maplibregl.GeoJSONSource | undefined;
    const hotspots = this.map.getSource("hotspots") as maplibregl.GeoJSONSource | undefined;
    if (src) {
      const fc = emptyFC();
      const heat = emptyFC();
      this.live.clear();
      for (const [id, l] of this.legs) {
        const s = this.sample(l, nowSec);
        fc.features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [s.lng, s.lat] },
          properties: {
            id,
            route: l.r,
            color: this.colors.get(l.r) ?? "#cccccc",
            status: s.status,
            brg: s.brg,
            ns: l.ns ?? "",
            eta: l.d1,
            dest: l.dest ?? "",
            dly: l.dly,
            asOf: l.hts,
          },
        });

        this.live.set(id, {
          id,
          route: l.r,
          lng: s.lng,
          lat: s.lat,
          dly: l.dly,
          status: s.status,
          ns: l.ns ?? "",
          dest: l.dest ?? "",
          asOf: l.hts,
        });

        // Feed the hotspots heatmap: any train significantly off schedule, or
        // stalled, contributes a weighted point. Weight grows with delay.
        const delayed = l.dly >= HOTSPOT_DELAY_S || s.status === "stalled";
        if (delayed) {
          const effDelay = s.status === "stalled" ? Math.max(l.dly, 300) : l.dly;
          const weight = Math.min(1, effDelay / HOTSPOT_MAX_S);
          heat.features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [s.lng, s.lat] },
            properties: { weight },
          });
        }
      }
      src.setData(fc);
      if (hotspots) hotspots.setData(heat);
    }
    requestAnimationFrame(() => this.frame());
  }
}
