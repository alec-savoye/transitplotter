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

// ---------------------------------------------------------------------------
// Car-traffic estimate (see traffic.ts). Two public, keyless sources:
//   - LIVE: NYC DOT Traffic Speeds. A citywide set of ~150 monitored road
//     "links" with a current speed (mph). Refreshes several times/minute, so we
//     poll it on the same cadence as the transit feeds. The direct TMC endpoint
//     is a small tab-separated snapshot; the SODA JSON mirror is the fallback.
//   - CALIBRATION: MTA Congestion Relief Zone vehicle entries (weekly, ~1wk
//     lag). Real counts of cars entering the Manhattan CBD in 10-min blocks;
//     used only to anchor the synthesized magnitude, never as a live signal.
// ---------------------------------------------------------------------------

/** Live NYC DOT traffic speeds — direct TMC snapshot (tab-separated). */
export const DOT_SPEEDS_URL = "https://linkdata.nyctmc.org/data/LinkSpeedQuery.txt";
/** SODA JSON mirror of the same data (fallback if the TMC endpoint is down). */
export const DOT_SPEEDS_SODA_URL =
  "https://data.cityofnewyork.us/resource/i4gi-tjb9.json?$select=speed,status,borough,link_points,data_as_of&$order=data_as_of%20DESC&$limit=5000";
/** MTA CRZ vehicle entries (cars class), used to calibrate the estimate. */
export const CRZ_URL =
  "https://data.ny.gov/resource/t6yz-b64h.json?$select=hour_of_day,sum(crz_entries)%20as%20entries&$where=vehicle_class%20like%20%271%20-%20Cars%25%27&$group=hour_of_day&$order=hour_of_day";

/** How often to re-derive the CRZ calibration factor (ms). CRZ is weekly, so
 *  daily is plenty; the value barely moves between refreshes. */
export const CALIBRATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// --- Greenshields / calibration constants (documented estimates). The scale
// factor α (derived from CRZ) re-anchors the citywide magnitude regardless, so
// these micro-assumptions mainly shape the spatial distribution, not the total.
/** Jam density per lane (veh/km/lane) — ~9 m/vehicle bumper-to-bumper. */
export const TRAFFIC_KJAM = 110;
/** Free-flow speed (mph) used in the Greenshields density curve. */
export const TRAFFIC_VFREE_MPH = 50;
/** Assumed lanes per monitored link (both directions combined). */
export const TRAFFIC_LANES = 2;
/** Mean time a car spends inside the CRZ per entry (h) — Little's-law dwell. */
export const CRZ_DWELL_HOURS = 0.5;
/** Fallback citywide scale factor if CRZ calibration is unavailable. Chosen so
 *  the estimate is grounded on first boot before the first CRZ fetch lands. */
export const TRAFFIC_ALPHA_FALLBACK = 1.0;
/** Speed (mph) below which a link is considered "congested". */
export const TRAFFIC_CONGESTED_MPH = 15;
