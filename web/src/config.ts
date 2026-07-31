// Runtime config. Override via Vite env vars when merging into another host.
export const SERVER_HTTP =
  import.meta.env.VITE_SERVER_HTTP ?? "http://localhost:8080";
export const SERVER_WS =
  import.meta.env.VITE_SERVER_WS ?? "ws://localhost:8080";
