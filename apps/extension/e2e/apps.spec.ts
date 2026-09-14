/**
 * The Web Apps group: the suite, plus whatever the reader made of it.
 *
 * Driven through the settings pane and read back off the new tab page, so
 * what is asserted is the card someone actually sees — the merge rule itself
 * is unit-tested next to the code in src/background/apps.test.ts.
 */
import { test, expect } from "./fixtures";

test("the card lists the suite, and the pane can take one off it", async ({ context, extensionId }) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html#pane=groups`);
  await settings.waitForSelector(".gitem");

  const group = settings.locator('.gitem[data-instance="apps"]');
  await expect(group).toHaveCount(1);
  // The options are in the DOM from the start but collapsed; "edit" is what
  // opens them. Clicking the row itself hits the group's enable checkbox.
  await group.locator('.gitem-head button:text-is("edit")').click();

  const rows = group.locator(".approw input[type=checkbox]");
  await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(8);

  const names = await group.locator(".approw label, .approw").allInnerTexts();
  expect(names.join(" ")).toContain("OpenSubs");
  expect(names.join(" ")).toContain("OpenPhotoId");

  // Untick the first, and it leaves the card.
  const firstLabel = ((await group.locator(".approw").first().innerText()).split("\n")[0] ?? "").trim();
  await rows.first().uncheck();

  const tab = await context.newPage();
  await expect
    .poll(
      async () => {
        await tab.goto(`chrome-extension://${extensionId}/newtab.html`);
        return tab.locator(".apps .app .n").allInnerTexts();
      },
      { timeout: 15_000 },
    )
    .not.toContain(firstLabel);
});

test("a web app someone adds shows up on the card", async ({ context, extensionId }) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html#pane=groups`);
  const group = settings.locator('.gitem[data-instance="apps"]');
  await group.locator('.gitem-head button:text-is("edit")').click();
  await settings.waitForSelector('.gitem[data-instance="apps"] .approw-add');

  await settings.locator('.gitem[data-instance="apps"] .approw-add input').first().fill("Excalidraw");
  // Typed without a scheme on purpose: that is how people type addresses.
  await settings.locator('.gitem[data-instance="apps"] .approw-add input').nth(1).fill("excalidraw.com");
  await settings.locator('.gitem[data-instance="apps"] .approw-add .btn').click();

  const tab = await context.newPage();
  await expect
    .poll(
      async () => {
        await tab.goto(`chrome-extension://${extensionId}/newtab.html`);
        return tab.locator(".apps .app .n").allInnerTexts();
      },
      { timeout: 15_000 },
    )
    .toContain("Excalidraw");

  // And it points at the real site, not at a path inside the extension —
  // which is where a scheme-less href resolves to.
  const href = await tab.locator('.apps .app:has(.n:text-is("Excalidraw"))').getAttribute("href");
  expect(href).toBe("https://excalidraw.com");
});

/**
 * Every deployed web app, and all three ways to change the card.
 *
 * The served catalogue is answered as a 404 here. Otherwise the worker would
 * fetch the live `apps.json` — which, at the time this was written, was being
 * regenerated twice a day by a binary built on 6 September and still listed
 * four apps, one of them a dead link — and the test would be asserting on
 * the server rather than on the extension.
 */
test("lists every deployed web app, and each can be unticked, added or removed", async ({ context, extensionId }) => {
  await context.route("https://opentabs.app/tabs/v1/apps.json", (r) => r.fulfill({ status: 404, body: "" }));

  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html#pane=groups`);
  const group = settings.locator('.gitem[data-instance="apps"]');
  await group.locator('.gitem-head button:text-is("edit")').click();

  // All ten, by name.
  const names = ["OpenSubs", "OpenPDFEdit", "OpenCapture", "OpenDocScan", "OpenDownloader",
    "OpenNoteTaker", "OpenPhotoId", "OpenPixels", "OpenClipboard", "OpenPassword"];
  const listed = (await group.locator("label.approw").allInnerTexts()).join(" ");
  for (const n of names) expect(listed, `${n} should be in the picker`).toContain(n);

  const cardNames = async () => {
    const tab = await context.newPage();
    await tab.goto(`chrome-extension://${extensionId}/newtab.html`);
    await tab.waitForTimeout(700);
    const got = await tab.locator(".apps .app .n").allInnerTexts();
    await tab.close();
    return got;
  };

  // 1. Untick one.
  await group.locator('label.approw:has-text("OpenPassword") input[type=checkbox]').uncheck();
  await expect.poll(cardNames, { timeout: 15_000 }).not.toContain("OpenPassword");

  // 2. Add one of your own.
  const add = group.locator(".approw-add");
  await add.locator("input").nth(0).fill("Linear");
  await add.locator("input").nth(1).fill("linear.app");
  await add.locator(".btn").click();
  await expect.poll(cardNames, { timeout: 15_000 }).toContain("Linear");

  // 3. Remove it again.
  await group.locator('.approw:has-text("Linear") .btn:text-is("Remove")').click();
  await expect.poll(cardNames, { timeout: 15_000 }).not.toContain("Linear");

  // And the unticked one comes back when ticked — nothing was destroyed.
  await group.locator('label.approw:has-text("OpenPassword") input[type=checkbox]').check();
  await expect.poll(cardNames, { timeout: 15_000 }).toContain("OpenPassword");
});
