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
    const issues = status.filter((s) => s.severity > 0).length;
    const bullets = status
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

  private renderDrawer(alerts: ServiceAlert[]) {
    const bySev = [...alerts].sort((a, b) => b.severity - a.severity);
    const items = bySev.length
      ? bySev
          .map((a) => {
            const chips = a.routes
              .filter((r) => !isExpress(r))
              .map(
                (r) =>
                  `<span class="al-chip" data-route="${r}">${bulletLabel(r)}</span>`
              )
              .join("");
            return `
              <div class="al-item sev-${a.severity}">
                <div class="al-item-head">${chips}<span class="al-effect">${a.effect}</span></div>
                <div class="al-header">${a.header}</div>
              </div>`;
          })
          .join("")
      : `<div class="al-empty">No active service alerts.</div>`;
    this.drawer.innerHTML =
      `<div class="al-head"><b>Service Alerts</b><span class="al-close">✕</span></div>` +
      items;
  }

  private toggleDrawer(show?: boolean) {
    const visible = this.drawer.style.display !== "none";
    const next = show ?? !visible;
    this.drawer.style.display = next ? "block" : "none";
  }
}
