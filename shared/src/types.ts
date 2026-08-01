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
  mode?: "subway" | "ferry";
  /** Vessel/vehicle label, e.g. ferry "H200". */
  label?: string;
}

/** Message pushed from server to clients whenever the feed refreshes. */
export interface ServerMessage {
  /** Server timestamp (epoch ms) when these legs were built. */
  t: number;
  /** All active train legs. */
  legs: TrainLeg[];
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
