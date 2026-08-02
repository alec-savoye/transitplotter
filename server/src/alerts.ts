// Fetch + decode the MTA GTFS-realtime Service Alerts feed, filter to subway,
// and roll up per-route status for the line-status strip.

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { ServiceAlert, RouteStatus } from "@transitplotter/shared";
import type { StaticData } from "./static/load.js";
import { ALERTS_URL } from "./feeds.js";
import { health } from "./health.js";

const { transit_realtime } = GtfsRealtimeBindings;

health.register("alerts", "Service Alerts", "Alerts", ALERTS_URL);

const baseStop = (id: string) => (id.endsWith("N") || id.endsWith("S") ? id.slice(0, -1) : id);

/**
 * The MTA subway alerts feed reports every alert with effect=UNKNOWN and puts
 * the real category in the (undecoded) Mercury extension. So we classify from
 * the headline text, which reliably contains phrases like "delays",
 * "suspended", "no [L]", "planned work", etc.
 */
function classify(header: string): { severity: 1 | 2 | 3; label: string } {
  const h = header.toLowerCase();

  // Severe: suspension / no service on part of a line.
  if (/\bsuspend/.test(h) || /\bno \[/.test(h) || /\bno service\b/.test(h)) {
    return { severity: 3, label: "Suspended" };
  }
  // Delays.
  if (/\bdelay/.test(h)) {
    return { severity: 2, label: "Delays" };
  }
  // Planned / scheduled work — lower urgency even if it changes service.
  if (/\bplanned\b/.test(h) || /\bweekend\b/.test(h) || /\bovernight\b/.test(h) || /\bwork\b/.test(h)) {
    return { severity: 1, label: "Planned Work" };
  }
  // Reroutes / skip-stop / express-local changes.
  if (/reroute|skip|express|local|bypass|not stopping|board (?:the )?/.test(h)) {
    return { severity: 2, label: "Service Change" };
  }
  return { severity: 1, label: "Info" };
}

const text = (t: any): string => t?.translation?.[0]?.text ?? "";

/** Fetch and parse the subway service alerts. */
export async function fetchAlerts(): Promise<ServiceAlert[]> {
  health.pollStart("alerts");
  const res = await fetch(ALERTS_URL);
  if (!res.ok) {
    console.warn(`alerts feed -> ${res.status}`);
    health.fail("alerts", `HTTP ${res.status}`);
    return [];
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const msg = transit_realtime.FeedMessage.decode(buf);
  const nowSec = Math.floor(Date.now() / 1000);
  const headerTs = Number(msg.header?.timestamp ?? nowSec);

  const out: ServiceAlert[] = [];
  for (const entity of msg.entity) {
    const a = entity.alert;
    if (!a) continue;
    const ies = a.informedEntity ?? [];

    // Subway only.
    if (!ies.some((e) => e.agencyId === "MTASBWY")) continue;

    // Only currently-active alerts (if an active period is provided).
    const periods = a.activePeriod ?? [];
    if (periods.length > 0) {
      const active = periods.some((p) => {
        const start = p.start != null ? Number(p.start) : -Infinity;
        const end = p.end != null ? Number(p.end) : Infinity;
        return nowSec >= start && nowSec <= end;
      });
      if (!active) continue;
    }

    const routes = [...new Set(ies.map((e) => e.routeId).filter(Boolean) as string[])];
    const stops = [
      ...new Set(ies.map((e) => e.stopId).filter(Boolean).map((s) => baseStop(s as string))),
    ];
    if (routes.length === 0 && stops.length === 0) continue;

    const header = text(a.headerText);
    const { severity, label } = classify(header);
    out.push({
      id: entity.id || `${routes.join(",")}:${header.slice(0, 24)}`,
      routes,
      stops,
      header,
      description: text(a.descriptionText),
      severity,
      effect: label,
    });
  }
  health.ok("alerts", {
    count: out.length,
    dataTs: headerTs * 1000,
    info: `${msg.entity.length} raw, ${out.length} active subway`,
  });
  return out;
}

/** Roll active alerts up into a per-route worst-severity status list. */
export function rollUpStatus(alerts: ServiceAlert[], stat: StaticData): RouteStatus[] {
  const worst = new Map<string, { severity: 0 | 1 | 2 | 3; label: string }>();

  // Seed every known base (non-express) route as good service.
  for (const [id, meta] of stat.routes) {
    if (id.endsWith("X")) continue;
    worst.set(id, { severity: 0, label: "Good Service" });
  }

  for (const al of alerts) {
    for (const r of al.routes) {
      const base = r.endsWith("X") ? r.slice(0, -1) : r;
      const cur = worst.get(base) ?? { severity: 0, label: "Good Service" };
      if (al.severity > cur.severity) {
        worst.set(base, { severity: al.severity, label: al.effect });
      }
    }
  }

  const list: RouteStatus[] = [];
  for (const [route, s] of worst) {
    list.push({
      route,
      color: stat.routes.get(route)?.color ?? "#666666",
      severity: s.severity,
      label: s.label,
    });
  }
  // Most severe first, then alphabetical.
  list.sort((a, b) => b.severity - a.severity || a.route.localeCompare(b.route));
  return list;
}
