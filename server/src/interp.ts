// Interpolation-error metrics store.
//
// Purpose: quantify how well our synthesized motion model predicts where a
// vehicle actually is, so we can prove the model is improving (and later, learn
// per-segment corrections). The subway feed has no coordinates, so on each feed
// refresh we compare the PREVIOUS leg's predicted position at the refresh
// instant against the new ground truth:
//   - bus / ferry: the new leg's real GPS anchor (path[0]) -> TRUE error.
//   - subway:      the new leg's freshly modeled position  -> snap-magnitude
//                  proxy (what the user perceives as a jump).
//
// This is realtime-derived data we persist over time (like TrackRecordStore),
// as a small JSON tally in the off-boot cache dir. It survives restarts.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { TrainLeg, InterpErrorStats, InterpErrorBucket } from "@transitplotter/shared";
import { buildCumMeters, interpAt, haversineM, type LngLat } from "@transitplotter/shared/kinematics";

/** Cap the number of raw samples retained per bucket for percentile math. */
const MAX_RESERVOIR = 4000;
/** Retain at most this many recent day-buckets on disk. */
const MAX_DAYS = 60;

interface DayAgg {
  n: number;
  sum: number;
  /** Sorted-insertion sample list capped at MAX_RESERVOIR for p95. */
  samples: number[];
}

interface Reservoir {
  n: number;
  sum: number;
  samples: number[];
}

interface DiskShape {
  totalSamples: number;
  overall: { n: number; sum: number; samples: number[] };
  byMode: Record<string, { n: number; sum: number; samples: number[] }>;
  byRoute: Record<string, { n: number; sum: number; samples: number[] }>;
  days: Record<string, { n: number; sum: number; samples: number[] }>;
}

function emptyReservoir(): Reservoir {
  return { n: 0, sum: 0, samples: [] };
}

/** Reservoir-sample an error value into a bucket (keeps memory bounded). */
function addSample(r: Reservoir, err: number) {
  r.n++;
  r.sum += err;
  if (r.samples.length < MAX_RESERVOIR) {
    r.samples.push(err);
  } else {
    // Replace a random slot so the reservoir stays representative.
    const j = Math.floor(Math.random() * r.n);
    if (j < MAX_RESERVOIR) r.samples[j] = err;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function bucketStats(r: Reservoir): InterpErrorBucket {
  const sorted = [...r.samples].sort((a, b) => a - b);
  return {
    n: r.n,
    mean: r.n > 0 ? Math.round((r.sum / r.n) * 10) / 10 : 0,
    p50: Math.round(percentile(sorted, 50) * 10) / 10,
    p95: Math.round(percentile(sorted, 95) * 10) / 10,
  };
}

/** Local calendar date "YYYY-MM-DD" for an epoch-ms timestamp. */
function dayKey(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export class InterpErrorStore {
  private overall = emptyReservoir();
  private byMode = new Map<string, Reservoir>();
  private byRoute = new Map<string, Reservoir>();
  private days = new Map<string, DayAgg>();
  private totalSamples = 0;
  private dirty = false;
  private readonly path: string;

  constructor(cacheDir: string) {
    this.path = join(cacheDir, "interp_errors.json");
    this.load();
  }

  private bucket(map: Map<string, Reservoir>, key: string): Reservoir {
    let r = map.get(key);
    if (!r) map.set(key, (r = emptyReservoir()));
    return r;
  }

  /**
   * Compare the previous broadcast's legs (predictions) against the new legs
   * (ground truth) at wall-clock `nowMs`, recording the along-track error for
   * every trip present in both sets.
   */
  ingest(prevLegs: TrainLeg[], newLegs: TrainLeg[], nowMs = Date.now()) {
    if (prevLegs.length === 0) return;
    const nowSec = nowMs / 1000;
    const prevById = new Map(prevLegs.map((l) => [l.id, l]));

    for (const cur of newLegs) {
      const prev = prevById.get(cur.id);
      if (!prev) continue;
      if (!prev.path || prev.path.length < 2) continue;
      if (!cur.path || cur.path.length === 0) continue;

      // Where the PREVIOUS leg predicted this vehicle would be, right now.
      const prevPts = prev.path as LngLat[];
      const cp = buildCumMeters(prevPts);
      const predicted = interpAt(prevPts, cp, prev.d0, prev.d1, nowSec);

      // Ground truth. Bus/ferry legs are anchored at real GPS (path[0]); subway
      // has none, so use the new leg's modeled position (snap magnitude).
      const mode = cur.mode ?? "subway";
      let truth: LngLat;
      if (mode === "bus" || mode === "ferry") {
        truth = cur.path[0] as LngLat;
      } else {
        const cpCur = buildCumMeters(cur.path as LngLat[]);
        const t = interpAt(cur.path as LngLat[], cpCur, cur.d0, cur.d1, nowSec);
        truth = [t.lng, t.lat];
      }

      const err = haversineM([predicted.lng, predicted.lat], truth);
      if (!Number.isFinite(err) || err > 20_000) continue; // reject garbage

      this.totalSamples++;
      addSample(this.overall, err);
      addSample(this.bucket(this.byMode, mode), err);
      addSample(this.bucket(this.byRoute, cur.r), err);

      const dk = dayKey(nowMs);
      let d = this.days.get(dk);
      if (!d) this.days.set(dk, (d = { n: 0, sum: 0, samples: [] }));
      d.n++;
      d.sum += err;
      if (d.samples.length < MAX_RESERVOIR) d.samples.push(err);

      this.dirty = true;
    }
  }

  /** Aggregate report for GET /interp/stats. */
  stats(): InterpErrorStats {
    const byMode: Record<string, InterpErrorBucket> = {};
    for (const [k, r] of this.byMode) byMode[k] = bucketStats(r);

    // Top routes by sample count (keep the report compact).
    const routes = [...this.byRoute.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 30);
    const byRoute: Record<string, InterpErrorBucket> = {};
    for (const [k, r] of routes) byRoute[k] = bucketStats(r);

    const days = [...this.days.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-MAX_DAYS)
      .map(([date, d]) => {
        const sorted = [...d.samples].sort((a, b) => a - b);
        return {
          date,
          n: d.n,
          mean: d.n > 0 ? Math.round((d.sum / d.n) * 10) / 10 : 0,
          p95: Math.round(percentile(sorted, 95) * 10) / 10,
        };
      });

    return {
      totalSamples: this.totalSamples,
      overall: bucketStats(this.overall),
      byMode,
      byRoute,
      days,
      note:
        "bus/ferry errors are GPS-referenced (true error); subway errors are the " +
        "refresh snap magnitude (proxy). Lower is better.",
    };
  }

  private load() {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as DiskShape;
      this.totalSamples = raw.totalSamples ?? 0;
      const restore = (m: Map<string, Reservoir>, rec?: Record<string, { n: number; sum: number; samples: number[] }>) => {
        for (const [k, v] of Object.entries(rec ?? {})) {
          m.set(k, { n: v.n ?? 0, sum: v.sum ?? 0, samples: v.samples ?? [] });
        }
      };
      if (raw.overall) this.overall = { n: raw.overall.n, sum: raw.overall.sum, samples: raw.overall.samples ?? [] };
      restore(this.byMode, raw.byMode);
      restore(this.byRoute, raw.byRoute);
      for (const [k, v] of Object.entries(raw.days ?? {})) {
        this.days.set(k, { n: v.n ?? 0, sum: v.sum ?? 0, samples: v.samples ?? [] });
      }
      console.log(`interp errors: loaded ${this.totalSamples} samples`);
    } catch (e) {
      console.warn("interp errors: could not load, starting fresh", e);
    }
  }

  flush(force = false) {
    if (!this.dirty && !force) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const dump = (m: Map<string, Reservoir>) => {
        const o: Record<string, { n: number; sum: number; samples: number[] }> = {};
        for (const [k, r] of m) o[k] = { n: r.n, sum: r.sum, samples: r.samples };
        return o;
      };
      // Trim day buckets to the retention window.
      const dayKeys = [...this.days.keys()].sort();
      while (dayKeys.length > MAX_DAYS) this.days.delete(dayKeys.shift()!);
      const days: Record<string, { n: number; sum: number; samples: number[] }> = {};
      for (const [k, d] of this.days) days[k] = { n: d.n, sum: d.sum, samples: d.samples };

      const out: DiskShape = {
        totalSamples: this.totalSamples,
        overall: { n: this.overall.n, sum: this.overall.sum, samples: this.overall.samples },
        byMode: dump(this.byMode),
        byRoute: dump(this.byRoute),
        days,
      };
      writeFileSync(this.path, JSON.stringify(out));
      this.dirty = false;
    } catch (e) {
      console.error("interp errors: flush failed", e);
    }
  }
}
