import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

/**
 * Voice streaming end to end against a running local gateway and UI server, which in turn reach a
 * real self-hosted speech service; nothing here starts or deploys them.
 */
export default defineConfig({
  testDir: fileURLToPath(new URL("../../voice/e2e/", import.meta.url)),
  testMatch: "*.e2e.ts",
  outputDir: fileURLToPath(
    new URL("../../../../../.local/ui-test-results/voice-e2e", import.meta.url),
  ),
  workers: 1,
  timeout: 150_000,
  use: {
    baseURL: process.env.UI_TEST_ORIGIN ?? "http://localhost:5181",
    trace: "off",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 960 },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 960 },
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 960 },
      },
    },
  ],
});
