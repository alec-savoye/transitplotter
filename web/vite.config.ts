import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true, // needed inside Docker
    port: 5173,
  },
});
