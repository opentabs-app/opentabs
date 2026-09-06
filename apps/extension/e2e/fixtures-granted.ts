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
  m.host_permissions = [
    ...new Set([...(m.host_permissions ?? []), "https://market.opentabs.app/*"]),
  ];
  writeFileSync(path, JSON.stringify(m, null, 2));
  return out;
}

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const build = grantedBuild();
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
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
