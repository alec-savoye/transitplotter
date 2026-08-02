// "Isolate" feature. Click the Isolate control to pick a single subway or ferry
// line from a scrollable menu; the map then shows only that line, its stations,
// and its live vehicles. A small dialog reports how many vehicles are running,
// their split by direction (destination), and any delays. Exit with the
// "Exit Isolate" button (or Escape).
//
// Buses and cars are intentionally excluded from the picker — too noisy.

import type maplibregl from "maplibre-gl";
import type { RouteMeta } from "@transitplotter/shared";
import { setIsolatedRoute, clearIsolate } from "./basemap.js";
import type { TrainLayer } from "./trains.js";

/** Delay (seconds) at/above which a vehicle counts as "delayed". */
const LATE_THRESHOLD_S = 120;

interface IsoRoute {
  id: string;
  label: string; // short bullet label ("6", "AS")
  name: string; // long name
  color: string;
  mode: "subway" | "ferry";
}

export function setupIsolate(
  map: maplibregl.Map,
  routes: RouteMeta[],
  trainLayer: TrainLayer,
) {
  const btn = document.getElementById("isolate-toggle");
  const picker = document.getElementById("isolate-picker");
  const listEl = picker?.querySelector<HTMLElement>(".iso-list");
  const pickerClose = picker?.querySelector<HTMLButtonElement>(".iso-picker-close");
  const dialog = document.getElementById("isolate-dialog");
  const exitBtn = dialog?.querySelector<HTMLButtonElement>(".iso-exit");
  if (!btn || !picker || !listEl || !dialog) return;

  const isoRoutes = buildIsoRoutes(routes);

  let active: IsoRoute | null = null;
  let statsTimer: number | null = null;

  // --- Picker menu ---
  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = "";
    let group = "";
    for (const r of isoRoutes) {
      const g = r.mode === "subway" ? "Subway lines" : "Ferry routes";
      if (g !== group) {
        group = g;
        const h = document.createElement("div");
        h.className = "iso-group";
        h.textContent = g;
        listEl.appendChild(h);
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "iso-row";
      row.innerHTML =
        `<span class="iso-bullet" style="background:${r.color}">${escapeHtml(r.label)}</span>` +
        `<span class="iso-name">${escapeHtml(r.name)}</span>`;
      row.addEventListener("click", () => {
        closePicker();
        isolate(r);
      });
      listEl.appendChild(row);
    }
  }

  const openPicker = () => {
    renderList();
    picker.classList.add("show");
  };
  const closePicker = () => picker.classList.remove("show");

  btn.addEventListener("click", () => {
    if (active) exit();
    else openPicker();
  });
  pickerClose?.addEventListener("click", closePicker);
  picker.addEventListener("click", (e) => {
    if (e.target === picker) closePicker();
  });

  // --- Isolate a route ---
  function isolate(r: IsoRoute) {
    active = r;
    setIsolatedRoute(map, r.id, r.mode);
    btn!.classList.add("active");
    btn!.textContent = "Exit Isolate";
    dialog!.classList.add("show");
    updateStats();
    // Refresh the stats box on the same cadence as the vehicle animation feed.
    if (statsTimer != null) window.clearInterval(statsTimer);
    statsTimer = window.setInterval(updateStats, 2000);
    fitToRoute(r);
  }

  function exit() {
    if (statsTimer != null) {
      window.clearInterval(statsTimer);
      statsTimer = null;
    }
    clearIsolate(map);
    dialog!.classList.remove("show");
    btn!.classList.remove("active");
    btn!.textContent = "Isolate";
    active = null;
  }

  exitBtn?.addEventListener("click", exit);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (picker.classList.contains("show")) closePicker();
    else if (active) exit();
  });

  // --- Live stats dialog ---
  function updateStats() {
    if (!active) return;
    const trains = trainLayer.trainsOnRoute(active.id);
    const total = trains.length;
    const delayed = trains.filter(
      (t) => t.dly >= LATE_THRESHOLD_S || t.status === "stalled",
    );

    const noun = active.mode === "ferry" ? "boats" : "trains";

    // Compact per-vehicle table: direction (destination) · next stop. Delayed
    // rows are highlighted red. Sorted by direction so the two directions cluster.
    const rows = [...trains].sort(
      (a, b) => (a.dest || "").localeCompare(b.dest || "") || (a.ns || "").localeCompare(b.ns || ""),
    );
    const tableRows = rows
      .map((t) => {
        const late = t.dly >= LATE_THRESHOLD_S || t.status === "stalled";
        return (
          `<tr${late ? ' class="late"' : ""}>` +
          `<td class="iso-t-dir" title="${escapeHtml(t.dest || "Unknown")}">${escapeHtml(t.dest || "—")}</td>` +
          `<td class="iso-t-ns" title="${escapeHtml(t.ns || "")}">${escapeHtml(t.ns || "—")}</td>` +
          `</tr>`
        );
      })
      .join("");

    const table =
      total > 0
        ? `<table class="iso-table"><thead><tr><th>Dir</th><th>Next</th></tr></thead>` +
          `<tbody>${tableRows}</tbody></table>`
        : `<div class="iso-none">No ${noun} currently running.</div>`;

    const delayLine =
      delayed.length > 0
        ? `<div class="iso-delay bad">⚠ ${delayed.length} delayed</div>`
        : total > 0
          ? `<div class="iso-delay ok">✓ No delays reported</div>`
          : "";

    dialog!.querySelector(".iso-body")!.innerHTML =
      `<div class="iso-head">` +
      `<span class="iso-bullet lg" style="background:${active.color}">${escapeHtml(active.label)}</span>` +
      `<span class="iso-title">${escapeHtml(active.name)}</span>` +
      `</div>` +
      `<div class="iso-total"><b>${total}</b> ${noun} running</div>` +
      delayLine +
      `<div class="iso-table-wrap">${table}</div>`;
  }

  /** Zoom/pan so the isolated route line fills the view. */
  function fitToRoute(r: IsoRoute) {
    // Bound the route from its rendered line features in the "routes" source.
    const feats = map.querySourceFeatures("routes", {
      filter:
        r.mode === "ferry"
          ? (["all", ["==", ["get", "mode"], "ferry"], ["==", ["get", "route"], r.id]] as unknown as maplibregl.FilterSpecification)
          : (["==", ["get", "route"], r.id] as unknown as maplibregl.FilterSpecification),
    });
    let minLng = Infinity,
      minLat = Infinity,
      maxLng = -Infinity,
      maxLat = -Infinity;
    const visit = (coords: GeoJSON.Position[]) => {
      for (const [lng, lat] of coords) {
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
    };
    for (const f of feats) {
      const g = f.geometry;
      if (g.type === "LineString") visit(g.coordinates);
      else if (g.type === "MultiLineString") g.coordinates.forEach(visit);
    }
    if (minLng !== Infinity) {
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 60, duration: 700, maxZoom: 14 },
      );
    }
  }
}

/** Build the subway + ferry route list for the picker (deduped, sorted). */
function buildIsoRoutes(routes: RouteMeta[]): IsoRoute[] {
  const subway: IsoRoute[] = [];
  const ferry: IsoRoute[] = [];
  const seen = new Set<string>();
  for (const r of routes) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.id.startsWith("B:")) continue; // buses excluded
    if (r.id.startsWith("F:")) {
      ferry.push({
        id: r.id,
        label: r.id.replace(/^F:/, ""),
        name: r.name,
        color: r.color,
        mode: "ferry",
      });
    } else {
      subway.push({
        id: r.id,
        label: r.id,
        name: r.name,
        color: r.color,
        mode: "subway",
      });
    }
  }
  subway.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  ferry.sort((a, b) => a.name.localeCompare(b.name));
  return [...subway, ...ferry];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
