import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** The isolated UI server's port; every API route is mocked, so no cluster is involved. */
const port = Number(process.env.CHAT_SCROLL_UI_PORT ?? 5186);
const origin = `http://localhost:${port}`;

/**
 * The conversation's scroll position while the composer changes, on a desktop and an emulated phone:
 * the real conversation page, composer, and styles in Chromium's layout. Sign-in, the teammate, its
 * history, and the voice gateway are mocked; dictation uses a silent stream and no microphone.
 */
export default defineConfig({
  testDir: fileURLToPath(new URL("../../conversation/e2e/", import.meta.url)),
  testMatch: "chat-scroll.e2e.ts",
  outputDir: fileURLToPath(
    new URL(
      "../../../../../.local/ui-test-results/chat-scroll",
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
