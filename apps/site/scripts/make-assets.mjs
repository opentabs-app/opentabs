/**
 * The website's icon set and link-preview card.
 *
 * Everything here is generated, not checked in as art nobody can rebuild.
 * The mark comes from `apps/extension/scripts/icon.mjs` — the same pixels
 * as the extension's toolbar icon, because a product whose tab icon and
 * whose favicon are two different drawings looks like two products.
 *
 *   node apps/site/scripts/make-assets.mjs
 *
 * # Why this many files
 *
 * Each one answers a client that ignores the others:
 *
 * - `favicon.ico` — what a browser requests from the site root when it does
 *   not use the `<link>` tags, and what several link-preview crawlers fetch
 *   without reading the HTML at all. Shipping only an SVG is why the tab
 *   was blank.
 * - `favicon.svg` — sharp at any DPI, and the one a modern browser prefers.
 * - `icon-180.png` — iOS home screen, which ignores SVG entirely.
 * - `icon-192.png` / `icon-512.png` — Android and the web app manifest.
 * - `og-image.png` — Telegram, Slack, WhatsApp, X, iMessage. Without it a
 *   pasted link is a bare URL with no picture and, in Telegram's case,
 *   often no description either.
 *
 * # Why the card is rendered rather than drawn
 *
 * The icons are pixel math because a rounded square and three bars *are*
 * pixel math. The card is type, and type from pixel math is a bitmap font
 * that looks like 1998. Playwright is already a dev dependency of the
 * extension for the e2e suite, so the card is authored as HTML — real
 * typography, real kerning — and screenshotted at exactly 1200×630.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ico, png, svg } from "../../extension/scripts/icon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..");
const extension = resolve(here, "..", "..", "extension");
// The marketplace is a separate origin, so it needs its own copy of every
// one of these. A crawler asking market.opentabs.app for /favicon.ico does
// not fall back to the apex.
const market = resolve(here, "..", "..", "marketplace", "public");

// ---------- icons ----------

for (const dir of [out, market]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "favicon.svg"), svg());
  writeFileSync(resolve(dir, "favicon.ico"), ico([16, 32, 48]));
  for (const size of [16, 32, 48, 180, 192, 512]) {
    writeFileSync(resolve(dir, `icon-${size}.png`), png(size));
  }
  console.log("icons written to", dir);
}

// ---------- the link-preview card ----------

const card = (title, dim, lede, pills) => `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face { font-family: x; src: local("Helvetica Neue"), local("Arial"); }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 26px;
    background: #101014;
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    color: #f4f4f6;
    /* A faint grid, so the ground is not a flat rectangle at the size these
       are actually looked at — about 500px wide in a chat list. */
    background-image:
      linear-gradient(rgba(122,162,247,.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(122,162,247,.045) 1px, transparent 1px);
    background-size: 48px 48px;
  }
  .mark { width: 112px; height: 112px; border-radius: 25px; }
  h1 { font-size: 68px; letter-spacing: -0.035em; font-weight: 700; }
  h1 .dim { color: #8b8b98; }
  p { font-size: 27px; color: #c3c3cc; text-align: center; max-width: 900px; line-height: 1.45; }
  .pills { display: flex; gap: 12px; margin-top: 8px; }
  .pill {
    border: 1px solid #2c2c36; border-radius: 999px; padding: 10px 22px;
    font-size: 20px; color: #c3c3cc;
  }
</style>
<img class="mark" src="data:image/png;base64,${png(224).toString("base64")}">
<h1><span class="dim">${dim}</span>${title}</h1>
<p>${lede}</p>
<div class="pills">${pills.map((t) => `<span class="pill">${t}</span>`).join("")}</div>
`;

const CARDS = [
  {
    file: resolve(out, "og-image.png"),
    html: card("Tabs", "Open", "Your open tabs, grouped, on every new tab —<br>above a briefing you choose.", [
      "Free",
      "No account",
      "Open source",
    ]),
  },
  {
    file: resolve(market, "og-image.png"),
    html: card("Tabs packs", "Open", "A topic someone spent an hour assembling,<br>as one click.", [
      "Free",
      "No account to install",
      "Open source",
    ]),
  },
];

const require = createRequire(resolve(extension, "package.json"));
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error(
    "Playwright is not installed. Run `npm ci` in apps/extension first —\n" +
      "the icons above are written; only og-image.png needs it.",
  );
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const c of CARDS) {
  await page.setContent(c.html);
  // No web fonts and the mark is a data URI, so one frame is enough —
  // waiting on the network here would wait forever.
  await page.waitForTimeout(150);
  await page.screenshot({ path: c.file });
  console.log("card written to", c.file);
}
await browser.close();
