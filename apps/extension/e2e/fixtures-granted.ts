/**
 * The same extension, with the optional grants already in place.
 *
 * `chrome.permissions.request()` opens a dialog no automation can accept, so
 * every path behind such a grant was untestable — which is exactly where a
 * bug then sat. This copies `dist`, moves `bookmarks` from
 * `optional_permissions` into `permissions`, and adds the marketplace origin
 * to `host_permissions`, so the grants are a property of the fixture rather
 * than something a test has to click through.
 *
 * Nothing else is patched: the code under test is byte-identical. The
 * *asking* is covered separately, against the unmodified build.
 */
import { test as base, chromium, type BrowserContext } from "@playwright/test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "dist");

function grantedBuild(): string {
  const out = mkdtempSync(resolve(tmpdir(), "opentabs-granted-"));
  cpSync(dist, out, { recursive: true });
  const path = resolve(out, "manifest.json");
  const m = JSON.parse(readFileSync(path, "utf8"));
  m.optional_permissions = (m.optional_permissions ?? []).filter(
    (p: string) => p !== "bookmarks",
  );
  m.permissions = [...new Set([...(m.permissions ?? []), "bookmarks"])];
  // Both hosts the marketplace pane asks for. `auth` is here even though no
  // test signs in: the Publish button requests the pair together, and a test
  // that reaches it would otherwise stall on a dialog automation cannot
  // accept — which presents as a timeout with nothing to read.
  m.host_permissions = [
    ...new Set([
      ...(m.host_permissions ?? []),
      "https://market.opentabs.app/*",
      "https://auth.opentabs.app/*",
    ]),
  ];
  writeFileSync(path, JSON.stringify(m, null, 2));
  return out;
}

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
    const build = grantedBuild();
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
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
