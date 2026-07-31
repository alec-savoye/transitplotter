// Runtime config.
//
// For LAN testing we default to deriving the backend host from whatever
// hostname the page was loaded from (e.g. 192.168.0.137), so phones/laptops on
// the network reach the server rather than their own localhost. The backend is
// on port 8090 (host mapping). Override explicitly via Vite env vars when
// merging into another host.

const BACKEND_PORT = 8090;

function deriveHttp(): string {
  const host = window.location.hostname || "localhost";
  return `http://${host}:${BACKEND_PORT}`;
}
function deriveWs(): string {
  const host = window.location.hostname || "localhost";
  return `ws://${host}:${BACKEND_PORT}`;
}

export const SERVER_HTTP = import.meta.env.VITE_SERVER_HTTP ?? deriveHttp();
export const SERVER_WS = import.meta.env.VITE_SERVER_WS ?? deriveWs();
