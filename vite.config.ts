import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { DEFAULT_PORT } from "./src/server/config.js";

const apiPort = process.env["SIB_PORT"] ?? String(DEFAULT_PORT);
const apiOrigin = `http://127.0.0.1:${apiPort}`;

// The SPA lives in src/web and is built to dist/web, next to the compiled server.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": apiOrigin, "/pair": apiOrigin } },
});
