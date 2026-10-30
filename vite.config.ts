import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The frontend lives in web/ and is built to dist/web, which the server serves.
// In development (`npm run dev`) Vite proxies /api to the server on :8686.
export default defineConfig({
  root: "web",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "web/src") } },
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8686" },
  },
});
