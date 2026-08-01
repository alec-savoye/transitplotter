// Hidden admin panel (visitor analytics), ported from the asphoto admin page.
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

  const open = () => {
    overlay.classList.add("show");
    gate.style.display = adminKey ? "none" : "";
    content.classList.toggle("hidden", !adminKey);
    pwInput.value = "";
    if (adminKey) loadStats();
    else setTimeout(() => pwInput.focus(), 50);
  };
  const close = () => overlay.classList.remove("show");

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

  function renderChart(daily: DailyPoint[]) {
    const chart = document.getElementById("admin-chart");
    if (!chart) return;
    chart.innerHTML = "";
    if (!daily || daily.length === 0) {
      chart.textContent = "No data yet";
      return;
    }
    let max = 1;
    daily.forEach((d) => (max = Math.max(max, d.count)));
    const n = daily.length;
    const labelStep = Math.ceil(n / 20);
    const showValues = n <= 31;

    const bars = document.createElement("div");
    bars.className = "admin-chart-bars";
    daily.forEach((d, i) => {
      const col = document.createElement("div");
      col.className = "admin-chart-col";
      const pct = (d.count / max) * 100;
      const showLabel = i % labelStep === 0 || i === n - 1;
      const label = d.date.slice(5);
      col.innerHTML =
        (showValues ? '<span class="admin-chart-value">' + (d.count || "") + "</span>" : "") +
        '<span class="admin-chart-bar" style="height:' + pct + '%"></span>' +
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
