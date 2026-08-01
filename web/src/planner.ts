// Trip planner UI: From/To inputs -> GET /plan -> itinerary panel + map
// highlight of the planned route legs.

import type maplibregl from "maplibre-gl";
import type { Itinerary, ItineraryLeg } from "@transitplotter/shared";
import { bulletLabel } from "./bullets.js";
import { emptyFC } from "./basemap.js";

const YELLOW = new Set(["#FCCC0A", "#F6BC26", "#FBBD08"]);
const textOn = (c: string) => (YELLOW.has(c.toUpperCase()) ? "#000" : "#fff");
const isExpress = (r: string) => r.endsWith("X");

function bulletHtml(route: string, color: string): string {
  const cls = isExpress(route) ? "pl-bullet exp" : "pl-bullet";
  const label = bulletLabel(route);
  const inner = isExpress(route) ? `<span>${label}</span>` : label;
  return `<span class="${cls}" style="background:${color};color:${textOn(color)}">${inner}</span>`;
}

const mins = (s: number) => Math.max(1, Math.round(s / 60));

export class TripPlanner {
  private panel: HTMLDivElement;
  private stationCoords = new Map<string, [number, number]>();

  constructor(private map: maplibregl.Map, private serverHttp: string) {
    this.panel = document.createElement("div");
    this.panel.id = "planner";
    this.panel.classList.add("hidden"); // hidden until toggled from controls
    this.panel.innerHTML = `
      <div class="pl-head">Trip Planner</div>
      <input id="pl-from" placeholder="From (address or place)" autocomplete="off" />
      <input id="pl-to" placeholder="To (address or place)" autocomplete="off" />
      <button id="pl-go">Plan trip</button>
      <div id="pl-result"></div>`;
    document.body.appendChild(this.panel);

    this.panel.querySelector<HTMLButtonElement>("#pl-go")!.addEventListener("click", () =>
      this.plan()
    );
    this.panel.querySelectorAll("input").forEach((inp) =>
      inp.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") this.plan();
      })
    );

    this.addRouteLayer();
    this.loadStationCoords();
  }

  /** Show or hide the planner panel. */
  setVisible(visible: boolean) {
    this.panel.classList.toggle("hidden", !visible);
    if (visible) this.panel.querySelector<HTMLInputElement>("#pl-from")?.focus();
  }

  /** Whether the planner panel is currently visible. */
  isVisible(): boolean {
    return !this.panel.classList.contains("hidden");
  }

  /** Cache base-station -> coordinate from the stations GeoJSON for highlighting. */
  private async loadStationCoords() {
    try {
      const fc = await (await fetch(`${this.serverHttp}/geo/stations`)).json();
      for (const f of fc.features as GeoJSON.Feature[]) {
        const id = (f.properties as any)?.id as string;
        const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        if (id) this.stationCoords.set(id, c);
      }
    } catch {
      /* highlight will simply be skipped if unavailable */
    }
  }

  private addRouteLayer() {
    if (!this.map.getSource("plan")) {
      this.map.addSource("plan", { type: "geojson", data: emptyFC() });
      this.map.addLayer({
        id: "plan-line",
        type: "line",
        source: "plan",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 6,
          "line-opacity": 0.9,
        },
      });
    }
  }

  private async plan() {
    const from = this.panel.querySelector<HTMLInputElement>("#pl-from")!.value.trim();
    const to = this.panel.querySelector<HTMLInputElement>("#pl-to")!.value.trim();
    const result = this.panel.querySelector<HTMLDivElement>("#pl-result")!;
    if (!from || !to) {
      result.innerHTML = `<div class="pl-err">Enter both a start and destination.</div>`;
      return;
    }
    result.innerHTML = `<div class="pl-loading">Planning…</div>`;
    try {
      const res = await fetch(
        `${this.serverHttp}/plan?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        result.innerHTML = `<div class="pl-err">${e.error ?? "No route found."}</div>`;
        this.clearHighlight();
        return;
      }
      const itin: Itinerary = await res.json();
      this.render(itin);
      this.highlight(itin);
    } catch {
      result.innerHTML = `<div class="pl-err">Request failed.</div>`;
    }
  }

  private render(itin: Itinerary) {
    const result = this.panel.querySelector<HTMLDivElement>("#pl-result")!;
    const legs = itin.legs
      .map((l) => {
        if (l.kind === "walk") {
          return `<div class="pl-leg"><span class="pl-walk">🚶</span>
            <span class="pl-leg-txt">Walk to ${l.toName} · ${mins(l.seconds)} min</span></div>`;
        }
        return `<div class="pl-leg">${bulletHtml(l.route!, l.color!)}
          <span class="pl-leg-txt"><b>${l.fromName}</b> → <b>${l.toName}</b>
          <br><span class="pl-sub">${l.numStops} stop${l.numStops > 1 ? "s" : ""} · ${mins(l.seconds)} min</span></span></div>`;
      })
      .join(`<div class="pl-arrow">↓</div>`);

    result.innerHTML = `
      <div class="pl-summary">
        <b>${mins(itin.seconds)} min</b> · ${itin.transfers} transfer${itin.transfers === 1 ? "" : "s"}
      </div>
      <div class="pl-legs">${legs}</div>`;
  }

  private highlight(itin: Itinerary) {
    const fc = emptyFC();
    for (const leg of itin.legs) {
      if (leg.kind !== "ride") continue;
      const coords = leg.stops
        .map((id) => this.stationCoords.get(id))
        .filter(Boolean) as [number, number][];
      if (coords.length < 2) continue;
      fc.features.push({
        type: "Feature",
        properties: { color: leg.color ?? "#000" },
        geometry: { type: "LineString", coordinates: coords },
      });
    }
    (this.map.getSource("plan") as maplibregl.GeoJSONSource | undefined)?.setData(fc);

    // Fit the map to the planned journey.
    const all = fc.features.flatMap((f) => (f.geometry as GeoJSON.LineString).coordinates);
    if (all.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of all as [number, number][]) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      this.map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 80, maxZoom: 14 });
    }
  }

  private clearHighlight() {
    (this.map.getSource("plan") as maplibregl.GeoJSONSource | undefined)?.setData(emptyFC());
  }
}
