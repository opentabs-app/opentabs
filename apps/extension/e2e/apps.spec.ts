/**
 * The Web Apps group: empty on arrival, and whatever the reader makes of it.
 *
 * Driven through the settings pane and read back off the new tab page, so
 * what is asserted is the card someone actually sees — the merge rule itself
 * is unit-tested next to the code in src/lib/apps.test.ts.
 *
 * Every test answers the served catalogue itself rather than letting the
 * worker fetch the live `apps.json`. The catalogue is a file on a server, and
 * a test that reads it is asserting on the server: these ran green locally
 * while the deployed file still listed ten products, and went red in CI an
 * hour later when it was emptied. What the extension does with a catalogue is
 * the thing under test, so the catalogue is supplied here.
 */
import { test, expect } from "./fixtures";

const APPS_JSON = "https://opentabs.app/tabs/v1/apps.json";

/** The card, as a reader sees it, after a fresh load of the new tab page. */
async function cardNames(context: import("@playwright/test").BrowserContext, extensionId: string) {
  const tab = await context.newPage();
  await tab.goto(`chrome-extension://${extensionId}/newtab.html`);
  await tab.waitForTimeout(700);
  const got = await tab.locator(".apps .app .n").allInnerTexts();
  await tab.close();
  return got;
}

test("the card starts empty, and its empty state opens the pane that fills it", async ({ context, extensionId }) => {
  await context.route(APPS_JSON, (r) => r.fulfill({ status: 200, body: JSON.stringify({ apps: [] }) }));

  const tab = await context.newPage();
  await tab.goto(`chrome-extension://${extensionId}/newtab.html`);

  // The group is still there. Hiding it when empty would hide the only way in.
  const card = tab.locator(".card", { has: tab.locator("text=Web Apps") }).first();
  await expect(card).toBeVisible();
  await expect(card.locator(".app")).toHaveCount(0);
  await expect(card).toContainText("No web apps yet.");

  const [settings] = await Promise.all([
    context.waitForEvent("page"),
    card.locator("button:text-is('Add a web app')").click(),
  ]);
  await settings.waitForLoadState();
  expect(settings.url()).toContain("settings.html#i=apps");
  // And it lands on the group whose card sent them, with its adder open.
  await expect(settings.locator('.gitem[data-instance="apps"] .approw-add')).toBeVisible();
});

test("a web app someone adds shows up on the card", async ({ context, extensionId }) => {
  await context.route(APPS_JSON, (r) => r.fulfill({ status: 200, body: JSON.stringify({ apps: [] }) }));

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
 * The three ways to change the card, against a catalogue that is not empty.
 *
 * Nothing ships in the catalogue any more, but the layering that reads it is
 * still the code that renders the card, and a served entry is still something
 * a reader must be able to take off. So one is supplied here — which is also
 * how this test stops depending on what any server happens to be saying.
 */
test("a served app can be unticked, and one of your own added and removed", async ({ context, extensionId }) => {
  await context.route(APPS_JSON, (r) =>
    r.fulfill({
      status: 200,
      body: JSON.stringify({ apps: [{ id: "demo", name: "Demo Docs", url: "https://demo.test/", tagline: "A served entry" }] }),
    }),
  );

  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html#pane=groups`);
  const group = settings.locator('.gitem[data-instance="apps"]');
  await group.locator('.gitem-head button:text-is("edit")').click();

  await expect.poll(() => cardNames(context, extensionId), { timeout: 15_000 }).toContain("Demo Docs");
  await expect.poll(async () => (await group.locator("label.approw").allInnerTexts()).join(" "), { timeout: 10_000 })
    .toContain("Demo Docs");

  // 1. Untick the served one.
  await group.locator('label.approw:has-text("Demo Docs") input[type=checkbox]').uncheck();
  await expect.poll(() => cardNames(context, extensionId), { timeout: 15_000 }).not.toContain("Demo Docs");

  // 2. Add one of your own.
  const add = group.locator(".approw-add");
  await add.locator("input").nth(0).fill("Linear");
  await add.locator("input").nth(1).fill("linear.app");
  await add.locator(".btn").click();
  await expect.poll(() => cardNames(context, extensionId), { timeout: 15_000 }).toContain("Linear");

  // 3. Remove it again.
  await group.locator('.approw:has-text("Linear") .btn:text-is("Remove")').click();
  await expect.poll(() => cardNames(context, extensionId), { timeout: 15_000 }).not.toContain("Linear");

  // And the unticked one comes back when ticked — nothing was destroyed.
  await group.locator('label.approw:has-text("Demo Docs") input[type=checkbox]').check();
  await expect.poll(() => cardNames(context, extensionId), { timeout: 15_000 }).toContain("Demo Docs");
});
