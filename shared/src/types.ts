// Wire contract shared between server and web.
// Kept intentionally tiny: the browser is a dumb renderer.

/** Movement state of a train, derived server-side. */
export type TrainStatus = "moving" | "stopped" | "stalled";

/**
 * A single train's computed position at broadcast time.
 * Field names are short to keep the WebSocket payload small.
 */
export interface TrainSnapshot {
  /** Unique trip id (GTFS-realtime trip_id). */
  id: string;
  /** Route id, e.g. "1", "A", "L". Used for coloring. */
  r: string;
  /** Longitude (WGS84). */
  lng: number;
  /** Latitude (WGS84). */
  lat: number;
  /** Bearing in degrees (0 = north, clockwise), for arrow orientation. */
  brg: number;
  /** Movement state. */
  s: TrainStatus;
}

/** Message pushed from server to clients each tick. */
export interface ServerMessage {
  /** Server timestamp (epoch ms) when this snapshot was computed. */
  t: number;
  /** All active trains. */
  trains: TrainSnapshot[];
}

/** Static route metadata sent once on connect so the client can draw legend/colors. */
export interface RouteMeta {
  id: string;
  /** Official MTA hex color, e.g. "#EE352E". */
  color: string;
  /** Long name, e.g. "Broadway - 7 Avenue Local". */
  name: string;
}
