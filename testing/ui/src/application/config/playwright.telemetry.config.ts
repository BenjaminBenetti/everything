import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** The isolated UI server's port; every API route is mocked, so no cluster is involved. */
const port = Number(process.env.TELEMETRY_UI_PORT ?? 5182);
const origin = `http://localhost:${port}`;

/** The Telemetry page on a desktop and a phone, against an isolated UI server. */
export default defineConfig({
  testDir: fileURLToPath(new URL("../../telemetry/test/", import.meta.url)),
  testMatch: "*.test.ts",
  outputDir: fileURLToPath(
    new URL("../../../../../.local/ui-test-results/telemetry", import.meta.url),
  ),
  workers: 1,
  timeout: 45_000,
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
  // The explorer is checked on a desktop, and its absence on a phone.
  projects: [
    {
      name: "desktop",
      grep: /@desktop/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 960 },
      },
    },
    {
      name: "phone",
      grep: /@phone/,
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
