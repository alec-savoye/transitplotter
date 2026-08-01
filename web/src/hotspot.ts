// Click-a-hotspot summary. When the hotspots layer is visible, clicking on a
// red delay cloud reports why it's a hotspot: how many delayed trains, total
// and worst delay, and a per-train breakdown.

import maplibregl from "maplibre-gl";
import type { TrainLayer, LiveTrain } from "./trains.js";
import { bulletLabel } from "./bullets.js";

const YELLOW = new Set(["#FCCC0A", "#F6BC26", "#FBBD08"]);
const textOn = (c: string) => (YELLOW.has(c.toUpperCase()) ? "#000" : "#fff");
const isExpress = (r: string) => r.endsWith("X");

/** Radius (meters) around the click to gather contributing trains. */
const CLICK_RADIUS_M = 900;

function bulletHtml(route: string, color: string): string {
  const cls = isExpress(route) ? "hs-bullet exp" : "hs-bullet";
  const label = bulletLabel(route);
  const inner = isExpress(route) ? `<span>${label}</span>` : label;
  return `<span class="${cls}" style="background:${color};color:${textOn(color)}">${inner}</span>`;
}

function delayText(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 1) return "<1 min";
  return `${m} min`;
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
 * Wire clicks on the hotspots heatmap to a popup summarizing the delay cluster.
 * The heatmap layer isn't individually feature-clickable, so we listen for map
 * clicks and, when hotspots are visible, gather nearby delayed trains from the
 * TrainLayer's live state.
 */
export function attachHotspotSummary(
  map: maplibregl.Map,
  trainLayer: TrainLayer,
  colorFor: (routeId: string) => string,
  isHotspotsOn: () => boolean
) {
  const popup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: true,
    offset: 12,
    maxWidth: "300px",
  });

  map.on("click", (e) => {
    if (!isHotspotsOn()) return;

    // Ignore clicks that landed on a train bullet (that has its own popup).
    const onTrain = map.queryRenderedFeatures(e.point, { layers: ["trains"] });
    if (onTrain.length) return;

    const near = trainLayer.delayedNear(e.lngLat.lng, e.lngLat.lat, CLICK_RADIUS_M);
    if (near.length === 0) return; // not a hotspot — no summary

    popup.setLngLat(e.lngLat).setHTML(summaryHtml(near, colorFor)).addTo(map);
  });
}

function summaryHtml(trains: LiveTrain[], colorFor: (r: string) => string): string {
  const worst = trains[0];
  const stalled = trains.filter((t) => t.status === "stalled").length;
  const avg = trains.reduce((s, t) => s + t.dly, 0) / trains.length;
  // Most recent observation time across the cluster.
  const latestObs = Math.max(...trains.map((t) => t.asOf || 0));

  const rows = trains
    .slice(0, 8)
    .map((t) => {
      const dest = t.dest ? `to ${t.dest}` : "";
      const ns = t.ns ? `→ ${t.ns}` : "";
      const tag = t.status === "stalled" ? ' <span class="hs-stalled">stalled</span>' : "";
      const when = whenText(t.asOf);
      return `<div class="hs-row">
        ${bulletHtml(t.route, colorFor(t.route))}
        <span class="hs-row-txt">${dest} ${ns}${tag}
          <br><span class="hs-sub">delayed ${delayText(t.dly)}${when ? ` at ${when}` : ""}</span></span>
      </div>`;
    })
    .join("");

  const more = trains.length > 8 ? `<div class="hs-more">+${trains.length - 8} more…</div>` : "";

  return `
    <div class="hs-head">⚠ Delay Hotspot</div>
    <div class="hs-stats">
      <b>${trains.length}</b> delayed train${trains.length === 1 ? "" : "s"} here
      ${stalled ? ` · <b>${stalled}</b> stalled` : ""}
      <br>Worst: <b>${delayText(worst.dly)}</b> · Avg: <b>${delayText(avg)}</b> behind schedule
      ${latestObs ? `<br><span class="hs-sub">as of ${whenText(latestObs)}</span>` : ""}
    </div>
    <div class="hs-rows">${rows}${more}</div>
  `;
}
