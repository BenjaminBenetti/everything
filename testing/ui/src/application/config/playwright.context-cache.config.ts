import { defineConfig } from "@playwright/test";
import modelInfo from "./playwright.model-info.config.js";

/** Reuse the isolated one-worker/retry-zero Chromium setup with fresh task-owned outputs. */
export default defineConfig({
  ...modelInfo,
  testMatch: "context-cache.e2e.ts",
});
