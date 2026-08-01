// Line-status strip + alerts drawer. Polls /status and /alerts and renders a
// compact per-service status bar; clicking it opens a drawer listing alerts.
// Also exposes which routes are disrupted so the map can dim/dash them.

import type { RouteStatus, ServiceAlert } from "@transitplotter/shared";
import { bulletLabel } from "./bullets.js";

const YELLOW = new Set(["#FCCC0A", "#F6BC26", "#FBBD08"]);
const textOn = (c: string) => (YELLOW.has(c.toUpperCase()) ? "#000" : "#fff");
const isExpress = (r: string) => r.endsWith("X");

const SEV_COLOR: Record<number, string> = {
  0: "#1a9c4b", // good
  1: "#e8a400", // info / planned
  2: "#e8730c", // delays / change
  3: "#c0392b", // suspended
};

export type DisruptedListener = (routesWithIssues: Set<string>) => void;

export class AlertsUI {
  private strip: HTMLDivElement;
  private drawer: HTMLDivElement;
  private timer: number | null = null;

  constructor(
    private serverHttp: string,
    private onDisrupted: DisruptedListener
  ) {
    this.strip = document.createElement("div");
    this.strip.id = "status-strip";
    this.strip.addEventListener("click", () => this.toggleDrawer());
    document.body.appendChild(this.strip);

    this.drawer = document.createElement("div");
    this.drawer.id = "alerts-drawer";
    this.drawer.style.display = "none";
    this.drawer.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("al-close")) this.toggleDrawer(false);
    });
    document.body.appendChild(this.drawer);
  }

  start() {
    this.refresh();
    this.timer = window.setInterval(() => this.refresh(), 60000);
  }

  private async refresh() {
    try {
      const [status, alerts] = await Promise.all([
        fetch(`${this.serverHttp}/status`).then((r) => r.json()) as Promise<RouteStatus[]>,
        fetch(`${this.serverHttp}/alerts`).then((r) => r.json()) as Promise<ServiceAlert[]>,
      ]);
      this.renderStrip(status);
      this.renderDrawer(alerts);

      const disrupted = new Set<string>();
      for (const s of status) if (s.severity >= 2) disrupted.add(s.route);
      this.onDisrupted(disrupted);
    } catch {
      /* transient; keep last render */
    }
  }

  private renderStrip(status: RouteStatus[]) {
    // The strip shows subway services only; buses (~305) would flood it and are
    // shown collapsed in the drawer instead.
    const subway = status.filter((s) => !s.route.startsWith("B:") && !s.route.startsWith("F:"));
    const issues = subway.filter((s) => s.severity > 0).length;
    const bullets = subway
      .map((s) => {
        const badge =
          s.severity > 0
            ? `<span class="ss-badge" style="background:${SEV_COLOR[s.severity]}"></span>`
            : "";
        return `<span class="ss-bullet" title="${s.route}: ${s.label}"
          style="background:${s.color};color:${textOn(s.color)}">${bulletLabel(s.route)}${badge}</span>`;
      })
      .join("");
    this.strip.innerHTML =
      `<span class="ss-title">Service ${issues ? `· ${issues} alert${issues > 1 ? "s" : ""}` : "· Good"}</span>` +
      `<span class="ss-bullets">${bullets}</span>`;
  }

  private alertItem(a: ServiceAlert): string {
    const chips = a.routes
      .filter((r) => !isExpress(r))
      .map((r) => {
        const label = bulletLabel(r).replace(/^B:/, "");
        return `<span class="al-chip" data-route="${r}">${label}</span>`;
      })
      .join("");
    return `
      <div class="al-item sev-${a.severity}">
        <div class="al-item-head">${chips}<span class="al-effect">${a.effect}</span></div>
        <div class="al-header">${a.header}</div>
      </div>`;
  }

  private renderDrawer(alerts: ServiceAlert[]) {
    const isBusAlert = (a: ServiceAlert) => a.routes.some((r) => r.startsWith("B:"));
    const subwayAlerts = alerts.filter((a) => !isBusAlert(a)).sort((a, b) => b.severity - a.severity);
    const busAlerts = alerts.filter(isBusAlert).sort((a, b) => b.severity - a.severity);

    const subwayItems = subwayAlerts.length
      ? subwayAlerts.map((a) => this.alertItem(a)).join("")
      : `<div class="al-empty">No active subway service alerts.</div>`;

    // Bus alerts collapsed into a native <details> dropdown.
    const busSection = `
      <details class="al-bus">
        <summary>Bus alerts (${busAlerts.length})</summary>
        ${
          busAlerts.length
            ? busAlerts.map((a) => this.alertItem(a)).join("")
            : `<div class="al-empty">No active bus service alerts.</div>`
        }
      </details>`;

    this.drawer.innerHTML =
      `<div class="al-head"><b>Service Alerts</b><span class="al-close">✕</span></div>` +
      subwayItems +
      busSection;
  }

  private toggleDrawer(show?: boolean) {
    const visible = this.drawer.style.display !== "none";
    const next = show ?? !visible;
    this.drawer.style.display = next ? "block" : "none";
  }
}
