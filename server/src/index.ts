// Entry point. Self-contained so it can be run standalone now and imported
// into another webserver project later.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadStatic } from "./static/load.js";
import { Broadcaster } from "./ws.js";
import { startLoops } from "./tick.js";
import { FeedStore } from "./feedstore.js";
import { buildRoutingGraph } from "./routing/graph.js";
import { TrackRecordStore } from "./trackrecord.js";
import { InterpErrorStore } from "./interp.js";
import { VisitStore } from "./visits.js";
import { CountStore } from "./counts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
// Same off-boot cache dir the static SQLite uses; the track-record tally lives
// alongside it so it persists across restarts.
const CACHE_DIR =
  process.env.GTFS_CACHE_DIR ?? join(__dirname, "..", "..", "..", ".cache");

export function startServer(port = PORT) {
  console.log("loading GTFS static ...");
  const stat = loadStatic();
  console.log(
    `loaded: ${stat.routes.size} routes, ${stat.stops.size} stops, ` +
      `${stat.trips.size} trips, ${stat.shapes.size} shapes`
  );

  console.log("building routing graph ...");
  const graph = buildRoutingGraph(stat);
  console.log(
    `graph: ${graph.stations.size} stations, ` +
      `${[...graph.ride.values()].reduce((n, e) => n + e.length, 0)} ride edges`
  );

  const feedStore = new FeedStore();
  const trackRecords = new TrackRecordStore(CACHE_DIR);
  const interpErrors = new InterpErrorStore(CACHE_DIR);
  const visits = new VisitStore(CACHE_DIR);
  const counts = new CountStore(CACHE_DIR);
  const broadcaster = new Broadcaster(stat, feedStore, graph, trackRecords, visits, interpErrors, counts);
  broadcaster.listen(port);
  startLoops(stat, broadcaster, feedStore, graph, trackRecords, interpErrors, counts);

  // Persist the latest tally on shutdown so a restart doesn't lose recent data.
  const shutdown = () => {
    trackRecords.flush(true);
    interpErrors.flush(true);
    visits.flush(true);
    counts.flush(true);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return broadcaster;
}

// Run directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
