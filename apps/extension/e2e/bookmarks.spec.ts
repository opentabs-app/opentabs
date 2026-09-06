/**
 * The bookmark paths that sit behind the optional permission.
 *
 * These use a fixture that grants `bookmarks` in the manifest, because
 * `permissions.request()` opens a dialog no automation can accept — and a
 * whole feature going untested behind that dialog is where the "cannot
 * unbookmark" bug lived.
 */
import { expect, test } from "./fixtures-granted";

/** Open a real tab, because the tabs card regroups on every tab event. */
async function withTab(context: import("@playwright/test").BrowserContext, extensionId: string, url: string) {
  await context.newPage().then((p) => p.goto(url).catch(() => {}));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector("#grid");
  await page.waitForTimeout(900);
  await page.reload();
  return page;
}

test("the mark saves, then unsaves, and says which it will do", async ({
  context,
  extensionId,
}) => {
  const page = await withTab(context, extensionId, "https://example.com/");
  const row = page.locator('.tablink[data-url="https://example.com/"]');
  const mark = row.locator(".bm");
  await expect(mark).toHaveAttribute("aria-label", "Save as a bookmark");

  await mark.click();
  await expect(row).toHaveAttribute("data-saved", "1");
  await expect(mark).toHaveAttribute("aria-label", "Remove bookmark");
  expect(await page.evaluate(() => chrome.bookmarks.search({ url: "https://example.com/" }))).toHaveLength(1);

  await mark.click();
  await expect(row).toHaveAttribute("data-saved", "0");
  await expect(mark).toHaveAttribute("aria-label", "Save as a bookmark");
  expect(await page.evaluate(() => chrome.bookmarks.search({ url: "https://example.com/" }))).toHaveLength(0);
});

test("a bookmark made elsewhere shows as saved, and can be removed", async ({
  context,
  extensionId,
}) => {
  const page = await withTab(context, extensionId, "https://example.com/");
  await page.evaluate(() =>
    chrome.bookmarks.create({ title: "Example", url: "https://example.com/" }),
  );
  await page.reload();

  const row = page.locator('.tablink[data-url="https://example.com/"]');
  // Decorated after paint from what is actually stored.
  await expect(row).toHaveAttribute("data-saved", "1");
  await row.locator(".bm").click();
  await expect(row).toHaveAttribute("data-saved", "0");
  expect(await page.evaluate(() => chrome.bookmarks.search({ url: "https://example.com/" }))).toHaveLength(0);
});

test("a bookmark whose URL differs by a slash is still this page", async ({
  context,
  extensionId,
}) => {
  const page = await withTab(context, extensionId, "https://example.com/");
  // Saved by hand, or imported, without the slash the tab reports. Byte
  // equality calls this a different page; a reader would not.
  await page.evaluate(() =>
    chrome.bookmarks.create({ title: "Example", url: "https://example.com" }),
  );
  await page.reload();

  const row = page.locator('.tablink[data-url="https://example.com/"]');
  await expect(row).toHaveAttribute("data-saved", "1");
  await row.locator(".bm").click();
  await expect(row).toHaveAttribute("data-saved", "0");
  const left = await page.evaluate(() => chrome.bookmarks.search("example.com"));
  expect(left).toHaveLength(0);
});

test("the button obeys what is stored, not what the row happens to say", async ({
  context,
  extensionId,
}) => {
  const page = await withTab(context, extensionId, "https://example.com/");
  const row = page.locator('.tablink[data-url="https://example.com/"]');
  await row.locator(".bm").click();
  await expect(row).toHaveAttribute("data-saved", "1");

  // Force the decoration to lie, the way a stale paint would.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.tablink[data-url="https://example.com/"]')!.dataset.saved = "0";
  });
  // A press must still remove it: the worker decides the direction.
  await row.locator(".bm").click();
  await expect(row).toHaveAttribute("data-saved", "0");
  expect(await page.evaluate(() => chrome.bookmarks.search({ url: "https://example.com/" }))).toHaveLength(0);
});

test("unsaving and saving again puts it back in its folder", async ({ context, extensionId }) => {
  const page = await withTab(context, extensionId, "https://example.com/");
  const folder = await page.evaluate(async () => {
    const f = await chrome.bookmarks.create({ title: "Reading" });
    await chrome.bookmarks.create({ title: "Example", url: "https://example.com/", parentId: f.id });
    return f.id;
  });
  await page.reload();

  const row = page.locator('.tablink[data-url="https://example.com/"]');
  await expect(row).toHaveAttribute("data-saved", "1");
  await row.locator(".bm").click();
  await expect(row).toHaveAttribute("data-saved", "0");
  await row.locator(".bm").click();
  await expect(row).toHaveAttribute("data-saved", "1");

  // Back in "Reading", not dropped into the default folder — a one-click
  // toggle that quietly loses curation is worse than no toggle.
  const parent = await page.evaluate(async () => {
    const [b] = await chrome.bookmarks.search({ url: "https://example.com/" });
    return b?.parentId;
  });
  expect(parent).toBe(folder);
});

test("a folder-scoped card shows that folder's bookmarks for real", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector("#grid");

  const folder = await page.evaluate(async () => {
    const f = await chrome.bookmarks.create({ title: "Reading" });
    await chrome.bookmarks.create({ title: "The Rust Book", url: "https://doc.rust-lang.org/book/", parentId: f.id });
    const sub = await chrome.bookmarks.create({ title: "Done", parentId: f.id });
    await chrome.bookmarks.create({ title: "Nested one", url: "https://example.org/", parentId: sub.id });
    await chrome.bookmarks.create({ title: "Elsewhere", url: "https://example.net/" });
    return f.id;
  });

  await page.evaluate(async (folderId) => {
    const cfg = (await chrome.storage.sync.get("opentabs:config"))["opentabs:config"];
    cfg.instances.push({
      def: "bookmarks", id: `bm_${folderId}`, name: "Reading", enabled: true,
      opts: { limit: 10, show_folder: false, folder_id: folderId, folder_name: "Reading" },
    });
    await chrome.storage.sync.set({ "opentabs:config": cfg });
    await chrome.runtime.sendMessage({ type: "refresh" });
  }, folder);
  await page.reload();

  const card = page.locator(`.card[data-id="bm_${folder}"]`);
  await expect(card.locator(".row-title")).toHaveCount(2);
  // Sub-folders count: a reading list with a "done" folder in it is still one
  // shelf to the person who made it. What is outside the folder does not.
  await expect(card).toContainText("The Rust Book");
  await expect(card).toContainText("Nested one");
  await expect(card).not.toContainText("Elsewhere");
});

test("a folder that is deleted says so instead of quietly showing something else", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector("#grid");
  await page.evaluate(async () => {
    const cfg = (await chrome.storage.sync.get("opentabs:config"))["opentabs:config"];
    cfg.instances.push({
      def: "bookmarks", id: "bm_gone", name: "Reading", enabled: true,
      opts: { limit: 10, folder_id: "99999", folder_name: "Reading" },
    });
    await chrome.storage.sync.set({ "opentabs:config": cfg });
    await chrome.runtime.sendMessage({ type: "refresh" });
  });
  await page.reload();
  await expect(page.locator('.card[data-id="bm_gone"]')).toContainText("folder is gone");
});

test("saving offers the folder it went to, and lets you move it", async ({
  context,
  extensionId,
}) => {
  const page = await withTab(context, extensionId, "https://example.com/");
  // The picker lists folders by full path, so select by id rather than leaf.
  const folder = await page.evaluate(async () => (await chrome.bookmarks.create({ title: "Reading" })).id);

  const row = page.locator('.tablink[data-url="https://example.com/"]');
  await row.locator(".bm").click();

  // Saved first, then told where — asking before every save would tax the
  // common case, where the last folder used is the right one.
  const pop = page.locator(".bmpop");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".bmpop-t")).toContainText("Saved to");
  await expect(pop.locator(`select option[value="${folder}"]`)).toHaveCount(1);

  await pop.locator("select").selectOption(folder);
  await expect(pop.locator(".bmpop-t")).toContainText("Moved to Reading");

  const parent = await page.evaluate(async () => {
    const [b] = await chrome.bookmarks.search({ url: "https://example.com/" });
    const [p] = await chrome.bookmarks.get(b!.parentId!);
    return p?.title;
  });
  expect(parent).toBe("Reading");
});

test("the next save defaults to the folder last chosen", async ({ context, extensionId }) => {
  const page = await withTab(context, extensionId, "https://example.com/");
  const folder = await page.evaluate(async () => (await chrome.bookmarks.create({ title: "Reading" })).id);

  const row = page.locator('.tablink[data-url="https://example.com/"]');
  await row.locator(".bm").click();
  await expect(page.locator(`.bmpop select option[value="${folder}"]`)).toHaveCount(1);
  await page.locator(".bmpop select").selectOption(folder);
  await expect(page.locator(".bmpop-t")).toContainText("Moved to");
  // Unsave, then save again: it should not fall back to the default folder.
  await row.locator(".bm").click();
  await expect(row).toHaveAttribute("data-saved", "0");
  await row.locator(".bm").click();
  await expect(page.locator(".bmpop-t")).toContainText("Saved to Reading");
});

test("the popover closes on Escape and on a click outside", async ({ context, extensionId }) => {
  const page = await withTab(context, extensionId, "https://example.com/");
  const row = page.locator('.tablink[data-url="https://example.com/"]');

  await row.locator(".bm").click();
  await expect(page.locator(".bmpop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".bmpop")).toHaveCount(0);

  // Unsave and save again to reopen it, then dismiss by clicking away.
  await row.locator(".bm").click();
  await row.locator(".bm").click();
  await expect(page.locator(".bmpop")).toBeVisible();
  await page.locator("h1.greeting").click();
  await expect(page.locator(".bmpop")).toHaveCount(0);
});

test("no popover when the press removed a bookmark", async ({ context, extensionId }) => {
  const page = await withTab(context, extensionId, "https://example.com/");
  const row = page.locator('.tablink[data-url="https://example.com/"]');
  await row.locator(".bm").click();
  await expect(page.locator(".bmpop")).toBeVisible();
  await page.keyboard.press("Escape");

  await row.locator(".bm").click();
  await expect(row).toHaveAttribute("data-saved", "0");
  // Nothing was saved, so there is no folder to talk about.
  await expect(page.locator(".bmpop")).toHaveCount(0);
});
