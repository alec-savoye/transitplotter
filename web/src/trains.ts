// Dumb renderer: consumes ServerMessage snapshots and smoothly tweens each
// train from its previous position to the newly received one using rAF.
// No transit logic here — the server already computed everything.

import type maplibregl from "maplibre-gl";
import type { ServerMessage, TrainSnapshot, RouteMeta } from "@transitplotter/shared";
import { emptyFC } from "./basemap.js";

interface TweenTrain {
  from: [number, number];
  to: [number, number];
  startMs: number;
  r: string;
  s: string;
  ns?: string;
  eta?: number;
  dest?: string;
}

// Duration to tween between snapshots. Matches server tick (~1s); a little
// longer keeps motion smooth if a packet is late.
const TWEEN_MS = 1100;

export class TrainLayer {
  private trains = new Map<string, TweenTrain>();
  private colors = new Map<string, string>();

  constructor(private map: maplibregl.Map, routes: RouteMeta[]) {
    for (const r of routes) this.colors.set(r.id, r.color);
    requestAnimationFrame(() => this.frame());
  }

  update(msg: ServerMessage) {
    const now = performance.now();
    const seen = new Set<string>();
    for (const t of msg.trains) {
      seen.add(t.id);
      const existing = this.trains.get(t.id);
      const cur = existing ? this.sample(existing, now) : [t.lng, t.lat] as [number, number];
      this.trains.set(t.id, {
        from: cur,
        to: [t.lng, t.lat],
        startMs: now,
        r: t.r,
        s: t.s,
        ns: t.ns,
        eta: t.eta,
        dest: t.dest,
      });
    }
    // drop trains no longer reported
    for (const id of [...this.trains.keys()]) {
      if (!seen.has(id)) this.trains.delete(id);
    }
  }

  private sample(t: TweenTrain, now: number): [number, number] {
    const f = Math.min(1, (now - t.startMs) / TWEEN_MS);
    return [
      t.from[0] + (t.to[0] - t.from[0]) * f,
      t.from[1] + (t.to[1] - t.from[1]) * f,
    ];
  }

  private frame() {
    const now = performance.now();

    // Slow pulse for the stalled-train ring (~2.5s period).
    if (this.map.getLayer("trains-halo")) {
      const phase = (Math.sin((now / 1250) * Math.PI) + 1) / 2; // 0..1
      this.map.setPaintProperty("trains-halo", "circle-stroke-opacity", 0.25 + 0.6 * phase);
      this.map.setPaintProperty("trains-halo", "circle-radius", 11 + 4 * phase);
    }

    const src = this.map.getSource("trains") as maplibregl.GeoJSONSource | undefined;
    if (src) {
      const fc = emptyFC();
      for (const [id, t] of this.trains) {
        const [lng, lat] = this.sample(t, now);
        fc.features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lng, lat] },
          properties: {
            id,
            route: t.r,
            color: this.colors.get(t.r) ?? "#cccccc",
            status: t.s,
            ns: t.ns ?? "",
            eta: t.eta ?? 0,
            dest: t.dest ?? "",
          },
        });
      }
      src.setData(fc);
    }
    requestAnimationFrame(() => this.frame());
  }
}
