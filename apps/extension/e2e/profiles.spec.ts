/**
 * The profile button, against a real browser.
 *
 * Worth an end-to-end test rather than a unit one because the whole feature
 * is a question about what the browser permits, and only the browser can
 * answer it. `chrome.profiles` does not exist, `windows.create` refuses a
 * `profileName`, and whether `chrome://profile-picker` opens from an
 * extension is not written down anywhere — it is measured here.
 */
import { chromium, type Worker } from "@playwright/test";
import { test, expect } from "./fixtures";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("the profile button opens the browser's own picker", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);

  const button = page.locator("#profiles");
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("title", "Switch profile");

  await button.click();

  // Read the tab list from the worker: a chrome:// page is not a Playwright
  // `page`, so waiting for one would time out on a click that worked.
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
  await expect.poll(() => landed(worker, "profile-picker"), { timeout: 10_000 }).toBe("page");
});

/**
 * Where the tab the button opened actually ended up.
 *
 * Finding a tab whose URL contains the target is not enough, and was the gap
 * APP-122 went through: Edge opened `edge://profile-picker/`, the URL matched,
 * and the tab was an ERR_INVALID_URL page. An error page's title is its own
 * URL; a real page has a name of its own.
 */
async function landed(worker: Worker, needle: string): Promise<"none" | "loading" | "error" | "page"> {
  return worker.evaluate(async (n) => {
    const tab = (await chrome.tabs.query({})).find((t) => (t.pendingUrl ?? t.url ?? "").includes(n));
    if (!tab) return "none";
    if (tab.status !== "complete" || !tab.title) return "loading";
    const url = tab.url ?? "";
    return tab.title === url || tab.title === url.replace(/\/$/, "") ? "error" : "page";
  }, needle);
}

/**
 * The same click in real Microsoft Edge (APP-122).
 *
 * Edge has no profile picker: it rewrites `chrome://profile-picker` to
 * `edge://profile-picker/` and shows ERR_INVALID_URL. The button must send it to
 * Settings → Profiles instead. Needs Edge installed, so it runs on a dev
 * machine and skips on a runner without it.
 */
const EDGE_BINARIES = [
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/opt/microsoft/msedge/msedge",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
test("in Edge, the profile button opens Settings → Profiles, not an error page", async () => {
  test.skip(!EDGE_BINARIES.some((p) => existsSync(p)), "Microsoft Edge is not installed here");
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  const context = await chromium.launchPersistentContext("", {
    channel: "msedge",
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/newtab.html`);
    await page.locator("#profiles").click();

    await expect.poll(() => landed(worker, "edge://settings/profiles"), { timeout: 10_000 }).toBe("page");
    expect(await landed(worker, "profile-picker")).toBe("none");
  } finally {
    await context.close();
  }
});

/**
 * The button must not appear where it cannot work.
 *
 * It ships with `hidden` set and is revealed by script only after the Firefox
 * check — so a build that never runs that script, or runs it on Firefox,
 * shows nothing rather than a control that does nothing.
 */
test("it ships hidden, and hidden actually hides it", async ({ context, extensionId }) => {
  // The attribute is in the markup as shipped…
  const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "newtab.html"), "utf8");
  expect(html).toMatch(/<button[^>]*id="profiles"[^>]*\shidden/);

  // …and, the part the previous version of this test never checked, the
  // attribute wins over the class. `.iconbtn { display: grid }` beat the user
  // agent's `[hidden]` rule, so the button was on screen everywhere — and a
  // test that only read the HTML string passed the whole time.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  const shown = await page.evaluate(() => {
    const b = document.getElementById("profiles")!;
    b.hidden = true;
    return getComputedStyle(b).display;
  });
  expect(shown).toBe("none");
});

/**
 * Off in Settings means off on the new tab — and it stays off.
 *
 * Whether the choice survives a schema migration is a separate question, and
 * is answered against the built wasm in src/lib/config-migrate.test.ts.
 */
test("the switch-profile button can be turned off in Settings, and stays off", async ({ context, extensionId }) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html#pane=general`);
  const box = settings.locator("#showprofiles");
  await expect(box).toBeChecked();
  await box.uncheck();

  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
  await expect
    .poll(() => worker.evaluate(async () =>
      (await chrome.storage.sync.get("opentabs:config"))["opentabs:config"]?.show_profile_picker))
    .toBe(false);

  // The migration half — that the key survives the Rust struct — is checked
  // against the compiled wasm in src/lib/config-migrate.test.ts, which is the
  // level the bug lived at. This test is about what a reader sees.

  const tab = await context.newPage();
  await tab.goto(`chrome-extension://${extensionId}/newtab.html`);
  await tab.waitForTimeout(800);
  await expect(tab.locator("#profiles")).toBeHidden();

  // And back on.
  await box.check();
  await tab.reload();
  await expect(tab.locator("#profiles")).toBeVisible();
});
