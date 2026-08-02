// Hidden admin panel (visitor analytics + data-source health).
// Opened by quadruple-clicking anywhere on the map. Gated by a password; on
// success the server returns a key used to fetch /admin/stats.

import type maplibregl from "maplibre-gl";

interface DailyPoint {
  date: string;
  count: number;
}
interface Location {
  lat: number;
  lon: number;
  count: number;
  label: string;
}
interface Stats {
  total: number;
  daily: DailyPoint[];
  locations: Location[];
  uniqueIps: number;
  locatedIps: number;
}
interface SourceHealth {
  key: string;
  label: string;
  group: string;
  url?: string;
  lastPollTs?: number;
  lastOkTs?: number;
  lastDataTs?: number;
  ok: boolean;
  count?: number;
  info?: string;
  lastError?: string;
  lastErrorTs?: number;
}
interface HealthSnapshot {
  now: number;
  sources: SourceHealth[];
}

const SVGNS = "http://www.w3.org/2000/svg";

export function attachAdmin(map: maplibregl.Map, serverHttp: string) {
  const overlay = document.getElementById("admin-overlay");
  const gate = document.getElementById("admin-gate");
  const content = document.getElementById("admin-content");
  const form = document.getElementById("admin-auth-form") as HTMLFormElement | null;
  const pwInput = document.getElementById("admin-password") as HTMLInputElement | null;
  const errEl = document.getElementById("admin-auth-error");
  const closeBtn = document.getElementById("admin-close");
  if (!overlay || !gate || !content || !form || !pwInput) return;

  let adminKey = "";
  let healthTimer: number | null = null;

  const open = () => {
    overlay.classList.add("show");
    gate.style.display = adminKey ? "none" : "";
    content.classList.toggle("hidden", !adminKey);
    pwInput.value = "";
    if (adminKey) {
      loadStats();
      loadHealth();
      startHealthPolling();
    } else setTimeout(() => pwInput.focus(), 50);
  };
  const close = () => {
    overlay.classList.remove("show");
    stopHealthPolling();
  };

  // Refresh the data-source health while the panel is open (it changes every
  // poll ~20s; a 5s cadence keeps the "last poll/update" ages feeling live).
  function startHealthPolling() {
    stopHealthPolling();
    healthTimer = window.setInterval(loadHealth, 5000);
  }
  function stopHealthPolling() {
    if (healthTimer != null) {
      window.clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  closeBtn?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // Quadruple-click detection on the map canvas.
  let clicks = 0;
  let timer: number | null = null;
  map.on("click", () => {
    clicks++;
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => (clicks = 0), 500);
    if (clicks >= 4) {
      clicks = 0;
      if (timer != null) window.clearTimeout(timer);
      open();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (errEl) errEl.textContent = "";
    fetch(`${serverHttp}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwInput.value }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Auth failed");
        adminKey = d.key;
        gate.style.display = "none";
        content.classList.remove("hidden");
        loadStats();
        loadHealth();
        startHealthPolling();
      })
      .catch((err) => {
        if (errEl) errEl.textContent = err.message;
      });
  });

  function loadStats() {
    fetch(`${serverHttp}/admin/stats?key=${encodeURIComponent(adminKey)}`)
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data: Stats) => render(data))
      .catch((err) => {
        const t = document.getElementById("admin-total");
        if (t) t.textContent = "Error: " + err.message;
      });
  }

  function render(data: Stats) {
    const total = document.getElementById("admin-total");
    if (total) total.textContent = "Total visits: " + data.total;
    renderChart(data.daily);
    renderMap(data.locations || [], data.uniqueIps || 0, data.locatedIps || 0);
  }

  function loadHealth() {
    fetch(`${serverHttp}/admin/health?key=${encodeURIComponent(adminKey)}`)
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((snap: HealthSnapshot) => renderHealth(snap))
      .catch((err) => {
        const el = document.getElementById("admin-health");
        if (el) el.textContent = "Error loading status: " + err.message;
      });
  }

  function renderHealth(snap: HealthSnapshot) {
    const el = document.getElementById("admin-health");
    if (!el) return;
    el.innerHTML = "";
    const sources = snap.sources || [];
    if (sources.length === 0) {
      el.textContent = "No sources reporting yet.";
      return;
    }

    // Group by logical group, preserving first-seen order.
    const groups: string[] = [];
    const byGroup = new Map<string, SourceHealth[]>();
    for (const s of sources) {
      if (!byGroup.has(s.group)) {
        byGroup.set(s.group, []);
        groups.push(s.group);
      }
      byGroup.get(s.group)!.push(s);
    }

    for (const g of groups) {
      const gh = document.createElement("div");
      gh.className = "admin-health-group";
      gh.textContent = g;
      el.appendChild(gh);

      for (const s of byGroup.get(g)!) {
        const row = document.createElement("div");
        row.className = "admin-hs-row " + (s.ok ? "ok" : "bad");

        const host = s.url ? hostOf(s.url) : "";
        const parts: string[] = [];
        if (s.count != null) parts.push(`${s.count.toLocaleString()} items`);
        if (s.info) parts.push(s.info);
        const infoLine = parts.join(" · ");

        const errLine =
          !s.ok && s.lastError
            ? `<div class="admin-hs-err" title="${escapeHtml(s.lastError)}">⚠ ${escapeHtml(s.lastError)}${
                s.lastErrorTs ? " (" + ago(snap.now, s.lastErrorTs) + ")" : ""
              }</div>`
            : s.lastError
              ? `<div class="admin-hs-err" title="${escapeHtml(s.lastError)}">last error: ${escapeHtml(
                  s.lastError,
                )}${s.lastErrorTs ? " (" + ago(snap.now, s.lastErrorTs) + ")" : ""}</div>`
              : "";

        row.innerHTML =
          `<span class="admin-hs-dot"></span>` +
          `<span class="admin-hs-main">` +
          `<div class="admin-hs-label">${escapeHtml(s.label)}</div>` +
          (host ? `<div class="admin-hs-url" title="${escapeHtml(s.url!)}">${escapeHtml(host)}</div>` : "") +
          (infoLine ? `<div class="admin-hs-info">${escapeHtml(infoLine)}</div>` : "") +
          errLine +
          `</span>` +
          `<span class="admin-hs-times">` +
          `poll: <b>${s.lastPollTs ? ago(snap.now, s.lastPollTs) : "—"}</b><br/>` +
          `data: <b>${s.lastDataTs ? ago(snap.now, s.lastDataTs) : "—"}</b>` +
          `</span>`;
        el.appendChild(row);
      }
    }
  }

  function renderChart(daily: DailyPoint[]) {
    const chart = document.getElementById("admin-chart");
    if (!chart) return;
    chart.innerHTML = "";
    if (!daily || daily.length === 0) {
      chart.textContent = "No data yet";
      return;
    }
    const max = daily.reduce((m, d) => Math.max(m, d.count), 0) || 1;
    const n = daily.length;
    const labelStep = Math.ceil(n / 20);
    const showValues = n <= 31;

    const bars = document.createElement("div");
    bars.className = "admin-chart-bars";
    daily.forEach((d, i) => {
      const col = document.createElement("div");
      col.className = "admin-chart-col";
      // Percentage of the FIXED-height track, so bars scale linearly against
      // the max regardless of the label heights around them.
      const pct = (d.count / max) * 100;
      const showLabel = i % labelStep === 0 || i === n - 1;
      const label = d.date.slice(5);
      col.innerHTML =
        (showValues ? '<span class="admin-chart-value">' + (d.count || "") + "</span>" : "") +
        '<span class="admin-chart-track"><span class="admin-chart-bar" style="height:' +
        pct.toFixed(1) +
        '%"></span></span>' +
        '<span class="admin-chart-date">' + (showLabel ? label : "") + "</span>";
      col.title = d.date + ": " + d.count + " visits";
      bars.appendChild(col);
    });
    chart.appendChild(bars);
  }

  function renderMap(locations: Location[], uniqueIps: number, locatedIps: number) {
    const ipTotal = document.getElementById("admin-ip-total");
    const svg = document.getElementById("admin-map-svg");
    const list = document.getElementById("admin-locations");
    if (ipTotal) ipTotal.textContent = "Unique visitors: " + uniqueIps + " (" + locatedIps + " located)";
    if (!svg || !list) return;
    svg.innerHTML = "";
    list.innerHTML = "";
    if (!locations || locations.length === 0) {
      list.textContent = "No located visits yet";
      return;
    }
    let max = 1;
    locations.forEach((l) => (max = Math.max(max, l.count)));

    locations.forEach((l) => {
      const x = ((l.lon + 180) / 360) * 720;
      const y = ((90 - l.lat) / 180) * 360;
      const r = 3 + Math.sqrt(l.count / max) * 12;
      const circle = document.createElementNS(SVGNS, "circle");
      circle.setAttribute("cx", String(x));
      circle.setAttribute("cy", String(y));
      circle.setAttribute("r", String(r));
      circle.setAttribute("class", "admin-map-dot");
      const title = document.createElementNS(SVGNS, "title");
      title.textContent = l.label + ": " + l.count;
      circle.appendChild(title);
      svg.appendChild(circle);

      const text = document.createElementNS(SVGNS, "text");
      text.setAttribute("x", String(x));
      text.setAttribute("y", String(y + 0.5));
      text.setAttribute("class", "admin-map-num");
      text.textContent = String(l.count);
      svg.appendChild(text);
    });

    locations.forEach((l) => {
      const row = document.createElement("div");
      row.className = "admin-stat-row";
      const pct = (l.count / max) * 100;
      row.innerHTML =
        '<span class="admin-stat-label">' + l.label + "</span>" +
        '<span class="admin-stat-bar"><span class="admin-stat-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="admin-stat-count">' + l.count + "</span>";
      list.appendChild(row);
    });
  }
}

/** "12s ago", "3m ago", "2h ago" from two epoch-ms timestamps. */
function ago(now: number, then: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Host (+ short path) of a URL for compact display. */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
