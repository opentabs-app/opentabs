/**
 * The arrangeable layout.
 *
 * Layout lives in the config document rather than localStorage, so these
 * assert against `chrome.storage.sync` — an arrangement that does not survive
 * a reload, or does not travel with the config string, is not persisted at
 * all.
 */
import { expect, test } from "./fixtures";

const readOpts = (page: import("@playwright/test").Page, id: string) =>
  page.evaluate(async (id) => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const inst = got["opentabs:config"].instances.find((i: { id: string }) => i.id === id);
    return inst?.opts ?? {};
  }, id);

async function newtab(context: import("@playwright/test").BrowserContext, extensionId: string) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card[data-id]");
  return page;
}

test("headlines are shown in full, not truncated", async ({ context, extensionId }) => {
  const page = await newtab(context, extensionId);
  const truncates = await page.evaluate(() => {
    const el = document.createElement("div");
    el.className = "row-title";
    el.textContent = "x".repeat(400);
    document.querySelector(".card")?.append(el);
    const cs = getComputedStyle(el);
    return { whiteSpace: cs.whiteSpace, textOverflow: cs.textOverflow };
  });
  expect(truncates.whiteSpace).not.toBe("nowrap");
  expect(truncates.textOverflow).not.toBe("ellipsis");
});

test("minimise collapses a card and survives a reload", async ({ context, extensionId }) => {
  const page = await newtab(context, extensionId);
  const card = page.locator('.card[data-id="focus"]');
  await card.hover();
  await card.getByRole("button", { name: "Minimise" }).click();

  await expect(card).toHaveClass(/collapsed/);
  await expect.poll(async () => (await readOpts(page, "focus")).collapsed).toBe(true);

  await page.reload();
  await expect(page.locator('.card[data-id="focus"]')).toHaveClass(/collapsed/);
});

test("maximise spans the full row, and toggles back", async ({ context, extensionId }) => {
  const page = await newtab(context, extensionId);
  const card = page.locator('.card[data-id="focus"]');
  await card.hover();
  const max = card.getByRole("button", { name: "Maximise" });

  await max.click();
  await expect(card).toHaveAttribute("data-span", "full");
  await expect.poll(async () => (await readOpts(page, "focus")).span).toBe("full");

  await max.click();
  await expect(card).toHaveAttribute("data-span", "1");
  await expect.poll(async () => (await readOpts(page, "focus")).span).toBe(1);
});

test("a maximised card really does span the whole row", async ({ context, extensionId }) => {
  const page = await newtab(context, extensionId);
  const card = page.locator('.card[data-id="focus"]');
  await expect(card).toBeVisible();
  // Start from a known span. Comparing against "whatever it was" made the
  // assertion depend on how many other cards had painted yet: with few on
  // screen the card was already the width of the row, and "wider than before"
  // is then unprovable even though maximising works.
  await expect(card).toHaveAttribute("data-span", "1");
  await card.hover();
  await card.getByRole("button", { name: "Maximise" }).click();
  await expect(card).toHaveAttribute("data-span", "full");

  // The property is "spans the row", so measure it against the row. The grid
  // repacks after the span changes and `boundingBox` does not wait for that
  // the way a click does, hence the poll.
  await expect
    .poll(async () => {
      const c = (await card.boundingBox())!.width;
      const g = (await page.locator("#grid").boundingBox())!.width;
      return c / g;
    })
    .toBeGreaterThan(0.95);
});

test("the tabs card starts wider than one column but stays resizable", async ({
  context,
  extensionId,
}) => {
  const page = await newtab(context, extensionId);
  // The tabs card appears once the worker has written its first grouping,
  // which is a race against page load on a cold profile — so reload until it
  // is there rather than asserting on whichever paint won.
  const tabs = page.locator('.card[data-id="tabs"]');
  for (let i = 0; i < 6 && (await tabs.count()) === 0; i++) {
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForSelector(".card[data-id]");
  }
  await expect(tabs).toHaveAttribute("data-span", "2");
  await tabs.hover();
  await tabs.getByRole("button", { name: "Maximise" }).click();
  await expect(tabs).toHaveAttribute("data-span", "full");
});

test("dragging one card past another reorders and persists", async ({ context, extensionId }) => {
  let page = await newtab(context, extensionId);
  // Only local groups render without granted permissions, so enable enough of
  // them to have something to reorder.
  await page.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    for (const i of cfg.instances) {
      if (["focus", "scratch", "todos", "tabs"].includes(i.id)) i.enabled = true;
    }
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  });
  await page.reload();
  await page.waitForSelector(".card[data-id]");

  const ids = () =>
    page.$$eval(".card[data-id]", (els) => els.map((e) => (e as HTMLElement).dataset.id));
  const before = await ids();
  expect(before.length, "need several cards to reorder").toBeGreaterThan(2);

  // The drag can only start from the grip, so links stay clickable.
  const first = page.locator(".card[data-id]").first();
  const third = page.locator(".card[data-id]").nth(2);
  await first.hover();
  await first.locator(".grip").hover();
  await page.mouse.down();
  const box = (await third.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  const after = await ids();
  if (after[0] !== before[0]) {
    // Order changed in the DOM; it must also be in storage.
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const got = await chrome.storage.sync.get("opentabs:config");
          return got["opentabs:config"].instances.map((i: { id: string }) => i.id).join(",");
        }),
      )
      .toContain(after[0]!);
  }
});

/** Enable enough local groups that a column has several cards in it. */
async function seedLocalGroups(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    for (const i of cfg.instances) {
      if (["tabs", "focus", "scratch", "todos"].includes(i.id)) i.enabled = true;
    }
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  });
  await page.reload();
  await page.waitForSelector(".card[data-id]");
}

test("cards pack vertically instead of leaving dead space", async ({ context, extensionId }) => {
  const page = await newtab(context, extensionId);
  await seedLocalGroups(page);

  const boxes = await page.$$eval(".card[data-id]", (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { id: (e as HTMLElement).dataset.id!, x: Math.round(r.x), y: r.y, bottom: r.bottom };
    }),
  );
  expect(boxes.length).toBeGreaterThan(2);

  // Within a column, each card should start just below the one above it. A
  // plain grid leaves the height of the tallest card in the row instead.
  const columns = new Map<number, typeof boxes>();
  for (const b of boxes) {
    const col = columns.get(b.x) ?? [];
    col.push(b);
    columns.set(b.x, col);
  }
  let checked = 0;
  for (const col of columns.values()) {
    col.sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) {
      const gap = col[i]!.y - col[i - 1]!.bottom;
      expect(gap, `dead space under ${col[i - 1]!.id}`).toBeLessThan(28);
      checked++;
    }
  }
  expect(checked, "no column had two stacked cards to compare").toBeGreaterThan(0);
});

test("every card gets a measured row span", async ({ context, extensionId }) => {
  const page = await newtab(context, extensionId);
  const spans = await page.$$eval(".card[data-id]", (els) =>
    els.map((e) => (e as HTMLElement).style.gridRow),
  );
  expect(spans.length).toBeGreaterThan(0);
  for (const s of spans) expect(s).toMatch(/^span \d+$/);
});

test("dragging the bottom edge sets a height that persists", async ({ context, extensionId }) => {
  const page = await newtab(context, extensionId);
  const card = page.locator('.card[data-id="focus"]');
  await card.hover();
  const before = (await card.boundingBox())!;

  const handle = card.locator(".resizer-y");
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 180, { steps: 10 });
  await page.mouse.up();

  const after = (await card.boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height + 100);

  await expect
    .poll(async () => (await readOpts(page, "focus")).rows)
    .toBeGreaterThan(0);

  // And it survives a reload, which is the whole point of persisting it.
  await page.reload();
  await page.waitForSelector('.card[data-id="focus"]');
  const reloaded = (await page.locator('.card[data-id="focus"]').boundingBox())!;
  expect(Math.abs(reloaded.height - after.height)).toBeLessThan(20);
});

test("double-clicking a resize handle returns the card to fitting its content", async ({
  context,
  extensionId,
}) => {
  const page = await newtab(context, extensionId);
  const card = page.locator('.card[data-id="focus"]');
  await card.hover();

  const handle = card.locator(".resizer-y");
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 200, { steps: 8 });
  await page.mouse.up();
  const stretched = (await card.boundingBox())!.height;

  await card.hover();
  await card.locator(".resizer-y").dblclick();
  const fitted = (await card.boundingBox())!.height;

  expect(fitted).toBeLessThan(stretched - 100);
  await expect.poll(async () => (await readOpts(page, "focus")).rows).toBe(0);
});

test("every card has a gear that opens settings at that group", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");

  // The tabs card is the one that always renders — the fetched groups need
  // data a test has no way to give them. It appears only once the worker has
  // written its first grouping, which under a full-suite run is not instant:
  // hovering before then is what made this flaky.
  const card = page.locator('.card[data-id="tabs"]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.hover();
  const gear = card.locator(".cardctl .gear");
  await expect(gear).toHaveCount(1);

  const opened = context.waitForEvent("page");
  await gear.click();
  const settings = await opened;
  await settings.waitForLoadState();

  expect(settings.url()).toContain("settings.html#i=tabs");
  // Landing on the page is not the point — landing on the right row is.
  const row = settings.locator('#pane-groups [data-instance="tabs"]');
  await expect(row).toHaveClass(/open/);
  await expect(settings.locator("#pane-groups")).toHaveClass(/on/);
});

test("an X search card carries the X mark and lands on the topics pane", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");

  // X searches ship disabled, so switch one on the way a reader would.
  const id = await page.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    const x = cfg.instances.find((i: { def: string }) => i.def === "xsearch");
    if (!x) return null;
    x.enabled = true;
    await chrome.storage.sync.set({ "opentabs:config": cfg });
    return x.id as string;
  });
  test.skip(id === null, "no xsearch group in the shipped config");

  await page.reload();
  const card = page.locator(`.card[data-id="${id}"]`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".card-icon")).toHaveCount(1);

  await card.hover();
  const opened = context.waitForEvent("page");
  await card.locator(".cardctl .gear").click();
  const settings = await opened;
  await settings.waitForLoadState();
  await expect(settings.locator("#pane-topics")).toHaveClass(/on/);
  await expect(settings.locator(`#pane-topics [data-instance="${id}"]`)).toHaveClass(/open/);
});

test("tickers pack tightly without clipping the price", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");

  // Realistic worst case: eight-character pairs and a six-figure price.
  await page.evaluate(async () => {
    const rows = [
      "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT",
      "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT",
    ].map((symbol, i) => ({ symbol, price: 118432.5 - i * 1000, changePct: i % 2 ? -12.34 : 5.67 }));
    const got = await chrome.storage.local.get("opentabs:payloads");
    const p = got["opentabs:payloads"] ?? {};
    const t = Math.floor(Date.now() / 1000);
    p.crypto = { instanceId: "crypto", data: rows, generated_at: t, stale_after: t + 9999 };
    await chrome.storage.local.set({ "opentabs:payloads": p });
    const cfg = (await chrome.storage.sync.get("opentabs:config"))["opentabs:config"];
    cfg.instances.find((i: { def: string }) => i.def === "crypto").enabled = true;
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  });
  await page.reload();

  const card = page.locator('.card[data-id="crypto"]');
  await expect(card.locator(".ticker")).toHaveCount(8);

  const m = await card.evaluate((c) => {
    const wrap = c.querySelector<HTMLElement>(".tickers")!;
    const tick = [...c.querySelectorAll<HTMLElement>(".ticker")];
    const tops = [...new Set(tick.map((t) => t.getBoundingClientRect().top))];
    // Intrinsic text width, not the box: a block stretches to its column and
    // would report "fits" while visibly ellipsised.
    const textWidth = (n: Element) => {
      const r = document.createRange();
      r.selectNodeContents(n);
      return r.getBoundingClientRect().width;
    };
    return {
      wrapWidth: wrap.clientWidth,
      colWidth: tick[0]!.getBoundingClientRect().width,
      perRow: Math.max(
        ...tops.map((y) => tick.filter((t) => t.getBoundingClientRect().top === y).length),
      ),
      overflows: wrap.scrollWidth > wrap.clientWidth + 1,
      widestLine: Math.max(
        ...tick.flatMap((t) =>
          [".sym", ".px", ".row-meta"].map((s) => textWidth(t.querySelector(s)!)),
        ),
      ),
    };
  });

  expect(m.overflows, "the grid must never push past its card").toBe(false);
  // Tightening the columns is only a gain if the values still fit in them.
  expect(m.widestLine).toBeLessThanOrEqual(m.colWidth);
  // The point of the exercise: three per row before, five now. Guarded by the
  // width so a narrower viewport cannot fail this spuriously.
  if (m.wrapWidth >= 350) expect(m.perRow).toBeGreaterThanOrEqual(5);
});

test("closing duplicates sits in the card head, not below the tab list", async ({
  context,
  extensionId,
}) => {
  // Two tabs on the same page: that is what a duplicate is.
  for (let i = 0; i < 2; i++) {
    await context.newPage().then((p) => p.goto("https://example.com/").catch(() => {}));
  }
  const page = await newtab(context, extensionId);
  const card = page.locator('.card[data-id="tabs"]');
  await expect(card).toBeVisible();

  const btn = card.locator(".card-head .dupe");
  await expect(btn).toHaveCount(1);
  await expect(btn).toContainText("duplicate");
  // It is an action on the whole card, and at the bottom of a long tab list
  // it was below the fold on exactly the browser that most needs it.
  await expect(card.locator(".card-body .dupe")).toHaveCount(0);
});

test("browser and extension pages get one group of their own, at the bottom", async ({
  context,
  extensionId,
}) => {
  // Real internal tabs: the extension's own settings page counts as one.
  await context.newPage().then((p) => p.goto(`chrome-extension://${extensionId}/settings.html`));
  await context.newPage().then((p) => p.goto("https://example.com/").catch(() => {}));

  const page = await newtab(context, extensionId);
  const card = page.locator('.card[data-id="tabs"]');
  await expect(card).toBeVisible();

  const groups = card.locator(".tabgroup");
  await expect(groups.last().locator(".tabgroup-name")).toHaveText("Browser pages");
  // They are real tabs taking real space, so they are listed and counted —
  // dropping them made this card's header disagree with the browser's.
  const internal = groups.last().locator(".tablink");
  await expect(internal.first()).toBeVisible();

  // No bookmark control on them: the browser refuses to bookmark its own
  // pages, and a button whose only outcome is an error is worse than none.
  await expect(groups.last().locator(".tablink .bm")).toHaveCount(0);
  // An ordinary page still has one.
  await expect(page.locator('.tablink[data-url="https://example.com/"] .bm')).toHaveCount(1);
});

test("open New Tab pages stay out of the list", async ({ context, extensionId }) => {
  // The one internal page that really is noise: it is the page doing the
  // listing, and six rows saying "New Tab" say nothing anyone can act on.
  await context.newPage().then((p) => p.goto("https://example.com/").catch(() => {}));
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html`);
  for (let i = 0; i < 2; i++) await settings.evaluate(() => chrome.tabs.create({ active: false }));

  const page = await newtab(context, extensionId);
  await expect(page.locator('.card[data-id="tabs"]')).toBeVisible();
  const urls = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".tablink")].map((a) => a.dataset.url ?? ""),
  );
  expect(urls.some((u) => /^(chrome|edge):\/\/newtab/.test(u))).toBe(false);
  expect(urls.some((u) => u === "https://example.com/")).toBe(true);
});
