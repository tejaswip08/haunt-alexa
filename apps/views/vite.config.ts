import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Each view is a single self-contained HTML file, served by the MCP server as a ui:// resource.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: { input: "scene.html" },
  },
});
