// Render the new tab with representative data and save a screenshot.
import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const dist = resolve(process.cwd(), "dist");
const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  viewport: { width: 1728, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");

// Enough real tabs, across enough sites, that packing is actually visible.
const urls = [
  "https://example.com/", "https://example.com/a", "https://example.com/b",
  "https://example.org/", "https://example.org/x",
  "https://iana.org/", "https://iana.org/domains",
  "https://www.rfc-editor.org/", "https://www.w3.org/", "https://httpbin.org/",
  "https://www.iso.org/", "https://unicode.org/",
];
await Promise.all(urls.map((u) => ctx.newPage().then((p) => p.goto(u).catch(() => {}))));

const now = Math.floor(Date.now() / 1000);
await sw.evaluate(async (now) => {
  const cfg = (await chrome.storage.sync.get("opentabs:config"))["opentabs:config"];
  for (const i of cfg.instances) {
    if (["ai", "crypto", "equities", "status", "trending", "todos", "focus", "scratch", "calendar"].includes(i.id)) i.enabled = true;
  }
  await chrome.storage.sync.set({ "opentabs:config": cfg });

  const P = (id, data, ttl) => [id, { instanceId: id, data, generated_at: now, stale_after: now + ttl }];
  await chrome.storage.local.set({
    "opentabs:payloads": Object.fromEntries([
      P("weather", { place: "Singapore", temp: 30.4, code: 2, isDay: true, max: 32, min: 26 }, 1800),
      P("crypto", [
        { symbol: "BTC", price: 98342, changePct: 1.86 },
        { symbol: "ETH", price: 3410.2, changePct: -0.74 },
        { symbol: "SOL", price: 214.9, changePct: 3.11 },
      ], 300),
      P("apps", [
        { name: "OpenSubs", url: "#", tagline: "Subtitles and translation" },
        { name: "OpenPDFEdit", url: "#", tagline: "Edit PDFs in the browser" },
        { name: "OpenCapture", url: "#", tagline: "Full-page screenshots" },
        { name: "OpenApps ID", url: "#", tagline: "Account and credits" },
      ], 86400),
      P("calendar", [
        { uid: "1", summary: "Standup", start: now + 3600, end: now + 5400,
          all_day: false, floating: false },
        { uid: "2", summary: "Design review", start: now + 9000, end: now + 12600,
          all_day: false, floating: false, join_url: "https://meet.google.com/abc-defg-hij" },
        { uid: "3", summary: "1:1 with Priya", start: now + 86400 + 7200,
          end: now + 86400 + 9000, all_day: false, floating: false },
        { uid: "4", summary: "Quarterly planning", start: now + 3 * 86400,
          end: now + 3 * 86400 + 5400, all_day: false, floating: false },
      ], 1200),
      P("status", [
        { name: "GitHub", indicator: "none", description: "All systems operational" },
        { name: "Cloudflare", indicator: "none", description: "All systems operational" },
        { name: "OpenAI", indicator: "minor", description: "Degraded performance" },
        { name: "Anthropic", indicator: "none", description: "All systems operational" },
      ], 300),
      P("equities", [
        { symbol: "000660.KS", price: 248500, changePct: 2.41, currency: "KRW" },
        { symbol: "NVDA", price: 184.22, changePct: -1.12, currency: "USD" },
        { symbol: "TSM", price: 291.4, changePct: 0.88, currency: "USD" },
      ], 900),
      P("ai", [
        { title: "Anthropic ships an official plugin registry for Claude Code", url: "#",
          id: "1", source: "Reuters", published: now - 3600, corroboration: 4,
          also_in: ["The Verge", "TechCrunch", "Ars Technica"], score: 9, binding: "gnews" },
        { title: "Two labs publish competing long-context results a day apart", url: "#",
          id: "2", source: "Import AI", published: now - 9000, corroboration: 2,
          also_in: ["TLDR AI"], score: 7, binding: "tldr" },
        { title: "Ask HN: what actually broke when you moved to a 1M window?", url: "#",
          id: "3", source: "Hacker News", published: now - 16000, corroboration: 1,
          also_in: [], score: 5, binding: "hn" },
      ], 2700),
      P("trending", [
        { repo: "tt-a1i/archify", url: "#", stars_today: 3927, language: "JavaScript",
          description: "A tool for archiving and indexing things." },
        { repo: "anthropics/claude-plugins-official", url: "#", stars_today: 356, language: "Python" },
      ], 43200),
    ]),
    "opentabs:layout_demo": true,
    "opentabs:local": {
      focus: { text: "Ship the topic engine", date: new Date().toISOString().slice(0, 10) },
      todos: [
        { id: "a", text: "email the vendor", due: now + 7200, hasTime: true, done: false, created: now },
        { id: "b", text: "review the ICS parser", due: now + 90000, hasTime: false, done: false, created: now },
      ],
    },
  });
}, now);

const id = new URL(sw.url()).host;
// Give the AI card a user-set height so its scrollbar is in frame.
await sw.evaluate(async () => {
  const got = await chrome.storage.sync.get("opentabs:config");
  const cfg = got["opentabs:config"];
  const ai = cfg.instances.find((i) => i.id === "ai");
  if (ai) ai.opts = { ...ai.opts, rows: 26 };
  await chrome.storage.sync.set({ "opentabs:config": cfg });
});

const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/newtab.html`);
await page.waitForSelector(".card");
await page.waitForTimeout(600);
await page.screenshot({ path: "newtab.png", fullPage: true });

await page.emulateMedia({ colorScheme: "dark" });
await page.waitForTimeout(300);
await page.screenshot({ path: "newtab-dark.png", fullPage: true });

const settings = await ctx.newPage();
await settings.goto(`chrome-extension://${id}/settings.html`);
// Show the groups pane with an editor open — the thing that was missing.
await settings.evaluate(() => {
  const w = document.querySelectorAll("#grouplist .gitem")[3];
  w?.classList.add("open");
});
await settings.waitForTimeout(300);
await settings.screenshot({ path: "settings.png", fullPage: true });

console.log("screenshots written");
await ctx.close();
