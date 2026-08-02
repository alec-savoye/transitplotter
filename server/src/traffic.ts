// Estimated cars on NYC roads, synthesized from live NYC DOT traffic speeds and
// anchored to real MTA congestion-zone counts. There is no public "cars in NYC
// right now" feed, so this is a modeled estimate (labeled as such in the UI).
//
// Pipeline (per poll, ~20s — same cadence as the transit feeds):
//   1. Fetch the DOT speed links (current speed on ~150 monitored road links).
//   2. For each live link, Greenshields density k = kjam·(1 − v/vfree), so the
//      cars on that link ≈ k · length_km · lanes.
//   3. Sum → cars on the MONITORED network. Multiply by a scale factor α to get
//      a citywide estimate. α is derived from the CRZ dataset (see below) so the
//      magnitude is grounded in a real count rather than being arbitrary.
//
// Calibration (daily; CRZ updates weekly): the MTA Congestion Relief Zone feed
// gives real car entries into the Manhattan CBD by hour. Via Little's law the
// cars *present* in the CBD ≈ entries_per_hour · dwell_hours. We compare that to
// our Greenshields sum over the CBD-area monitored links to solve a single α,
// then apply α citywide (assuming the monitored sample covers a similar fraction
// of roadway everywhere — a documented simplification).

import {
  DOT_SPEEDS_URL,
  DOT_SPEEDS_SODA_URL,
  CRZ_URL,
  TRAFFIC_KJAM,
  TRAFFIC_VFREE_MPH,
  TRAFFIC_LANES,
  CRZ_DWELL_HOURS,
  TRAFFIC_ALPHA_FALLBACK,
  TRAFFIC_CONGESTED_MPH,
} from "./feeds.js";
import { health } from "./health.js";

health.register("traffic", "NYC DOT Traffic Speeds", "Traffic", DOT_SPEEDS_URL);
health.register("crz", "MTA Congestion Zone (calibration)", "Traffic", CRZ_URL);

/** Latitude of 60th St — the northern edge of the Congestion Relief Zone. */
const CBD_NORTH_LAT = 40.7685;
/** mph → km/h. */
const MPH_TO_KMH = 1.609344;
/** Hard ceiling on the citywide car estimate (guards against model/α bugs). */
const CARS_MAX = 500_000;

/** Module-cached citywide scale factor, refreshed from CRZ (see below). */
let alpha = TRAFFIC_ALPHA_FALLBACK;
let alphaCalibrated = false;

interface Link {
  speedMph: number;
  /** Reporting status: 0 = live/good, negative = stale sensor (skip). */
  ok: boolean;
  borough: string;
  lengthKm: number;
  /** Mean latitude of the polyline (for CBD membership). */
  midLat: number;
}

export interface TrafficEstimate {
  /** Estimated cars on NYC roads citywide. */
  cars: number;
  /** Mean speed (mph) across live links. */
  avgSpeedMph: number;
  /** Share of live links below the congested threshold (0..1). */
  pctCongested: number;
  /** Number of live (reporting) links this poll. */
  monitoredLinks: number;
}

// NYC bounding box. The direct TMC feed sometimes TRUNCATES the link_points
// field mid-coordinate (e.g. "...40.61916,-7"), yielding a garbage point that
// would otherwise add thousands of bogus km. Reject anything outside the box.
const NYC_LAT_MIN = 40.4;
const NYC_LAT_MAX = 41.1;
const NYC_LON_MIN = -74.3;
const NYC_LON_MAX = -73.6;

function inNYC(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= NYC_LAT_MIN &&
    lat <= NYC_LAT_MAX &&
    lon >= NYC_LON_MIN &&
    lon <= NYC_LON_MAX
  );
}

/** Parse a "lat,lon lat,lon …" polyline into in-bounds points. */
function parsePolyline(linkPoints: string): [number, number][] {
  const pts: [number, number][] = [];
  for (const p of linkPoints.split(/\s+/)) {
    const [la, lo] = p.split(",");
    const lat = Number(la);
    const lon = Number(lo);
    if (inNYC(lat, lon)) pts.push([lat, lon]);
  }
  return pts;
}

/** Haversine length of the polyline, in km (in-bounds points only). */
function polylineKm(linkPoints: string): number {
  const pts = parsePolyline(linkPoints);
  let km = 0;
  for (let i = 1; i < pts.length; i++) {
    const [la1, lo1] = pts[i - 1];
    const [la2, lo2] = pts[i];
    const dLat = ((la2 - la1) * Math.PI) / 180;
    const dLon = ((lo2 - lo1) * Math.PI) / 180;
    const mLat = (((la1 + la2) / 2) * Math.PI) / 180;
    km += 6371 * Math.sqrt(dLat * dLat + Math.pow(Math.cos(mLat) * dLon, 2));
  }
  return km;
}

function midLatOf(linkPoints: string): number {
  const pts = parsePolyline(linkPoints);
  return pts.length ? pts.reduce((a, p) => a + p[0], 0) / pts.length : NaN;
}

/** Cars on a single link via the Greenshields density model. */
function carsOnLink(link: Link): number {
  const vfree = TRAFFIC_VFREE_MPH;
  const k = TRAFFIC_KJAM * Math.max(0, 1 - link.speedMph / vfree); // veh/km/lane
  return k * link.lengthKm * TRAFFIC_LANES;
}

/** Parse the direct TMC tab-separated snapshot into Links. */
function parseTsv(text: string): Link[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const links: Link[] = [];
  // Header order: id Speed TravelTime Status DataAsOf linkId linkPoints ...
  //               EncodedPolyLine EncodedPolyLineLvls Owner Transcom_id Borough
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split("\t").map((s) => s.replace(/^"|"$/g, ""));
    if (f.length < 13) continue;
    const speedMph = Number(f[1]);
    const status = Number(f[3]);
    const linkPoints = f[6];
    const borough = f[11];
    if (!Number.isFinite(speedMph) || !linkPoints) continue;
    links.push({
      speedMph,
      ok: status === 0,
      borough,
      lengthKm: polylineKm(linkPoints),
      midLat: midLatOf(linkPoints),
    });
  }
  return links;
}

/**
 * Parse the SODA JSON mirror into Links. The SODA query is ordered newest-first
 * and returns many historical rows per link, so we keep only the FIRST (most
 * recent) row per link — otherwise the same links would be counted dozens of
 * times and inflate the estimate far above the one-row-per-link TMC snapshot.
 */
function parseSoda(rows: unknown[]): Link[] {
  const seen = new Set<string>();
  const links: Link[] = [];
  for (const r of rows as Record<string, string>[]) {
    const speedMph = Number(r.speed);
    const status = Number(r.status);
    const linkPoints = r.link_points;
    if (!Number.isFinite(speedMph) || !linkPoints) continue;
    if (seen.has(linkPoints)) continue; // dedupe: newest row per link wins
    seen.add(linkPoints);
    links.push({
      speedMph,
      ok: status === 0,
      borough: r.borough ?? "",
      lengthKm: polylineKm(linkPoints),
      midLat: midLatOf(linkPoints),
    });
  }
  return links;
}

/** Fetch the live DOT speed links; prefer the fast TMC snapshot, fall back to
 *  the SODA JSON mirror. Throws if both fail (caller tolerates it). */
async function fetchLinks(): Promise<Link[]> {
  try {
    const res = await fetch(DOT_SPEEDS_URL, { signal: AbortSignal.timeout(12_000) });
    if (res.ok) {
      const links = parseTsv(await res.text());
      if (links.length) return links;
    } else {
      console.warn(`traffic: DOT TMC feed -> ${res.status}, trying SODA`);
    }
  } catch (e) {
    console.warn("traffic: DOT TMC feed failed, trying SODA", e);
  }
  const res = await fetch(DOT_SPEEDS_SODA_URL, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`DOT SODA feed -> ${res.status}`);
  return parseSoda((await res.json()) as unknown[]);
}

/** Greenshields car sum over links, optionally filtered to a predicate. */
function greenshieldsSum(links: Link[], pred?: (l: Link) => boolean): number {
  let sum = 0;
  for (const l of links) {
    if (!l.ok) continue;
    if (l.speedMph <= 0 || l.speedMph >= 80) continue; // reject sensor garbage
    if (pred && !pred(l)) continue;
    sum += carsOnLink(l);
  }
  return sum;
}

/** Live citywide car estimate for this poll. */
export async function fetchTrafficEstimate(): Promise<TrafficEstimate> {
  health.pollStart("traffic");
  let links: Link[];
  try {
    links = await fetchLinks();
  } catch (e) {
    health.fail("traffic", e);
    throw e;
  }
  const live = links.filter((l) => l.ok && l.speedMph > 0 && l.speedMph < 80);

  const monitoredCars = greenshieldsSum(links);
  // Clamp the citywide estimate to a sane ceiling so a bug in the density model
  // or a bad calibration can't push an absurd number into the HUD/chart.
  const cars = Math.min(CARS_MAX, Math.round(alpha * monitoredCars));

  const avgSpeedMph =
    live.length > 0
      ? live.reduce((a, l) => a + l.speedMph, 0) / live.length
      : 0;
  const congested = live.filter((l) => l.speedMph < TRAFFIC_CONGESTED_MPH).length;
  const pctCongested = live.length > 0 ? congested / live.length : 0;

  const est: TrafficEstimate = {
    cars,
    avgSpeedMph: Math.round(avgSpeedMph * 10) / 10,
    pctCongested: Math.round(pctCongested * 1000) / 1000,
    monitoredLinks: live.length,
  };
  health.ok("traffic", {
    count: est.cars,
    dataTs: Date.now(),
    info:
      `${est.monitoredLinks} live links · avg ${est.avgSpeedMph} mph · ` +
      `${Math.round(est.pctCongested * 100)}% congested · α=${alpha.toFixed(3)}`,
  });
  return est;
}

/**
 * Re-derive the citywide scale factor α from the CRZ dataset. Called at startup
 * and daily. Anchors our Greenshields magnitude to a real count: at the current
 * clock hour, true cars present in the CBD ≈ entries/hour · dwell; α makes our
 * CBD Greenshields sum equal that. Tolerant of failure (keeps the last α).
 */
export async function refreshCalibration(): Promise<void> {
  health.pollStart("crz");
  try {
    // 1) CRZ car entries summed per hour-of-day, and the number of days covered,
    //    so we can turn the sum into an average entries-per-hour rate.
    const [hourRows, dayRows] = await Promise.all([
      fetch(CRZ_URL, { signal: AbortSignal.timeout(20_000) }).then((r) => {
        if (!r.ok) throw new Error(`CRZ hours -> ${r.status}`);
        return r.json() as Promise<{ hour_of_day: string; entries: string }[]>;
      }),
      fetch(
        "https://data.ny.gov/resource/t6yz-b64h.json?$select=count(distinct%20toll_date)%20as%20days",
        { signal: AbortSignal.timeout(20_000) },
      ).then((r) => {
        if (!r.ok) throw new Error(`CRZ days -> ${r.status}`);
        return r.json() as Promise<{ days: string }[]>;
      }),
    ]);

    const days = Number(dayRows[0]?.days) || 0;
    if (days <= 0) throw new Error("CRZ day count unavailable");

    const entriesByHour = new Map<number, number>();
    for (const row of hourRows) {
      const h = Number(row.hour_of_day);
      const sum = Number(row.entries);
      if (Number.isFinite(h) && Number.isFinite(sum)) entriesByHour.set(h, sum / days);
    }

    // 2) Current live CBD Greenshields sum (Manhattan links below 60th St).
    const links = await fetchLinks();
    const cbdGreenshields = greenshieldsSum(
      links,
      (l) => l.borough === "Manhattan" && Number.isFinite(l.midLat) && l.midLat < CBD_NORTH_LAT,
    );
    if (cbdGreenshields <= 0) throw new Error("no live CBD links for calibration");

    // 3) True cars present in the CBD right now (Little's law).
    const hour = new Date().getHours();
    const entriesPerHour = entriesByHour.get(hour);
    if (entriesPerHour == null || entriesPerHour <= 0)
      throw new Error(`no CRZ rate for hour ${hour}`);
    const cbdPresent = entriesPerHour * CRZ_DWELL_HOURS;

    const next = cbdPresent / cbdGreenshields;
    if (Number.isFinite(next) && next > 0) {
      alpha = next;
      alphaCalibrated = true;
      console.log(
        `traffic: calibrated α=${alpha.toFixed(3)} ` +
          `(CBD present≈${Math.round(cbdPresent)} vs Greenshields≈${Math.round(cbdGreenshields)}, hour ${hour})`,
      );
      health.ok("crz", {
        count: Math.round(cbdPresent),
        dataTs: Date.now(),
        info: `α=${alpha.toFixed(3)} from ${days} days of CRZ data (hour ${hour})`,
      });
    } else {
      health.fail("crz", "computed α was not a positive finite number");
    }
  } catch (e) {
    console.warn(
      `traffic: calibration failed, keeping α=${alpha.toFixed(3)}${alphaCalibrated ? "" : " (fallback)"}`,
      e,
    );
    health.fail("crz", e);
  }
}
