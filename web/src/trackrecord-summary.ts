// Click-a-cell rationale for the Track Records overlay. When the overlay is on
// and displayable, clicking a mesh cell explains its color: the late rate and
// the per-mode breakdown (how many observed subway/bus segment traversals were
// late vs. on time). Ferries are not tracked (no delay signal).

import maplibregl from "maplibre-gl";
import type { TrackRecords } from "./trackrecords.js";
import type { TrackRecordCell, TrackRecordHistory } from "@transitplotter/shared";
import { SERVER_HTTP } from "./config.js";

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** A short reliability label + accent color from a late rate. */
function grade(rate: number): { label: string; color: string } {
  if (rate < 0.15) return { label: "Very reliable", color: "#2ecc40" };
  if (rate < 0.35) return { label: "Mostly reliable", color: "#a8d600" };
  if (rate < 0.55) return { label: "Mixed", color: "#ffc300" };
  if (rate < 0.75) return { label: "Often late", color: "#ff7b00" };
  return { label: "Frequently late", color: "#ff4136" };
}

function modeRow(label: string, late: number, total: number): string {
  if (total === 0) return "";
  const onTime = total - late;
  return `<div class="tr-row">
      <span class="tr-mode">${label}</span>
      <span class="tr-nums"><b>${late}</b> late · ${onTime} on time
        <span class="tr-sub">(${pct(late / total)} of ${total})</span></span>
    </div>`;
}

/** Days elapsed since an epoch-ms timestamp. */
function daysSince(epochMs: number): number {
  if (!epochMs) return 0;
  return (Date.now() - epochMs) / (24 * 60 * 60 * 1000);
}

function summaryHtml(c: TrackRecordCell): string {
  const modes =
    modeRow("🚇 Subway", c.subway.late, c.subway.total) +
    modeRow("🚌 Bus", c.bus.late, c.bus.total);

  // Not enough history yet: this cell is gray. Explain the week requirement.
  if (!c.ready) {
    const days = daysSince(c.firstObs);
    const daysTxt = c.firstObs
      ? `Observed for <b>${days.toFixed(1)}</b> of 7 day${days >= 1 && days < 2 ? "" : "s"} so far.`
      : `No observations recorded here yet.`;
    return `
      <div class="tr-head" style="border-color:#b8bcc2">
        <span class="tr-dot" style="background:#b8bcc2"></span>
        Not enough data yet
      </div>
      <div class="tr-stats">
        A cell must be observed across at least one full week before it is graded.<br>
        ${daysTxt}
      </div>
      <div class="tr-rows">${modes}</div>
      <div class="tr-foot">Ferry reliability is not yet tracked.</div>
    `;
  }

  const g = grade(c.rate);
  return `
    <div class="tr-head" style="border-color:${g.color}">
      <span class="tr-dot" style="background:${g.color}"></span>
      ${g.label}
    </div>
    <div class="tr-stats">
      <b>${pct(c.rate)}</b> of ${c.total} observed segment${c.total === 1 ? "" : "s"}
      here ran late
      <span class="tr-sub">(over ${daysSince(c.firstObs).toFixed(0)}+ days)</span>
    </div>
    <div class="tr-plot"><div class="tr-plot-loading">Loading history…</div></div>
    <div class="tr-rows">${modes}</div>
    <div class="tr-foot">Ferry reliability is not yet tracked.</div>
  `;
}

/**
 * Render a compact "% lateness vs. date" line plot as inline SVG from a cell's
 * daily history. X axis = date (days, oldest→newest), Y axis = late %.
 */
function plotSvg(hist: TrackRecordHistory): string {
  const days = hist.days.filter((d) => d.total > 0);
  if (days.length === 0) return `<div class="tr-plot-empty">No daily history yet.</div>`;

  const W = 248;
  const H = 96;
  const padL = 26; // room for y labels
  const padR = 6;
  const padT = 8;
  const padB = 18; // room for x labels
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const n = days.length;
  const pctVals = days.map((d) => (d.late / d.total) * 100);
  const xAt = (i: number) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yAt = (p: number) => padT + ih - (Math.min(100, p) / 100) * ih;

  // Gridlines at 0/25/50/75/100%.
  const grid = [0, 25, 50, 75, 100]
    .map((p) => {
      const y = yAt(p);
      return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="tr-grid"/>
        <text x="${padL - 4}" y="${(y + 3).toFixed(1)}" class="tr-ylab">${p}</text>`;
    })
    .join("");

  const line = days
    .map((_, i) => `${xAt(i).toFixed(1)},${yAt(pctVals[i]).toFixed(1)}`)
    .join(" ");

  const dots = days
    .map((d, i) => {
      const cx = xAt(i).toFixed(1);
      const cy = yAt(pctVals[i]).toFixed(1);
      return `<circle cx="${cx}" cy="${cy}" r="2.2" class="tr-dot-pt"><title>${d.date}: ${pctVals[i].toFixed(0)}% late (${d.late}/${d.total})</title></circle>`;
    })
    .join("");

  // First + last x labels (MM-DD) to avoid clutter.
  const shortDate = (s: string) => s.slice(5);
  const firstLab = `<text x="${xAt(0).toFixed(1)}" y="${H - 4}" class="tr-xlab" text-anchor="start">${shortDate(days[0].date)}</text>`;
  const lastLab =
    n > 1
      ? `<text x="${xAt(n - 1).toFixed(1)}" y="${H - 4}" class="tr-xlab" text-anchor="end">${shortDate(days[n - 1].date)}</text>`
      : "";

  return `
    <div class="tr-plot-title">% late by day</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="tr-svg">
      ${grid}
      <polyline points="${line}" class="tr-line"/>
      ${dots}
      ${firstLab}${lastLab}
    </svg>`;
}

/**
 * Wire clicks on the track-records mesh to a rationale popup. The overlay is
 * only interactive when it's both toggled on and has enough data (`isOn()`).
 */
export function attachTrackRecordSummary(
  map: maplibregl.Map,
  trackRecords: TrackRecords,
  isOn: () => boolean,
) {
  const popup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: true,
    offset: 12,
    maxWidth: "280px",
  });

  map.on("click", (e) => {
    if (!isOn()) return;
    // Don't hijack clicks that landed on a vehicle marker (own popup).
    const onVehicle = map.queryRenderedFeatures(e.point, {
      layers: ["trains", "buses", "ferries"].filter((l) => map.getLayer(l)),
    });
    if (onVehicle.length) return;

    const cell = trackRecords.cellAt(e.lngLat.lng, e.lngLat.lat);
    if (!cell || cell.total === 0) return;

    popup.setLngLat(e.lngLat).setHTML(summaryHtml(cell)).addTo(map);

    // Only ready (colored) cells get the historical %-lateness-vs-date plot;
    // gray cells don't yet have a meaningful series.
    if (!cell.ready) return;
    fetchHistory(cell.key)
      .then((hist) => {
        const el = popup.getElement()?.querySelector(".tr-plot");
        if (el) el.innerHTML = hist ? plotSvg(hist) : `<div class="tr-plot-empty">No history.</div>`;
      })
      .catch(() => {
        const el = popup.getElement()?.querySelector(".tr-plot");
        if (el) el.innerHTML = `<div class="tr-plot-empty">History unavailable.</div>`;
      });
  });
}

async function fetchHistory(key: string): Promise<TrackRecordHistory | null> {
  const res = await fetch(`${SERVER_HTTP}/trackrecords/history?key=${encodeURIComponent(key)}`);
  if (!res.ok) return null;
  return (await res.json()) as TrackRecordHistory;
}
