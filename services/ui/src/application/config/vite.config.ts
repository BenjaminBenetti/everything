import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

/** Development traffic uses the same origin and route boundaries as the ingress. */
export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    {
      name: "offline-worker",
      /** Emit the domain-owned worker at the root so its scope covers the PWA. */
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: readFileSync(
            new URL("../../pwa/worker/service-worker.js", import.meta.url),
            "utf8",
          ),
        });
      },
    },
  ],
  build: { outDir: "build/client", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://localhost:8080",
    },
  },
});
