import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Main supplies its existing Chromium and a fresh owned output directory; no browser installation. */
const root = process.env.MODEL_INFO_E2E_ROOT;
if (!root || !path.isAbsolute(root))
  throw new Error(
    "Set MODEL_INFO_E2E_ROOT to a fresh absolute fixture/output directory.",
  );
const port = Number(process.env.MODEL_INFO_E2E_PORT ?? 5187);

/** Real application UI with entirely synthetic, intercepted API responses. No provider or database. */
export default defineConfig({
  testDir: fileURLToPath(new URL("../../agent/e2e/", import.meta.url)),
  testMatch: "model-info.e2e.ts",
  outputDir: path.join(root, "playwright"),
  workers: 1,
  retries: 0,
  timeout: 45_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "off",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: `pnpm exec vite --config src/application/config/vite.config.ts --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL("../../../../../services/ui/", import.meta.url)),
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 960 },
      },
    },
    {
      name: "phone",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
