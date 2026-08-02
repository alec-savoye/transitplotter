// Vehicle-count time series store.
//
// On every feed poll we record how many vehicles are active per mode (subway
// trains, buses, ferries). Samples are kept in a rolling 48-hour window and
// persisted as a small JSON array in the off-boot cache dir, so the series
// survives restarts. Powers GET /counts and the "vehicles over the last 48h"
// chart (double-click the HUD).
//
// Same persistence shape/discipline as VisitStore / InterpErrorStore:
// constructor(cacheDir) -> load(); dirty-gated flush(force); mkdir before write.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { VehicleCountPoint, VehicleCountSeries } from "@transitplotter/shared";

/** Rolling retention window: 48 hours. */
const WINDOW_MS = 48 * 60 * 60 * 1000;

interface DiskShape {
  points: VehicleCountPoint[];
}

export class CountStore {
  private points: VehicleCountPoint[] = [];
  private dirty = false;
  private readonly path: string;

  constructor(cacheDir: string) {
    this.path = join(cacheDir, "counts.json");
    this.load();
  }

  /** Drop samples older than the retention window. Points are appended in time
   *  order, so stale entries are always a prefix we can shift off the front. */
  private prune(nowMs: number) {
    const cutoff = nowMs - WINDOW_MS;
    let drop = 0;
    while (drop < this.points.length && this.points[drop].t < cutoff) drop++;
    if (drop > 0) {
      this.points.splice(0, drop);
      this.dirty = true;
    }
  }

  /** Record one sample of active (and delayed) vehicle counts by mode. */
  record(p: Omit<VehicleCountPoint, "t">, nowMs = Date.now()) {
    this.points.push({ t: nowMs, ...p });
    this.dirty = true;
    this.prune(nowMs);
  }

  /** Snapshot for GET /counts (oldest → newest, within the window). */
  series(nowMs = Date.now()): VehicleCountSeries {
    this.prune(nowMs);
    return { windowMs: WINDOW_MS, now: nowMs, points: this.points };
  }

  private load() {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as DiskShape;
      const pts = Array.isArray(raw.points) ? raw.points : [];
      // Keep only well-formed, in-window points (sorted by time to be safe).
      // Delay fields default to 0 for points persisted before they existed.
      this.points = pts
        .filter(
          (p) =>
            p &&
            Number.isFinite(p.t) &&
            Number.isFinite(p.subway) &&
            Number.isFinite(p.bus) &&
            Number.isFinite(p.ferry),
        )
        .map((p) => ({
          t: p.t,
          subway: p.subway,
          bus: p.bus,
          ferry: p.ferry,
          subwayDelayed: Number.isFinite(p.subwayDelayed) ? p.subwayDelayed : 0,
          busDelayed: Number.isFinite(p.busDelayed) ? p.busDelayed : 0,
          ferryDelayed: Number.isFinite(p.ferryDelayed) ? p.ferryDelayed : 0,
          cars: Number.isFinite(p.cars) ? p.cars : 0,
        }))
        .sort((a, b) => a.t - b.t);
      this.prune(Date.now());
      console.log(`counts: loaded ${this.points.length} samples`);
    } catch (e) {
      console.warn("counts: could not load, starting fresh", e);
    }
  }

  flush(force = false) {
    if (!this.dirty && !force) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const out: DiskShape = { points: this.points };
      writeFileSync(this.path, JSON.stringify(out));
      this.dirty = false;
    } catch (e) {
      console.error("counts: flush failed", e);
    }
  }
}
