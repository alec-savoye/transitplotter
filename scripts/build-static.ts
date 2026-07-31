/**
 * Downloads the MTA GTFS static ZIP and builds data/gtfs_static.sqlite.
 *
 * Run manually when MTA updates its static data (every few weeks):
 *   npm run build-static
 *
 * The resulting SQLite file is committed to the repo so normal setup
 * requires no download.
 */
import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Large cached assets live OFF the boot drive. Inside the container this is a
// bind-mounted volume; override with GTFS_CACHE_DIR if running elsewhere.
const DATA_DIR = process.env.GTFS_CACHE_DIR ?? join(__dirname, "..", ".cache");
const DB_PATH = join(DATA_DIR, "gtfs_static.sqlite");

// MTA "supplemented" static feed (includes most short-term service changes).
const GTFS_STATIC_URL =
  process.env.GTFS_STATIC_URL ??
  "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip";

type Row = Record<string, string>;

function csv(zip: AdmZip, name: string): Row[] {
  const entry = zip.getEntry(name);
  if (!entry) {
    console.warn(`  ! ${name} not found in ZIP, skipping`);
    return [];
  }
  const text = entry.getData().toString("utf8");
  return parse(text, { columns: true, skip_empty_lines: true, bom: true }) as Row[];
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  // Cache behavior: skip rebuild if the DB already exists, unless FORCE=1.
  if (existsSync(DB_PATH) && process.env.FORCE !== "1") {
    console.log(`Cached DB already present at ${DB_PATH} (set FORCE=1 to rebuild). Skipping.`);
    return;
  }

  console.log(`Downloading GTFS static from ${GTFS_STATIC_URL} ...`);
  const res = await fetch(GTFS_STATIC_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`  downloaded ${(buf.length / 1e6).toFixed(1)} MB`);

  const zip = new AdmZip(buf);

  if (existsSync(DB_PATH)) {
    console.log("Removing existing DB ...");
    const { rmSync } = await import("node:fs");
    rmSync(DB_PATH);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // --- schema ---------------------------------------------------------------
  db.exec(`
    CREATE TABLE routes (
      route_id TEXT PRIMARY KEY,
      route_short_name TEXT,
      route_long_name TEXT,
      route_color TEXT
    );
    CREATE TABLE stops (
      stop_id TEXT PRIMARY KEY,
      stop_name TEXT,
      stop_lat REAL,
      stop_lon REAL,
      parent_station TEXT
    );
    CREATE TABLE trips (
      trip_id TEXT PRIMARY KEY,
      route_id TEXT,
      shape_id TEXT,
      direction_id INTEGER
    );
    CREATE TABLE shapes (
      shape_id TEXT,
      seq INTEGER,
      lat REAL,
      lon REAL,
      dist REAL
    );
    CREATE INDEX idx_shapes_id ON shapes(shape_id, seq);
    CREATE TABLE stop_times (
      trip_id TEXT,
      stop_id TEXT,
      seq INTEGER,
      shape_dist REAL
    );
    CREATE INDEX idx_stop_times_trip ON stop_times(trip_id, seq);
  `);

  const tx = db.transaction((fn: () => void) => fn());

  // --- routes ---------------------------------------------------------------
  const routes = csv(zip, "routes.txt");
  const insRoute = db.prepare(
    `INSERT OR REPLACE INTO routes VALUES (@route_id,@route_short_name,@route_long_name,@route_color)`
  );
  tx(() => {
    for (const r of routes) {
      insRoute.run({
        route_id: r.route_id,
        route_short_name: r.route_short_name ?? "",
        route_long_name: r.route_long_name ?? "",
        route_color: r.route_color ?? "",
      });
    }
  });
  console.log(`  routes: ${routes.length}`);

  // --- stops ----------------------------------------------------------------
  const stops = csv(zip, "stops.txt");
  const insStop = db.prepare(
    `INSERT OR REPLACE INTO stops VALUES (@stop_id,@stop_name,@stop_lat,@stop_lon,@parent_station)`
  );
  tx(() => {
    for (const s of stops) {
      insStop.run({
        stop_id: s.stop_id,
        stop_name: s.stop_name ?? "",
        stop_lat: s.stop_lat ? Number(s.stop_lat) : null,
        stop_lon: s.stop_lon ? Number(s.stop_lon) : null,
        parent_station: s.parent_station ?? "",
      });
    }
  });
  console.log(`  stops: ${stops.length}`);

  // --- trips ----------------------------------------------------------------
  const trips = csv(zip, "trips.txt");
  const insTrip = db.prepare(
    `INSERT OR REPLACE INTO trips VALUES (@trip_id,@route_id,@shape_id,@direction_id)`
  );
  tx(() => {
    for (const t of trips) {
      insTrip.run({
        trip_id: t.trip_id,
        route_id: t.route_id,
        shape_id: t.shape_id ?? "",
        direction_id: t.direction_id ? Number(t.direction_id) : null,
      });
    }
  });
  console.log(`  trips: ${trips.length}`);

  // --- shapes ---------------------------------------------------------------
  const shapes = csv(zip, "shapes.txt");
  const insShape = db.prepare(
    `INSERT INTO shapes VALUES (@shape_id,@seq,@lat,@lon,@dist)`
  );
  tx(() => {
    for (const s of shapes) {
      insShape.run({
        shape_id: s.shape_id,
        seq: Number(s.shape_pt_sequence),
        lat: Number(s.shape_pt_lat),
        lon: Number(s.shape_pt_lon),
        dist: s.shape_dist_traveled ? Number(s.shape_dist_traveled) : null,
      });
    }
  });
  console.log(`  shape points: ${shapes.length}`);

  // --- stop_times -----------------------------------------------------------
  const stopTimes = csv(zip, "stop_times.txt");
  const insST = db.prepare(
    `INSERT INTO stop_times VALUES (@trip_id,@stop_id,@seq,@shape_dist)`
  );
  tx(() => {
    for (const st of stopTimes) {
      insST.run({
        trip_id: st.trip_id,
        stop_id: st.stop_id,
        seq: Number(st.stop_sequence),
        shape_dist: st.shape_dist_traveled ? Number(st.shape_dist_traveled) : null,
      });
    }
  });
  console.log(`  stop_times: ${stopTimes.length}`);

  db.close();
  console.log(`\nDone -> ${DB_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
