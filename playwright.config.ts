import { defineConfig } from "@playwright/test";

/** Phone width of the main journey (iPhone 14 viewport). */
export const PHONE = { width: 390, height: 844 } as const;

// The e2e specs drive a real server (fake model, fake weather, temporary data folder) that each
// spec file starts itself, so there is no `webServer` here. Run `npm run build` first.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
    // The app is served over plain HTTP on the LAN; nothing leaves the machine.
    acceptDownloads: false,
    trace: "off",
  },
});
