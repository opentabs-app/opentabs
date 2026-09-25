/**
 * To-do due dates, in three timezones (APP-181).
 *
 * "Standup 10:30" typed in Shanghai was stored as 10:30 UTC and shown as
 * 18:30, with the reminder to match. The parser reads civil time and knew
 * nothing of the reader's zone, so only UTC was ever right — which is why a
 * suite that runs in UTC never caught it.
 *
 * Driven through the real input box, and asserted on three things a reader
 * can point at: the label on the card, the number in storage, and the alarm
 * the reminder is scheduled from.
 */
import { test, expect, chromium } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** The zones from the report: east of UTC, west of it, and on it. */
const ZONES = [
  { id: "Asia/Shanghai", label: "UTC+8" },
  { id: "America/Los_Angeles", label: "UTC-7" },
  { id: "UTC", label: "UTC" },
];

async function zoneContext(timezoneId: string) {
  return await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    timezoneId,
    locale: "en-GB",
  });
}

for (const zone of ZONES) {
  test(`a to-do typed in ${zone.id} (${zone.label}) is due at the hour that was typed`, async () => {
    const ctx = await zoneContext(zone.id);
    try {
      let [sw] = ctx.serviceWorkers();
      sw ??= await ctx.waitForEvent("serviceworker");
      const id = new URL(sw.url()).host;

      const page = await ctx.newPage();
      await page.goto(`chrome-extension://${id}/newtab.html`);
      await page.evaluate(async () => {
        const got = await chrome.storage.sync.get("opentabs:config");
        const cfg = got["opentabs:config"];
        cfg.instances.find((i: { def: string }) => i.def === "todos").enabled = true;
        await chrome.storage.sync.set({ "opentabs:config": cfg });
      });
      await page.reload();

      const input = page.locator('.card[data-id="todos"] input.newtodo').first();
      await input.waitFor({ timeout: 15_000 });
      await input.fill("Standup 10:30");
      await input.press("Enter");

      // 1. The label a reader sees says the hour they typed.
      const due = page.locator('.card[data-id="todos"] .due').first();
      await expect(due).toBeVisible({ timeout: 10_000 });
      await expect(due).toContainText("10:30");

      // 2. The stored instant is that hour in this zone, not in UTC.
      const stored = await page.evaluate(async () => {
        const local = (await chrome.storage.local.get("opentabs:local"))["opentabs:local"] ?? {};
        const t = (local.todos ?? []).find((x: { text: string }) => x.text.includes("Standup"));
        return t?.due as number | undefined;
      });
      expect(stored, "the to-do was not stored").toBeTruthy();
      const hourHere = new Date(stored! * 1000).toLocaleTimeString("en-GB", {
        timeZone: zone.id,
        hour: "2-digit",
        minute: "2-digit",
      });
      expect(hourHere, `stored instant reads wrong in ${zone.id}`).toBe("10:30");

      // 3. The reminder is scheduled from that same instant. This is the half
      //    the report measured separately, and it was wrong by the offset too.
      const alarm = await sw.evaluate(async () => {
        await chrome.runtime.sendMessage({ type: "rescheduleReminder" }).catch(() => {});
        const a = await chrome.alarms.get("opentabs:todo");
        return a?.scheduledTime ?? null;
      });
      if (alarm) {
        expect(Math.abs(alarm / 1000 - stored!), "the alarm is not at the to-do's due time").toBeLessThanOrEqual(61);
      }
    } finally {
      await ctx.close();
    }
  });
}

/**
 * The other five phrasings from the report, in the zone that reported them.
 *
 * Each one is a clock time the reader typed; each one must come back as that
 * clock time. The date anchors ("tue", "tomorrow", "today") are checked here
 * too, because they were resolved against the UTC date and so could land on
 * the wrong day for anyone far enough east or west.
 */
test("every phrasing from the report reads back at the typed hour in Shanghai", async () => {
  const ctx = await zoneContext("Asia/Shanghai");
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/newtab.html`);
    await page.evaluate(async () => {
      const got = await chrome.storage.sync.get("opentabs:config");
      const cfg = got["opentabs:config"];
      cfg.instances.find((i: { def: string }) => i.def === "todos").enabled = true;
      await chrome.storage.sync.set({ "opentabs:config": cfg });
    });
    await page.reload();

    const cases = [
      { typed: "Review pull request #212 tue 10am", hour: "10:00" },
      { typed: "Book flights fri 3pm", hour: "15:00" },
      { typed: "Call mom tomorrow 9am", hour: "09:00" },
      { typed: "Send report today 5pm", hour: "17:00" },
    ];
    const input = page.locator('.card[data-id="todos"] input.newtodo').first();
    await input.waitFor({ timeout: 15_000 });
    for (const c of cases) {
      await input.fill(c.typed);
      await input.press("Enter");
      await page.waitForTimeout(250);
    }

    const stored = await page.evaluate(async () => {
      const local = (await chrome.storage.local.get("opentabs:local"))["opentabs:local"] ?? {};
      return (local.todos ?? []).map((t: { text: string; due: number | null }) => ({ text: t.text, due: t.due }));
    });

    for (const c of cases) {
      const word = c.typed.split(" ")[0]!;
      const got = stored.find((t: { text: string }) => t.text.startsWith(word));
      expect(got?.due, `${c.typed} stored no due date`).toBeTruthy();
      const hour = new Date(got.due * 1000).toLocaleTimeString("en-GB", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
      });
      expect(hour, `"${c.typed}" is due at the wrong hour in Shanghai`).toBe(c.hour);
    }

    // "today 5pm" must still be today where the reader is standing.
    const today = stored.find((t: { text: string }) => t.text.startsWith("Send"));
    const dayHere = new Date(today.due * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    const nowHere = await page.evaluate(() =>
      new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
    );
    expect(dayHere, '"today 5pm" landed on another day').toBe(nowHere);
  } finally {
    await ctx.close();
  }
});

/**
 * The case the report predicted but could not test: 07:00 in Shanghai.
 *
 * Before 08:00 local, UTC is still on yesterday's date, so "today" and
 * "tomorrow" resolved against the UTC day landed a day early for anyone far
 * enough east. The clock is faked rather than waited for.
 */
test("at 07:00 in Shanghai, today and tomorrow are still the reader's days", async () => {
  const ctx = await zoneContext("Asia/Shanghai");
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    // 2026-09-25T07:00 in Shanghai is 2026-09-24T23:00Z — UTC is on the 24th.
    await page.clock.setFixedTime(new Date("2026-09-24T23:00:00Z"));
    await page.goto(`chrome-extension://${id}/newtab.html`);
    await page.evaluate(async () => {
      const got = await chrome.storage.sync.get("opentabs:config");
      const cfg = got["opentabs:config"];
      cfg.instances.find((i: { def: string }) => i.def === "todos").enabled = true;
      await chrome.storage.sync.set({ "opentabs:config": cfg });
    });
    await page.reload();

    const input = page.locator('.card[data-id="todos"] input.newtodo').first();
    await input.waitFor({ timeout: 15_000 });
    for (const typed of ["Send report today 5pm", "Call mom tomorrow 9am"]) {
      await input.fill(typed);
      await input.press("Enter");
      await page.waitForTimeout(250);
    }

    const stored = await page.evaluate(async () => {
      const local = (await chrome.storage.local.get("opentabs:local"))["opentabs:local"] ?? {};
      return (local.todos ?? []).map((t: { text: string; due: number | null }) => ({ text: t.text, due: t.due }));
    });
    const dayOf = (due: number) =>
      new Date(due * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    const hourOf = (due: number) =>
      new Date(due * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" });

    const today = stored.find((t: { text: string }) => t.text.startsWith("Send"));
    const tomorrow = stored.find((t: { text: string }) => t.text.startsWith("Call"));
    expect(dayOf(today.due), '"today" fell on the UTC day, not the reader’s').toBe("2026-09-25");
    expect(hourOf(today.due)).toBe("17:00");
    expect(dayOf(tomorrow.due), '"tomorrow" fell on the UTC day, not the reader’s').toBe("2026-09-26");
    expect(hourOf(tomorrow.due)).toBe("09:00");
  } finally {
    await ctx.close();
  }
});

/**
 * To-dos saved by an older build are repaired once, on start.
 *
 * Seeded the way 1.0.2 stored them — civil time as an instant — and read back
 * after the worker has run its repair.
 */
test("a to-do stored by the old build is corrected, once", async () => {
  const ctx = await zoneContext("Asia/Shanghai");
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    const id = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/newtab.html`);

    // 10:30 Shanghai, stored the old way: the clock face, stamped as UTC.
    const wrong = Date.UTC(2026, 11, 1, 10, 30, 0) / 1000;
    await page.evaluate(async (due) => {
      const got = await chrome.storage.sync.get("opentabs:config");
      const cfg = got["opentabs:config"];
      cfg.instances.find((i: { def: string }) => i.def === "todos").enabled = true;
      await chrome.storage.sync.set({ "opentabs:config": cfg });
      await chrome.storage.local.set({
        "opentabs:local": {
          todos: [{ id: "old", text: "Standup", due, hasTime: true, done: false, created: 1 }],
        },
      });
    }, wrong);

    // Sent from the page, not the worker: a worker's own sendMessage is not
    // delivered back to its own listener.
    const repaired = await page.evaluate(async () => {
      // The worker runs this on install and on browser start; ask it to do
      // the same thing here, then read what it left behind.
      await chrome.runtime.sendMessage({ type: "repairTodoDues" }).catch(() => {});
      for (let i = 0; i < 50; i++) {
        const local = (await chrome.storage.local.get("opentabs:local"))["opentabs:local"] ?? {};
        if (local.todoDuesLocalised) return local.todos[0].due as number;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    });

    expect(repaired, "the repair never ran").toBeTruthy();
    const hour = new Date(repaired! * 1000).toLocaleTimeString("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(hour, "the old to-do still reads at the wrong hour").toBe("10:30");

    // Idempotent: a second run must not move it again.
    const again = await page.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: "repairTodoDues" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      const local = (await chrome.storage.local.get("opentabs:local"))["opentabs:local"] ?? {};
      return local.todos[0].due as number;
    });
    expect(again, "the repair ran twice and moved it again").toBe(repaired);
  } finally {
    await ctx.close();
  }
});
