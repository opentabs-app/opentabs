/**
 * Screenshots for the test guide, from the built extension.
 *
 *     node e2e/capture.mjs ../../docs/screenshots
 *
 * Drives `dist/` — the same bytes the release ships — in a real Chromium with
 * the extension loaded. Never a mockup, never the dev server: a guide that
 * photographs something nobody can install documents nothing.
 *
 * Waits are on content, never on the clock. The new tab paints from one
 * storage read, but the *worker* has to group the tabs first, and on a busy
 * machine a fixed timeout photographs an empty card.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "dist");
const out = resolve(process.cwd(), process.argv[2] ?? "docs/screenshots");
mkdirSync(out, { recursive: true });

/** A configuration worth photographing: several groups, real-looking data. */
const CONFIG = {
  version: 6,
  theme: "auto",
  assistant: "claude",
  instances: [
    { def: "tabs", id: "tabs", name: "Tabs management", enabled: true, opts: {} },
    { def: "focus", id: "focus", name: "Focus", enabled: true, opts: {} },
    { def: "topic", id: "ai", name: "AI", enabled: true, opts: { query: "AI" } },
    { def: "trending", id: "trending", name: "GitHub trending", enabled: true, opts: {} },
  ],
};

async function shoot(page, name) {
  await page.screenshot({ path: resolve(out, `${name}.png`) });
  console.log("  ", name);
}

async function newContext(colorScheme) {
  return chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme,
  });
}

async function extensionId(ctx) {
  let [w] = ctx.serviceWorkers();
  if (!w) w = await ctx.waitForEvent("serviceworker");
  return w.url().split("/")[2];
}

/** Open enough tabs that the grouping has something to show. */
async function openTabs(ctx) {
  const urls = [
    "https://example.com/", "https://example.com/two", "https://example.com/three",
    "https://example.org/a", "https://example.org/b",
    "https://example.net/x",
  ];
  for (const u of urls) {
    const p = await ctx.newPage();
    await p.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {});
  }
}

console.log(`capturing into ${out}`);

// ---- empty state: the first thing a new profile sees ----
{
  const ctx = await newContext("light");
  const id = await extensionId(ctx);
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/newtab.html`);
  // The tabs card, not merely *a* card. Waiting on `.card` matched Focus,
  // which renders from local state with nothing to fetch, and photographed
  // the fraction of a second before the worker's first grouping lands — a
  // picture of the product's headline feature missing.
  await page.waitForSelector('.card[data-id="tabs"]', { timeout: 20_000 });
  await page.waitForTimeout(300);
  await shoot(page, "01-first-open");
  await ctx.close();
}

// ---- configured, with tabs open, light and dark ----
for (const [scheme, n] of [["light", "02-newtab-light"], ["dark", "03-newtab-dark"]]) {
  const ctx = await newContext(scheme);
  const id = await extensionId(ctx);

  // One page for the whole setup, kept open. Closing it between steps and
  // reopening raced the worker's own refresh, which rewrites this key.
  const setup = await ctx.newPage();
  await setup.goto(`chrome-extension://${id}/settings.html`);
  await setup.evaluate(async (cfg) => {
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  }, CONFIG);
  // Wait for the worker to have *migrated* the config — it merges in every
  // other group as disabled and writes the result back, and seeding before
  // that lands means seeding into a document about to be replaced. Waiting
  // on the payloads alone was not enough: the run came out with a different
  // set of cards each time.
  await setup.waitForFunction(
    async () => {
      const r = await chrome.runtime.sendMessage({ type: "config" });
      const on = (r?.config?.instances ?? []).filter((i) => i.enabled).map((i) => i.id).sort();
      return JSON.stringify(on) === JSON.stringify(["ai", "focus", "tabs", "trending"]);
    },
    null,
    { timeout: 20_000 },
  );
  // Then for the first refresh to have written something, so the merge below
  // has the worker's own envelope to keep.
  await setup.waitForFunction(
    async () => {
      const p = (await chrome.storage.local.get("opentabs:payloads"))["opentabs:payloads"] ?? {};
      return !!p.tabs;
    },
    null,
    { timeout: 20_000 },
  );

  await openTabs(ctx);
  await setup.waitForTimeout(1500);

  await setup.evaluate(async () => {
    const now = Math.floor(Date.now() / 1000);
    const got = await chrome.storage.local.get("opentabs:payloads");
    const payloads = got["opentabs:payloads"] ?? {};
    await chrome.storage.local.set({
      // `focusItems`, not `todos` — `todos` is a different group entirely,
      // and seeding it left the Focus card showing its empty state while
      // looking, at a glance, as though the seed had worked.
      "opentabs:local": {
        focusItems: [
          { id: "t1", text: "Cut the release candidate", done: true, created: now - 400, doneAt: now - 300, order: 1 },
          { id: "t2", text: "Walk the manual pass", done: false, created: now - 300, order: 2 },
          { id: "t3", text: "Read every screenshot before publishing", done: false, created: now - 200, parent: "t2" },
          { id: "t4", text: "Check the link preview in Telegram", done: false, created: now - 100, parent: "t2" },
          { id: "t5", text: "Reply with the artifact link", done: false, created: now - 50, order: 3 },
        ],
      },
      // Merged, never replaced: this key is one object keyed by instance, and
      // writing it whole deletes the tabs grouping the worker just wrote.
      //
      // The worker's own envelope is kept and only `data` is swapped. The
      // envelope carries `config_hash`, and the page hides a group whose hash
      // does not match the options it was configured with — inventing one
      // produced four seeded cards that never appeared, which is the same
      // symptom as a broken feed and took a while to tell apart.
      "opentabs:payloads": {
        ...payloads,
        ai: {
          ...(payloads.ai ?? {}),
          instanceId: "ai",
          generated_at: now - 600,
          stale_after: now + 2400,
          error: undefined,
          data: [
              { title: "An Empirical Study into Clustering of Unseen Datasets with Self-Supervised Encoders",
                url: "https://arxiv.org/abs/1", source: "arxiv.org", published: now - 3600, corroboration: 1, also_in: [] },
              { title: "Seattle Times and Newsday sue OpenAI and Microsoft for infringement",
                url: "https://www.theverge.com/1", source: "theverge.com", published: now - 18000, corroboration: 3,
                also_in: ["reuters.com", "bbc.co.uk"] },
              { title: "Show HN: GET Together – a social network where you don't need POST to Post",
                url: "https://gettogether.example/1", source: "gettogether.example", published: now - 12000, corroboration: 1, also_in: [] },
              { title: "Europe has its first commercial orbital rocket",
                url: "https://www.theverge.com/2", source: "theverge.com", published: now - 36000, corroboration: 2,
                also_in: ["bbc.co.uk"] },
              { title: "Small Molecule Optimization with Large Language Models",
                url: "https://arxiv.org/abs/2", source: "arxiv.org", published: now - 3700, corroboration: 1, also_in: [] },
          ],
        },
        trending: {
          ...(payloads.trending ?? {}),
          instanceId: "trending",
          generated_at: now - 900,
          stale_after: now + 40000,
          error: undefined,
          data: [
              { repo: "mattpocock/skills", url: "https://github.com/mattpocock/skills",
                description: "Skills for Real Engineers", language: "TypeScript", stars_today: 2207, stars_total: 254985 },
              { repo: "affaan-m/ECC", url: "https://github.com/affaan-m/ECC",
                description: "The agent harness performance optimization system", language: "JavaScript", stars_today: 1485, stars_total: 251687 },
              { repo: "NousResearch/hermes-agent", url: "https://github.com/NousResearch/hermes-agent",
                description: "The agent that grows with you", language: "Python", stars_today: 520, stars_total: 242653 },
          ],
        },
      },
    });
  });

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/newtab.html`);
  // Content, not clock: every card the config asked for must have painted.
  try {
    await page.waitForFunction(
      () => {
        const ids = [...document.querySelectorAll(".card")].map((c) => c.dataset.id);
        return ["tabs", "focus", "ai", "trending"].every((k) => ids.includes(k));
      },
      null,
      { timeout: 20_000 },
    );
  } catch (e) {
    // Say what actually painted. "Timeout exceeded" on its own sends you
    // looking at the wait rather than at the page.
    console.error("cards present:", await page.evaluate(() =>
      [...document.querySelectorAll(".card")].map((c) => c.dataset.id)));
    console.error("payloads:", await page.evaluate(async () => {
      const p = (await chrome.storage.local.get("opentabs:payloads"))["opentabs:payloads"] ?? {};
      return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Object.keys(v.data ?? {})]));
    }));
    throw e;
  }
  await page.waitForTimeout(300);
  await shoot(page, n);
  await ctx.close();
}

// ---- settings: groups, and the marketplace with its publish row ----
{
  const ctx = await newContext("light");
  const id = await extensionId(ctx);
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/settings.html`);
  await page.evaluate(async (cfg) => {
    await chrome.storage.sync.set({ "opentabs:config": cfg });
  }, CONFIG);
  await page.reload();
  await page.waitForSelector('#pane-groups [data-instance="ai"]');
  await shoot(page, "04-settings-groups");

  await page.goto(`chrome-extension://${id}/settings.html#pane=market`);
  await page.waitForFunction(() => document.querySelectorAll("#sharerow .btn").length > 0, null, {
    timeout: 10_000,
  });
  await shoot(page, "05-settings-marketplace");

  // The Share dialog — what leaves the browser, said before it leaves.
  await page.locator("#sharerow .btn").first().click();
  await page.waitForSelector(".modal-box");
  await shoot(page, "06-share-dialog");
  await ctx.close();
}

console.log("done");
