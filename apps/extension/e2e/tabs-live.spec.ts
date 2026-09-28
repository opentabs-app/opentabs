/**
 * The tabs card is either live or it says it is not.
 *
 * It renders from the last grouping the worker stored, then asks for a fresh
 * one — right for a fast first frame, and silent when that request fails.
 * Found on a real profile: the worker had been dead for eight hours, so the
 * card listed tabs closed the previous afternoon and omitted every tab opened
 * since. Nothing on screen suggested it was a snapshot.
 */
import { test, expect } from "./fixtures";

/** A grouping shaped like the worker's, naming a tab that does not exist. */
const GHOST = {
  total: 1,
  skipped: 0,
  groups: [
    {
      key: "ghost.test",
      label: "ghost.test",
      is_homepage: false,
      tabs: [
        {
          id: 999,
          window_id: 1,
          title: "A tab closed hours ago",
          url: "https://ghost.test/gone",
          fav_icon_url: null,
          active: false,
          pinned: false,
          duplicate_of: [],
        },
      ],
    },
  ],
};

async function seedStaleTabs(page: import("@playwright/test").Page) {
  await page.evaluate(async (data) => {
    const all = (await chrome.storage.local.get("opentabs:payloads"))["opentabs:payloads"] ?? {};
    const t = Math.floor(Date.now() / 1000) - 8 * 3600;
    all.tabs = { instanceId: "tabs", data, generated_at: t, stale_after: t + 9999 };
    await chrome.storage.local.set({ "opentabs:payloads": all });
  }, GHOST);
}

test("a stale grouping is replaced by the live one after paint", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await seedStaleTabs(page);
  await page.reload();

  // The worker answers, so the ghost is gone and this very page is listed.
  await expect(page.locator('.card[data-id="tabs"]')).not.toContainText("A tab closed hours ago", {
    timeout: 15_000,
  });
  await expect(page.locator('.card[data-id="tabs"] .notlive')).toHaveCount(0);
});

test("when the worker will not answer, the card says so instead of lying", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);

  // Block the request *before* seeding: the first load's own refresh would
  // otherwise regroup and replace the stale payload with the truth, which is
  // the behaviour the other test covers.
  //
  // A worker that never starts is what a dead one looks like from the page:
  // the send rejects. Simulated here, because a browser cannot be asked to
  // keep its own service worker down.
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // @ts-expect-error — narrowing the overloads is not the point here
    chrome.runtime.sendMessage = (msg, ...rest) =>
      msg?.type === "refreshTabs"
        ? Promise.reject(new Error("Could not establish connection."))
        : send(msg, ...rest);
  });
  await page.reload();
  await seedStaleTabs(page);
  await page.reload();

  const card = page.locator('.card[data-id="tabs"]');
  await expect(card.locator(".notlive")).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("not responding");
  // The way out is on the card, not in a support page somewhere.
  await expect(card.locator("button:text-is('Reload the extension')")).toBeVisible();
  // The list itself is kept rather than blanked: it is the last thing known
  // to be true, now labelled as such.
  //
  // It is the *live* grouping here rather than the seeded ghost, because a
  // reload is itself a tab event and the worker corrects the payload before
  // the page reads it — which is worth knowing: only a worker that cannot
  // run at all leaves a stale card, and that is exactly the case this note
  // is for.
  await expect(card.locator(".card-body > *:not(.notlive):not(.corrob)").first()).toBeVisible();
});
