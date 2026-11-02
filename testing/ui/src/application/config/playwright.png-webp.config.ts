import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = process.env.ATTACHMENTS_E2E_ROOT;
if (!root || !path.isAbsolute(root))
  throw new Error(
    "Set ATTACHMENTS_E2E_ROOT to a fresh owned absolute directory",
  );
const port = Number(process.env.ATTACHMENTS_E2E_UI_PORT ?? 5188);
const gatewayPort = Number(process.env.ATTACHMENTS_E2E_GATEWAY_PORT ?? 18188);
const origin = "http://localhost:" + port;

/** No browser installation: main supplies its existing Chromium, one worker, retry zero, fresh outputs. */
export default defineConfig({
  testDir: fileURLToPath(new URL("../../conversation/e2e/", import.meta.url)),
  testMatch: "png-webp.e2e.ts",
  outputDir: path.join(root, "playwright"),
  workers: 1,
  retries: 0,
  timeout: 90_000,
  use: {
    baseURL: origin,
    trace: "off",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: [
    {
      command: "pnpm exec tsx src/attachment/test/png-webp-gateway.ts",
      cwd: fileURLToPath(
        new URL("../../../../../services/everything/", import.meta.url),
      ),
      url: "http://127.0.0.1:" + gatewayPort + "/health/live",
      env: {
        ATTACHMENTS_E2E_ROOT: root,
        ATTACHMENTS_E2E_ORIGIN: origin,
        ATTACHMENTS_E2E_GATEWAY_PORT: String(gatewayPort),
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        "pnpm exec vite --config src/application/config/vite.config.ts --port " +
        port +
        " --strictPort",
      cwd: fileURLToPath(
        new URL("../../../../../services/ui/", import.meta.url),
      ),
      url: origin,
      env: { UI_API_ORIGIN: "http://127.0.0.1:" + gatewayPort },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
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
