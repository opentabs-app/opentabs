/**
 * The wasm↔JS boundary, which only exists in a real browser.
 *
 * Unit tests on either side of it pass while the boundary itself is broken:
 * `serde_wasm_bindgen` defaulted to serialising maps as ES `Map`s, so
 * `Instance.opts` arrived in JS as a Map. `opts.sources` was then `undefined`
 * everywhere, writes to it were dropped by `JSON.stringify`, and a topic with
 * five sources configured reported "No sources configured".
 */
import { expect, test } from "./fixtures";

// Evaluated from an extension page, not the worker: chrome.runtime
// .sendMessage does not deliver to a listener in the same context.
test("config crosses the wasm boundary as plain objects, not Maps", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);

  const shape = await page.evaluate(async () => {
    const res = await chrome.runtime.sendMessage({ type: "config" });
    const ai = res.config.instances.find((i: { id: string }) => i.id === "ai");
    return {
      optsIsMap: ai.opts instanceof Map,
      optsIsPlainObject: Object.getPrototypeOf(ai.opts) === Object.prototype,
      sourceCount: Array.isArray(ai.opts.sources) ? ai.opts.sources.length : -1,
      query: typeof ai.opts.query,
      // The thing that actually broke: survives a JSON round trip.
      survivesJson: JSON.parse(JSON.stringify(ai.opts)).sources?.length ?? -1,
    };
  });

  expect(shape.optsIsMap, "opts must not be an ES Map").toBe(false);
  expect(shape.optsIsPlainObject).toBe(true);
  expect(shape.sourceCount, "the AI seed topic ships five sources").toBe(5);
  expect(shape.query).toBe("string");
  expect(shape.survivesJson, "opts must survive being stored as JSON").toBe(5);
});

test("every seed topic resolves its bindings to fetchable URLs", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);

  const resolved = await page.evaluate(async () => {
    const res = await chrome.runtime.sendMessage({ type: "config" });
    const out: Record<string, number> = {};
    for (const i of res.config.instances.filter((x: { def: string }) => x.def === "topic")) {
      out[i.id] = (i.opts.sources ?? []).length;
    }
    return out;
  });

  // "No sources configured" was the symptom; zero here is the cause.
  for (const [id, n] of Object.entries(resolved)) {
    expect(n, `topic ${id} has no sources`).toBeGreaterThan(0);
  }
});

test("the topic editor shows the sources a topic actually has", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  await page.click('#nav button[data-pane="topics"]');
  await page.waitForSelector("#topiclist .titem");

  const ai = page.locator("#topiclist .titem").filter({ hasText: "AI" }).first();
  await ai.getByRole("button", { name: "edit", exact: true }).click();
  await expect(ai.locator(".srcrow")).toHaveCount(5);
  await expect(ai.locator(".srcrow .who").first()).toContainText("googlenews");
});

test("adding a source persists through storage", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  await page.click('#nav button[data-pane="topics"]');
  await page.waitForSelector("#topiclist .titem");

  const ai = page.locator("#topiclist .titem").filter({ hasText: "AI" }).first();
  await ai.getByRole("button", { name: "edit", exact: true }).click();
  // Scoped: the topic editor also has a recency dropdown.
  await ai.locator(".addrow select").selectOption("bingnews");
  await ai.getByRole("button", { name: "Add source", exact: true }).click();

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const got = await chrome.storage.sync.get("opentabs:config");
        const cfg = got["opentabs:config"];
        const t = cfg.instances.find((i: { id: string }) => i.id === "ai");
        return (t.opts.sources ?? []).length;
      }),
    )
    .toBe(6);
});

test("a config damaged by the v1 Map fault heals itself on load", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);

  // Write exactly what the Map bug persisted: topics whose opts stringified
  // to {}. This is the state a real profile is now in.
  await page.evaluate(async () => {
    await chrome.storage.sync.set({
      "opentabs:config": {
        version: 1,
        theme: "auto",
        assistant: "claude",
        instances: [
          { def: "tabs", id: "tabs", name: "Right now", enabled: true, opts: {} },
          { def: "topic", id: "ai", name: "AI", enabled: true, opts: {} },
          { def: "topic", id: "hft", name: "High Frequency Trading", enabled: true, opts: {} },
        ],
      },
    });
  });

  const healed = await page.evaluate(async () => {
    const res = await chrome.runtime.sendMessage({ type: "config" });
    const byId = (id: string) =>
      res.config.instances.find((i: { id: string }) => i.id === id);
    return {
      version: res.config.version,
      aiSources: byId("ai").opts.sources?.length ?? 0,
      hftSources: byId("hft").opts.sources?.length ?? 0,
      hftQuery: byId("hft").opts.query,
      hftName: byId("hft").name,
    };
  });

  // Assert it migrated forward, not the exact number — pinning the version
  // makes every future bump a test failure with nothing to learn from it.
  expect(healed.version).toBeGreaterThan(1);
  expect(healed.aiSources, "a seed topic gets its shipped sources back").toBeGreaterThan(0);
  expect(healed.hftSources, "a user's own topic gets a working default").toBe(1);
  expect(healed.hftQuery, "keyed on what the user named it").toBe("High Frequency Trading");
  expect(healed.hftName).toBe("High Frequency Trading");

  // And the repair is written back, not just held in memory.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const got = await chrome.storage.sync.get("opentabs:config");
        return got["opentabs:config"].version;
      }),
    )
    .toBeGreaterThan(1);
});

test("a search-only topic with an empty query says so, and is not called sourceless", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);

  // Sources present, query empty: every binding is a search with nothing to
  // search for. This resolves to zero URLs, and used to be reported as "No
  // sources configured" — which sent people looking in the wrong place.
  await page.evaluate(async () => {
    await chrome.storage.sync.set({
      "opentabs:config": {
        version: 2,
        theme: "auto",
        assistant: "claude",
        instances: [
          {
            def: "topic", id: "ai", name: "AI", enabled: true,
            opts: {
              query: "",
              sources: [{ kind: "query", tmpl: "googlenews", weight: 1 }],
              limit: 8, exclude: [], include: [],
            },
          },
        ],
      },
    });
  });
  await page.reload();
  await page.click('#nav button[data-pane="topics"]');
  // The settings page fills its lists from the worker, which under a full
  // suite is not instant — the nav button exists in the HTML long before the
  // topics do, so clicking through immediately raced an empty list.
  const ai = page.locator("#topiclist .titem").first();
  await expect(ai).toBeVisible({ timeout: 15_000 });
  await ai.getByRole("button", { name: "edit", exact: true }).click();
  await expect(ai.getByText("the Query box is empty")).toBeVisible();
});

test("the recency window is settable and persists", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  await page.click('#nav button[data-pane="topics"]');
  const ai = page.locator("#topiclist .titem").filter({ hasText: "AI" }).first();
  await ai.getByRole("button", { name: "edit", exact: true }).click();

  // Seed topics ship as news: last 24 hours.
  const age = ai.locator(".field select").last();
  await expect(age).toHaveValue("24");

  await age.selectOption("168");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const got = await chrome.storage.sync.get("opentabs:config");
        const t = got["opentabs:config"].instances.find((i: { id: string }) => i.id === "ai");
        return t.opts.max_age_hours;
      }),
    )
    .toBe(168);
});

test("X search defaults to a launcher that fetches nothing and asks for no access", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);

  const mode = await page.evaluate(async () => {
    const res = await chrome.runtime.sendMessage({ type: "config" });
    const x = res.config.instances.find((i: { id: string }) => i.id === "xsearch");
    const origins = await chrome.runtime.sendMessage({ type: "originsFor", instance: x });
    return { mode: x.opts.mode, enabled: x.enabled, origins: origins.origins };
  });

  expect(mode.mode).toBe("launcher");
  expect(mode.enabled, "opt-in, like every risky thing").toBe(false);
  // The launcher fetches nothing, so enabling it must not request site access.
  expect(mode.origins).toEqual([]);
});

test("a pasted advanced-search URL fills the fields in", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);

  const fields = await page.evaluate(async () => {
    const q = "microduck -crypto -contract -gem until:2026-08-30 since:2026-08-29";
    const res = await chrome.runtime.sendMessage({ type: "xParse", q });
    return res.fields;
  });

  expect(fields.all).toBe("microduck");
  expect(fields.none).toBe("crypto contract gem");
  expect(fields.since).toBe("2026-08-29");
  expect(fields.until).toBe("2026-08-30");
});

test("you can keep as many X searches as you like", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  await page.click('#nav button[data-pane="topics"]');

  for (const name of ["@elonmusk", "microduck", "@nasa"]) {
    await page.fill("#newx", name);
    await page.getByRole("button", { name: "Add X search", exact: true }).click();
  }

  const made = await page.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    return got["opentabs:config"].instances
      .filter((i: { def: string }) => i.def === "xsearch")
      .map((i: { id: string; name: string; opts: Record<string, never> }) => ({
        id: i.id,
        name: i.name,
        fields: i.opts.query_fields,
      }));
  });

  // Three added, plus the one that ships.
  expect(made.length).toBeGreaterThanOrEqual(4);
  expect(new Set(made.map((m: { id: string }) => m.id)).size).toBe(made.length);

  const elon = made.find((m: { name: string }) => m.name === "@elonmusk");
  expect(elon.fields.from, "an @name becomes a from: filter").toBe("elonmusk");
  expect(elon.fields.window_days, "rolling by default").toBe(1);

  const duck = made.find((m: { name: string }) => m.name === "microduck");
  expect(duck.fields.all, "a plain name becomes search words").toBe("microduck");
});

test("a saved X search re-dates itself instead of freezing", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);

  const urls = await page.evaluate(async () => {
    const inst = {
      def: "xsearch", id: "x_t", name: "t", enabled: true,
      opts: { query_fields: { all: "microduck", window_days: 1 }, mode: "launcher" },
    };
    const a = await chrome.runtime.sendMessage({ type: "xWebUrl", instance: inst });
    return { url: a.url };
  });

  // The dates are computed now, not stored — so today appears in the URL.
  const today = new Date().toISOString().slice(0, 10);
  expect(decodeURIComponent(urls.url)).toContain(`until:${today}`);
  expect(decodeURIComponent(urls.url)).toContain("since:");
  expect(decodeURIComponent(urls.url)).toContain("microduck");
});

test("adding a calendar switches the calendar group on", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  await page.click('#nav button[data-pane="calendar"]');

  const before = await page.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    return got["opentabs:config"].instances.find((i: { def: string }) => i.def === "calendar")
      ?.enabled;
  });
  expect(before, "calendar ships off, like everything else").toBe(false);

  await page.fill("#newcal", "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics");
  await page.getByRole("button", { name: "Add calendar", exact: true }).click();

  // The address is stored locally, never synced — it is a bearer secret.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const local = await chrome.storage.local.get("opentabs:local");
        return (local["opentabs:local"]?.calendarUrls ?? []).length;
      }),
    )
    .toBe(1);

  // And the group is now on, which is the bug this covers.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const got = await chrome.storage.sync.get("opentabs:config");
        return got["opentabs:config"].instances.find((i: { def: string }) => i.def === "calendar")
          ?.enabled;
      }),
    )
    .toBe(true);

  const synced = await page.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    return JSON.stringify(got["opentabs:config"]).includes("private-abc");
  });
  expect(synced, "a calendar secret must never reach storage.sync").toBe(false);
});

test("a calendar card explains itself instead of vanishing", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  await page.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    const cal = cfg.instances.find((i: { def: string }) => i.def === "calendar");
    cal.enabled = true;
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  });

  const tab = await context.newPage();
  await tab.goto(`chrome-extension://${extensionId}/newtab.html`);
  // Enabled with no address: the card must appear and say what to do.
  await expect(tab.locator('.card[data-id="calendar"]')).toBeVisible({ timeout: 15_000 });
});

test("the Filters and Engagement controls reach the emitted X query", async ({
  context,
  extensionId,
}) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html`);

  const id = await settings.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    const x = cfg.instances.find((i: { def: string }) => i.def === "xsearch");
    return (x?.id as string) ?? null;
  });
  test.skip(id === null, "no xsearch group in the shipped config");

  await settings.click('button[data-pane="topics"]');
  const editor = settings.locator(`#pane-topics [data-instance="${id}"]`);
  await editor.locator("button", { hasText: "edit" }).first().click();

  // The three sections X's own advanced search has, which the editor lacked.
  await expect(editor.locator(".subhead", { hasText: "Filters" })).toHaveCount(1);
  await expect(editor.locator(".subhead", { hasText: "Engagement" })).toHaveCount(1);

  await settings.evaluate(async (instId) => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    const x = cfg.instances.find((i: { id: string }) => i.id === instId);
    x.opts.query_fields = {
      ...x.opts.query_fields,
      all: "microduck",
      to: "@sfbart",
      replies: "none",
      links: "only",
      min_likes: 25,
      min_replies: 3,
      window_days: 1,
    };
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  }, id);

  const url = await settings.evaluate(async (instId) => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    const inst = cfg.instances.find((i: { id: string }) => i.id === instId);
    const r = await chrome.runtime.sendMessage({ type: "xWebUrl", instance: inst });
    return r.url as string;
  }, id);

  const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
  expect(q).toContain("to:sfbart");
  expect(q).toContain("-filter:replies");
  expect(q).toContain("filter:links");
  expect(q).toContain("min_faves:25");
  expect(q).toContain("min_replies:3");
});

test("recent bookmarks ships off, asks for its own permission, and explains itself", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");

  const inst = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "config" });
    return r.config.instances.find((i: { def: string }) => i.def === "bookmarks") ?? null;
  });
  expect(inst, "the group must exist for anyone who already has a config").not.toBeNull();
  expect(inst.enabled, "a release must never switch a group on for you").toBe(false);

  // Reading bookmarks is an optional permission, so it is not held on install.
  const held = await page.evaluate(() =>
    chrome.permissions.contains({ permissions: ["bookmarks"] }),
  );
  expect(held).toBe(false);

  // Switched on without the permission, the card must say so rather than vanish.
  await page.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    const b = cfg.instances.find((i: { def: string }) => i.def === "bookmarks");
    b.enabled = true;
    await chrome.storage.sync.set({ "opentabs:config": cfg });
    await chrome.runtime.sendMessage({ type: "refresh" });
  });
  await page.reload();
  const card = page.locator('.card[data-id="bookmarks"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("cannot read your bookmarks");
  // An empty state must never be a dead end.
  await expect(card.locator("button", { hasText: "Open settings" })).toHaveCount(1);
});

test("bookmarks render newest first, with host and folder", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");

  await page.evaluate(async () => {
    const t = Math.floor(Date.now() / 1000);
    const got = await chrome.storage.local.get("opentabs:payloads");
    const p = got["opentabs:payloads"] ?? {};
    p.bookmarks = {
      instanceId: "bookmarks",
      data: [
        { id: "1", title: "Rust book", url: "https://doc.rust-lang.org/book/", folder: "Reading", added: t - 300 },
        { id: "2", title: "Hacker News", url: "https://news.ycombinator.com/", folder: "", added: t - 7200 },
      ],
      generated_at: t,
      stale_after: t + 9999,
    };
    await chrome.storage.local.set({ "opentabs:payloads": p });
    const cfg = (await chrome.storage.sync.get("opentabs:config"))["opentabs:config"];
    cfg.instances.find((i: { def: string }) => i.def === "bookmarks").enabled = true;
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  });
  await page.reload();

  const card = page.locator('.card[data-id="bookmarks"]');
  const rows = card.locator(".row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator(".row-title")).toHaveText("Rust book");
  await expect(rows.first().locator(".row-title")).toHaveAttribute(
    "href",
    "https://doc.rust-lang.org/book/",
  );
  // Host without the www, and the folder only when there is a real one.
  await expect(rows.first().locator(".row-sub")).toHaveText("doc.rust-lang.org · Reading");
  await expect(rows.nth(1).locator(".row-sub")).toHaveText("news.ycombinator.com");
});

test("a bookmarks card can be scoped to a folder, and several can coexist", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector(".card");

  // Two folder-scoped cards, as the settings adder would create them.
  await page.evaluate(async () => {
    const t = Math.floor(Date.now() / 1000);
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    for (const [id, name, folder] of [
      ["bm_10", "Reading", "10"],
      ["bm_20", "Work", "20"],
    ]) {
      cfg.instances.push({
        def: "bookmarks", id, name, enabled: true,
        opts: { limit: 10, show_folder: false, folder_id: folder, folder_name: name },
      });
    }
    await chrome.storage.sync.set({ "opentabs:config": cfg });

    const p = (await chrome.storage.local.get("opentabs:payloads"))["opentabs:payloads"] ?? {};
    p.bm_10 = {
      instanceId: "bm_10", generated_at: t, stale_after: t + 9999,
      data: [{ id: "a", title: "The Rust Book", url: "https://doc.rust-lang.org/book/", folder: "Reading", added: t - 60 }],
    };
    p.bm_20 = {
      instanceId: "bm_20", generated_at: t, stale_after: t + 9999,
      data: [{ id: "b", title: "Internal wiki", url: "https://wiki.example.com/", folder: "Work", added: t - 60 }],
    };
    await chrome.storage.local.set({ "opentabs:payloads": p });
  });
  await page.reload();

  // Two cards of the same def, each showing only its own folder.
  await expect(page.locator('.card[data-id="bm_10"] .card-title')).toHaveText("Reading");
  await expect(page.locator('.card[data-id="bm_20"] .card-title')).toHaveText("Work");
  await expect(page.locator('.card[data-id="bm_10"] .row-title')).toHaveText("The Rust Book");
  await expect(page.locator('.card[data-id="bm_20"] .row-title')).toHaveText("Internal wiki");

  // And each has its own gear, landing on its own editor.
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings.html#i=bm_20`);
  await expect(settings.locator('#pane-groups [data-instance="bm_20"]')).toHaveClass(/open/);
  // A folder group a reader added is theirs to delete; the shipped one is not.
  await expect(
    settings.locator('[data-instance="bm_20"] button', { hasText: "remove" }),
  ).toHaveCount(1);
  await expect(
    settings.locator('#pane-groups [data-instance="bookmarks"] button', { hasText: "remove" }),
  ).toHaveCount(0);
});

test("each tab row offers to bookmark it", async ({ context, extensionId }) => {
  // A real tab, because the tabs card is live: it regroups on every tab event,
  // so a payload written into storage is overwritten before the page reads it.
  await context.newPage().then((p) => p.goto("https://example.com/").catch(() => {}));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await page.waitForSelector("#grid");
  await page.waitForTimeout(1_000);
  await page.reload();

  const row = page.locator('.tablink[data-url="https://example.com/"]');
  const mark = row.locator(".bm");
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute("aria-label", "Save as a bookmark");

  // Without the permission it must ask rather than fail silently, and it must
  // never mark a tab as saved when nothing was saved.
  await mark.click();
  await expect(row).not.toHaveAttribute("data-saved", "1");
  // Clicking the mark must not also trigger the row's own jump-to-tab handler.
  await expect(page.locator('.card[data-id="tabs"]')).toBeVisible();

});

test("the marketplace pane asks for access before it can show anything", async ({
  context,
  extensionId,
}) => {
  // Against the unmodified build: someone who never opens this pane is never
  // asked, which is the whole reason the origin is optional rather than in
  // the manifest.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  await page.click('#nav button[data-pane="market"]');

  const note = page.locator("#marketaccess");
  await expect(note).toBeVisible();
  await expect(note).toContainText("no account and no cookie");
  await expect(note.locator("button")).toHaveCount(1);
  await expect(page.locator("#marketlist")).toBeEmpty();

  const held = await page.evaluate(() =>
    chrome.permissions.contains({ origins: ["https://market.opentabs.app/*"] }),
  );
  expect(held).toBe(false);
});
