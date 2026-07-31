// Geometry helpers: find a point at a given distance along a shape polyline,
// and compute bearing. Works in meters using the cumulative distances that
// load.ts precomputed for each shape.

import type { Shape } from "./load.js";

export interface PointBrg {
  lng: number;
  lat: number;
  brg: number;
}

/** Bearing from point A to point B in degrees (0 = north, clockwise). */
export function bearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const φ1 = (aLat * Math.PI) / 180;
  const φ2 = (bLat * Math.PI) / 180;
  const Δλ = ((bLon - aLon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/**
 * Project a lat/lon onto the shape polyline and return the cumulative distance
 * (meters) of the nearest point along the shape. Used to derive per-stop shape
 * distances since MTA's stop_times lacks shape_dist_traveled.
 */
export interface Projection {
  /** Cumulative distance along the shape (meters) of the nearest point. */
  dist: number;
  /** Perpendicular distance from the input point to the shape (meters). */
  err: number;
}

export function projectDistance(shape: Shape, lat: number, lon: number): Projection {
  const pts = shape.points;
  if (pts.length < 2) return { dist: 0, err: Infinity };
  // Local planar approximation is fine at subway scale.
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const px = lon * mPerDegLon;
  const py = lat * mPerDegLat;

  let best = Infinity;
  let bestDist = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const ax = a.lon * mPerDegLon,
      ay = a.lat * mPerDegLat;
    const bx = b.lon * mPerDegLon,
      by = b.lat * mPerDegLat;
    const dx = bx - ax,
      dy = by - ay;
    const segLen2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / segLen2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx,
      cy = ay + t * dy;
    const d2 = (px - cx) ** 2 + (py - cy) ** 2;
    if (d2 < best) {
      best = d2;
      bestDist = a.dist + t * (b.dist - a.dist);
    }
  }
  return { dist: bestDist, err: Math.sqrt(best) };
}

/**
 * Point at `dist` meters along the shape. Binary-searches the cumulative
 * distance array, then linearly interpolates within the segment.
 */
export function pointAtDistance(shape: Shape, dist: number): PointBrg {
  const pts = shape.points;
  if (pts.length === 0) return { lng: 0, lat: 0, brg: 0 };
  if (dist <= 0) {
    const b = pts.length > 1 ? bearing(pts[0].lat, pts[0].lon, pts[1].lat, pts[1].lon) : 0;
    return { lng: pts[0].lon, lat: pts[0].lat, brg: b };
  }
  const last = pts[pts.length - 1];
  if (dist >= last.dist) {
    const p = pts[pts.length - 2] ?? last;
    return { lng: last.lon, lat: last.lat, brg: bearing(p.lat, p.lon, last.lat, last.lon) };
  }

  // binary search for the segment containing `dist`
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].dist < dist) lo = mid + 1;
    else hi = mid;
  }
  const b = pts[lo];
  const a = pts[lo - 1] ?? b;
  const span = b.dist - a.dist || 1;
  const f = (dist - a.dist) / span;
  return {
    lng: a.lon + (b.lon - a.lon) * f,
    lat: a.lat + (b.lat - a.lat) * f,
    brg: bearing(a.lat, a.lon, b.lat, b.lon),
  };
}
