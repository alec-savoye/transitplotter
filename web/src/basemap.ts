// Builds the stylized subway-map basemap: a dark empty background with subway
// route lines and station dots drawn from the server's static GeoJSON.
//
// Route line + station geometry is fetched from the server as GeoJSON
// (endpoints added later); for now we set up the layers and sources so trains
// have something to sit on.

import maplibregl from "maplibre-gl";

// Minimal empty style — no external basemap tiles, just a background color.
// This gives the clean "diagram" look you asked for.
export function createMap(container: string): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {},
      layers: [
        {
          id: "bg",
          type: "background",
          paint: { "background-color": "#12151c" },
        },
      ],
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    },
    center: [-73.98, 40.75], // Midtown Manhattan
    zoom: 11,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  return map;
}

/** Add sources/layers for routes, stations, and trains, loading static geo. */
export async function addLayers(map: maplibregl.Map, serverHttp: string) {
  const [routesGeo, stationsGeo] = await Promise.all([
    fetch(`${serverHttp}/geo/routes`).then((r) => r.json()).catch(() => emptyFC()),
    fetch(`${serverHttp}/geo/stations`).then((r) => r.json()).catch(() => emptyFC()),
  ]);

  map.addSource("routes", { type: "geojson", data: routesGeo });
  map.addLayer({
    id: "routes",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": 3,
      "line-opacity": 0.9,
    },
  });

  map.addSource("stations", { type: "geojson", data: stationsGeo });
  map.addLayer({
    id: "stations",
    type: "circle",
    source: "stations",
    paint: {
      "circle-radius": 2.5,
      "circle-color": "#ffffff",
      "circle-opacity": 0.6,
      "circle-stroke-color": "#000",
      "circle-stroke-width": 0.5,
    },
  });

  map.addSource("trains", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "trains",
    type: "circle",
    source: "trains",
    paint: {
      "circle-radius": 5,
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1.5,
    },
  });
}

// (kept for reference; layers above now load real data)

export function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}
