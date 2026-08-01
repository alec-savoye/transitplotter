// Builds the basemap: a satellite/aerial view of the NYC area (Esri World
// Imagery raster tiles, free / no API key) with subway route lines and station
// dots drawn on top from the server's static GeoJSON.

import maplibregl from "maplibre-gl";
import type { RouteMeta } from "@transitplotter/shared";
import { registerAllBullets, BULLET_PREFIX, FERRY_PREFIX, BUS_PREFIX } from "./bullets.js";

// Esri "World Imagery" satellite basemap. No API key required.
const SATELLITE_TILES = [
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
];

/** Coarse-pointer / small-screen devices we treat as "mobile" for perf tuning. */
const IS_MOBILE =
  typeof navigator !== "undefined" &&
  (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches));

export function createMap(container: string): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    // Cap the device pixel ratio on mobile: retina phones render 3x the pixels,
    // which combined with the per-frame vehicle updates can overload/crash the
    // tab. 1.5x is plenty sharp for a live map.
    pixelRatio: IS_MOBILE ? Math.min(window.devicePixelRatio || 1, 1.5) : undefined,
    // Flat (non-tilted) on mobile is cheaper to render and easier to pan.
    style: {
      version: 8,
      sources: {
        satellite: {
          type: "raster",
          tiles: SATELLITE_TILES,
          tileSize: 256,
          attribution:
            "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        },
      },
      layers: [
        // Fallback background while tiles load.
        { id: "bg", type: "background", paint: { "background-color": "#0a0f14" } },
        { id: "satellite", type: "raster", source: "satellite" },
      ],
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    },
    center: [-73.98, 40.75], // Midtown Manhattan
    zoom: 11,
    pitch: IS_MOBILE ? 0 : 45, // tilted 3D-style view (flat on mobile for perf)
    bearing: IS_MOBILE ? 0 : -17,
    maxPitch: 75,
  });

  // Compass enabled so users can reset/rotate the tilted view.
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
  return map;
}

/** Add sources/layers for routes, stations, and trains, loading static geo. */
export async function addLayers(
  map: maplibregl.Map,
  serverHttp: string,
  routes: RouteMeta[]
) {
  const [routesGeo, stationsGeo] = await Promise.all([
    fetch(`${serverHttp}/geo/routes`).then((r) => r.json()).catch(() => emptyFC()),
    fetch(`${serverHttp}/geo/stations`).then((r) => r.json()).catch(() => emptyFC()),
  ]);

  // promoteId lets us drive per-route feature-state by route id. Multiple
  // segments share the same route id, so setting state once dims them all.
  map.addSource("routes", { type: "geojson", data: routesGeo, promoteId: "route" });
  map.addLayer({
    id: "routes",
    type: "line",
    source: "routes",
    filter: ["!=", ["get", "mode"], "ferry"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": 3,
      // Disrupted routes (feature-state.disrupted) are dimmed.
      "line-opacity": ["case", ["boolean", ["feature-state", "disrupted"], false], 0.35, 0.9],
    },
  });

  // Ferry routes: dashed, semi-transparent lines to distinguish water routes.
  map.addLayer({
    id: "routes-ferry",
    type: "line",
    source: "routes",
    filter: ["==", ["get", "mode"], "ferry"],
    layout: { "line-cap": "round", "line-join": "round", visibility: "visible" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": 2,
      "line-dasharray": [2, 2],
      "line-opacity": 0.7,
    },
  });

  // Dashed overlay drawn only for disrupted routes, to signal service issues.
  map.addLayer({
    id: "routes-disrupted",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": 3,
      "line-dasharray": [1.5, 1.5],
      "line-opacity": ["case", ["boolean", ["feature-state", "disrupted"], false], 0.95, 0],
    },
  });

  map.addSource("stations", { type: "geojson", data: stationsGeo });

  // Non-bus (subway/ferry) filter — bus stops are far too numerous to show
  // except when zoomed way in (see bus-stops layer below).
  const notBus: maplibregl.FilterSpecification = [
    "!=",
    ["get", "mode"],
    "bus",
  ] as unknown as maplibregl.FilterSpecification;

  // Small dots: visible when zoomed out, faded once pins take over.
  map.addLayer({
    id: "stations",
    type: "circle",
    source: "stations",
    filter: notBus,
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

  // Bus stops: small dots, zoom-gated to avoid clutter. Appear from ~z14 and
  // grow/brighten as you zoom in.
  map.addLayer({
    id: "bus-stops",
    type: "circle",
    source: "stations",
    minzoom: 13.5,
    filter: ["==", ["get", "mode"], "bus"] as unknown as maplibregl.FilterSpecification,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 13.5, 2.5, 16, 5],
      "circle-color": "#1b7fc4",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.2,
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 13.5, 0, 14, 0.9],
      "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 13.5, 0, 14, 0.9],
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
    filter: notBus, // pins only for subway/ferry stations
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

  // "Hotspots": a transparent red heat cloud around trains/stations with heavy
  // delays. Fed each frame by TrainLayer (see trains.ts). Hidden by default;
  // toggled via setHotspotsVisible().
  map.addSource("hotspots", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "hotspots",
    type: "heatmap",
    source: "hotspots",
    layout: { visibility: "none" },
    paint: {
      // Per-point intensity from the delay weight (0..1).
      "heatmap-weight": ["coalesce", ["get", "weight"], 0.5],
      // Grow the cloud + intensity as you zoom in.
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 9, 0.6, 15, 2.5],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 24, 15, 70],
      "heatmap-opacity": 0.55,
      // Transparent -> deep red ramp (all red hues, per the "red cloud" spec).
      "heatmap-color": [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0, "rgba(255,0,0,0)",
        0.2, "rgba(255,80,40,0.25)",
        0.5, "rgba(255,40,20,0.5)",
        0.8, "rgba(220,0,0,0.7)",
        1, "rgba(160,0,0,0.85)",
      ],
    },
  });

  // "Track Records": a green→red reliability mesh built from persisted on-time
  // history. Fed by trackrecords.ts; hidden by default, unlocked after enough
  // data is collected and toggled via setTrackRecordsVisible(). Added before
  // trains/bullets so vehicle markers stay clickable on top.
  map.addSource("trackrecords", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "trackrecords-fill",
    type: "fill",
    source: "trackrecords",
    layout: { visibility: "none" },
    paint: {
      // Cells without a full week of data are light gray; ready cells are
      // colored green (reliable) -> yellow -> red (often late) by late rate.
      "fill-color": [
        "case",
        ["!", ["coalesce", ["get", "ready"], false]],
        "#b8bcc2", // light gray: not enough data gathered yet
        [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "rate"], 0],
          0, "#2ecc40",
          0.25, "#a8d600",
          0.5, "#ffc300",
          0.75, "#ff7b00",
          1, "#ff4136",
        ],
      ],
      "fill-opacity": [
        "case",
        ["!", ["coalesce", ["get", "ready"], false]],
        0.2,
        0.35,
      ],
    },
  });
  map.addLayer({
    id: "trackrecords-outline",
    type: "line",
    source: "trackrecords",
    layout: { visibility: "none" },
    paint: { "line-color": "#ffffff", "line-width": 0.3, "line-opacity": 0.25 },
  });

  // Trains rendered as MTA route bullets (colored disc/diamond w/ label).
  registerAllBullets(map, routes);
  map.addSource("trains", { type: "geojson", data: emptyFC() });

  // Slowly flashing red ring around stalled trains. The radius/opacity are
  // animated each frame (see TrainLayer) to create a gentle pulse.
  map.addLayer({
    id: "trains-halo",
    type: "circle",
    source: "trains",
    filter: ["==", ["get", "status"], "stalled"],
    paint: {
      "circle-radius": 12,
      "circle-color": "rgba(0,0,0,0)", // ring only, no fill
      "circle-stroke-color": "#ff3b30",
      "circle-stroke-width": 2.5,
      "circle-stroke-opacity": 0.8,
    },
  });

  // Buses: zoom-gated + borough-filtered layer. Drawn BELOW trains/ferries so
  // rail markers stay on top. Starts filtered to Manhattan + Brooklyn.
  map.addLayer({
    id: "buses",
    type: "symbol",
    source: "trains",
    minzoom: DEFAULT_BUS_MINZOOM,
    filter: busFilter(["manhattan", "brooklyn"]),
    layout: {
      "icon-image": [
        "coalesce",
        ["image", ["concat", BUS_PREFIX, ["get", "route"]]],
        ["image", `${BUS_PREFIX}?`],
      ],
      // Always render every bus. With collision on, overlapping buses would
      // flicker in/out as positions update each frame.
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.7, 16, 1.0],
    },
  });

  map.addLayer({
    id: "trains",
    type: "symbol",
    source: "trains",
    filter: ["==", ["coalesce", ["get", "mode"], "subway"], "subway"],
    layout: {
      // route id -> "bullet-<route>", falling back to "bullet-?"
      "icon-image": [
        "coalesce",
        ["image", ["concat", BULLET_PREFIX, ["get", "route"]]],
        ["image", `${BULLET_PREFIX}?`],
      ],
      "icon-allow-overlap": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 14, 0.9],
    },
  });

  // Ferries as boat badges (separate layer so we can toggle them independently).
  map.addLayer({
    id: "ferries",
    type: "symbol",
    source: "trains",
    filter: ["==", ["get", "mode"], "ferry"],
    layout: {
      "icon-image": [
        "coalesce",
        ["image", ["concat", FERRY_PREFIX, ["get", "route"]]],
        ["image", `${FERRY_PREFIX}?`],
      ],
      "icon-allow-overlap": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 14, 1.0],
    },
  });
}

/** Default zoom at/above which buses become visible. */
export const DEFAULT_BUS_MINZOOM = 13.5;

/** Build the buses layer filter for a set of enabled borough codes. */
function busFilter(boros: string[]): maplibregl.FilterSpecification {
  return [
    "all",
    ["==", ["get", "mode"], "bus"],
    ["in", ["get", "boro"], ["literal", boros]],
  ] as unknown as maplibregl.FilterSpecification;
}

/** Show or hide the ferry markers layer. */
export function setFerriesVisible(map: maplibregl.Map, visible: boolean) {
  if (map.getLayer("ferries")) {
    map.setLayoutProperty("ferries", "visibility", visible ? "visible" : "none");
  }
}

/** Update which boroughs' buses are shown. Empty array hides all buses. */
export function setBusBoroughs(map: maplibregl.Map, boros: string[]) {
  if (map.getLayer("buses")) map.setFilter("buses", busFilter(boros));
}

/** Set the minimum zoom at which buses appear. */
export function setBusMinZoom(map: maplibregl.Map, minzoom: number) {
  if (map.getLayer("buses")) map.setLayerZoomRange("buses", minzoom, 24);
}

/** Show or hide the delay "hotspots" heatmap layer. */
export function setHotspotsVisible(map: maplibregl.Map, visible: boolean) {
  if (map.getLayer("hotspots")) {
    map.setLayoutProperty("hotspots", "visibility", visible ? "visible" : "none");
  }
}

/** Show or hide the "track records" reliability mesh (fill + outline). */
export function setTrackRecordsVisible(map: maplibregl.Map, visible: boolean) {
  const v = visible ? "visible" : "none";
  if (map.getLayer("trackrecords-fill")) map.setLayoutProperty("trackrecords-fill", "visibility", v);
  if (map.getLayer("trackrecords-outline")) map.setLayoutProperty("trackrecords-outline", "visibility", v);
}

/**
 * Mark the given route ids as disrupted (dimmed + dashed on the map). Any route
 * not in the set is cleared. Uses feature-state keyed by the promoted route id.
 */
export function setDisruptedRoutes(
  map: maplibregl.Map,
  allRouteIds: string[],
  disrupted: Set<string>
) {
  for (const id of allRouteIds) {
    map.setFeatureState(
      { source: "routes", id },
      { disrupted: disrupted.has(id) }
    );
  }
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
