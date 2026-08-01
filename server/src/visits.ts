// Visitor analytics: total visits, per-day counts, and unique visitor IPs with
// a coarse geo lookup. Ported from the asphoto admin analytics. Persisted as a
// lightweight JSON in the off-boot cache dir (same convention as track records).
//
// Privacy/robustness notes:
//   - Private/LAN IPs are ignored (they're just us / the reverse proxy).
//   - Each unique public IP is geolocated once (best-effort, via ip-api.com),
//     then cached; we never re-query or store per-request history per IP.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import http from "node:http";

interface IpEntry {
  ts: string; // ISO timestamp first seen
  city: string;
  region: string;
  country: string;
  lat: number | null;
  lon: number | null;
}

interface VisitData {
  total: number;
  /** date "YYYY-MM-DD" -> count */
  daily: Record<string, number>;
  /** ip -> geo entry (one per unique public IP) */
  ips: Record<string, IpEntry>;
}

/** A geo cluster of visitor IPs for the admin map. */
export interface VisitLocation {
  lat: number;
  lon: number;
  count: number;
  label: string;
}

export interface VisitStats {
  total: number;
  daily: { date: string; count: number }[];
  locations: VisitLocation[];
  uniqueIps: number;
  locatedIps: number;
}

/** True for loopback / LAN / reverse-proxy addresses we don't want to count. */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  ip = ip.replace(/^::ffff:/, "");
  if (ip === "::1" || ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168."))
    return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) {
    const second = parseInt(m[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  return false;
}

function geoLookup(ip: string): Promise<Omit<IpEntry, "ts"> | null> {
  return new Promise((resolve) => {
    let done = false;
    const req = http.get(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,lat,lon`,
      (r) => {
        let body = "";
        r.on("data", (d) => (body += d));
        r.on("end", () => {
          if (done) return;
          done = true;
          try {
            const data = JSON.parse(body);
            if (data.status === "success") {
              resolve({
                city: data.city || "",
                region: data.regionName || "",
                country: data.country || "",
                lat: data.lat,
                lon: data.lon,
              });
            } else resolve(null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.setTimeout(5000, () => {
      if (!done) {
        done = true;
        req.destroy();
        resolve(null);
      }
    });
    req.on("error", () => {
      if (!done) {
        done = true;
        resolve(null);
      }
    });
  });
}

export class VisitStore {
  private data: VisitData = { total: 0, daily: {}, ips: {} };
  private dirty = false;
  private readonly path: string;

  constructor(cacheDir: string) {
    this.path = join(cacheDir, "visits.json");
    this.load();
    setInterval(() => this.flush(), 10_000);
  }

  /** Record a page visit (total + per-day) and the visitor IP (deduped). */
  record(ip: string) {
    this.data.total += 1;
    const day = new Date().toISOString().slice(0, 10);
    this.data.daily[day] = (this.data.daily[day] || 0) + 1;
    this.dirty = true;
    this.recordIp(ip);
  }

  private recordIp(ip: string) {
    if (isPrivateIp(ip)) return;
    ip = ip.replace(/^::ffff:/, "");
    if (this.data.ips[ip]) return; // already known
    this.data.ips[ip] = { ts: new Date().toISOString(), city: "", region: "", country: "", lat: null, lon: null };
    this.dirty = true;
    geoLookup(ip).then((geo) => {
      if (geo && this.data.ips[ip]) {
        this.data.ips[ip] = { ts: this.data.ips[ip].ts, ...geo };
        this.dirty = true;
      }
    });
  }

  /** Build the admin stats payload (totals, daily series, geo clusters). */
  stats(): VisitStats {
    const daily = this.data.daily;
    const days = Object.keys(daily).sort();
    const series: { date: string; count: number }[] = [];
    if (days.length > 0) {
      const start = new Date(days[0] + "T00:00:00Z");
      const end = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
      for (const d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const key = d.toISOString().slice(0, 10);
        series.push({ date: key, count: daily[key] || 0 });
      }
    }

    const ips = this.data.ips;
    const ipKeys = Object.keys(ips);
    let located = 0;
    const clusters: Record<string, { latSum: number; lonSum: number; count: number; label: string }> = {};
    for (const ip of ipKeys) {
      const e = ips[ip];
      if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
      located++;
      const key = Math.round(e.lat) + "," + Math.round(e.lon);
      if (!clusters[key]) clusters[key] = { latSum: 0, lonSum: 0, count: 0, label: "" };
      const c = clusters[key];
      c.latSum += e.lat;
      c.lonSum += e.lon;
      c.count += 1;
      if (!c.label) c.label = [e.city, e.country].filter(Boolean).join(", ") || "Unknown";
    }
    const locations: VisitLocation[] = Object.keys(clusters).map((k) => {
      const c = clusters[k];
      return { lat: c.latSum / c.count, lon: c.lonSum / c.count, count: c.count, label: c.label };
    });
    locations.sort((a, b) => b.count - a.count);

    return {
      total: this.data.total,
      daily: series,
      locations,
      uniqueIps: ipKeys.length,
      locatedIps: located,
    };
  }

  private load() {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<VisitData>;
      this.data = {
        total: typeof raw.total === "number" ? raw.total : 0,
        daily: raw.daily ?? {},
        ips: raw.ips ?? {},
      };
      console.log(`visits: loaded ${this.data.total} visits, ${Object.keys(this.data.ips).length} unique IPs`);
    } catch (e) {
      console.warn("visits: could not load, starting fresh", e);
    }
  }

  flush(force = false) {
    if (!this.dirty && !force) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data));
      this.dirty = false;
    } catch (e) {
      console.error("visits: flush failed", e);
    }
  }
}

/**
 * Extract the client IP from a request, honoring X-Forwarded-For (the app runs
 * behind a Caddy reverse proxy, so req.socket.remoteAddress is the proxy).
 */
export function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = (Array.isArray(xff) ? xff[0] : xff).split(",")[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? "";
}
