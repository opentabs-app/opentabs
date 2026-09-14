/**
 * The profile button, against a real browser.
 *
 * Worth an end-to-end test rather than a unit one because the whole feature
 * is a question about what the browser permits, and only the browser can
 * answer it. `chrome.profiles` does not exist, `windows.create` refuses a
 * `profileName`, and whether `chrome://profile-picker` opens from an
 * extension is not written down anywhere — it is measured here.
 */
import { test, expect } from "./fixtures";
import { readFileSync } from "node:fs";
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
  await expect
    .poll(
      async () =>
        worker.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          return tabs.map((t) => t.pendingUrl ?? t.url ?? "").filter((u) => u.includes("profile-picker"));
        }),
      { timeout: 10_000 },
    )
    .not.toHaveLength(0);
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
