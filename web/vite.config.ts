import { defineConfig } from "vite";

// Comma-separated public hostnames the dev server is reverse-proxied under.
// Unset -> allow all hosts (safe when only your proxy reaches the dev port).
// Vite blocks unknown Host headers by default, which otherwise 403s a proxied
// public domain.
const hosts = process.env.VITE_ALLOWED_HOSTS
  ?.split(",")
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  server: {
    host: true, // needed inside Docker
    port: 5173,
    allowedHosts: hosts && hosts.length ? hosts : true,
  },
});
