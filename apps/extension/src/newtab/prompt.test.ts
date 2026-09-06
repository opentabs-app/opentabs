import { describe, expect, it } from "vitest";
import { clockTime, dayLabel, eventInstant, relTime, wxGlyph, zonedToInstant } from "./render";

describe("relTime", () => {
  const now = 1_788_048_000;
  it("shows minutes under an hour", () => {
    expect(relTime(now - 300, now)).toBe("5m");
  });
  it("shows hours, then days", () => {
    expect(relTime(now - 7200, now)).toBe("2h");
    expect(relTime(now - 3 * 86400, now)).toBe("3d");
  });
  it("never shows 0m for something that just landed", () => {
    expect(relTime(now, now)).toBe("1m");
  });
  it("never shows a negative age for a clock-skewed future date", () => {
    expect(relTime(now + 600, now)).toBe("1m");
  });
});

describe("wxGlyph", () => {
  it("distinguishes day from night for a clear sky", () => {
    expect(wxGlyph(0, true)).not.toBe(wxGlyph(0, false));
  });
  it("returns a glyph for every WMO code it might see", () => {
    for (let code = 0; code <= 99; code++) {
      expect(wxGlyph(code, true).length).toBeGreaterThan(0);
    }
  });
});

describe("dayLabel", () => {
  // 2026-08-30T12:00:00Z
  const now = 1_788_048_000 + 12 * 3600;
  const day = 86_400;

  it("names today and tomorrow rather than dating them", () => {
    expect(dayLabel(now, now)).toBe("Today");
    expect(dayLabel(now + day, now)).toBe("Tomorrow");
    expect(dayLabel(now - day, now)).toBe("Yesterday");
  });

  it("dates anything further out, so a week is readable", () => {
    const label = dayLabel(now + 4 * day, now);
    expect(label).not.toBe("Today");
    expect(label).toMatch(/\d/);
  });

  it("changes at the reader's day boundary, not 24 hours out", () => {
    // Built from *local* components, so this holds in any timezone. The old
    // version hard-coded UTC offsets and only passed at UTC+0.
    const base = new Date(now * 1000);
    const localMidnight = new Date(
      base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0,
    ).getTime() / 1000;
    const lateTonight = localMidnight + 23 * 3600;
    const earlyTomorrow = localMidnight + 25 * 3600;

    expect(dayLabel(lateTonight, now)).toBe("Today");
    expect(dayLabel(earlyTomorrow, now)).toBe("Tomorrow");
    // Two hours apart, yet different days — which is the whole point.
    expect(earlyTomorrow - lateTonight).toBe(2 * 3600);
  });
});

describe("clockTime", () => {
  const noonUtc = 1_788_048_000 + 12 * 3600;

  it("reads a floating time as wall clock, not as an instant to convert", () => {
    // A TZID= local time is stamped as if UTC; converting again would shift
    // it by the reader's own offset.
    expect(clockTime(noonUtc, true)).toBe("12:00");
  });

  it("is 24-hour, so 3pm can never render as 03:00", () => {
    // The reported bug: a 12-hour locale renders "03:00 PM", and the narrow
    // time column clips the meridiem — leaving a time that is wrong by
    // twelve hours and looks perfectly reasonable.
    const threePmFloating = 1_788_048_000 + 15 * 3600;
    expect(clockTime(threePmFloating, true)).toBe("15:00");

    const threeAmFloating = 1_788_048_000 + 3 * 3600;
    expect(clockTime(threeAmFloating, true)).toBe("03:00");
    expect(clockTime(threePmFloating, true)).not.toBe(clockTime(threeAmFloating, true));
  });

  it("never emits a meridiem, whatever the locale", () => {
    for (const ts of [0, 3600, 13 * 3600, 23 * 3600]) {
      expect(clockTime(1_788_048_000 + ts, true)).toMatch(/^\d{2}:\d{2}$/);
      expect(clockTime(1_788_048_000 + ts, false)).toMatch(/^\d{2}:\d{2}$/);
    }
  });
});

describe("dayLabel across timezones", () => {
  // 2026-08-30T13:00:00Z — 21:00 in Singapore, so local and UTC dates agree.
  const now = 1_788_048_000 + 13 * 3600;

  it("uses the reader's day boundary, not UTC's", () => {
    // 2026-08-30T17:00:00Z is 01:00 on the 31st in Singapore. Counting UTC
    // days would file it under today; the reader's calendar says tomorrow.
    const lateUtc = 1_788_048_000 + 17 * 3600;
    const label = dayLabel(lateUtc, now);
    const localDay = new Date(lateUtc * 1000).getDate();
    const todayDay = new Date(now * 1000).getDate();
    expect(label === "Today").toBe(localDay === todayDay);
  });

  it("reads a floating event's date as wall clock", () => {
    // A TZID= event at 09:00 is stamped 09:00Z; its date is the UTC date.
    const nineAm = 1_788_048_000 + 9 * 3600;
    expect(dayLabel(nineAm, now, true)).toBe("Today");
  });

  it("is stable — the same instant always gets the same label", () => {
    const t = now + 3600;
    expect(dayLabel(t, now)).toBe(dayLabel(t, now));
  });
});

describe("zonedToInstant", () => {
  // A calendar can hold events written in other zones — this one has
  // America/New_York and America/Los_Angeles blocks alongside Asia/Singapore.
  const wall = (y: number, m: number, d: number, h: number) =>
    Math.floor(Date.UTC(y, m - 1, d, h, 0, 0) / 1000);

  it("resolves a New York wall clock to the right instant", () => {
    // 2026-09-01 15:00 in New York is 19:00 UTC (EDT, UTC-4).
    const at = zonedToInstant(wall(2026, 9, 1, 15), "America/New_York");
    expect(new Date(at * 1000).toISOString()).toBe("2026-09-01T19:00:00.000Z");
  });

  it("resolves a Singapore wall clock, which has no daylight saving", () => {
    // 15:00 SGT is 07:00 UTC, all year.
    const at = zonedToInstant(wall(2026, 9, 1, 15), "Asia/Singapore");
    expect(new Date(at * 1000).toISOString()).toBe("2026-09-01T07:00:00.000Z");
  });

  it("follows daylight saving rather than a fixed offset", () => {
    // New York is UTC-4 in September and UTC-5 in January: the same wall
    // clock is a different instant, which a fixed offset would get wrong.
    const summer = zonedToInstant(wall(2026, 9, 1, 12), "America/New_York");
    const winter = zonedToInstant(wall(2026, 1, 1, 12), "America/New_York");
    expect(new Date(summer * 1000).getUTCHours()).toBe(16);
    expect(new Date(winter * 1000).getUTCHours()).toBe(17);
  });

  it("returns the input unchanged for a zone it does not know", () => {
    const w = wall(2026, 9, 1, 15);
    expect(zonedToInstant(w, "Not/AZone")).toBe(w);
  });
});

describe("eventInstant", () => {
  it("converts a zoned event and stops treating it as floating", () => {
    const start = Math.floor(Date.UTC(2026, 8, 1, 15, 0, 0) / 1000);
    const r = eventInstant({ start, floating: true, tzid: "America/New_York" });
    expect(r.floating).toBe(false);
    expect(new Date(r.at * 1000).toISOString()).toBe("2026-09-01T19:00:00.000Z");
  });

  it("leaves a zoneless floating time alone, as wall clock", () => {
    const start = 1_788_048_000;
    const r = eventInstant({ start, floating: true });
    expect(r).toEqual({ at: start, floating: true });
  });

  it("leaves an absolute time alone", () => {
    const start = 1_788_048_000;
    const r = eventInstant({ start, floating: false });
    expect(r).toEqual({ at: start, floating: false });
  });
});
