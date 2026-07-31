// Click-a-station arrivals board. Fetches /station/:id/arrivals and renders a
// side panel with per-direction countdown clocks, refreshing while open.

import type maplibregl from "maplibre-gl";
import type { StationArrivals, Arrival, ServiceAlert } from "@transitplotter/shared";
import { bulletLabel } from "./bullets.js";

const YELLOW = new Set(["#FCCC0A", "#F6BC26", "#FBBD08"]);
const textOn = (c: string) => (YELLOW.has(c.toUpperCase()) ? "#000" : "#fff");

function bulletHtml(route: string, color: string, express: boolean): string {
  const cls = express ? "st-bullet exp" : "st-bullet";
  const label = bulletLabel(route);
  const inner = express ? `<span>${label}</span>` : label;
  return `<span class="${cls}" style="background:${color};color:${textOn(color)}">${inner}</span>`;
}

function countdown(inSec: number): string {
  if (inSec < 30) return "now";
  const m = Math.round(inSec / 60);
  return m <= 1 ? "1 min" : `${m} min`;
}

function rowHtml(a: Arrival): string {
  return `
    <div class="st-row">
      ${bulletHtml(a.route, a.color, a.express)}
      <span class="st-dest">${a.dest || "—"}${a.express ? ' <em class="st-exp">express</em>' : ""}</span>
      <span class="st-eta">${countdown(a.inSec)}</span>
    </div>`;
}

function dirHtml(title: string, arrivals: Arrival[]): string {
  const rows = arrivals.length
    ? arrivals.map(rowHtml).join("")
    : `<div class="st-empty">No trains predicted</div>`;
  return `<div class="st-dir"><h4>${title}</h4>${rows}</div>`;
}

function alertsHtml(alerts: ServiceAlert[]): string {
  if (!alerts.length) return "";
  const items = alerts
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 6)
    .map(
      (a) =>
        `<div class="st-alert sev-${a.severity}"><b>${a.effect}</b> ${a.header}</div>`
    )
    .join("");
  return `<div class="st-alerts"><h4>Service Alerts</h4>${items}</div>`;
}

export class StationPanel {
  private el: HTMLDivElement;
  private timer: number | null = null;
  private currentId: string | null = null;

  constructor(private serverHttp: string) {
    this.el = document.createElement("div");
    this.el.id = "station-panel";
    this.el.style.display = "none";
    this.el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("st-close")) this.close();
    });
    document.body.appendChild(this.el);
  }

  /** Wire station-pin + dot clicks to open the panel. */
  attach(map: maplibregl.Map) {
    const open = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string>;
      if (p.id) this.show(p.id, p.name);
    };
    for (const layer of ["station-pins", "stations"]) {
      map.on("click", layer, open);
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }
  }

  private async show(id: string, name: string) {
    this.currentId = id;
    this.el.style.display = "block";
    this.el.innerHTML = `<div class="st-head"><b>${name}</b><span class="st-close">✕</span></div><div class="st-loading">Loading…</div>`;
    await this.refresh();
    if (this.timer) clearInterval(this.timer);
    this.timer = window.setInterval(() => this.refresh(), 15000);
  }

  private async refresh() {
    if (!this.currentId) return;
    try {
      const data: StationArrivals = await (
        await fetch(`${this.serverHttp}/station/${encodeURIComponent(this.currentId)}/arrivals`)
      ).json();
      this.el.innerHTML =
        `<div class="st-head"><b>${data.name}</b><span class="st-close">✕</span></div>` +
        alertsHtml(data.alerts ?? []) +
        dirHtml("Uptown / North", data.north) +
        dirHtml("Downtown / South", data.south);
    } catch {
      this.el.innerHTML =
        `<div class="st-head"><b>Station</b><span class="st-close">✕</span></div>` +
        `<div class="st-empty">Could not load arrivals</div>`;
    }
  }

  private close() {
    this.el.style.display = "none";
    this.currentId = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
