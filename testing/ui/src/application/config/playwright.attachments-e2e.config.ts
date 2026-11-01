import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** The UI server's port; its /v1 proxy reaches the attachment gateway. */
const port = Number(process.env.ATTACHMENTS_E2E_UI_PORT ?? 5184);
const gatewayPort = Number(process.env.ATTACHMENTS_E2E_GATEWAY_PORT ?? 18_184);
const origin = `http://localhost:${port}`;

/** The gateway's temporary workspace volume and evidence, shared with the test that inspects them. */
const root = (process.env.ATTACHMENTS_E2E_ROOT ??= fileURLToPath(
  new URL("../../../../../.local/attachments-e2e/", import.meta.url),
));

/**
 * Attachments end to end on a desktop and a phone: the browser, the UI server, and Everything's HTTP
 * application with the real attachment and conversation services over a temporary workspace volume.
 * Sign-in, record storage, and the model are mocked by the gateway; see its e2e-gateway.ts.
 */
export default defineConfig({
  testDir: fileURLToPath(new URL("../../conversation/e2e/", import.meta.url)),
  testMatch: "attachments.e2e.ts",
  outputDir: fileURLToPath(
    new URL(
      "../../../../../.local/ui-test-results/attachments-e2e",
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
  webServer: [
    {
      command: "pnpm exec tsx src/attachment/test/e2e-gateway.ts",
      cwd: fileURLToPath(
        new URL("../../../../../services/everything/", import.meta.url),
      ),
      url: `http://127.0.0.1:${gatewayPort}/health/live`,
      env: {
        ATTACHMENTS_E2E_ROOT: root,
        ATTACHMENTS_E2E_ORIGIN: origin,
        ATTACHMENTS_E2E_GATEWAY_PORT: String(gatewayPort),
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm exec vite --config src/application/config/vite.config.ts --port ${port} --strictPort`,
      cwd: fileURLToPath(
        new URL("../../../../../services/ui/", import.meta.url),
      ),
      url: origin,
      env: { UI_API_ORIGIN: `http://127.0.0.1:${gatewayPort}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
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
