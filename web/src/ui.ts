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

  map.on("click", "trains", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const p = f.properties as Record<string, string>;
    const route = p.route ?? "?";
    const color = colorFor(route);
    const status = (p.status as string) || "moving";
    const dest = p.dest || "—";
    const ns = p.ns || "—";
    const eta = Number(p.eta) || 0;

    const statusLabel =
      status === "stalled"
        ? "Delayed / not moving"
        : status === "stopped"
          ? "At station"
          : "In service";

    const coords = (f.geometry as GeoJSON.Point).coordinates.slice() as [
      number,
      number,
    ];
    const html = `
      <div class="tp-pop-head">
        ${bulletHtml(route, color)}
        <span class="tp-dest">to ${dest}</span>
      </div>
      <div class="tp-row">Next stop: <b>${ns}</b></div>
      <div class="tp-row">Arriving: <span class="tp-eta">${etaText(eta) || "—"}</span></div>
      <div class="tp-status ${status}">${statusLabel}</div>
    `;
    popup.setLngLat(coords).setHTML(html).addTo(map);
  });

  map.on("mouseenter", "trains", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "trains", () => (map.getCanvas().style.cursor = ""));
}
