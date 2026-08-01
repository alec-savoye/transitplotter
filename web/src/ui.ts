// UI glue: line legend + click-a-train popup. Kept separate from rendering.

import maplibregl from "maplibre-gl";
import type { RouteMeta } from "@transitplotter/shared";
import { bulletLabel } from "./bullets.js";

const YELLOW = new Set(["#FCCC0A", "#F6BC26", "#FBBD08"]);
function textOn(color: string): string {
  return YELLOW.has(color.toUpperCase()) ? "#000" : "#fff";
}
function isExpress(routeId: string): boolean {
  return routeId.endsWith("X");
}

/** Build the small line legend in the bottom-left box. */
export function buildLegend(routes: RouteMeta[]) {
  const rows = document.querySelector<HTMLDivElement>("#legend .rows");
  if (!rows) return;
  rows.innerHTML = "";
  // De-dup by label+color so 6/6X don't both show; show base services only.
  const seen = new Set<string>();
  for (const r of routes) {
    // Subway only — buses ("B:") and ferries ("F:") would flood the legend.
    if (r.id.startsWith("B:") || r.id.startsWith("F:")) continue;
    if (isExpress(r.id)) continue; // legend shows base services
    const label = bulletLabel(r.id);
    if (seen.has(label)) continue;
    seen.add(label);
    const el = document.createElement("span");
    el.className = "lg-bullet";
    el.style.background = r.color;
    el.style.color = textOn(r.color);
    el.title = r.name;
    el.textContent = label;
    rows.appendChild(el);
  }
}

function bulletHtml(routeId: string, color: string): string {
  const cls = isExpress(routeId) ? "tp-bullet exp" : "tp-bullet";
  const label = bulletLabel(routeId);
  const inner = isExpress(routeId) ? `<span>${label}</span>` : label;
  return `<span class="${cls}" style="background:${color};color:${textOn(color)}">${inner}</span>`;
}

function etaText(eta: number): string {
  if (!eta) return "";
  const secs = eta - Date.now() / 1000;
  if (secs < 30) return "now";
  const mins = Math.round(secs / 60);
  return mins <= 1 ? "1 min" : `${mins} min`;
}

/** Format an epoch-seconds timestamp as "3:41 PM on Jul 31". */
function whenText(epochSec: number): string {
  if (!epochSec) return "";
  const d = new Date(epochSec * 1000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${time} on ${date}`;
}

/**
 * Wire up click + hover behavior on the trains layer to show a popup with
 * route bullet, destination, next stop + ETA, and reliability status.
 */
export function attachTrainPopup(
  map: maplibregl.Map,
  colorFor: (routeId: string) => string
) {
  const popup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: true,
    offset: 14,
    maxWidth: "260px",
  });

  const onClick = (e: maplibregl.MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    const p = f.properties as Record<string, string>;
    const route = p.route ?? "?";
    const isFerry = p.mode === "ferry";
    const isBus = p.mode === "bus";
    const color = colorFor(route);
    const status = (p.status as string) || "moving";
    const dest = p.dest || "—";
    const ns = p.ns || "—";
    const eta = Number(p.eta) || 0;
    const dly = Number(p.dly) || 0;
    const asOf = Number(p.asOf) || 0;
    const label = p.label || "";

    const statusLabel =
      status === "stalled"
        ? "Delayed / not moving"
        : status === "stopped"
          ? isFerry
            ? "At landing"
            : "At station"
          : "In service";

    const coords = (f.geometry as GeoJSON.Point).coordinates.slice() as [
      number,
      number,
    ];
    const delayRow =
      dly >= 60
        ? `<div class="tp-row tp-delay">Delayed <b>${Math.round(dly / 60)} min</b>${asOf ? ` as of ${whenText(asOf)}` : ""}</div>`
        : "";
    const busLabel = (route || "").replace(/^B:/, "");
    const head = isFerry
      ? `<div class="tp-pop-head"><span class="tp-ferry" style="background:${color};color:${textOn(color)}">⛴</span>
           <span class="tp-dest">${label ? `${label} · ` : ""}to ${dest}</span></div>`
      : isBus
        ? `<div class="tp-pop-head"><span class="tp-busbadge" style="background:${color};color:${textOn(color)}">${busLabel}</span>
             <span class="tp-dest">to ${dest}</span></div>`
        : `<div class="tp-pop-head">${bulletHtml(route, color)}
             <span class="tp-dest">to ${dest}</span></div>`;
    const nextLabel = isFerry ? "landing" : "stop";
    const html = `
      ${head}
      <div class="tp-row">Next ${nextLabel}: <b>${ns}</b></div>
      <div class="tp-row">Arriving: <span class="tp-eta">${etaText(eta) || "—"}</span></div>
      ${delayRow}
      <div class="tp-status ${status}">${statusLabel}</div>
    `;
    popup.setLngLat(coords).setHTML(html).addTo(map);
  };

  for (const layer of ["trains", "ferries", "buses"]) {
    map.on("click", layer, onClick);
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }
}
