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
/**
 * Answer the placeholder hosts locally.
 *
 * Seven tests navigate to example.com and friends purely to make tabs exist
 * — the grouping is the thing under test, and the page content is never
 * looked at. Fetching them for real made an offline suite impossible and put
 * a network round trip in front of every grouping assertion, which is one of
 * the reasons a full run flakes.
 *
 * The tab still carries the URL it was given, so grouping, duplicate
 * detection and the domain rows are all exercised exactly as before.
 *
 * Only these reserved names are stubbed. A test that means to reach a real
 * host still does.
 */
async function stubPlaceholderHosts(context: BrowserContext): Promise<void> {
  await context.route(/^https?:\/\/([a-z0-9-]+\.)*example\.(com|org|net)\//i, (route) => {
    const url = route.request().url();
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      // Titled, because the tab list shows titles and an empty one would
      // send every row through the "untitled" fallback instead.
      body: `<!doctype html><title>Example Domain</title><p>${url}</p>`,
    });
  });
}

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    await stubPlaceholderHosts(context);
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
