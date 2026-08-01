// Renders MTA-style "route bullets" (a colored disc/diamond with the route
// letter or number) to canvas and registers them as map images. One image per
// route id, reused for both train markers and (optionally) legends.

import type maplibregl from "maplibre-gl";
import type { RouteMeta } from "@transitplotter/shared";

/** Express services are drawn as diamonds per MTA convention. */
function isExpress(routeId: string): boolean {
  return routeId.endsWith("X");
}

/** The label shown inside the bullet, e.g. "6X" -> "6". */
export function bulletLabel(routeId: string): string {
  return isExpress(routeId) ? routeId.slice(0, -1) : routeId;
}

/** MTA lines that use black/near-white text on a light bullet (N/Q/R/W = yellow). */
function textColorFor(color: string): string {
  // Yellow (NQRW) bullets use black text; everything else uses white.
  const c = color.toUpperCase();
  if (c === "#FCCC0A" || c === "#F6BC26" || c === "#FBBD08") return "#000000";
  return "#ffffff";
}

export const BULLET_PREFIX = "bullet-";

/** Register a bullet image for a single route. */
export function registerBullet(map: maplibregl.Map, route: RouteMeta) {
  const id = `${BULLET_PREFIX}${route.id}`;
  if (map.hasImage(id)) return;

  const scale = 3; // supersample for crispness on hi-DPI + when scaled up
  const size = 26;
  const px = size * scale;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 2;
  const color = route.color || "#666666";

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.fillStyle = color;

  if (isExpress(route.id)) {
    // diamond
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
  } else {
    // circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();

  // label
  const label = bulletLabel(route.id);
  ctx.fillStyle = textColorFor(color);
  ctx.font = `bold ${label.length > 1 ? 12 : 15}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, cy + 0.5);

  const img = ctx.getImageData(0, 0, px, px);
  map.addImage(id, img, { pixelRatio: scale });
}

export const FERRY_PREFIX = "ferry-";

/**
 * Register a ferry marker: a rounded-square badge in the route color with a
 * small boat glyph, so ferries read differently from the circular train
 * bullets. One image per ferry route id.
 */
export function registerFerry(map: maplibregl.Map, route: RouteMeta) {
  const id = `${FERRY_PREFIX}${route.id}`;
  if (map.hasImage(id)) return;

  const scale = 3;
  const size = 26;
  const px = size * scale;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  const color = route.color || "#0a3d62";
  const r = 6;
  const m = 2;
  const w = size - m * 2;

  // rounded-square badge
  ctx.beginPath();
  ctx.moveTo(m + r, m);
  ctx.arcTo(m + w, m, m + w, m + w, r);
  ctx.arcTo(m + w, m + w, m, m + w, r);
  ctx.arcTo(m, m + w, m, m, r);
  ctx.arcTo(m, m, m + w, m, r);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();

  // simple white boat glyph
  const cx = size / 2;
  const cy = size / 2 + 1;
  ctx.fillStyle = textColorFor(color);
  ctx.strokeStyle = textColorFor(color);
  ctx.lineWidth = 1.4;
  ctx.beginPath(); // hull
  ctx.moveTo(cx - 6, cy);
  ctx.lineTo(cx + 6, cy);
  ctx.lineTo(cx + 4, cy + 4);
  ctx.lineTo(cx - 4, cy + 4);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath(); // mast
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - 6);
  ctx.stroke();
  ctx.beginPath(); // sail
  ctx.moveTo(cx + 0.5, cy - 6);
  ctx.lineTo(cx + 5, cy - 1);
  ctx.lineTo(cx + 0.5, cy - 1);
  ctx.closePath();
  ctx.fill();

  const img = ctx.getImageData(0, 0, px, px);
  map.addImage(id, img, { pixelRatio: scale });
}

export const BUS_PREFIX = "bus-";

/**
 * Register a bus marker: a small rounded badge in the route color with the
 * route label, distinct from circular train bullets and square ferry badges.
 * One image per bus route id.
 */
export function registerBus(map: maplibregl.Map, route: RouteMeta) {
  const id = `${BUS_PREFIX}${route.id}`;
  if (map.hasImage(id)) return;

  const scale = 3;
  const w = 34;
  const h = 18;
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  const color = route.color || "#1b7fc4";
  const r = 5;
  // rounded pill
  ctx.beginPath();
  ctx.moveTo(r, 1);
  ctx.arcTo(w - 1, 1, w - 1, h - 1, r);
  ctx.arcTo(w - 1, h - 1, 1, h - 1, r);
  ctx.arcTo(1, h - 1, 1, 1, r);
  ctx.arcTo(1, 1, w - 1, 1, r);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();

  const label = bulletLabel(route.id).replace(/^B:/, "");
  ctx.fillStyle = textColorFor(color);
  ctx.font = `bold ${label.length > 4 ? 8 : 10}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, w / 2, h / 2 + 0.5);

  const img = ctx.getImageData(0, 0, w * scale, h * scale);
  map.addImage(id, img, { pixelRatio: scale });
}

/** Register bullets for all known routes, plus a neutral fallback. */
export function registerAllBullets(map: maplibregl.Map, routes: RouteMeta[]) {
  for (const r of routes) {
    if (r.id.startsWith("F:")) registerFerry(map, r);
    else if (r.id.startsWith("B:")) registerBus(map, r);
    else registerBullet(map, r);
  }
  // fallback markers for unknown routes
  registerBullet(map, { id: "?", color: "#666666", name: "Unknown" });
  registerFerry(map, { id: "?", color: "#0a3d62", name: "Ferry" });
  registerBus(map, { id: "?", color: "#1b7fc4", name: "Bus" });
}
