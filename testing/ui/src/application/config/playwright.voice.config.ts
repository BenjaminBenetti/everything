import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** The isolated UI server's port; every API route is mocked, so no cluster is involved. */
const port = Number(process.env.VOICE_UI_PORT ?? 5180);
const origin = `http://localhost:${port}`;

/** Chromium's generated microphone, granted without a prompt, for the real-recording checks. */
const chromiumMedia = {
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
};

/** A touch phone of the given size. */
function phone(width: number, height: number) {
  return {
    viewport: { width, height },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  };
}

/** Voice input in Chromium and Playwright's WebKit build, at desktop and phone widths. */
export default defineConfig({
  testDir: fileURLToPath(new URL("../../voice/test/", import.meta.url)),
  testMatch: "*.test.ts",
  outputDir: fileURLToPath(
    new URL("../../../../../.local/ui-test-results/voice", import.meta.url),
  ),
  workers: 1,
  timeout: 45_000,
  use: { baseURL: origin, trace: "off", screenshot: "only-on-failure" },
  webServer: {
    command: `pnpm exec vite --config src/application/config/vite.config.ts --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL("../../../../../services/ui/", import.meta.url)),
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 960 },
        launchOptions: chromiumMedia,
      },
    },
    {
      name: "chromium-393",
      use: {
        browserName: "chromium",
        ...phone(393, 852),
        launchOptions: chromiumMedia,
      },
    },
    {
      name: "chromium-320",
      use: {
        browserName: "chromium",
        ...phone(320, 640),
        launchOptions: chromiumMedia,
      },
    },
    {
      name: "webkit-desktop",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 960 },
      },
    },
    { name: "webkit-393", use: { browserName: "webkit", ...phone(393, 852) } },
    { name: "webkit-320", use: { browserName: "webkit", ...phone(320, 640) } },
  ],
});
