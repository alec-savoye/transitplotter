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

/** Seconds-old age of an observation, e.g. "12s ago" / "3 min ago". */
function agoText(epochSec: number): string {
  if (!epochSec) return "";
  const secs = Math.max(0, Math.round(Date.now() / 1000 - epochSec));
  if (secs < 60) return `${secs}s ago`;
  const m = Math.round(secs / 60);
  return m === 1 ? "1 min ago" : `${m} min ago`;
}

/** Compass point (N, NE, …) plus degrees from a bearing in degrees. */
function compassText(brg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(((brg % 360) / 45)) % 8;
  return `${dirs[idx]} (${Math.round(brg)}°)`;
}

/** m/s -> "8.3 kn · 15 km/h · 9 mph" (ferries report speed in m/s). */
function speedText(mps: number): string {
  const kn = mps * 1.943844;
  const kmh = mps * 3.6;
  const mph = mps * 2.236936;
  return `${kn.toFixed(1)} kn · ${kmh.toFixed(0)} km/h · ${mph.toFixed(0)} mph`;
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
    const spd = p.spd !== "" && p.spd != null ? Number(p.spd) : NaN;
    const vid = p.vid || "";
    const brg = Number(p.brg);

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

    // Ferries get an expanded live-telemetry block (all the feed offers):
    // vessel name/id, live speed, heading, current position, and freshness.
    let ferryDetail = "";
    if (isFerry) {
      const moving = Number.isFinite(spd) ? spd > 0.5 : status === "moving";
      const rows: string[] = [];
      if (Number.isFinite(spd)) {
        rows.push(
          `<div class="tp-row">Speed: <b>${speedText(spd)}</b>${moving ? "" : " · <i>stationary</i>"}</div>`
        );
      }
      if (Number.isFinite(brg) && moving) {
        rows.push(`<div class="tp-row">Heading: <b>${compassText(brg)}</b></div>`);
      }
      rows.push(
        `<div class="tp-row tp-mono">Position: ${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}</div>`
      );
      if (vid) rows.push(`<div class="tp-row">Vessel ID: <b>${vid}</b></div>`);
      if (asOf) rows.push(`<div class="tp-row tp-sub">Live as of ${agoText(asOf)}</div>`);
      ferryDetail = rows.join("");
    }

    const html = isFerry
      ? `
      ${head}
      <div class="tp-row">Next ${nextLabel}: <b>${ns}</b></div>
      <div class="tp-row">Arriving: <span class="tp-eta">${etaText(eta) || "—"}</span></div>
      ${ferryDetail}
      ${delayRow}
      <div class="tp-status ${status}">${statusLabel}</div>
    `
      : `
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
