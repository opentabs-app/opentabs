/**
 * The marketplace, inside the extension.
 *
 * The API is stubbed at the network layer rather than mocked in code, so what
 * is exercised is the real fetch, the real permission check, the real wasm
 * validation and the real config merge — everything except the server.
 */
import { expect, test } from "./fixtures-granted";

const ORIGIN = "https://market.opentabs.app";

function listing(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "group",
    name: id.toUpperCase(),
    description: `Twelve good sources for ${id}, ranked by corroboration.`,
    author: "someone",
    tags: ["ai"],
    published: Math.floor(Date.now() / 1000) - 3600,
    updated: Math.floor(Date.now() / 1000) - 3600,
    likes: 12,
    installs: 40,
    hidden: false,
    ...over,
  };
}

function pack(id: string, over: Record<string, unknown> = {}) {
  return {
    format: 1,
    kind: "group",
    id,
    name: id.toUpperCase(),
    description: `Twelve good sources for ${id}, ranked by corroboration.`,
    author: "someone",
    tags: ["ai"],
    instances: [
      {
        def: "topic",
        id,
        name: id.toUpperCase(),
        enabled: true,
        opts: { query: id, sources: [{ kind: "query", tmpl: "googlenews", weight: 1 }], limit: 8 },
      },
    ],
    ...over,
  };
}

/** Stub the marketplace and grant access, then open Settings on the pane. */
async function openMarket(
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
  routes: {
    listings?: unknown[];
    packs?: Record<string, unknown>;
    fail?: boolean;
  } = {},
) {
  await context.route(`${ORIGIN}/**`, async (route) => {
    if (routes.fail) return route.abort("failed");
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/packs") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const all = (routes.listings ?? []) as { name: string }[];
      const listings = q ? all.filter((l) => l.name.toLowerCase().includes(q)) : all;
      return route.fulfill({
        json: { listings, tags: [{ tag: "ai", count: listings.length }], total: listings.length },
      });
    }
    const m = /^\/v1\/packs\/([^/]+)\/install$/.exec(url.pathname);
    if (m && routes.packs?.[m[1]!]) return route.fulfill({ json: routes.packs[m[1]!] });
    return route.fulfill({ status: 404, json: { error: "No such pack." } });
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  await page.click('#nav button[data-pane="market"]');
  return page;
}

test("packs are listed, searched and installed", async ({ context, extensionId }) => {
  // Neither name is one of the shipped seed topics, so a collision here would
  // be the install's doing rather than the default config's.
  const page = await openMarket(context, extensionId, {
    listings: [listing("semiconductors"), listing("shipping")],
    packs: { shipping: pack("shipping") },
  });

  const rows = page.locator("#marketlist .titem");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("SEMICONDUCTORS");
  await expect(rows.first()).toContainText("♥ 12");

  await page.fill("#marketsearch", "semi");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("SEMICONDUCTORS");

  await page.fill("#marketsearch", "ship");
  // The search is debounced, so the list is still the previous one for a
  // moment — clicking before it settles adds whatever was there before.
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("SHIPPING");
  await rows.first().locator("button", { hasText: "Add" }).click();
  await expect(page.locator("#savebar")).toContainText("Added");

  // It reached the stored config, not just the toast.
  const added = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "config" });
    return r.config.instances.find((i: { id: string }) => i.id === "shipping") ?? null;
  });
  expect(added).not.toBeNull();
  expect(added.def).toBe("topic");
  expect(added.enabled).toBe(true);
});

test("installing never overwrites a group you already have", async ({ context, extensionId }) => {
  // Someone's "AI" must not silently replace the AI you spent an hour on.
  const page = await openMarket(context, extensionId, {
    listings: [listing("ai")],
    packs: { ai: pack("ai") },
  });

  const before = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "config" });
    return r.config.instances.find((i: { id: string }) => i.id === "ai")?.opts ?? null;
  });
  expect(before).not.toBeNull();

  await page.locator("#marketlist .titem button", { hasText: "Add" }).first().click();
  await expect(page.locator("#savebar")).toContainText("already had one");

  const after = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "config" });
    const mine = r.config.instances.find((i: { id: string }) => i.id === "ai");
    const theirs = r.config.instances.filter((i: { id: string }) => i.id.startsWith("ai-"));
    return { mine: mine?.opts ?? null, extra: theirs.length };
  });
  expect(after.mine).toEqual(before);
  expect(after.extra).toBe(1);
});

test("a marketplace that cannot be reached says so, and is not an empty one", async ({
  context,
  extensionId,
}) => {
  const page = await openMarket(context, extensionId, { fail: true });
  await expect(page.locator("#marketlist")).toContainText("Could not reach the marketplace");
  // "Nothing published" would be a different and much worse thing to believe.
  await expect(page.locator("#marketlist")).not.toContainText("No packs published");
});

test("a pasted pack is shown before it is applied, and only then", async ({
  context,
  extensionId,
}) => {
  const page = await openMarket(context, extensionId, { listings: [] });

  await page.fill("#packpaste", JSON.stringify(pack("quant", { name: "Quant" })));
  await page.click("#packload");

  // A pack is a document from a stranger: "press this and find out" is not a
  // reasonable thing to ask.
  const preview = page.locator("#packpreview .titem");
  await expect(preview).toContainText("Quant");
  await expect(preview).toContainText("topic");

  const beforeCount = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "config" });
    return r.config.instances.length;
  });

  await preview.locator("button", { hasText: "Add to OpenTabs" }).click();
  await expect(page.locator("#savebar")).toContainText("Added");
  const afterCount = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "config" });
    return r.config.instances.length;
  });
  expect(afterCount).toBe(beforeCount + 1);
});

test("a link from anywhere but the marketplace is refused", async ({ context, extensionId }) => {
  // "Paste a URL and we will apply whatever comes back" is a request to
  // install arbitrary configuration from anywhere.
  const page = await openMarket(context, extensionId, { listings: [] });
  await page.fill("#packpaste", "https://evil.test/v1/packs/x/install");
  await page.click("#packload");
  await expect(page.locator("#packpreview")).toContainText("Only links from");
});

test("a pack carrying a key or a calendar is refused by the extension too", async ({
  context,
  extensionId,
}) => {
  const page = await openMarket(context, extensionId, { listings: [] });

  const leaky = pack("leaky", {
    instances: [
      { def: "calendar", id: "leaky", name: "Leaky", enabled: true, opts: { urls: ["https://x"] } },
    ],
  });
  await page.fill("#packpaste", JSON.stringify(leaky));
  await page.click("#packload");
  await page.locator("#packpreview button", { hasText: "Add to OpenTabs" }).click();

  // A calendar address is a bearer secret, so a shareable calendar is a
  // leaked one — refused here as well as on the server.
  await expect(page.locator("#savebar")).toContainText("cannot be shared");
  const hasIt = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "config" });
    return r.config.instances.some((i: { id: string }) => i.id === "leaky");
  });
  expect(hasIt).toBe(false);
});

test("a theme pack repaints the new tab page and travels in the config", async ({
  context,
  extensionId,
}) => {
  const page = await openMarket(context, extensionId, { listings: [] });
  const theme = {
    format: 1,
    kind: "theme",
    id: "midnight",
    name: "Midnight",
    description: "A calm dark palette for reading late at night.",
    author: "someone",
    tags: ["dark"],
    instances: [],
    theme: {
      base: "dark",
      font: "Inter, sans-serif",
      colors: { bg: "#0b0b0d", "text-strong": "#f2f2f0" },
    },
  };
  await page.fill("#packpaste", JSON.stringify(theme));
  await page.click("#packload");
  await page.locator("#packpreview button", { hasText: "Add to OpenTabs" }).click();
  await expect(page.locator("#savebar")).toContainText("Theme applied");

  const newtab = await context.newPage();
  await newtab.goto(`chrome-extension://${extensionId}/newtab.html`);
  await newtab.waitForSelector(".card");
  const applied = await newtab.evaluate(() => ({
    bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
    font: getComputedStyle(document.documentElement).getPropertyValue("--font").trim(),
    cls: document.documentElement.className,
  }));
  expect(applied.bg).toBe("#0b0b0d");
  expect(applied.font).toBe("Inter, sans-serif");
  expect(applied.cls).toContain("oa-dark");
});

test("a theme cannot smuggle a request into the stylesheet", async ({ context, extensionId }) => {
  const page = await openMarket(context, extensionId, { listings: [] });
  await page.fill(
    "#packpaste",
    JSON.stringify({
      format: 1,
      kind: "theme",
      id: "sneaky",
      name: "Sneaky",
      description: "Looks like an ordinary dark theme, and mostly is.",
      author: "someone",
      tags: [],
      instances: [],
      theme: {
        base: "dark",
        font: "url(https://tracker.test/f.woff2)",
        colors: { bg: "#101010", "border-focus": "url(https://tracker.test/p.gif)" },
      },
    }),
  );
  await page.click("#packload");
  await page.locator("#packpreview button", { hasText: "Add to OpenTabs" }).click();
  await expect(page.locator("#savebar")).toContainText("Theme applied");

  const stored = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "config" });
    return r.config.custom_theme;
  });
  // The safe colour survives; the two that could fetch do not.
  expect(stored.colors.bg).toBe("#101010");
  expect(stored.colors["border-focus"]).toBeUndefined();
  expect(stored.font).toBeUndefined();
});

test("a shareable group offers Share, and a calendar does not", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);

  const topic = page.locator('#pane-groups [data-instance="ai"]');
  await expect(topic.locator("button", { hasText: "share" })).toHaveCount(1);
  // A Share button on a calendar would be an offer to publish a bearer secret.
  await expect(
    page.locator('#pane-groups [data-instance="calendar"] button', { hasText: "share" }),
  ).toHaveCount(0);
});

test("sharing strips secrets before anything can leave the browser", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);

  await page.evaluate(async () => {
    const got = await chrome.storage.sync.get("opentabs:config");
    const cfg = got["opentabs:config"];
    const ai = cfg.instances.find((i: { id: string }) => i.id === "ai");
    ai.opts = { ...ai.opts, apiKey: "sk-live-must-not-escape", lat: 1.35, span: 3 };
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  });

  const packed = await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "packFromInstance",
      instanceId: "ai",
      author: "darius",
      description: "Twelve good AI sources.",
    }),
  );
  const opts = packed.pack.instances[0].opts;
  expect(opts.apiKey).toBeUndefined();
  expect(opts.lat).toBeUndefined();
  expect(opts.span).toBeUndefined();
  expect(packed.pack.author).toBe("darius");
});

test("the share dialog can copy a pack without any account at all", async ({
  context,
  extensionId,
}) => {
  // A sharing feature that only works signed in is one most people never use.
  const page = await context.newPage();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`chrome-extension://${extensionId}/settings.html`);

  await page.locator('#pane-groups [data-instance="ai"] button', { hasText: "share" }).click();
  const dialog = page.locator(".modal-box");
  await expect(dialog).toContainText("stripped out");

  await dialog.locator("textarea").fill("Twelve good AI sources, ranked by corroboration.");
  await dialog.locator("button", { hasText: "Copy the pack" }).click();
  await expect(dialog.locator("button", { hasText: "Copied" })).toHaveCount(1);

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(copied);
  expect(parsed.kind).toBe("group");
  expect(parsed.description).toContain("Twelve good AI sources");
});

test("publishing without a description is refused before anything is sent", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  await page.locator('#pane-groups [data-instance="ai"] button', { hasText: "share" }).click();
  await page.locator(".modal-box button", { hasText: "Publish" }).click();
  await expect(page.locator(".modal-box")).toContainText("Say what it is for");
});
