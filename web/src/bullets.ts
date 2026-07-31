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

/** Register bullets for all known routes, plus a neutral fallback. */
export function registerAllBullets(map: maplibregl.Map, routes: RouteMeta[]) {
  for (const r of routes) registerBullet(map, r);
  // fallback bullet for unknown routes
  registerBullet(map, { id: "?", color: "#666666", name: "Unknown" });
}
