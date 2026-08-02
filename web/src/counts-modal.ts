// "Vehicles over the last 48 hours" chart modal.
//
// Double-click / double-tap the top-left Live HUD to open a modal with two
// time-series line plots over a rolling 48-hour window, each split by mode
// (subway / bus / ferry):
//   1. active vehicles
//   2. delayed vehicles (predicted delay ≥ 120s)
// The X axis always spans the full 48h; the plotted lines only cover the range
// for which data exists, and any leading gap (before the oldest sample) is
// shaded with a "no data" note. A static snapshot is fetched each time the
// modal opens (GET /counts).

import type { VehicleCountSeries, VehicleCountPoint } from "@transitplotter/shared";
import { carsShown } from "./main.js";

const WINDOW_MS = 48 * 60 * 60 * 1000;

type ModeKey = "subway" | "bus" | "ferry" | "cars";

interface ChartSeries {
  cls: string;
  /** Extract this series' value from a sample point. */
  value: (p: VehicleCountPoint) => number;
  /** Plot against the right-hand Y axis (its own scale) instead of the left. */
  rightAxis?: boolean;
}

interface LegendMode {
  key: ModeKey;
  label: string;
  cls: string;
  value: (p: VehicleCountPoint) => number;
  /** Plot against the right-hand Y axis (its own scale) instead of the left. */
  rightAxis?: boolean;
}

/** Modes drawn in the ACTIVE-vehicles chart (transit + estimated cars). Cars
 *  are ~1000× the transit counts, so they get their own right-hand Y axis. */
const ACTIVE_MODES: LegendMode[] = [
  { key: "subway", label: "🚇 Subway", cls: "subway", value: (p) => p.subway },
  { key: "bus", label: "🚌 Bus", cls: "bus", value: (p) => p.bus },
  { key: "ferry", label: "⛴ Ferry", cls: "ferry", value: (p) => p.ferry },
  { key: "cars", label: "🚗 Cars (est.)", cls: "cars", value: (p) => p.cars, rightAxis: true },
];

/** Modes drawn in the DELAY chart (transit only — cars have no delay signal). */
const DELAY_MODES: LegendMode[] = [
  { key: "subway", label: "🚇 Subway", cls: "subway", value: (p) => p.subwayDelayed },
  { key: "bus", label: "🚌 Bus", cls: "bus", value: (p) => p.busDelayed },
  { key: "ferry", label: "⛴ Ferry", cls: "ferry", value: (p) => p.ferryDelayed },
];

/** Wire the HUD double-click/tap trigger and the modal open/close behavior. */
export function setupCountsModal(serverHttp: string) {
  const hud = document.getElementById("hud");
  const modal = document.getElementById("counts-modal");
  if (!hud || !modal) return;

  const activeChart = modal.querySelector<HTMLElement>(".cm-chart-active");
  const activeLegend = modal.querySelector<HTMLElement>(".cm-legend-active");
  const delayChart = modal.querySelector<HTMLElement>(".cm-chart-delay");
  const delayLegend = modal.querySelector<HTMLElement>(".cm-legend-delay");
  const closeBtn = modal.querySelector<HTMLButtonElement>(".cm-close");

  const open = async () => {
    modal.classList.add("show");
    if (activeChart) activeChart.innerHTML = `<div class="cm-empty">Loading…</div>`;
    if (delayChart) delayChart.innerHTML = "";
    if (activeLegend) activeLegend.innerHTML = "";
    if (delayLegend) delayLegend.innerHTML = "";
    try {
      const series: VehicleCountSeries = await (
        await fetch(`${serverHttp}/counts`)
      ).json();
      // Respect the "Cars (est.)" toggle: drop the cars series when it's off.
      const showCars = carsShown();
      const activeModes = ACTIVE_MODES.filter((m) => m.key !== "cars" || showCars);
      const activeChartSeries: ChartSeries[] = activeModes.map((m) => ({
        cls: m.cls,
        value: m.value,
        rightAxis: m.rightAxis,
      }));
      if (activeChart) activeChart.innerHTML = plotSvg(series, activeChartSeries);
      if (activeLegend) activeLegend.innerHTML = legendHtml(series, activeModes);
      if (delayChart) delayChart.innerHTML = plotSvg(series, delaySeries);
      if (delayLegend) delayLegend.innerHTML = legendHtml(series, DELAY_MODES);
    } catch {
      if (activeChart)
        activeChart.innerHTML = `<div class="cm-empty">Could not load count history.</div>`;
      if (delayChart) delayChart.innerHTML = "";
    }
  };
  const close = () => modal.classList.remove("show");

  // Trigger: manual double-activation detector on the HUD container. Attaching
  // to the container (not its innerHTML) survives the HUD's periodic re-render,
  // and a click-count-within-window approach fires uniformly for mouse
  // double-clicks and touch double-taps.
  let taps = 0;
  let timer: number | null = null;
  const bump = () => {
    taps++;
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => (taps = 0), 350);
    if (taps >= 2) {
      taps = 0;
      if (timer != null) window.clearTimeout(timer);
      void open();
    }
  };
  hud.addEventListener("click", bump);
  // Suppress the browser's native text-selection on rapid double-click.
  hud.addEventListener("dblclick", (e) => e.preventDefault());

  closeBtn?.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("show")) close();
  });
}

/** Delay-chart series (transit only; built once). The active-chart series is
 *  built per-open so it can honor the "Cars (est.)" toggle. */
const delaySeries: ChartSeries[] = DELAY_MODES.map((m) => ({
  cls: m.cls,
  value: m.value,
}));

/** Legend with the latest value for each mode (uses the same accessors). */
function legendHtml(data: VehicleCountSeries, modes: LegendMode[]): string {
  const last = data.points[data.points.length - 1];
  return modes
    .map((m) => {
      const v = last ? Math.round(m.value(last)) : 0;
      const axis = m.rightAxis ? ` <span class="cm-axis-note">(right axis)</span>` : "";
      return `<span><i class="cm-swatch" style="background:${swatchColor(m.cls)}"></i>${m.label}: <b>${v.toLocaleString()}</b>${axis}</span>`;
    })
    .join("");
}

function swatchColor(cls: string): string {
  return cls === "subway"
    ? "#fbbf24"
    : cls === "bus"
      ? "#4ade80"
      : cls === "ferry"
        ? "#38bdf8"
        : "#f472b6"; // cars
}

/**
 * Render a 48h multi-series line chart as inline SVG. X axis is a fixed 48h
 * window ending "now"; lines only span where samples exist; the pre-data gap is
 * shaded with a note. `series` supplies one line per mode via value accessors.
 */
function plotSvg(data: VehicleCountSeries, series: ChartSeries[]): string {
  const now = data.now;
  const windowMs = data.windowMs || WINDOW_MS;
  const t0 = now - windowMs; // left edge of the axis
  const pts = data.points.filter((p) => p.t >= t0);

  const leftSeries = series.filter((s) => !s.rightAxis);
  const rightSeries = series.filter((s) => s.rightAxis);
  const hasRight = rightSeries.length > 0;

  const W = 520;
  const H = 200;
  const padL = 30;
  const padR = hasRight ? 40 : 10; // room for the right-hand axis labels
  const padT = 12;
  const padB = 22;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const xAt = (t: number) =>
    padL + Math.max(0, Math.min(1, (t - t0) / windowMs)) * iw;

  // Independent Y scales: left axis for transit series, right axis for cars.
  let maxL = 0;
  let maxR = 0;
  for (const p of pts) {
    for (const s of leftSeries) maxL = Math.max(maxL, s.value(p));
    for (const s of rightSeries) maxR = Math.max(maxR, s.value(p));
  }
  const yMaxL = niceMax(Math.max(1, maxL));
  const yMaxR = niceMax(Math.max(1, maxR));
  const yAtL = (v: number) => padT + ih - (v / yMaxL) * ih;
  const yAtR = (v: number) => padT + ih - (v / yMaxR) * ih;
  const yAtFor = (s: ChartSeries) => (s.rightAxis ? yAtR : yAtL);

  // Left Y gridlines/labels at 0, ¼, ½, ¾, max (shared horizontal gridlines).
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const v = Math.round(yMaxL * f);
      const y = yAtL(v);
      const right = hasRight
        ? `<text x="${W - padR + 4}" y="${(y + 3).toFixed(1)}" class="cm-ylab cm-ylab-right">${abbrev(Math.round(yMaxR * f))}</text>`
        : "";
      return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="cm-grid"/>
        <text x="${padL - 4}" y="${(y + 3).toFixed(1)}" class="cm-ylab">${v}</text>${right}`;
    })
    .join("");

  // X (time) axis labels: every 6 hours, as local HH:MM.
  const xlabels: string[] = [];
  const stepMs = 6 * 60 * 60 * 1000;
  // Align to the next 6h boundary at/after t0.
  const firstTick = Math.ceil(t0 / stepMs) * stepMs;
  for (let t = firstTick; t <= now + 1; t += stepMs) {
    const x = xAt(t);
    const d = new Date(t);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    xlabels.push(
      `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${padT + ih}" class="cm-grid"/>
       <text x="${x.toFixed(1)}" y="${H - 8}" class="cm-xlab" text-anchor="middle">${hh}:${mm}</text>`,
    );
  }

  // Empty: no samples in the window at all.
  if (pts.length === 0) {
    return `<div class="cm-empty">No data collected yet. The chart fills in as the server records samples (about every 20 seconds).</div>`;
  }

  // "No data" shaded band from the axis start to the first sample.
  let noData = "";
  const firstT = pts[0].t;
  if (firstT > t0) {
    const x1 = xAt(t0);
    const x2 = xAt(firstT);
    const w = Math.max(0, x2 - x1);
    if (w > 2) {
      noData = `<rect x="${x1.toFixed(1)}" y="${padT}" width="${w.toFixed(1)}" height="${ih}" class="cm-nodata-band"/>
        <text x="${(x1 + w / 2).toFixed(1)}" y="${(padT + ih / 2).toFixed(1)}" class="cm-nodata-lab">no data</text>`;
    }
  }

  const linePoly = (s: ChartSeries) => {
    const yAt = yAtFor(s);
    const coords = pts.map((p) => `${xAt(p.t).toFixed(1)},${yAt(s.value(p)).toFixed(1)}`);
    // A single sample renders as a tiny 2px segment so it's visible.
    if (pts.length === 1) {
      const [x, y] = coords[0].split(",");
      return `<polyline points="${x},${y} ${(parseFloat(x) + 2).toFixed(1)},${y}" class="cm-line ${s.cls}"/>`;
    }
    return `<polyline points="${coords.join(" ")}" class="cm-line ${s.cls}"/>`;
  };

  const lines = series.map(linePoly).join("");

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="cm-svg" preserveAspectRatio="none">
      ${grid}
      ${xlabels.join("")}
      ${noData}
      ${lines}
    </svg>`;
}

/** Round a max value up to a "nice" round axis top. */
function niceMax(v: number): number {
  if (v <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

/** Compact large numbers for axis labels: 1200 -> "1.2k", 730000 -> "730k". */
function abbrev(v: number): string {
  if (v >= 1_000_000) return `${Math.round(v / 100_000) / 10}M`;
  if (v >= 1_000) return `${Math.round(v / 100) / 10}k`;
  return String(v);
}
