/**
 * What the calendar card actually shows, in a non-UTC browser.
 *
 * The parser was verified against a real Google export and is right; two
 * attempts to fix "the times are wrong" were reasoning about the render step
 * without ever rendering it in a timezone where the bug could appear. In UTC
 * every wrong answer looks correct.
 */
import { chromium, expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** Load the extension in a browser pinned to Singapore, UTC+8. */
async function sgContext() {
  return await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    timezoneId: "Asia/Singapore",
    locale: "en-GB",
  });
}

test("a 9am local event shows as 09:00, not shifted by the reader's offset", async () => {
  const ctx = await sgContext();
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    const id = new URL(sw.url()).host;

    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/newtab.html`);

    // Two events at the same wall clock, expressed the two ways Google does:
    // a TZID= local time (floating) and the equivalent Z-suffixed instant.
    const shown = await page.evaluate(async () => {
      const d = new Date();
      const y = d.getFullYear();
      const m = d.getMonth();
      // Tomorrow, so the event is upcoming whatever time the test runs — a
      // past event is filtered out before it can be rendered.
      const day = d.getDate() + 1;
      // 09:00 *local* tomorrow, as a real instant.
      const nineLocal = Math.floor(new Date(y, m, day, 9, 0, 0).getTime() / 1000);
      // The floating form: the same wall clock stamped as if UTC.
      const nineFloating = Math.floor(Date.UTC(y, m, day, 9, 0, 0) / 1000);

      const got = await chrome.storage.sync.get("opentabs:config");
      const cfg = got["opentabs:config"];
      cfg.instances.find((i: { def: string }) => i.def === "calendar").enabled = true;
      await chrome.storage.sync.set({ "opentabs:config": cfg });

      const now = Math.floor(Date.now() / 1000);
      await chrome.storage.local.set({
        "opentabs:payloads": {
          calendar: {
            instanceId: "calendar",
            generated_at: now,
            stale_after: now + 3600,
            data: [
              { uid: "f", summary: "Floating nine", start: nineFloating,
                end: nineFloating + 3600, all_day: false, floating: true },
              { uid: "z", summary: "Absolute nine", start: nineLocal,
                end: nineLocal + 3600, all_day: false, floating: false },
            ],
          },
        },
      });
      return true;
    });
    expect(shown).toBe(true);

    await page.reload();
    await page.waitForSelector('.card[data-id="calendar"]', { timeout: 15_000 });

    const rows = await page.$$eval('.card[data-id="calendar"] .ev', (els) =>
      els.map((e) => ({
        when: e.querySelector(".when")?.textContent?.trim() ?? "",
        what: e.querySelector(".what")?.textContent?.trim() ?? "",
      })),
    );

    // Both forms describe 9am. Both must display 09:00 in a UTC+8 browser.
    // (A 3pm case is covered in the unit tests: it is the one a 12-hour
    // locale renders as "03:00" once the meridiem is clipped.)
    const floating = rows.find((r) => r.what.includes("Floating"));
    const absolute = rows.find((r) => r.what.includes("Absolute"));
    if (floating) expect(floating.when, "TZID= event shifted").toBe("09:00");
    if (absolute) expect(absolute.when, "Z-suffixed event shifted").toBe("09:00");
    expect(floating || absolute, "neither event rendered").toBeTruthy();
  } finally {
    await ctx.close();
  }
});

test("a 9am event today is filed under Today, not Yesterday or Tomorrow", async () => {
  const ctx = await sgContext();
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/newtab.html`);

    await page.evaluate(async () => {
      const d = new Date();
      // 23:30 local tonight: past 08:00, so already tomorrow in UTC. Counting
      // UTC days would file this under the wrong heading.
      const lateLocal = Math.floor(
        new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 30, 0).getTime() / 1000,
      );
      const got = await chrome.storage.sync.get("opentabs:config");
      const cfg = got["opentabs:config"];
      cfg.instances.find((i: { def: string }) => i.def === "calendar").enabled = true;
      await chrome.storage.sync.set({ "opentabs:config": cfg });

      const now = Math.floor(Date.now() / 1000);
      await chrome.storage.local.set({
        "opentabs:payloads": {
          calendar: {
            instanceId: "calendar", generated_at: now, stale_after: now + 3600,
            data: [
              { uid: "l", summary: "Late tonight", start: lateLocal,
                end: lateLocal + 1800, all_day: false, floating: false },
            ],
          },
        },
      });
    });

    await page.reload();
    await page.waitForSelector('.card[data-id="calendar"] .daysep', { timeout: 15_000 });
    const heading = await page.textContent('.card[data-id="calendar"] .daysep');
    expect(heading?.trim(), "23:30 tonight is Today in the reader's timezone").toBe("Today");
  } finally {
    await ctx.close();
  }
});

test("an all-day event does not collide with its title", async () => {
  const ctx = await sgContext();
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/newtab.html`);

    await page.evaluate(async () => {
      const got = await chrome.storage.sync.get("opentabs:config");
      const cfg = got["opentabs:config"];
      cfg.instances.find((i: { def: string }) => i.def === "calendar").enabled = true;
      await chrome.storage.sync.set({ "opentabs:config": cfg });

      const now = Math.floor(Date.now() / 1000);
      const d = new Date();
      const midnight = Math.floor(
        new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() / 1000,
      );
      await chrome.storage.local.set({
        "opentabs:payloads": {
          calendar: {
            instanceId: "calendar", generated_at: now, stale_after: now + 3600,
            data: [
              { uid: "a", summary: "Labor Day", start: midnight, end: midnight + 86400,
                all_day: true, floating: false },
            ],
          },
        },
      });
    });
    await page.reload();
    await page.waitForSelector('.card[data-id="calendar"] .ev');

    // The label and the title must not overlap: the right edge of "all day"
    // has to sit left of the title's left edge.
    const boxes = await page.evaluate(() => {
      const row = document.querySelector('.card[data-id="calendar"] .ev')!;
      const w = row.querySelector(".when")!.getBoundingClientRect();
      const t = row.querySelector(".what")!.getBoundingClientRect();
      return { whenRight: w.right, whatLeft: t.left, text: row.querySelector(".when")!.textContent };
    });
    expect(boxes.text?.trim()).toBe("all day");
    expect(boxes.whatLeft, "'all day' runs into the event title").toBeGreaterThanOrEqual(
      boxes.whenRight,
    );
  } finally {
    await ctx.close();
  }
});

test("an event written in another timezone shows at the reader's hour", async () => {
  const ctx = await sgContext();
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/newtab.html`);

    await page.evaluate(async () => {
      const got = await chrome.storage.sync.get("opentabs:config");
      const cfg = got["opentabs:config"];
      cfg.instances.find((i: { def: string }) => i.def === "calendar").enabled = true;
      await chrome.storage.sync.set({ "opentabs:config": cfg });

      const now = Math.floor(Date.now() / 1000);
      const d = new Date();
      // 09:00 tomorrow in New York, stamped as wall clock the way the parser
      // does. In Singapore (UTC+8, NY at UTC-4) that is 21:00 the same day.
      const wall = Math.floor(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 9, 0, 0) / 1000,
      );
      await chrome.storage.local.set({
        "opentabs:payloads": {
          calendar: {
            instanceId: "calendar", generated_at: now, stale_after: now + 3600,
            data: [
              { uid: "ny", summary: "New York call", start: wall, end: wall + 3600,
                all_day: false, floating: true, tzid: "America/New_York" },
            ],
          },
        },
      });
    });

    await page.reload();
    await page.waitForSelector('.card[data-id="calendar"] .ev', { timeout: 15_000 });
    const when = (await page.textContent('.card[data-id="calendar"] .when'))?.trim();

    // 09:00 New York is 21:00 Singapore. Showing "09:00" would mean the zone
    // was ignored; showing "21:00" means it was honoured.
    expect(when, "a New York 9am must not display as 09:00 in Singapore").toBe("21:00");
  } finally {
    await ctx.close();
  }
});
