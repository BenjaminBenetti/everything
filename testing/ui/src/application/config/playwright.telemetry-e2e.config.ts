import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** The UI server's port; its /v1 proxy reaches the telemetry gateway at UI_API_ORIGIN. */
const port = Number(process.env.TELEMETRY_E2E_UI_PORT ?? 5183);
const origin = `http://localhost:${port}`;

/**
 * The Telemetry page end to end: the browser, the UI server, Everything's HTTP application with its
 * real telemetry reader, and a real OpenObserve holding records exported by Everything's runtime.
 * deployment/script/test-telemetry.sh --browser starts the gateway and storage first.
 */
export default defineConfig({
  testDir: fileURLToPath(new URL("../../telemetry/e2e/", import.meta.url)),
  testMatch: "*.e2e.ts",
  outputDir: fileURLToPath(
    new URL(
      "../../../../../.local/ui-test-results/telemetry-e2e",
      import.meta.url,
    ),
  ),
  workers: 1,
  timeout: 90_000,
  use: {
    baseURL: origin,
    trace: "off",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: `pnpm exec vite --config src/application/config/vite.config.ts --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL("../../../../../services/ui/", import.meta.url)),
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 960 },
      },
    },
  ],
});
