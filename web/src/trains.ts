// Client-side position engine. The server sends each train's *leg* (segment
// polyline + schedule times) only when the feed refreshes (~20s). This class
// interpolates the live position along that polyline every animation frame, so
// motion is smooth and the server no longer streams per-second updates.

import type maplibregl from "maplibre-gl";
import type { ServerMessage, TrainLeg, TrainStatus, RouteMeta } from "@transitplotter/shared";
import {
  buildCumMeters,
  trapezoidDistance,
  trapezoidSpeed,
  projectDistance,
  locate,
  type CumPath,
  type LngLat,
} from "@transitplotter/shared/kinematics";
import { emptyFC } from "./basemap.js";
import { IS_MOBILE } from "./config.js";

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
  mode: "subway" | "ferry" | "bus";
  label: string;
  boro: string;
  spd?: number; // feed-reported speed (m/s), if any
  vid?: string; // vehicle/vessel id, if any
  d0: number; // depart epoch s
  d1: number; // arrive epoch s
  hts: number; // feed header epoch s
  dly: number; // estimated delay seconds (0 if on time/unknown)
  /** Polyline points [lng,lat]. */
  pts: LngLat[];
  /** Cumulative metric distance (meters) at each point. */
  cum: number[];
  /** Total length (meters). */
  len: number;
  /** epoch ms when this leg was received (for stall clock). */
  recvMs: number;

  // --- along-track continuity follower state ---
  /**
   * Rendered distance (meters) along THIS leg's polyline. Persisted across
   * frames so the vehicle advances smoothly (and never teleports) rather than
   * snapping to the freshly computed target on each feed refresh.
   */
  s: number;
  /** Rendered along-track speed (m/s) of the follower, for accel limiting. */
  v: number;
}

interface Sample {
  lng: number;
  lat: number;
  brg: number;
  status: TrainStatus;
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
  mode: "subway" | "ferry" | "bus";
  label: string;
  boro: string;
  /** Feed header time (epoch seconds) = when this delay was last observed. */
  asOf: number;
  /** Follower along-track speed (m/s) at render time, carried across refreshes. */
  v: number;
}

/**
 * Cap the render rate. Rebuilding the GeoJSON for ~1000 vehicles on every
 * animation frame (60fps) overwhelms mobile devices and can crash the tab.
 * Interpolation still looks smooth at a lower rate. Mobile gets a lower cap.
 */
const TARGET_FPS = IS_MOBILE ? 12 : 30;
const FRAME_MIN_MS = 1000 / TARGET_FPS;

/**
 * Continuity follower tuning. Instead of snapping to the trapezoidal target on
 * every feed refresh (which caused the whole fleet to jolt in sync), each
 * vehicle keeps an along-track position `s` and speed `v` and *chases* the
 * model target with bounded acceleration. When the model and the rendered
 * position agree (the common case now that we model accel/dwell), the follower
 * is a no-op; when they disagree, it closes the gap smoothly and monotonically.
 */

/** Max along-track acceleration the follower may apply (m/s²). */
const MAX_ACCEL = 1.3;
/**
 * How aggressively the follower's target speed reacts to the position error
 * (1/s). Higher = closes gaps faster (snappier, riskier); lower = smoother,
 * laggier. The gain is applied as: vTarget = modelSpeed + gain * (target - s).
 */
const CATCHUP_GAIN = 0.5;
/** Hard cap on catch-up speed as a multiple of the leg's mean speed. */
const MAX_CATCHUP_MULT = 3;
/**
 * If the reprojected position is more than this far (m) from the model target
 * on refresh — e.g. a route/segment change — jump directly instead of sliding
 * across unrelated geometry.
 */
const TELEPORT_GAP_M = 400;

export class TrainLayer {
  private legs = new Map<string, Leg>();
  private colors = new Map<string, string>();
  /** Latest rendered position/state per train, refreshed each frame. */
  private live = new Map<string, LiveTrain>();
  /** Wall-clock ms of the last rendered frame (for FPS throttling). */
  private lastFrameMs = 0;
  /** Cumulative-path cache keyed by train id (parallel to `legs`). */
  private paths = new Map<string, CumPath>();

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

  /** All currently-rendered vehicles on a given route id (for Isolate). */
  trainsOnRoute(routeId: string): LiveTrain[] {
    const out: LiveTrain[] = [];
    for (const t of this.live.values()) if (t.route === routeId) out.push(t);
    return out;
  }

  /** Ingest a fresh batch of legs from the server. */
  update(msg: ServerMessage) {
    const recvMs = Date.now();
    const nowSec = recvMs / 1000;
    const seen = new Set<string>();
    for (const l of msg.legs) {
      seen.add(l.id);
      const pts = l.path as LngLat[];
      const cp = buildCumMeters(pts);

      // Continuity: carry the follower's position across the leg refresh by
      // reprojecting the last-rendered lng/lat onto the NEW polyline. This puts
      // both the old rendered position and the new model target in the same
      // 1-D (along-track) frame so the follower can chase without teleporting.
      const prev = this.live.get(l.id);
      const modelTarget = trapezoidDistance(nowSec - l.d0, l.d1 - l.d0, cp.len);
      let s: number;
      let v: number;
      if (prev && pts.length > 1) {
        const reproj = projectDistance(pts, cp, prev.lng, prev.lat);
        const gap = Math.abs(modelTarget - reproj);
        if (gap > TELEPORT_GAP_M) {
          // Unrelated geometry (route/segment change): jump to the model.
          s = modelTarget;
        } else {
          // Never allow the follower to sit *ahead* of the model target by a
          // lot (would imply reversing); clamp behind-or-at target.
          s = Math.min(reproj, modelTarget);
        }
        v = prev.v ?? 0;
      } else {
        s = modelTarget;
        v = 0;
      }

      this.legs.set(l.id, {
        r: l.r,
        ns: l.ns,
        dest: l.dest,
        mode: l.mode ?? "subway",
        label: l.label ?? "",
        boro: l.boro ?? "",
        spd: l.spd,
        vid: l.vid,
        d0: l.d0,
        d1: l.d1,
        hts: l.hts,
        dly: l.dly ?? 0,
        pts,
        cum: cp.cum,
        len: cp.len,
        recvMs,
        s,
        v,
      });
      this.paths.set(l.id, cp);
    }
    // Drop trains no longer reported.
    for (const id of [...this.legs.keys()]) {
      if (!seen.has(id)) {
        this.legs.delete(id);
        this.paths.delete(id);
      }
    }
  }

  /**
   * Advance a leg's along-track follower by `dtSec` and return its rendered
   * position. The trapezoidal model provides the physically-plausible target
   * distance + speed; the follower chases it with bounded acceleration so the
   * marker never teleports and never reverses.
   */
  private sample(l: Leg, cp: CumPath, nowSec: number, dtSec: number): Sample {
    const T = l.d1 - l.d0;
    const elapsed = nowSec - l.d0;

    let status: TrainStatus = "moving";
    if (elapsed <= 0) status = "stopped";
    if (nowSec - l.hts > STALL_THRESHOLD_S) status = "stalled";

    if (l.pts.length === 1 || l.len <= 0) {
      const p = l.pts[0] ?? [0, 0];
      l.s = 0;
      l.v = 0;
      return { lng: p[0], lat: p[1], brg: 0, status };
    }

    // Physically-plausible target from the trapezoidal profile.
    const target = trapezoidDistance(elapsed, T, l.len);
    const modelSpeed = trapezoidSpeed(elapsed, T, l.len);
    const meanSpeed = T > 0 ? l.len / T : 0;

    // Follower: choose a target speed that both moves with the model and closes
    // any residual gap, then limit acceleration and integrate. Monotonic (never
    // negative) so trains don't visually reverse.
    const gap = target - l.s;
    let vTarget = modelSpeed + CATCHUP_GAIN * gap;
    const vCap = Math.max(modelSpeed, meanSpeed) * MAX_CATCHUP_MULT;
    vTarget = Math.max(0, Math.min(vTarget, vCap));

    const dv = vTarget - l.v;
    const maxDv = MAX_ACCEL * dtSec;
    l.v += Math.max(-maxDv, Math.min(maxDv, dv));
    if (l.v < 0) l.v = 0;
    l.s += l.v * dtSec;

    // Clamp to the leg; hold (dwell) at the end until the next leg arrives.
    if (l.s >= l.len) {
      l.s = l.len;
      l.v = 0;
    }
    if (l.s < 0) l.s = 0;

    if (l.s <= 0) status = elapsed <= 0 ? "stopped" : status;

    const loc = locate(l.pts, cp, l.s);
    return { lng: loc.lng, lat: loc.lat, brg: loc.brg, status };
  }

  private frame() {
    const now = performance.now();

    // Throttle to TARGET_FPS: skip this frame if too little time has elapsed.
    // Prevents rebuilding ~1000-feature GeoJSON at 60fps, which overloads mobile.
    if (now - this.lastFrameMs < FRAME_MIN_MS) {
      requestAnimationFrame(() => this.frame());
      return;
    }
    // Delta since the last *rendered* frame, for the follower integration.
    // Clamp to avoid a huge jump after a tab was backgrounded.
    const dtSec = this.lastFrameMs > 0 ? Math.min(1, (now - this.lastFrameMs) / 1000) : 0;
    this.lastFrameMs = now;

    const nowMs = Date.now();
    const nowSec = nowMs / 1000;

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
        const cp = this.paths.get(id) ?? { cum: l.cum, len: l.len };
        const s = this.sample(l, cp, nowSec, dtSec);
        const lng = s.lng;
        const lat = s.lat;

        fc.features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lng, lat] },
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
            mode: l.mode,
            label: l.label,
            boro: l.boro,
            spd: l.spd ?? "",
            vid: l.vid ?? "",
          },
        });

        this.live.set(id, {
          id,
          route: l.r,
          lng,
          lat,
          dly: l.dly,
          status: s.status,
          ns: l.ns ?? "",
          dest: l.dest ?? "",
          mode: l.mode,
          label: l.label,
          boro: l.boro,
          asOf: l.hts,
          v: l.v,
        });

        // Feed the hotspots heatmap: any train significantly off schedule, or
        // stalled, contributes a weighted point. Weight grows with delay.
        const delayed = l.dly >= HOTSPOT_DELAY_S || s.status === "stalled";
        if (delayed) {
          const effDelay = s.status === "stalled" ? Math.max(l.dly, 300) : l.dly;
          const weight = Math.min(1, effDelay / HOTSPOT_MAX_S);
          heat.features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [lng, lat] },
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
