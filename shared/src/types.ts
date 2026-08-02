// Wire contract shared between server and web.
// Kept intentionally tiny: the browser is a dumb renderer.

/** Movement state of a train, derived client-side from a TrainLeg. */
export type TrainStatus = "moving" | "stopped" | "stalled";

/**
 * A train's *current leg*: the segment it is traversing (prev stop -> next
 * stop), sent when feeds refresh (~20s). The browser interpolates the live
 * position along `path` continuously using the schedule times, so the server
 * no longer needs to stream positions every second.
 *
 * Field names are short to keep the WebSocket payload small.
 */
export interface TrainLeg {
  /** Unique trip id (GTFS-realtime trip_id). */
  id: string;
  /** Route id, e.g. "1", "A", "L". Used for coloring. */
  r: string;
  /**
   * The segment polyline in travel order, as [lng, lat] pairs. For shaped legs
   * this follows the real curved track between the two stops; for fallbacks it
   * is just the two stop coordinates. Position is interpolated linearly by
   * arc-length as a function of time fraction.
   */
  path: [number, number][];
  /** Departure from the previous stop (epoch seconds). */
  d0: number;
  /** Predicted arrival at the next stop (epoch seconds). */
  d1: number;
  /** Feed header timestamp (epoch seconds) for stall detection. */
  hts: number;
  /** Next stop name, if known. */
  ns?: string;
  /** Final destination stop name for the trip, if known. */
  dest?: string;
  /**
   * Estimated delay in seconds: how much longer this leg is predicted to take
   * than the typical (median) time for the segment. 0 when on time or unknown.
   * Drives the "hotspots" heatmap on the client.
   */
  dly?: number;
  /** Transit mode. Absent = subway. */
  mode?: "subway" | "ferry" | "bus";
  /** Vessel/vehicle label, e.g. ferry "H200" or bus route "M15". */
  label?: string;
  /** Borough code for buses (manhattan|brooklyn|bronx|queens|statenisland). */
  boro?: string;
  /** Momentary speed in meters/second, when the feed reports it (ferries/buses). */
  spd?: number;
  /** Vehicle/vessel id from the feed (e.g. ferry hull id), when available. */
  vid?: string;
}

/** Message pushed from server to clients whenever the feed refreshes. */
export interface ServerMessage {
  /** Server timestamp (epoch ms) when these legs were built. */
  t: number;
  /** All active train legs. */
  legs: TrainLeg[];
  /**
   * Estimated number of cars currently on NYC roads (synthesized from live NYC
   * DOT traffic speeds, calibrated to MTA congestion-zone counts). Absent if
   * the traffic feed was unavailable this poll. Powers the HUD 🚗 line.
   */
  cars?: number;
}

/** Static route metadata sent once on connect so the client can draw legend/colors. */
export interface RouteMeta {
  id: string;
  /** Official MTA hex color, e.g. "#EE352E". */
  color: string;
  /** Long name, e.g. "Broadway - 7 Avenue Local". */
  name: string;
}

/** A single upcoming train arrival at a station (one direction). */
export interface Arrival {
  /** Route id, e.g. "6", "6X". */
  route: string;
  /** Official MTA hex color for the route. */
  color: string;
  /** Whether this is express service (route id ends in X). */
  express: boolean;
  /** Predicted arrival time (epoch seconds). */
  eta: number;
  /** Seconds until arrival (server-computed at request time). */
  inSec: number;
  /** Trip's final destination stop name, if known. */
  dest: string;
}

/** A service alert affecting one or more routes/stations. */
export interface ServiceAlert {
  /** Stable id for de-duping on the client. */
  id: string;
  /** Route ids this alert affects, e.g. ["B","D"]. */
  routes: string[];
  /** Base station ids this alert affects (directional suffix stripped). */
  stops: string[];
  /** Short headline text. */
  header: string;
  /** Longer description, if provided. */
  description: string;
  /**
   * Coarse severity derived from the alert effect:
   *   3 = severe (suspended / no service)
   *   2 = delays / reduced service
   *   1 = info / planned / minor
   */
  severity: 1 | 2 | 3;
  /** Short human label, e.g. "Delays", "Suspended", "Planned Work". */
  effect: string;
}

/** Per-route rolled-up status for the line-status strip. */
export interface RouteStatus {
  route: string;
  color: string;
  /** Worst severity among active alerts for this route (0 = good service). */
  severity: 0 | 1 | 2 | 3;
  /** Short label: "Good Service" | "Planned Work" | "Delays" | "Suspended" ... */
  label: string;
}

/** One leg of a planned journey (a ride on a single route, or a walk). */
export interface ItineraryLeg {
  /** "ride" | "walk". */
  kind: "ride" | "walk";
  /** Route id for ride legs. */
  route?: string;
  /** Route color for ride legs. */
  color?: string;
  /** Boarding station id + name (ride) or origin (walk). */
  fromId: string;
  fromName: string;
  /** Alighting station id + name (ride) or destination (walk). */
  toId: string;
  toName: string;
  /** Ordered station ids traversed (ride legs), for map highlighting. */
  stops: string[];
  /** Number of intermediate stops passed (ride legs). */
  numStops: number;
  /** Estimated duration in seconds. */
  seconds: number;
}

/** A full planned journey from origin to destination. */
export interface Itinerary {
  /** Total estimated duration in seconds (incl. transfer penalties). */
  seconds: number;
  /** Number of transfers (boardings - 1). */
  transfers: number;
  legs: ItineraryLeg[];
  /** Origin/destination as resolved (echoed back for the UI). */
  origin: { name: string; lat: number; lon: number };
  destination: { name: string; lat: number; lon: number };
}

/** Per-mode late/total tally for a single mesh cell. */
export interface TrackRecordModeTally {
  /** Observations that were late (>= the server's late threshold). */
  late: number;
  /** Total completed-segment observations recorded in this cell for this mode. */
  total: number;
}

/** One spatial mesh cell of the track-record overlay. */
export interface TrackRecordCell {
  /** Cell key "<latIndex>:<lonIndex>". */
  key: string;
  /** Cell center latitude (degrees). */
  lat: number;
  /** Cell center longitude (degrees). */
  lon: number;
  /** Combined late rate across tracked modes (late / total), 0..1. */
  rate: number;
  /** Total observations across all modes in this cell. */
  total: number;
  /**
   * Whether this cell has enough history to be colored: it has been observed
   * across a span of at least one calendar week. Cells that are not ready are
   * rendered light gray ("not enough data yet").
   */
  ready: boolean;
  /** Epoch ms of the first observation recorded in this cell (0 if none). */
  firstObs: number;
  /** Epoch ms of the most recent observation recorded in this cell (0 if none). */
  lastObs: number;
  /** Per-mode breakdown. Ferries are not tracked (no delay signal). */
  subway: TrackRecordModeTally;
  bus: TrackRecordModeTally;
}

/** One calendar day of late/total history for a cell. */
export interface TrackRecordDay {
  /** Calendar date "YYYY-MM-DD" (server local time). */
  date: string;
  /** Segment observations that ran late that day. */
  late: number;
  /** Total segment observations that day. */
  total: number;
}

/** Historical performance for one cell: GET /trackrecords/history?key=... */
export interface TrackRecordHistory {
  /** Cell key "<latIndex>:<lonIndex>". */
  key: string;
  /** Cell center latitude (degrees). */
  lat: number;
  /** Cell center longitude (degrees). */
  lon: number;
  /** Per-day series, oldest first, suitable for a %-lateness-vs-date plot. */
  days: TrackRecordDay[];
}

/** Whole track-record snapshot returned by GET /trackrecords. */
export interface TrackRecordSnapshot {
  /** Total observations logged globally (across all cells/modes). */
  totalObs: number;
  /** Observation-window length (days) a cell must span before it's colored. */
  windowDays: number;
  /** Number of cells that currently meet the window requirement. */
  readyCells: number;
  /** Whether any cell is ready to display (readyCells > 0). */
  ready: boolean;
  /** Cell size in degrees [latStep, lonStep], for drawing cell rectangles. */
  cellStep: [number, number];
  /** Populated cells (empty cells are omitted). */
  cells: TrackRecordCell[];
}

/** Live arrivals board for one station, split by direction. */
export interface StationArrivals {
  /** Base station id, e.g. "635". */
  id: string;
  /** Station name. */
  name: string;
  /** Northbound / Uptown arrivals, soonest first. */
  north: Arrival[];
  /** Southbound / Downtown arrivals, soonest first. */
  south: Arrival[];
  /** Active service alerts touching this station or its routes. */
  alerts?: ServiceAlert[];
}

// ---------------------------------------------------------------------------
// Interpolation-error metrics (GET /interp/stats)
//
// The subway feed has no coordinates, so we model position by moving vehicles
// along track over predicted times. To know how good that model is, on each
// feed refresh we compare where the *previous* leg predicted a vehicle would be
// at the refresh instant against the new ground truth:
//   - subway: the new leg's freshly computed position (the "snap" magnitude the
//     user perceives as a jump) — a proxy for true error.
//   - bus/ferry: the new leg's real GPS anchor — a true interpolation error.
// Lower is better; watch it trend down as the model improves.
// ---------------------------------------------------------------------------

/** Aggregate error statistics for one bucket (overall, a mode, or a route). */
export interface InterpErrorBucket {
  /** Number of samples contributing to this bucket. */
  n: number;
  /** Mean along-track error in meters. */
  mean: number;
  /** Median (p50) error in meters. */
  p50: number;
  /** 95th-percentile error in meters. */
  p95: number;
}

/** One calendar day of aggregate interpolation error. */
export interface InterpErrorDay {
  /** Calendar date "YYYY-MM-DD" (server local time). */
  date: string;
  /** Sample count that day. */
  n: number;
  /** Mean error (m) that day. */
  mean: number;
  /** p95 error (m) that day. */
  p95: number;
}

/** Interpolation-error report returned by GET /interp/stats. */
export interface InterpErrorStats {
  /** Total samples logged since the store began. */
  totalSamples: number;
  /** Overall error across all samples. */
  overall: InterpErrorBucket;
  /** Error broken down by mode ("subway" | "bus" | "ferry"). */
  byMode: Record<string, InterpErrorBucket>;
  /** Error broken down by route id (top routes by sample count). */
  byRoute: Record<string, InterpErrorBucket>;
  /** Recent per-day trend, oldest first. */
  days: InterpErrorDay[];
  /**
   * Whether the error is a true GPS-referenced measurement (bus/ferry) or the
   * snap-magnitude proxy (subway). Reported per bucket via `byMode` labels.
   */
  note: string;
}

// ---------------------------------------------------------------------------
// Vehicle-count time series (GET /counts)
//
// One sample is recorded per feed poll (~20s), holding the number of active
// legs per mode at that instant, plus how many of those were delayed (predicted
// delay ≥ 120s). The store prunes to a rolling 48-hour window. Powers the two
// "over the last 48h" charts (double-click the HUD): active vehicles, and
// delayed vehicles, each split by mode.
// ---------------------------------------------------------------------------

/** One sampled count of active (and delayed) vehicles by mode. */
export interface VehicleCountPoint {
  /** Sample time (epoch ms) — the poll instant. */
  t: number;
  /** Active subway trains. */
  subway: number;
  /** Active buses (enabled boroughs). */
  bus: number;
  /** Active ferries. */
  ferry: number;
  /** Delayed subway trains (predicted delay ≥ 120s). */
  subwayDelayed: number;
  /** Delayed buses (predicted delay ≥ 120s). */
  busDelayed: number;
  /** Delayed ferries (predicted delay ≥ 120s; ferries carry no delay signal, so 0). */
  ferryDelayed: number;
  /**
   * Estimated cars on NYC roads at this instant (synthesized from live traffic
   * speeds, CRZ-calibrated). 0 for points recorded before the traffic feed was
   * available. Shown as an "estimated" series in the active-vehicles chart.
   */
  cars: number;
}

/** Rolling vehicle-count series returned by GET /counts (oldest → newest). */
export interface VehicleCountSeries {
  /** Retention window in ms (the intended X-axis span, e.g. 48h). */
  windowMs: number;
  /** Server clock (epoch ms) when this snapshot was built. */
  now: number;
  /** Samples within the window, oldest first. */
  points: VehicleCountPoint[];
}
