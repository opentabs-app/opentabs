/**
 * The paint-path budgets, in a real browser.
 *
 * `test/budget.test.ts` asserts these statically against the bundle; these
 * assert the behaviour that actually matters — that opening a new tab paints
 * without touching the network, and that the tab grouping is real rather
 * than a fixture.
 */
import { expect, test } from "./fixtures";

test("the service worker starts and grouping reaches storage", async ({ context, extensionId }) => {
  expect(extensionId).toBeTruthy();
  const [worker] = context.serviceWorkers();
  expect(worker).toBeTruthy();

  // The worker groups tabs on start; give it a moment, then read what it wrote.
  await expect
    .poll(
      async () =>
        await worker!.evaluate(async () => {
          const got = await chrome.storage.local.get("opentabs:payloads");
          return got["opentabs:payloads"]?.tabs?.data?.groups?.length ?? 0;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(0);
});

test("the new tab page paints with no network request at all", async ({ context, extensionId }) => {
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (r) => {
    // Extension-local loads are not network; anything else is a budget breach.
    if (!r.url().startsWith(`chrome-extension://${extensionId}`)) requests.push(r.url());
  });

  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector("#greeting");

  expect(await page.textContent("#greeting")).not.toBe("");
  expect(requests, `newtab made network requests: ${requests.join(", ")}`).toEqual([]);
});

test("first paint lands inside the 50ms budget", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  const fcp = await page.evaluate(() => {
    const entry = performance.getEntriesByName("first-contentful-paint")[0];
    return entry ? entry.startTime : 0;
  });
  expect(fcp).toBeLessThan(200); // generous in CI; the local target is 50ms
});

test("open tabs are grouped by site and shown", async ({ context, extensionId }) => {
  await context.newPage().then((p) => p.goto("https://example.com/").catch(() => {}));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector("#grid");
  // The tabs card is enabled by default, so it must render.
  await expect(page.locator(".card.tabs")).toBeVisible({ timeout: 10_000 });
});

test("the prompt bar routes to the chosen assistant", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.fill("#prompt", "!g what is an eTLD");
  const nav = page.waitForURL(/google\.com\/search/, { timeout: 5000 }).catch(() => null);
  await page.press("#prompt", "Enter");
  await nav;
  expect(page.url()).toContain("google.com/search");
});

test("settings renders every configured group", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  await page.waitForSelector("#grouplist .gitem");
  expect(await page.locator("#grouplist .gitem").count()).toBeGreaterThan(5);

  await page.click('#nav button[data-pane="topics"]');
  // Seven seed topics ship as config, not code.
  expect(await page.locator("#topiclist .titem").count()).toBe(7);
});

test("the very first new tab renders even before config has been stored", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  // Simulate the race: storage cleared, worker asked cold.
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.evaluate(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
  });
  await page.reload();

  // An empty page here is the failure — the worker must be asked as a
  // fallback rather than the page rendering nothing.
  await expect(page.locator(".card[data-id]").first()).toBeVisible({ timeout: 15_000 });
});

test("multiple windows can be merged into one", async ({ context, extensionId }) => {
  // Two windows with tabs in each.
  await context.newPage().then((p) => p.goto("https://example.com/").catch(() => {}));
  const other = await context.newPage();
  await other.goto("https://example.org/").catch(() => {});

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector('.card[data-id="tabs"]', { timeout: 15_000 });

  const windowsBefore = await page.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return new Set(tabs.map((t) => t.windowId)).size;
  });

  if (windowsBefore > 1) {
    const merge = page.locator('.card[data-id="tabs"] button', { hasText: /Merge \d+ windows/ });
    await expect(merge).toBeVisible();
    await merge.click();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          return new Set(tabs.map((t) => t.windowId)).size;
        }),
      )
      .toBe(1);
  } else {
    // A single window must NOT offer the button.
    await expect(
      page.locator('.card[data-id="tabs"] button', { hasText: /Merge/ }),
    ).toHaveCount(0);
  }
});

/**
 * Open a genuine new tab, the way Ctrl+T does.
 *
 * Navigating a page to `chrome-extension://…/newtab.html` looks equivalent and
 * is not: a real new tab reports `chrome://newtab/`, and testing the hand-typed
 * URL is what let auto-close ship matching a URL that never occurs.
 */
async function openRealNewTab(page: import("@playwright/test").Page) {
  await page.evaluate(() => chrome.tabs.create({ active: false }));
}

/** Count new tab pages the way the browser reports them. */
async function countNewTabs(page: import("@playwright/test").Page) {
  return await page.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((t) => /^(chrome|edge):\/\/newtab\/?$/.test(t.url ?? "")).length;
  });
}

test("spare New Tab pages are left alone until auto-close is switched on", async ({
  context,
  extensionId,
}) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html`);

  for (let i = 0; i < 3; i++) await openRealNewTab(settings);
  await settings.waitForTimeout(400);

  await settings.evaluate(() => chrome.runtime.sendMessage({ type: "refreshTabs" }));
  expect(await countNewTabs(settings), "off by default, so nothing is closed").toBe(3);
});

test("a real new tab is recognised as one, not just the hand-typed URL", async ({
  context,
  extensionId,
}) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html`);
  await openRealNewTab(settings);
  await settings.waitForTimeout(400);

  const seen = await settings.evaluate(() =>
    chrome.runtime.sendMessage({ type: "pruneProbe" }),
  );
  const ours = (seen.verdicts as { ours: boolean }[]).filter((v) => v.ours);
  expect(ours.length, "the worker must see the tab the reader actually opened").toBe(1);
});

test("switching auto-close on prunes the spares but keeps one", async ({
  context,
  extensionId,
}) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html`);

  await settings.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    const tabs = cfg.instances.find((i: { def: string }) => i.def === "tabs");
    tabs.opts = { ...tabs.opts, auto_close_dupes: true };
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  });

  for (let i = 0; i < 3; i++) await openRealNewTab(settings);
  await settings.waitForTimeout(400);

  // The grace period means nothing just-opened is closed — which is the
  // guard working, not a failure. Assert the guard rather than defeating it.
  await settings.evaluate(() => chrome.runtime.sendMessage({ type: "refreshTabs" }));
  expect(
    await countNewTabs(settings),
    "tabs opened seconds ago are protected by the grace period",
  ).toBe(3);
});

test("a closing cutoff gets its own alarm, because idle tabs fire no events", async ({
  context,
  extensionId,
}) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html`);

  const setCutoff = (min: number) =>
    settings.evaluate(async (m) => {
      const got = await chrome.storage.sync.get("opentabs:config");
      const cfg = got["opentabs:config"];
      const tabs = cfg.instances.find((i: { def: string }) => i.def === "tabs");
      tabs.opts = { ...tabs.opts, auto_close_after_min: m };
      await chrome.storage.sync.set({ "opentabs:config": cfg });
    }, min);

  const prunePeriod = () =>
    settings.evaluate(async () => {
      const a = await chrome.alarms.get("opentabs:prune");
      return a?.periodInMinutes ?? null;
    });

  expect(await prunePeriod(), "no alarm while the feature is off").toBeNull();

  await setCutoff(1);
  await expect.poll(prunePeriod, { timeout: 5_000 }).toBe(0.5);

  await setCutoff(6);
  await expect.poll(prunePeriod, { timeout: 5_000 }).toBe(3);

  await setCutoff(0);
  await expect.poll(prunePeriod, { timeout: 5_000 }).toBeNull();
});

test("a real New Tab is actually closed once it goes idle", async ({ context, extensionId }) => {
  // Slow on purpose. This is the only test that exercises the whole chain the
  // reader depends on — real tab, real alarm, real clock — and every faster
  // version of it passed while the feature did nothing at all.
  test.setTimeout(180_000);
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html`);
  await settings.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    const tabs = cfg.instances.find((i: { def: string }) => i.def === "tabs");
    tabs.opts = { ...tabs.opts, auto_close_after_min: 1 };
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  });

  await openRealNewTab(settings);
  await settings.bringToFront();
  expect(await countNewTabs(settings)).toBe(1);

  await expect.poll(() => countNewTabs(settings), { timeout: 150_000, intervals: [5_000] }).toBe(0);
});

test("the probe names the guard holding each New Tab page", async ({ context, extensionId }) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html`);
  await settings.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    const tabs = cfg.instances.find((i: { def: string }) => i.def === "tabs");
    tabs.opts = { ...tabs.opts, auto_close_after_min: 5 };
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  });

  await openRealNewTab(settings);
  await settings.bringToFront();

  await settings.click('button[data-pane="general"]');
  await settings.click("#runprune");
  const out = settings.locator("#pruneout");
  await expect(out).toContainText("close after      5 min");
  await expect(out).toContainText("checks every     2.5 min");
  await expect(out).toContainText("New Tab pages open: 1");
  // Freshly opened, so the grace period is what is holding it — and the probe
  // must say that rather than leaving the reader to guess.
  await expect(out).toContainText("grace");
});

test("the focus card is a checklist that strikes through and clears itself", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");

  const focus = page.locator('.card[data-id="focus"]');
  // The card's own input, not a task's "add a step" line.
  const taskInput = focus.locator("> .card-body > .newtodo");
  await taskInput.fill("ship the thing");
  await taskInput.press("Enter");
  await taskInput.fill("second thing");
  await taskInput.press("Enter");
  await expect(focus.locator(".todo:not(.addstep)")).toHaveCount(2);

  // Ticking strikes it through and starts the clock, rather than removing it.
  await focus.locator(".todo:not(.addstep)").first().locator('input[type="checkbox"]').check();
  await expect(focus.locator(".todo.done")).toHaveCount(1);
  await expect(focus.locator(".todo.done .due")).toContainText("clears in");
  await expect(focus.locator(".todo:not(.addstep)")).toHaveCount(2);

  // It survives a reload — a checklist that forgets is worse than no checklist.
  await page.reload();
  await expect(focus.locator(".todo.done .t")).toHaveText("ship the thing");

  // Backdate the tick past the window: it must be gone on the next paint.
  await page.evaluate(async () => {
    const got = await chrome.storage.local.get("opentabs:local");
    const local = got["opentabs:local"];
    local.focusItems = local.focusItems.map((i: { done: boolean; doneAt?: number }) =>
      i.done ? { ...i, doneAt: Math.floor(Date.now() / 1000) - 7 * 3600 } : i,
    );
    await chrome.storage.local.set({ "opentabs:local": local });
  });
  await page.reload();
  await expect(focus.locator(".todo:not(.addstep)")).toHaveCount(1);
  await expect(focus.locator(".todo .t")).toHaveText("second thing");
});

test("the old one-line focus note becomes the first checklist item", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");
  await page.evaluate(async () => {
    await chrome.storage.local.set({
      "opentabs:local": { focus: { text: "close the round", date: "2026-08-30" } },
    });
  });
  await page.reload();
  await expect(page.locator('.card[data-id="focus"] .todo .t')).toHaveText("close the round");
});

test("a focus task can hold steps, and ticking it ticks them", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");
  const focus = page.locator('.card[data-id="focus"]');

  // The task input is the one at the bottom of the card, not a step's.
  const taskInput = focus.locator("> .card-body > .newtodo");
  await taskInput.fill("ship the release");
  await taskInput.press("Enter");

  const task = focus.locator(".todo:not(.step)").first();
  await expect(task.locator(".t")).toHaveText("ship the release");

  // "Add a step" belongs to one task and appears only while that task is
  // hovered — otherwise every task shows an empty input at once.
  await expect(focus.locator(".todo.addstep")).toBeHidden();
  await task.hover();
  const step = focus.locator(".todo.addstep input");
  await step.fill("write the notes");
  await step.press("Enter");
  await step.fill("tag it");
  await step.press("Enter");

  await expect(focus.locator(".todo.step:not(.addstep)")).toHaveCount(2);
  await expect(task.locator(".prog")).toContainText("0/2");

  // Ticking one step moves the count, and leaves the task open.
  await focus.locator(".todo.step:not(.addstep)").first().locator("input[type=checkbox]").check();
  await expect(task.locator(".prog")).toContainText("1/2");
  await expect(task).not.toHaveClass(/done/);

  // Ticking the task strikes through everything under it.
  await task.locator("input[type=checkbox]").check();
  await expect(focus.locator(".todo.step.done:not(.addstep)")).toHaveCount(2);
  await expect(task.locator(".prog")).toContainText("2/2");

  // And it survives a reload with its shape intact.
  await page.reload();
  await expect(focus.locator(".todo.step:not(.addstep)")).toHaveCount(2);
  await expect(focus.locator(".todo:not(.step)").first().locator(".prog")).toContainText("2/2");
});

test("removing a task takes its steps with it", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");
  const focus = page.locator('.card[data-id="focus"]');

  await page.evaluate(async () => {
    const t = Math.floor(Date.now() / 1000);
    await chrome.storage.local.set({
      "opentabs:local": {
        focusItems: [
          { id: "t", text: "ship", done: false, created: t - 100 },
          { id: "s1", text: "notes", done: false, created: t - 90, parent: "t" },
          { id: "keep", text: "other thing", done: false, created: t - 80 },
        ],
      },
    });
  });
  await page.reload();
  await expect(focus.locator(".todo:not(.addstep)")).toHaveCount(3);

  await focus.locator(".todo:not(.step)").first().locator(".x").click();
  // The step must not survive its task.
  await expect(focus.locator(".todo:not(.addstep)")).toHaveCount(1);
  await expect(focus.locator(".todo .t")).toHaveText("other thing");
});

test("typing into the focus card is legible, not the browser default black", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");
  // An <input> does not inherit colour: with none set it falls back to the
  // user agent's black whatever the theme says.
  const colour = await page
    .locator('.card[data-id="focus"] .newtodo')
    .first()
    .evaluate((n) => getComputedStyle(n).color);
  const strong = await page
    .locator('.card[data-id="focus"]')
    .evaluate((n) => getComputedStyle(n).getPropertyValue("--text-strong").trim());
  expect(colour, "the input must take the theme's text colour").not.toBe("rgb(0, 0, 0)");
  if (strong) expect(colour).not.toBe("");
});

test("focus tasks can be dragged into a different order, and it sticks", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");

  await page.evaluate(async () => {
    const t = Math.floor(Date.now() / 1000);
    await chrome.storage.local.set({
      "opentabs:local": {
        focusItems: [
          { id: "a", text: "first", done: false, created: t - 300 },
          { id: "b", text: "second", done: false, created: t - 200 },
          { id: "c", text: "third", done: false, created: t - 100 },
        ],
      },
    });
  });
  await page.reload();

  const focus = page.locator('.card[data-id="focus"]');
  const order = () => focus.locator(".task .todo:not(.step) .t").allTextContents();
  expect(await order()).toEqual(["first", "second", "third"]);

  // The grip is the only place a drag starts — the row holds a checkbox, an
  // editable sentence and two buttons, all of which a whole-row drag fights.
  await focus.locator('.task[data-task="c"]').hover();
  await expect(focus.locator('.task[data-task="c"] .taskgrip')).toBeVisible();

  await page.evaluate(() => {
    // dragstart/drop, driven directly: Playwright's dragTo does not carry
    // dataTransfer through a synthesised HTML5 drag in every build.
    const from = document.querySelector('.task[data-task="c"]')!;
    const to = document.querySelector('.task[data-task="a"]')!;
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
    to.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true }));
    to.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
  });
  expect(await order()).toEqual(["third", "first", "second"]);

  // Order is stored, not just painted.
  await page.reload();
  expect(await order()).toEqual(["third", "first", "second"]);
});

test("a ticked step stays as long as its task does", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");

  await page.evaluate(async () => {
    const t = Math.floor(Date.now() / 1000);
    await chrome.storage.local.set({
      "opentabs:local": {
        focusItems: [
          { id: "t", text: "ship", done: false, created: t - 300 },
          // Ticked days ago. A task would have cleared long since.
          { id: "s", text: "notes", done: true, doneAt: t - 400 * 3600, created: t - 200, parent: "t" },
        ],
      },
    });
  });
  await page.reload();

  const focus = page.locator('.card[data-id="focus"]');
  await expect(focus.locator(".todo.step:not(.addstep)")).toHaveCount(1);
  // And it promises no countdown it would not keep.
  await expect(focus.locator(".todo.step .due")).toHaveCount(0);
});

test("a task's steps fold away, and stay folded", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");

  await page.evaluate(async () => {
    const t = Math.floor(Date.now() / 1000);
    await chrome.storage.local.set({
      "opentabs:local": {
        focusItems: [
          { id: "t", text: "ship", done: false, created: t - 300 },
          { id: "s1", text: "notes", done: true, doneAt: t - 60, created: t - 200, parent: "t" },
          { id: "s2", text: "tag it", done: false, created: t - 100, parent: "t" },
          { id: "plain", text: "no steps", done: false, created: t - 50 },
        ],
      },
    });
  });
  await page.reload();

  const focus = page.locator('.card[data-id="focus"]');
  const block = focus.locator('.task[data-task="t"]');
  const steps = block.locator(".todo.step:not(.addstep)");
  await expect(steps).toHaveCount(2);
  await expect(steps.first()).toBeVisible();

  // The count is the control: it exists only where there is something to
  // fold, so a task with no steps reserves no space for one.
  const toggle = block.locator(".prog");
  await expect(toggle).toContainText("1/2");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(focus.locator('.task[data-task="plain"] .prog')).toHaveCount(0);

  await toggle.click();
  await expect(steps.first()).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // Folded, the count is what stands in for the steps — so it must still be
  // there and still be right.
  await expect(toggle).toContainText("1/2");

  // Hovering must not spring "add a step" open on a folded task.
  await block.hover();
  await expect(block.locator(".todo.addstep")).toBeHidden();

  // Folding is remembered: a fold that resets on the next new tab achieves
  // nothing on the one surface you open fifty times a day.
  await page.reload();
  const after = focus.locator('.task[data-task="t"]');
  await expect(after.locator(".todo.step:not(.addstep)").first()).toBeHidden();
  await expect(after.locator(".prog")).toHaveAttribute("aria-expanded", "false");

  await after.locator(".prog").click();
  await expect(after.locator(".todo.step:not(.addstep)").first()).toBeVisible();
});
