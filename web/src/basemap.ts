// Builds the basemap: a real geographic map of the NYC area (CARTO raster
// tiles, free / no API key) with subway route lines and station dots drawn on
// top from the server's static GeoJSON.

import maplibregl from "maplibre-gl";

// CARTO "Voyager" raster basemap — real streets/land/water/parks in a light,
// colorful palette. No API key required. (Swap "voyager" for "dark_all" for a
// dark map, or "light_all" for a pale minimal one.)
const CARTO_TILES = [
  "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  "https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
];

export function createMap(container: string): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        carto: {
          type: "raster",
          tiles: CARTO_TILES,
          tileSize: 256,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        },
      },
      layers: [
        // Fallback background while tiles load.
        { id: "bg", type: "background", paint: { "background-color": "#12151c" } },
        { id: "carto", type: "raster", source: "carto" },
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

  // Small dots: visible when zoomed out, faded once pins take over.
  map.addLayer({
    id: "stations",
    type: "circle",
    source: "stations",
    paint: {
      "circle-radius": 2.5,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#1a3c6e",
      "circle-stroke-width": 1,
      // fade dots out as pins fade in
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.8, 12.5, 0],
      "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.8, 12.5, 0],
    },
  });

  // Location pins for every MTA subway station, colored by the station's line.
  // Pre-render one pin image per distinct color and select it data-driven.
  const colors = new Set<string>();
  for (const f of (stationsGeo.features ?? []) as GeoJSON.Feature[]) {
    const c = (f.properties?.color as string) || DEFAULT_PIN_COLOR;
    colors.add(c);
  }
  colors.add(DEFAULT_PIN_COLOR);
  for (const c of colors) registerPinIcon(map, c);

  map.addLayer({
    id: "station-pins",
    type: "symbol",
    source: "stations",
    layout: {
      // e.g. color "#EE352E" -> image "pin-#EE352E"
      "icon-image": ["concat", "pin-", ["coalesce", ["get", "color"], DEFAULT_PIN_COLOR]],
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 14, 0.9],
      // station name labels appear when zoomed in
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 12.5, 12, 15, 16],
      "text-anchor": "top",
      "text-offset": [0, 0.3],
      "text-optional": true,
    },
    paint: {
      "icon-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, 0, 12.5, 1],
      "text-color": "#222222",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.8,
      "text-opacity": ["interpolate", ["linear"], ["zoom"], 13.5, 0, 14.5, 1],
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

const DEFAULT_PIN_COLOR = "#0b60d6"; // MTA-ish blue fallback

/**
 * Draw a classic teardrop location pin (filled with `color`) on a canvas and
 * register it with the map as "pin-<color>". Hi-DPI for crisp scaling.
 */
function registerPinIcon(map: maplibregl.Map, color: string) {
  const id = `pin-${color}`;
  if (map.hasImage(id)) return;

  const scale = 2; // supersample for crispness
  const w = 28 * scale;
  const h = 40 * scale;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  const cx = 14;
  const cy = 14; // center of the round head
  const r = 11;

  // teardrop body
  ctx.beginPath();
  ctx.moveTo(14, 40); // tip at the anchor point
  ctx.bezierCurveTo(4, 26, 14 - r, 22, 14 - r, cy);
  ctx.arc(cx, cy, r, Math.PI, 0, false);
  ctx.bezierCurveTo(14 + r, 22, 24, 26, 14, 40);
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();

  // white inner dot
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  const img = ctx.getImageData(0, 0, w, h);
  map.addImage(id, img, { pixelRatio: scale });
}

export function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}
