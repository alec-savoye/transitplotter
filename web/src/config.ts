// Runtime config.
//
// Two deployment shapes are supported automatically:
//
//   1. LAN / direct dev (http): the page is served over plain http from a LAN
//      IP or localhost (e.g. http://192.168.0.137:5173). The backend is reached
//      at the same host on port 8090 (the docker-compose host mapping), so
//      phones/laptops hit the server rather than their own localhost.
//
//   2. Reverse-proxied HTTPS (e.g. https://train.alecsavoye.com): a proxy
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
