import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The SPA lives in src/web and is built to dist/web, next to the compiled server.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:3000", "/pair": "http://127.0.0.1:3000" } },
});
