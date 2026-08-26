// "Track Records": a persistent, lightweight history of on-time-vs-late
// performance, bucketed into a coarse spatial mesh (~a few blocks per cell).
//
// Design notes / invariants:
//   - This is the ONE piece of realtime-derived data we persist, by explicit
//     product requirement ("log constantly over time"). It is kept as a tiny
//     JSON tally per populated cell, NOT in the static SQLite (which stays
//     "static data only"). The file lives in the off-boot cache dir so it
//     survives restarts and accumulates over time.
//   - We count ONE observation per *completed segment traversal* per trip, not
//     one per poll. A trip advancing from heading-to-stop-A to heading-to-stop-B
//     means the segment ending at A just completed; we log its lateness once.
//     This avoids inflating counts by re-sampling the same slow train every 20s.
//   - Ferries carry no delay signal (their `dly` is always 0), so tallying them
//     would paint every ferry cell misleadingly green. They are excluded; the
//     UI notes ferry reliability is not yet tracked.
//
// Storage model (bounded — does NOT grow with the number of observations):
//   - Each cell keeps a *time-decayed* late/total tally per mode: an
//     exponential moving average with a fixed half-life (DECAY_HALFLIFE_MS).
//     On each new observation the existing counts are first decayed by
//     0.5^(dt/halflife), then the new sample is added. Old observations fade
//     rather than accumulating forever, so (a) the stored numbers stay bounded
//     no matter how long we run, and (b) the displayed percentage keeps
//     tracking *recent* reliability instead of freezing once the lifetime total
//     gets huge. Storage is O(cells), independent of observation count.
//   - A short per-cell daily series (late/total per calendar day) still backs
//     the click-through trend plot, but it is pruned to the last
//     MAX_HISTORY_DAYS so it too is bounded over time.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type {
  TrainLeg,
  TrackRecordSnapshot,
  TrackRecordCell,
  TrackRecordHistory,
  TrackRecordDay,
} from "@transitplotter/shared";

/** Mesh cell size in degrees (~a few NYC blocks; ~0.004° lat ≈ 445 m). */
const LAT_STEP = 0.004;
const LON_STEP = 0.005;

/** A leg is "late" once its estimated/reported delay reaches this many seconds. */
const LATE_THRESHOLD_S = 120;

/**
 * A cell is only colored once it has been observed across a span of at least
 * this many days (first observation to latest observation). Until then it is
 * rendered light gray ("not enough data gathered yet"). This ensures a cell
 * reflects a full day's worth of conditions before we grade its reliability.
 */
const WINDOW_DAYS = 1;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Half-life of the time-decayed tallies (ms). Each observation's weight halves
 * every this-many ms, so the effective sample window is ~2x this. With a 1-day
 * half-life a cell's percentage reflects roughly the last couple of days of
 * conditions and keeps updating forever without the counts growing unbounded.
 */
const DECAY_HALFLIFE_MS = 24 * 60 * 60 * 1000;

/** Keep at most this many calendar days of per-cell trend history (pruned). */
const MAX_HISTORY_DAYS = 14;

/** Drop a trip's tracking state if we haven't seen it for this long (ms). */
const TRIP_STALE_MS = 10 * 60 * 1000;

/** Only subway + bus are tracked (ferries have no delay signal). */
type TrackedMode = "subway" | "bus";

/**
 * A time-decayed late/total tally. `late`/`total` are *weighted* counts (real
 * numbers, not integers): each is multiplied by 0.5^(dt/halflife) before a new
 * observation is folded in, so recent samples dominate and the values stay
 * bounded. `ts` is the epoch-ms of the last decay so the next update knows dt.
 */
interface Tally {
  late: number;
  total: number;
  /** Epoch ms the weights were last decayed to. 0 = never observed. */
  ts: number;
}
/** Plain integer late/total, used only for the per-day trend series on disk. */
interface DayTally {
  late: number;
  total: number;
}
interface Cell {
  subway: Tally;
  bus: Tally;
  /** Epoch ms of the first observation recorded in this cell. */
  firstObs: number;
  /** Epoch ms of the most recent observation recorded in this cell. */
  lastObs: number;
  /**
   * Per-calendar-day late/total tallies keyed by "YYYY-MM-DD", enabling a
   * historical %-lateness-vs-date plot when a ready cell is clicked. Pruned to
   * the last MAX_HISTORY_DAYS so it stays bounded.
   */
  days: Map<string, DayTally>;
}

/** What we remember about a trip between polls, to detect segment completion. */
interface TripState {
  /** Next-stop name, our proxy for "which segment is this trip on". */
  ns: string;
  /** Delay (s) most recently reported while heading to that stop. */
  dly: number;
  /** Arrival-end coordinate of the current segment [lng, lat]. */
  lat: number;
  lon: number;
  mode: TrackedMode;
  /** Last time we saw this trip (ms), for stale purging. */
  seen: number;
}

interface DiskShape {
  totalObs: number;
  cells: Record<
    string,
    {
      subway: Tally;
      bus: Tally;
      firstObs?: number;
      lastObs?: number;
      /** Per-day tallies keyed by "YYYY-MM-DD". */
      days?: Record<string, DayTally>;
    }
  >;
}

const emptyTally = (): Tally => ({ late: 0, total: 0, ts: 0 });

/**
 * Decay a weighted tally to time `now` in place: multiply both counts by
 * 0.5^((now - ts)/halflife). No-op for a never-observed tally.
 */
function decayTally(t: Tally, now: number): void {
  if (t.ts === 0) {
    t.ts = now;
    return;
  }
  const dt = now - t.ts;
  if (dt <= 0) return;
  const f = Math.pow(0.5, dt / DECAY_HALFLIFE_MS);
  t.late *= f;
  t.total *= f;
  t.ts = now;
}

/**
 * Blended late rate for a cell (0..1) that gives each *mode* equal weight.
 *
 * We average the per-mode late percentages (only modes that actually have
 * observations here) instead of pooling raw counts. Buses are ~87% of all
 * observations, so a raw `(subwayLate+busLate)/(subwayTotal+busTotal)` let bus
 * volume dominate — a heavily-delayed subway segment could read as green just
 * because plenty of on-time buses share the tile. Averaging the rates keeps
 * subway and bus reliability on equal footing. Ferries carry no delay signal
 * and are not tracked, so at most two modes contribute.
 */
function modeRate(c: Cell): number {
  const rates: number[] = [];
  if (c.subway.total > 0) rates.push(c.subway.late / c.subway.total);
  if (c.bus.total > 0) rates.push(c.bus.late / c.bus.total);
  if (rates.length === 0) return 0;
  return rates.reduce((s, r) => s + r, 0) / rates.length;
}

/** Minimum decayed weight in a cell before we consider it graded/ready. */
const MIN_READY_WEIGHT = 5;

/** Local calendar date "YYYY-MM-DD" for an epoch-ms timestamp. */
function dayKey(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export class TrackRecordStore {
  private cells = new Map<string, Cell>();
  private trips = new Map<string, TripState>();
  private totalObs = 0;
  private dirty = false;
  private readonly path: string;

  constructor(cacheDir: string) {
    this.path = join(cacheDir, "track_records.json");
    this.load();
  }

  /** Mesh cell key for a coordinate. */
  private cellKey(lat: number, lon: number): string {
    const li = Math.floor(lat / LAT_STEP);
    const lo = Math.floor(lon / LON_STEP);
    return `${li}:${lo}`;
  }

  private getCell(key: string): Cell {
    let c = this.cells.get(key);
    if (!c) {
      c = {
        subway: emptyTally(),
        bus: emptyTally(),
        firstObs: 0,
        lastObs: 0,
        days: new Map(),
      };
      this.cells.set(key, c);
    }
    return c;
  }

  /**
   * Ingest the latest batch of legs. Detects segment completions vs. the
   * previous poll and records one observation per completed segment.
   */
  ingest(legs: TrainLeg[]) {
    const now = Date.now();
    const seenNow = new Set<string>();

    for (const leg of legs) {
      const mode = (leg.mode ?? "subway") as string;
      if (mode !== "subway" && mode !== "bus") continue; // ferries excluded
      if (!leg.path || leg.path.length === 0) continue;

      seenNow.add(leg.id);
      const ns = leg.ns ?? "";
      const dly = leg.dly ?? 0;
      // Arrival end of this leg = last point of the path (the next stop).
      const end = leg.path[leg.path.length - 1];
      const [lon, lat] = end;

      const prev = this.trips.get(leg.id);
      if (prev && prev.ns && ns && prev.ns !== ns) {
        // The trip advanced to a new stop: the previous segment completed.
        this.record(prev.mode, prev.lat, prev.lon, prev.dly >= LATE_THRESHOLD_S, now);
      }

      this.trips.set(leg.id, {
        ns,
        dly,
        lat,
        lon,
        mode: mode as TrackedMode,
        seen: now,
      });
    }

    // Purge trips we haven't seen in a while (finished/ended trips never get a
    // final segment logged, which is fine — we only count observed completions).
    for (const [id, st] of this.trips) {
      if (now - st.seen > TRIP_STALE_MS) this.trips.delete(id);
    }
  }

  private record(
    mode: TrackedMode,
    lat: number,
    lon: number,
    late: boolean,
    now: number
  ) {
    const cell = this.getCell(this.cellKey(lat, lon));
    const t = cell[mode];
    // Decay the existing weighted counts to `now`, then fold in this sample
    // with weight 1. This keeps the stored numbers bounded (they converge
    // rather than grow) and makes the percentage track recent conditions.
    decayTally(t, now);
    t.total += 1;
    if (late) t.late += 1;
    if (!cell.firstObs) cell.firstObs = now;
    cell.lastObs = now;

    // Per-day tally (all modes combined) for the historical plot. Integer
    // counts; pruned to the last MAX_HISTORY_DAYS so the map stays bounded.
    const dk = dayKey(now);
    let day = cell.days.get(dk);
    if (!day) cell.days.set(dk, (day = { late: 0, total: 0 }));
    day.total++;
    if (late) day.late++;
    if (cell.days.size > MAX_HISTORY_DAYS) {
      const keys = [...cell.days.keys()].sort();
      while (keys.length > MAX_HISTORY_DAYS) cell.days.delete(keys.shift()!);
    }

    this.totalObs++;
    this.dirty = true;
  }

  /**
   * Per-day historical series for one cell (oldest first), for the click-through
   * "% lateness vs. date" plot. Returns null for unknown/empty cells.
   */
  history(key: string): TrackRecordHistory | null {
    const c = this.cells.get(key);
    if (!c || c.days.size === 0) return null;
    const [li, lo] = key.split(":").map(Number);
    const days: TrackRecordDay[] = [...c.days.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, t]) => ({ date, late: t.late, total: t.total }));
    return {
      key,
      lat: (li + 0.5) * LAT_STEP,
      lon: (lo + 0.5) * LON_STEP,
      days,
    };
  }

  /** Serializable snapshot for the API / overlay. */
  snapshot(): TrackRecordSnapshot {
    const now = Date.now();
    const cells: TrackRecordCell[] = [];
    let readyCells = 0;
    for (const [key, c] of this.cells) {
      // Decay to `now` so an idle cell's weight (and thus its readiness) fades
      // rather than freezing at its last-seen value.
      decayTally(c.subway, now);
      decayTally(c.bus, now);
      const total = c.subway.total + c.bus.total;
      if (total <= 0) continue;
      const [li, lo] = key.split(":").map(Number);
      // A cell is ready once its observations span at least the window AND it
      // still carries enough (decayed) weight to be meaningful.
      const span = c.firstObs ? now - c.firstObs : 0;
      const ready =
        c.firstObs > 0 && span >= WINDOW_MS && total >= MIN_READY_WEIGHT;
      if (ready) readyCells++;
      cells.push({
        key,
        // Cell center coordinate.
        lat: (li + 0.5) * LAT_STEP,
        lon: (lo + 0.5) * LON_STEP,
        // Blend the *per-mode* late rates rather than pooling raw counts.
        // Averaging each mode's own percentage gives subway and bus equal
        // weight, so the far-more-numerous buses (~87% of observations) can no
        // longer swamp the subway signal in a mixed cell. See modeRate() above.
        rate: modeRate(c),
        // Report rounded weighted counts so the client sees stable integers.
        total: Math.round(total),
        ready,
        firstObs: c.firstObs,
        lastObs: c.lastObs,
        subway: { late: Math.round(c.subway.late), total: Math.round(c.subway.total) },
        bus: { late: Math.round(c.bus.late), total: Math.round(c.bus.total) },
      });
    }
    return {
      totalObs: this.totalObs,
      windowDays: WINDOW_DAYS,
      readyCells,
      ready: readyCells > 0,
      cellStep: [LAT_STEP, LON_STEP],
      cells,
    };
  }

  /** Load persisted tallies from disk, if present. */
  private load() {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as DiskShape;
      this.totalObs = raw.totalObs ?? 0;
      for (const [key, c] of Object.entries(raw.cells ?? {})) {
        const days = new Map<string, DayTally>();
        for (const [dk, t] of Object.entries(c.days ?? {})) {
          days.set(dk, { late: t.late ?? 0, total: t.total ?? 0 });
        }
        // Seed the decay timestamp from lastObs so pre-existing weighted counts
        // continue to fade correctly (files predating decay simply resume from
        // their last-seen time).
        const seedTs = c.lastObs ?? 0;
        this.cells.set(key, {
          subway: {
            late: c.subway?.late ?? 0,
            total: c.subway?.total ?? 0,
            ts: c.subway?.ts ?? seedTs,
          },
          bus: {
            late: c.bus?.late ?? 0,
            total: c.bus?.total ?? 0,
            ts: c.bus?.ts ?? seedTs,
          },
          firstObs: c.firstObs ?? 0,
          lastObs: c.lastObs ?? 0,
          days,
        });
      }
      console.log(
        `track records: loaded ${this.cells.size} cells, ${this.totalObs} observations`
      );
    } catch (e) {
      console.warn("track records: could not load, starting fresh", e);
    }
  }

  /** Persist tallies to disk (only if something changed since last flush). */
  flush(force = false) {
    if (!this.dirty && !force) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const out: DiskShape = { totalObs: this.totalObs, cells: {} };
      for (const [key, c] of this.cells) {
        const days: Record<string, DayTally> = {};
        for (const [dk, t] of c.days) days[dk] = t;
        out.cells[key] = {
          subway: c.subway,
          bus: c.bus,
          firstObs: c.firstObs,
          lastObs: c.lastObs,
          days,
        };
      }
      writeFileSync(this.path, JSON.stringify(out));
      this.dirty = false;
    } catch (e) {
      console.error("track records: flush failed", e);
    }
  }
}
