import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const api = `http://localhost:${process.env.HAUNT_PORT ?? 3001}`;

// HAUNT_BACKEND=live (npm run dev:live): the local web app talks to the deployed AWS backend instead of a local server,
// the same way the Vercel site does. Sign-in is the real Cognito email code, and the stories are the real ones.
// The backend only answers Haunt's own sites, so requests go out with the deployed site's origin.
const LIVE_API = process.env.HAUNT_LIVE_API ?? "https://itok3jbqel.execute-api.us-east-1.amazonaws.com";
const LIVE_ORIGIN = process.env.HAUNT_LIVE_ORIGIN ?? "https://haunt-firetv.vercel.app";
const live = process.env.HAUNT_BACKEND === "live";
const toLive: ProxyOptions = { target: LIVE_API, changeOrigin: true, secure: true, headers: { origin: LIVE_ORIGIN } };

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Reachable from the Android emulator (10.0.2.2) and a Fire TV on your network
    host: true,
    proxy: live
      ? { "/mcp": toLive, "/api": toLive, "/activate": toLive }
      : {
          "/mcp": api,
          // Keep the browser's Host header so the server's same-origin check on /api/transcribe
          // sees the page's own origin (localhost:5173), as it would in production.
          "/api": { target: api, changeOrigin: false },
          "/skills": api,
          // The phone page for QR sign-in ("scan with your phone"), served by the Haunt server.
          "/activate": { target: api, changeOrigin: false },
        },
  },
});
