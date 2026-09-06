import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  /**
   * Generous, and not to paper over flakes.
   *
   * Every test launches its own persistent Chrome with the extension loaded,
   * and almost everything on screen arrives through a service-worker round
   * trip: config, payloads, the first tab grouping. On a loaded machine
   * running these one at a time, the 5-second default `expect` budget was
   * expiring on UI that was merely late, not wrong — which is a slow test
   * reported as a broken feature.
   *
   * `retries` stays at zero deliberately. A longer wait for something that
   * does arrive is honest; re-running until it passes would not be.
   */
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
