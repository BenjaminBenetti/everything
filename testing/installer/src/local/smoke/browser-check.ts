import { chromium } from "playwright-core";

/**
 * Sign in to a local installation in this computer's Chrome, which trusts the local certificate
 * authority only through the NSS database install-k3s.sh wrote. Certificate errors are not
 * ignored, so a page that loads proves the browser trusts it.
 */
async function main(): Promise<void> {
  const username = process.env.SMOKE_USERNAME;
  const password = process.env.SMOKE_PASSWORD;
  if (!username || !password)
    throw new Error("Set SMOKE_USERNAME and SMOKE_PASSWORD.");
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: false });
    await page.goto("https://everything.internal/");
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator(".shell").waitFor({ timeout: 60_000 });
    if (new URL(page.url()).origin !== "https://everything.internal") {
      throw new Error(`Signed in on ${page.url()}`);
    }
    console.log(`Signed in at ${page.url()}`);
    const artifacts = await page.goto("https://artifacts.everything.internal/");
    console.log(
      `The artifact host answered HTTP ${artifacts?.status() ?? "nothing"}`,
    );
  } finally {
    await browser.close();
  }
}

await main();
