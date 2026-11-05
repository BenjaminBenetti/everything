import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** The UI server's port; its /v1 proxy reaches the jobs gateway. */
const port = Number(process.env.JOBS_E2E_UI_PORT ?? 5185);
const gatewayPort = (process.env.JOBS_E2E_GATEWAY_PORT ??= "18185");
const origin = `http://localhost:${port}`;

/** The gateway's evidence folder, shared with the test that inspects it. */
const root = (process.env.JOBS_E2E_ROOT ??= fileURLToPath(
  new URL("../../../../../.local/jobs-e2e/", import.meta.url),
));

/**
 * Teammate jobs end to end on a desktop and a phone: the browser, the UI server, and Everything's
 * HTTP application with the real job, scheduler, dispatcher, conversation, subagent, and session
 * family code. Sign-in, record storage, the model, and the job clock are synthetic; see job-gateway.ts.
 */
export default defineConfig({
  testDir: fileURLToPath(new URL("../../job/e2e/", import.meta.url)),
  testMatch: "jobs.e2e.ts",
  outputDir: fileURLToPath(
    new URL("../../../../../.local/ui-test-results/jobs-e2e", import.meta.url),
  ),
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: origin,
    locale: "en-US",
    timezoneId: "Europe/Paris",
    trace: "off",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: [
    {
      command: "pnpm exec tsx src/job/test/jobs-e2e-gateway.ts",
      cwd: fileURLToPath(
        new URL("../../../../../services/everything/", import.meta.url),
      ),
      url: `http://127.0.0.1:${gatewayPort}/health/live`,
      env: {
        JOBS_E2E_ROOT: root,
        JOBS_E2E_ORIGIN: origin,
        JOBS_E2E_GATEWAY_PORT: gatewayPort,
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
