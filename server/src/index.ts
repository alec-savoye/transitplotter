// Entry point. Self-contained so it can be run standalone now and imported
// into another webserver project later.

import { loadStatic } from "./static/load.js";
import { Broadcaster } from "./ws.js";
import { startLoops } from "./tick.js";
import { FeedStore } from "./feedstore.js";
import { buildRoutingGraph } from "./routing/graph.js";

const PORT = Number(process.env.PORT ?? 8080);

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
  const broadcaster = new Broadcaster(stat, feedStore, graph);
  broadcaster.listen(port);
  startLoops(stat, broadcaster, feedStore, graph);
  return broadcaster;
}

// Run directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
