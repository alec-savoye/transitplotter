// "Track Records": a persistent, lightweight history of on-time-vs-late
// performance, bucketed into a coarse spatial mesh (~a few blocks per cell).
//
// Design notes / invariants:
//   - This is the ONE piece of realtime-derived data we persist, by explicit
//     product requirement ("log constantly over time"). It is kept as a tiny
//     JSON tally (integer counts per populated cell), NOT in the static SQLite
//     (which stays "static data only"). The file lives in the off-boot cache
//     dir so it survives restarts and accumulates over time.
//   - We count ONE observation per *completed segment traversal* per trip, not
//     one per poll. A trip advancing from heading-to-stop-A to heading-to-stop-B
//     means the segment ending at A just completed; we log its lateness once.
//     This avoids inflating counts by re-sampling the same slow train every 20s.
//   - Ferries carry no delay signal (their `dly` is always 0), so tallying them
//     would paint every ferry cell misleadingly green. They are excluded; the
//     UI notes ferry reliability is not yet tracked.

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
 * reflects a full week's worth of conditions before we grade its reliability.
 */
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Drop a trip's tracking state if we haven't seen it for this long (ms). */
const TRIP_STALE_MS = 10 * 60 * 1000;

/** Only subway + bus are tracked (ferries have no delay signal). */
type TrackedMode = "subway" | "bus";

interface Tally {
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
   * historical %-lateness-vs-date plot when a ready cell is clicked.
   */
  days: Map<string, Tally>;
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
      days?: Record<string, Tally>;
    }
  >;
}

const emptyTally = (): Tally => ({ late: 0, total: 0 });

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
    t.total++;
    if (late) t.late++;
    if (!cell.firstObs) cell.firstObs = now;
    cell.lastObs = now;

    // Per-day tally (all modes combined) for the historical plot.
    const dk = dayKey(now);
    let day = cell.days.get(dk);
    if (!day) cell.days.set(dk, (day = emptyTally()));
    day.total++;
    if (late) day.late++;

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
      const total = c.subway.total + c.bus.total;
      if (total === 0) continue;
      const late = c.subway.late + c.bus.late;
      const [li, lo] = key.split(":").map(Number);
      // A cell is ready only once its observations span at least one week.
      const span = c.firstObs ? now - c.firstObs : 0;
      const ready = c.firstObs > 0 && span >= WINDOW_MS;
      if (ready) readyCells++;
      cells.push({
        key,
        // Cell center coordinate.
        lat: (li + 0.5) * LAT_STEP,
        lon: (lo + 0.5) * LON_STEP,
        rate: total > 0 ? late / total : 0,
        total,
        ready,
        firstObs: c.firstObs,
        lastObs: c.lastObs,
        subway: { ...c.subway },
        bus: { ...c.bus },
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
        const days = new Map<string, Tally>();
        for (const [dk, t] of Object.entries(c.days ?? {})) {
          days.set(dk, { late: t.late ?? 0, total: t.total ?? 0 });
        }
        this.cells.set(key, {
          subway: { late: c.subway?.late ?? 0, total: c.subway?.total ?? 0 },
          bus: { late: c.bus?.late ?? 0, total: c.bus?.total ?? 0 },
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
        const days: Record<string, Tally> = {};
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
