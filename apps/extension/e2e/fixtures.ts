import { test as base, chromium, type BrowserContext } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/**
 * Loading an unpacked extension needs a persistent context and, literally,
 * `channel: "chromium"`.
 *
 * Not "omit channel" (a differently-behaving launch), and not
 * `channel: "chrome"` — real Chrome's plain `headless: true` is old headless,
 * which has never supported loading extensions at all.
 */
export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    await use(new URL(worker.url()).host);
  },
});

export const expect = test.expect;
