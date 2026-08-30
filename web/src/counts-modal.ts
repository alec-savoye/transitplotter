// "Vehicles over the last 48 hours" chart modal.
//
// Double-click / double-tap the top-left Live HUD to open a modal with three
// time-series line plots over a rolling 48-hour window, each split by mode
// (subway / bus / ferry):
//   1. active vehicles
//   2. delayed vehicles (predicted delay ≥ 2 min)
//   3. severely delayed vehicles (predicted delay ≥ 10 min)
// The two delay charts share identical functionality (per-borough bus lines on
// their own right axis + a "Count / % of active" normalize toggle). The X axis
// always spans the full 48h; the plotted lines only cover the range for which
// data exists, and any leading gap (before the oldest sample) is shaded with a
// "no data" note. A static snapshot is fetched each time the modal opens
// (GET /counts).

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
  /** Fixed maximum for the right axis (e.g. 100 for a percentage). */
  rightMax?: number;
}

interface LegendMode {
  key: ModeKey;
  label: string;
  cls: string;
  value: (p: VehicleCountPoint) => number;
  /** Plot against the right-hand Y axis (its own scale) instead of the left. */
  rightAxis?: boolean;
  /** Fixed maximum for the right axis (e.g. 100 for a percentage). */
  rightMax?: number;
  /** Render the legend value as a percentage (e.g. "12%") instead of a count. */
  pct?: boolean;
}

/** Modes drawn in the ACTIVE-vehicles chart (transit + estimated cars). Cars
 *  are ~1000× the transit counts, so they get their own right-hand Y axis. */
const ACTIVE_MODES: LegendMode[] = [
  { key: "subway", label: "🚇 Subway", cls: "subway", value: (p) => p.subway },
  { key: "bus", label: "🚌 Bus", cls: "bus", value: (p) => p.bus },
  { key: "ferry", label: "⛴ Ferry", cls: "ferry", value: (p) => p.ferry },
  { key: "cars", label: "🚗 Cars (est.)", cls: "cars", value: (p) => p.cars, rightAxis: true },
];

/** Borough breakdown for delayed buses. Each borough is its own line, plotted
 *  on the right-hand Y axis (delayed buses run ~1–2 orders of magnitude higher
 *  than delayed subway/ferry, so sharing the left axis would flatten them). */
const BUS_BOROUGHS: { code: string; label: string; cls: string }[] = [
  { code: "manhattan", label: "🚌 Bus · Manhattan", cls: "bus-manhattan" },
  { code: "brooklyn", label: "🚌 Bus · Brooklyn", cls: "bus-brooklyn" },
  { code: "bronx", label: "🚌 Bus · Bronx", cls: "bus-bronx" },
  { code: "queens", label: "🚌 Bus · Queens", cls: "bus-queens" },
  { code: "statenisland", label: "🚌 Bus · Staten Is.", cls: "bus-statenisland" },
];

/**
 * A delay tier selects which fields on a sample point supply the per-mode and
 * per-borough delayed counts. Both charts share identical rendering logic; only
 * these accessors differ (≥ 2 min vs. ≥ 10 min).
 */
interface DelayTier {
  subway: (p: VehicleCountPoint) => number;
  ferry: (p: VehicleCountPoint) => number;
  busBoro: (p: VehicleCountPoint, code: string) => number;
}

const TIER_DELAYED: DelayTier = {
  subway: (p) => p.subwayDelayed,
  ferry: (p) => p.ferryDelayed,
  busBoro: (p, code) => p.busDelayedBoro?.[code] ?? 0,
};

const TIER_VERY_DELAYED: DelayTier = {
  subway: (p) => p.subwayVeryDelayed ?? 0,
  ferry: (p) => p.ferryVeryDelayed ?? 0,
  busBoro: (p, code) => p.busVeryDelayedBoro?.[code] ?? 0,
};

/** Active buses in one borough at a sample (0 when the breakdown is absent). */
function busBoroActive(p: VehicleCountPoint, code: string): number {
  return p.busActiveBoro?.[code] ?? 0;
}

/**
 * Normalized bus lateness in one borough for a tier: delayed / active as a
 * percentage 0..100 for plotting. Returns 0 when there are no active buses in
 * that borough at the sample (or the breakdown is absent).
 */
function busBoroLateFrac(tier: DelayTier, p: VehicleCountPoint, code: string): number {
  const active = busBoroActive(p, code);
  if (active <= 0) return 0;
  return (tier.busBoro(p, code) / active) * 100;
}

/**
 * Modes drawn in a DELAY chart (transit only — cars have no delay signal).
 * Subway + ferry share the left axis; delayed buses are split by borough on the
 * right-hand axis so all delay signals can be observed together. Built per
 * render so it can honor the per-chart "Bus lateness: Count / % of active"
 * toggle. `normalized` picks raw counts vs. % of active buses.
 */
function delayModes(tier: DelayTier, normalized: boolean): LegendMode[] {
  return [
    { key: "subway", label: "🚇 Subway", cls: "subway", value: tier.subway },
    { key: "ferry", label: "⛴ Ferry", cls: "ferry", value: tier.ferry },
    ...BUS_BOROUGHS.map((b) => ({
      key: "bus" as ModeKey,
      label: b.label,
      cls: b.cls,
      value: normalized
        ? (p: VehicleCountPoint) => busBoroLateFrac(tier, p, b.code)
        : (p: VehicleCountPoint) => tier.busBoro(p, b.code),
      rightAxis: true,
      // Percent axis is fixed 0..100; counts auto-scale (undefined).
      rightMax: normalized ? 100 : undefined,
      // Render normalized values as "12%" in the legend.
      pct: normalized,
    })),
  ];
}

/** Wire the HUD double-click/tap trigger and the modal open/close behavior. */
export function setupCountsModal(serverHttp: string) {
  const hud = document.getElementById("hud");
  const modal = document.getElementById("counts-modal");
  if (!hud || !modal) return;

  const activeChart = modal.querySelector<HTMLElement>(".cm-chart-active");
  const activeLegend = modal.querySelector<HTMLElement>(".cm-legend-active");
  const closeBtn = modal.querySelector<HTMLButtonElement>(".cm-close");

  /** Latest fetched series, kept so the normalize toggles can redraw instantly. */
  let latest: VehicleCountSeries | null = null;

  /**
   * Bind one delay chart (either the ≥2min or ≥10min tier) to its DOM triplet
   * (chart / legend / normalize button). Returns a render fn + keeps its own
   * normalized state so the two charts toggle independently.
   */
  function bindDelayChart(tier: DelayTier, suffix: string) {
    const chart = modal!.querySelector<HTMLElement>(`.cm-chart-delay${suffix}`);
    const legend = modal!.querySelector<HTMLElement>(`.cm-legend-delay${suffix}`);
    const normBtn = modal!.querySelector<HTMLButtonElement>(`.cm-norm-toggle${suffix}`);
    let normalized = false;

    const render = () => {
      if (!latest) return;
      const modes = delayModes(tier, normalized);
      const chartSeries: ChartSeries[] = modes.map((m) => ({
        cls: m.cls,
        value: m.value,
        rightAxis: m.rightAxis,
        rightMax: m.rightMax,
      }));
      if (chart) chart.innerHTML = plotSvg(latest, chartSeries);
      if (legend) legend.innerHTML = legendHtml(latest, modes);
      if (normBtn)
        normBtn.textContent = normalized
          ? "Bus lateness: % of active"
          : "Bus lateness: Count";
    };

    normBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      normalized = !normalized;
      render();
    });

    const clear = () => {
      if (chart) chart.innerHTML = "";
      if (legend) legend.innerHTML = "";
    };

    return { render, clear };
  }

  // Two delay charts sharing identical functionality: ≥2 min and ≥10 min.
  const delayed = bindDelayChart(TIER_DELAYED, "");
  const veryDelayed = bindDelayChart(TIER_VERY_DELAYED, "-severe");

  const open = async () => {
    modal.classList.add("show");
    if (activeChart) activeChart.innerHTML = `<div class="cm-empty">Loading…</div>`;
    delayed.clear();
    veryDelayed.clear();
    if (activeLegend) activeLegend.innerHTML = "";
    try {
      const series: VehicleCountSeries = await (
        await fetch(`${serverHttp}/counts`)
      ).json();
      latest = series;
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
      delayed.render();
      veryDelayed.render();
    } catch {
      if (activeChart)
        activeChart.innerHTML = `<div class="cm-empty">Could not load count history.</div>`;
      delayed.clear();
      veryDelayed.clear();
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

/** Legend with the latest value for each mode (uses the same accessors). */
function legendHtml(data: VehicleCountSeries, modes: LegendMode[]): string {
  const last = data.points[data.points.length - 1];
  return modes
    .map((m) => {
      const raw = last ? m.value(last) : 0;
      const v = Math.round(raw);
      const shown = m.pct ? `${v}%` : v.toLocaleString();
      const axis = m.rightAxis ? ` <span class="cm-axis-note">(right axis)</span>` : "";
      return `<span><i class="cm-swatch" style="background:${swatchColor(m.cls)}"></i>${m.label}: <b>${shown}</b>${axis}</span>`;
    })
    .join("");
}

function swatchColor(cls: string): string {
  switch (cls) {
    case "subway":
      return "#fbbf24";
    case "bus":
      return "#4ade80";
    case "ferry":
      return "#38bdf8";
    case "cars":
      return "#f472b6";
    // Delayed-bus borough lines (each a distinct green→teal shade).
    case "bus-manhattan":
      return "#4ade80";
    case "bus-brooklyn":
      return "#a3e635";
    case "bus-bronx":
      return "#22d3ee";
    case "bus-queens":
      return "#2dd4bf";
    case "bus-statenisland":
      return "#facc15";
    default:
      return "#94a3b8";
  }
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
  // A right-hand series may pin a fixed max (e.g. 100 for a percentage axis).
  const fixedRightMax = rightSeries.find((s) => s.rightMax != null)?.rightMax;
  // Right-axis labels get a "%" suffix when the axis is a fixed 0..100 scale.
  const rightIsPct = fixedRightMax === 100;
  const yMaxL = niceMax(Math.max(1, maxL));
  const yMaxR = fixedRightMax != null ? fixedRightMax : niceMax(Math.max(1, maxR));
  const yAtL = (v: number) => padT + ih - (v / yMaxL) * ih;
  const yAtR = (v: number) => padT + ih - (v / yMaxR) * ih;
  const yAtFor = (s: ChartSeries) => (s.rightAxis ? yAtR : yAtL);

  // Left Y gridlines/labels at 0, ¼, ½, ¾, max (shared horizontal gridlines).
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const v = Math.round(yMaxL * f);
      const y = yAtL(v);
      const rlabel = rightIsPct
        ? `${Math.round(yMaxR * f)}%`
        : abbrev(Math.round(yMaxR * f));
      const right = hasRight
        ? `<text x="${W - padR + 4}" y="${(y + 3).toFixed(1)}" class="cm-ylab cm-ylab-right">${rlabel}</text>`
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
