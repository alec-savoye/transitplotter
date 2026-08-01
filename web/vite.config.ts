import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true, // needed inside Docker
    port: 5173,
    // Allow the public hostname the dev server is reverse-proxied under.
    // (Vite blocks unknown Host headers by default.)
    allowedHosts: ["train.alecsavoye.com"],
  },
});
