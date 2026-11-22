import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Hub serves the PWA at `/` (SPA fallback to index.html). In development, /api goes to the local Hub,
// so the PWA and the API share an origin and CORS is not needed.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // contracts and core import `node:crypto` in functions the PWA never calls (pattern hashing, ulid).
    alias: { "node:crypto": fileURLToPath(new URL("./src/node-crypto-shim.ts", import.meta.url)) },
  },
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:4100", changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
