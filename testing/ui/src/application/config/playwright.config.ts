import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** Exercise the real ingress and Keycloak, keeping test artifacts outside tracked source. */
export default defineConfig({
  testDir: fileURLToPath(new URL("../../", import.meta.url)),
  testMatch: "**/test/*.test.ts",
  outputDir: fileURLToPath(
    new URL("../../../../../.local/ui-test-results", import.meta.url),
  ),
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: process.env.UI_TEST_ORIGIN ?? "http://localhost:8080",
    // Traces can contain auth responses; keep them disabled for live identity-provider tests.
    trace: "off",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
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
