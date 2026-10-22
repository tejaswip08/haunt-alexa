import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = `http://localhost:${process.env.HAUNT_PORT ?? 3001}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Reachable from the Android emulator (10.0.2.2) and a Fire TV on your network
    host: true,
    proxy: {
      "/mcp": api,
      // Keep the browser's Host header so the server's same-origin check on /api/transcribe
      // sees the page's own origin (localhost:5173), as it would in production.
      "/api": { target: api, changeOrigin: false },
      "/skills": api,
    },
  },
});
