// Central registry of external data-source health, for the admin panel.
//
// Every upstream fetch (subway GTFS-rt feeds, alerts, ferry, bus, traffic
// speeds, CRZ calibration) reports its outcome here: when we last polled, when
// we last succeeded, how fresh the returned data is, how many items came back,
// and the last error if any. Exposed at GET /admin/health.

export interface SourceHealth {
  /** Stable key. */
  key: string;
  /** Human label for the admin UI. */
  label: string;
  /** Logical group ("Subway", "Bus", "Ferry", "Alerts", "Traffic"). */
  group: string;
  /** The upstream endpoint (host shown in the UI; full string on hover). */
  url?: string;
  /** epoch ms when we last attempted a poll. */
  lastPollTs?: number;
  /** epoch ms when we last succeeded. */
  lastOkTs?: number;
  /** epoch ms freshness of the data itself (e.g. feed header timestamp). */
  lastDataTs?: number;
  /** True if the most recent poll succeeded. */
  ok: boolean;
  /** Item count from the last success (trips / vehicles / links / rows). */
  count?: number;
  /** Free-form extra detail for the last success. */
  info?: string;
  /** Last error message (kept even after a later success, for context). */
  lastError?: string;
  /** epoch ms of the last error. */
  lastErrorTs?: number;
}

class HealthRegistry {
  private map = new Map<string, SourceHealth>();
  private order: string[] = [];

  /** Declare a source up-front so it shows in the UI before its first poll. */
  register(key: string, label: string, group: string, url?: string) {
    if (!this.map.has(key)) {
      this.map.set(key, { key, label, group, url, ok: false });
      this.order.push(key);
    }
  }

  private get(key: string): SourceHealth {
    let s = this.map.get(key);
    if (!s) {
      s = { key, label: key, group: "Other", ok: false };
      this.map.set(key, s);
      this.order.push(key);
    }
    return s;
  }

  /** Mark the start of a poll attempt. */
  pollStart(key: string) {
    this.get(key).lastPollTs = Date.now();
  }

  /** Record a successful poll. */
  ok(
    key: string,
    detail?: { count?: number; dataTs?: number; info?: string },
  ) {
    const s = this.get(key);
    const now = Date.now();
    s.ok = true;
    s.lastOkTs = now;
    if (s.lastPollTs == null) s.lastPollTs = now;
    if (detail?.count != null) s.count = detail.count;
    if (detail?.dataTs != null) s.lastDataTs = detail.dataTs;
    if (detail?.info != null) s.info = detail.info;
  }

  /** Record a failed poll. */
  fail(key: string, error: unknown) {
    const s = this.get(key);
    const now = Date.now();
    s.ok = false;
    if (s.lastPollTs == null) s.lastPollTs = now;
    s.lastError = error instanceof Error ? error.message : String(error);
    s.lastErrorTs = now;
  }

  /** Snapshot for the admin endpoint, in registration order. */
  snapshot(): { now: number; sources: SourceHealth[] } {
    return {
      now: Date.now(),
      sources: this.order.map((k) => ({ ...this.map.get(k)! })),
    };
  }
}

/** Process-wide singleton. */
export const health = new HealthRegistry();
