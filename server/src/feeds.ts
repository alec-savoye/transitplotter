// MTA GTFS-realtime feed endpoints (no API key required as of 2024).
// One feed per line group.

const BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds";

export const FEED_URLS: Record<string, string> = {
  numbered: `${BASE}/nyct%2Fgtfs`, // 1 2 3 4 5 6 7 S(42 St), GS/FS/H shuttles
  ace: `${BASE}/nyct%2Fgtfs-ace`,
  bdfm: `${BASE}/nyct%2Fgtfs-bdfm`,
  g: `${BASE}/nyct%2Fgtfs-g`,
  jz: `${BASE}/nyct%2Fgtfs-jz`,
  l: `${BASE}/nyct%2Fgtfs-l`,
  nqrw: `${BASE}/nyct%2Fgtfs-nqrw`,
  si: `${BASE}/nyct%2Fgtfs-si`,
};

export const FEED_KEYS = Object.keys(FEED_URLS);

/** How often to poll each feed (ms). MTA regenerates every ~30s. */
export const POLL_INTERVAL_MS = 20_000;

/**
 * GTFS-realtime Service Alerts feed (all agencies; we filter to subway).
 * Note: the path separator MUST be URL-encoded (%2F) — the un-encoded form
 * returns 403.
 */
export const ALERTS_URL = `${BASE}/camsys%2Fall-alerts`;

/** Alerts change slowly; poll less often than positions. */
export const ALERTS_POLL_INTERVAL_MS = 60_000;

/**
 * MTA Bus Time GTFS-realtime (OneBusAway). Requires a free developer API key
 * (set BUS_API_KEY). Vehicle positions include real GPS coordinates.
 */
export const BUS_API_KEY = process.env.BUS_API_KEY ?? "";
const OBA = "https://gtfsrt.prod.obanyc.com";
export const BUS_VEHICLES_URL = `${OBA}/vehiclePositions?key=${BUS_API_KEY}`;
export const BUS_TRIPUPDATES_URL = `${OBA}/tripUpdates?key=${BUS_API_KEY}`;
