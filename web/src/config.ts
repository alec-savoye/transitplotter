// Runtime config.
//
// Two deployment shapes are supported automatically:
//
//   1. LAN / direct dev (http): the page is served over plain http from a LAN
//      IP or localhost (e.g. http://<lan-ip>:5173). The backend is reached at
//      the same host on port 8090 (the docker-compose host mapping), so
//      phones/laptops hit the server rather than their own localhost.
//
//   2. Reverse-proxied HTTPS (e.g. https://your-domain.example): a proxy
//      (Caddy/nginx) terminates TLS and routes the API + WebSocket under the
//      same origin. Talking to :8090 here would be mixed-content (blocked) or
//      hang, so we instead use the page's own origin and let the proxy forward
//      `/api/*` (HTTP) and `/ws` (WebSocket upgrade) to the backend.
//
// Either can be overridden explicitly via Vite env vars.

const BACKEND_PORT = 8090;

/** True when the page itself was served over TLS (https/wss required). */
const isHttps = window.location.protocol === "https:";

function deriveHttp(): string {
  // Proxied HTTPS: same-origin, API under /api (proxy strips the prefix).
  if (isHttps) return `${window.location.origin}/api`;
  const host = window.location.hostname || "localhost";
  return `http://${host}:${BACKEND_PORT}`;
}
function deriveWs(): string {
  // Proxied HTTPS: same-origin wss under /ws.
  if (isHttps) return `wss://${window.location.host}/ws`;
  const host = window.location.hostname || "localhost";
  return `ws://${host}:${BACKEND_PORT}`;
}

export const SERVER_HTTP = import.meta.env.VITE_SERVER_HTTP ?? deriveHttp();
export const SERVER_WS = import.meta.env.VITE_SERVER_WS ?? deriveWs();

// ---------------------------------------------------------------------------
// View mode (mobile vs desktop) — single source of truth.
//
// "auto" detects touch/small screens and applies the mobile perf profile
// (lower FPS cap, capped pixelRatio, flat map, compact controls). Users can
// force "mobile" or "desktop" from the View toggle; the choice is persisted and
// a full reload re-applies pixelRatio/pitch/FPS cleanly.
// ---------------------------------------------------------------------------

export type ViewMode = "auto" | "mobile" | "desktop";

const VIEW_KEY = "tp-view";

function readViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "mobile" || v === "desktop" || v === "auto") return v;
  } catch {
    /* localStorage unavailable (private mode etc.) */
  }
  return "auto";
}

/** UA/media auto-detection of a mobile-class device. */
const autoMobile =
  typeof navigator !== "undefined" &&
  (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches));

/** The user's explicit setting (or "auto"). */
export const VIEW_MODE: ViewMode = readViewMode();

/** Effective mobile flag after applying any forced override. */
export const IS_MOBILE: boolean =
  VIEW_MODE === "mobile" ? true : VIEW_MODE === "desktop" ? false : autoMobile;

// Tag <html> so CSS can force the compact layout regardless of screen size.
if (typeof document !== "undefined") {
  const el = document.documentElement;
  el.classList.toggle("tp-force-mobile", VIEW_MODE === "mobile");
  el.classList.toggle("tp-force-desktop", VIEW_MODE === "desktop");
}

/** Advance auto → mobile → desktop → auto, persist, and reload to re-apply. */
export function cycleViewMode(): void {
  const next: ViewMode =
    VIEW_MODE === "auto" ? "mobile" : VIEW_MODE === "mobile" ? "desktop" : "auto";
  try {
    localStorage.setItem(VIEW_KEY, next);
  } catch {
    /* ignore */
  }
  location.reload();
}
