// Shared motion model. Both the browser (live rendering) and the server
// (interpolation-error metrics) MUST place a vehicle identically for a given
// leg + time, so the math lives here and is imported by both sides.
//
// Why this exists: the subway realtime feed has no coordinates. We synthesize
// position by moving a vehicle along its stop->stop track polyline over the
// predicted time window. A naive constant-speed model is systematically wrong
// (real trains accelerate out of a stop, cruise, decelerate in, then dwell), so
// every feed refresh delivers a visible correction — the "jump". This module
// uses a trapezoidal speed profile (accel / cruise / decel) which matches
// reality far better and shrinks that per-refresh correction at its source.

/** Ramp (accel/decel) time at each end of a leg, in seconds. */
export const RAMP_S = 8;

/** Meters per degree latitude (approx, WGS84 mean). */
const M_PER_DEG_LAT = 110_540;
/** Meters per degree longitude at the equator. */
const M_PER_DEG_LON = 111_320;

export type LngLat = [number, number];

export interface CumPath {
  /** Cumulative distance (meters) at each polyline vertex. */
  cum: number[];
  /** Total polyline length (meters). */
  len: number;
}

/** Build cumulative *metric* distances along a [lng,lat] polyline. */
export function buildCumMeters(pts: LngLat[]): CumPath {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const latMid = ((pts[i][1] + pts[i - 1][1]) / 2) * (Math.PI / 180);
    const dx = (pts[i][0] - pts[i - 1][0]) * M_PER_DEG_LON * Math.cos(latMid);
    const dy = (pts[i][1] - pts[i - 1][1]) * M_PER_DEG_LAT;
    cum[i] = cum[i - 1] + Math.hypot(dx, dy);
  }
  return { cum, len: cum[cum.length - 1] || 0 };
}

/**
 * Distance (meters) travelled along a leg after `elapsed` seconds, following a
 * symmetric trapezoidal speed profile over total duration `T` covering `len`
 * meters. Degrades to a triangular profile when the leg is too short to reach
 * cruising speed. `elapsed` is clamped to [0, T] (so it dwells at the end).
 */
export function trapezoidDistance(
  elapsed: number,
  T: number,
  len: number,
  ramp = RAMP_S
): number {
  if (len <= 0) return 0;
  if (T <= 0) return len;
  const t = Math.max(0, Math.min(T, elapsed));

  // Triangular case: not enough time for a full ramp on each side.
  if (T <= 2 * ramp) {
    const half = T / 2;
    const a = (2 * len) / (T * T); // so that 2 * (0.5*a*half^2) = len
    if (t <= half) return 0.5 * a * t * t;
    const r = T - t;
    return len - 0.5 * a * r * r;
  }

  // Trapezoidal case. Cruise speed vmax such that the profile area == len.
  // Area = vmax * (T - ramp)  =>  vmax = len / (T - ramp).
  const vmax = len / (T - ramp);
  const a = vmax / ramp; // accel during the ramp
  if (t <= ramp) return 0.5 * a * t * t;
  if (t <= T - ramp) return 0.5 * a * ramp * ramp + vmax * (t - ramp);
  const r = T - t;
  return len - 0.5 * a * r * r;
}

/** Instantaneous speed (m/s) of the trapezoidal profile at `elapsed` seconds. */
export function trapezoidSpeed(
  elapsed: number,
  T: number,
  len: number,
  ramp = RAMP_S
): number {
  if (len <= 0 || T <= 0) return 0;
  const t = Math.max(0, Math.min(T, elapsed));
  if (T <= 2 * ramp) {
    const half = T / 2;
    const a = (2 * len) / (T * T);
    return t <= half ? a * t : a * (T - t);
  }
  const vmax = len / (T - ramp);
  const a = vmax / ramp;
  if (t <= ramp) return a * t;
  if (t <= T - ramp) return vmax;
  return a * (T - t);
}

export interface Located {
  lng: number;
  lat: number;
  /** Bearing (deg, 0=N) of the segment the point falls on. */
  brg: number;
}

/** Bearing in degrees (0=N, clockwise) from point a to point b. */
export function bearing(a: LngLat, b: LngLat): number {
  const p1 = (a[1] * Math.PI) / 180;
  const p2 = (b[1] * Math.PI) / 180;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Locate the point `d` meters along the polyline (with precomputed cum). */
export function locate(pts: LngLat[], cp: CumPath, d: number): Located {
  const { cum, len } = cp;
  if (pts.length === 0) return { lng: 0, lat: 0, brg: 0 };
  if (pts.length === 1) return { lng: pts[0][0], lat: pts[0][1], brg: 0 };
  const target = Math.max(0, Math.min(len, d));
  // Binary search the cumulative array for the segment containing `target`.
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const a = pts[i - 1];
  const b = pts[i];
  const segLen = cum[i] - cum[i - 1] || 1;
  const t = (target - cum[i - 1]) / segLen;
  return {
    lng: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    brg: bearing(a, b),
  };
}

/**
 * Project a point onto the polyline, returning the distance (meters) along the
 * line of the nearest point. Planar approximation (fine at city scale). Used to
 * carry a vehicle's rendered position across a leg refresh (reprojection) and
 * to measure interpolation error against real GPS.
 */
export function projectDistance(pts: LngLat[], cp: CumPath, lng: number, lat: number): number {
  if (pts.length === 0) return 0;
  if (pts.length === 1) return 0;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const toXY = (p: LngLat): [number, number] => [
    p[0] * M_PER_DEG_LON * cosLat,
    p[1] * M_PER_DEG_LAT,
  ];
  const px = lng * M_PER_DEG_LON * cosLat;
  const py = lat * M_PER_DEG_LAT;

  let best = Infinity;
  let bestDist = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = toXY(pts[i - 1]);
    const [bx, by] = toXY(pts[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const segLen2 = dx * dx + dy * dy;
    let t = segLen2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / segLen2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
    if (d2 < best) {
      best = d2;
      const segLen = Math.sqrt(segLen2);
      bestDist = cp.cum[i - 1] + segLen * t;
    }
  }
  return bestDist;
}

/**
 * Full interpolation for a leg at wall-clock time `nowSec` using the shared
 * trapezoidal model. This is the single source of truth used by the server's
 * error metric; the client mirrors it (with a continuity follower on top).
 */
export function interpAt(
  pts: LngLat[],
  cp: CumPath,
  d0: number,
  d1: number,
  nowSec: number,
  ramp = RAMP_S
): Located {
  const T = d1 - d0;
  const d = trapezoidDistance(nowSec - d0, T, cp.len, ramp);
  return locate(pts, cp, d);
}

/** Great-circle distance in meters between two [lng,lat] points. */
export function haversineM(a: LngLat, b: LngLat): number {
  const R = 6_371_000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
