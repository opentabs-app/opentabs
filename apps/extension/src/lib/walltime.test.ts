import { describe, expect, it } from "vitest";
import { wallNow, wallToEpoch } from "./walltime";

/**
 * A stated zone, so these assertions do not depend on the machine's.
 *
 * `offsetMin` is what `Date.prototype.getTimezoneOffset` returns: minutes
 * *behind* UTC, so UTC+8 is -480. The fake `local` builder is the inverse of
 * that — civil components in, instant out.
 */
const zone = (offsetMin: number) => ({
  now: (iso: string) =>
    ({
      getTime: () => Date.parse(iso),
      getTimezoneOffset: () => offsetMin,
    }) as Date,
  local: (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
    Date.UTC(y, mo, d, h, mi, s) + offsetMin * 60_000,
});

const SHANGHAI = zone(-480);
const LOS_ANGELES = zone(420); // PDT
const UTC = zone(0);

describe("wallNow", () => {
  it("hands the parser the reader's clock, not UTC's", () => {
    // 2026-09-25T08:00:00Z is 16:00 in Shanghai. The parser must see 16:00,
    // because "today 5pm" has to mean the reader's today and the reader's 5pm.
    const wall = wallNow(SHANGHAI.now("2026-09-25T08:00:00Z"));
    expect(new Date(wall * 1000).toISOString()).toBe("2026-09-25T16:00:00.000Z");
  });

  it("is the identity in UTC, which is why this went unnoticed", () => {
    const wall = wallNow(UTC.now("2026-09-25T08:00:00Z"));
    expect(new Date(wall * 1000).toISOString()).toBe("2026-09-25T08:00:00.000Z");
  });

  it("goes the other way west of the meridian", () => {
    const wall = wallNow(LOS_ANGELES.now("2026-09-25T08:00:00Z"));
    expect(new Date(wall * 1000).toISOString()).toBe("2026-09-25T01:00:00.000Z");
  });
});

describe("wallToEpoch", () => {
  /** The reported case: "Standup 10:30" in Shanghai. */
  it("turns the parser's 10:30 into the instant a Shanghai clock reads 10:30", () => {
    const wall = Date.UTC(2026, 8, 25, 10, 30, 0) / 1000;
    const at = wallToEpoch(wall, SHANGHAI.local);
    expect(new Date(at * 1000).toISOString()).toBe("2026-09-25T02:30:00.000Z");
  });

  it("does the same in Los Angeles", () => {
    const wall = Date.UTC(2026, 8, 25, 10, 30, 0) / 1000;
    const at = wallToEpoch(wall, LOS_ANGELES.local);
    expect(new Date(at * 1000).toISOString()).toBe("2026-09-25T17:30:00.000Z");
  });

  it("changes nothing in UTC", () => {
    const wall = Date.UTC(2026, 8, 25, 10, 30, 0) / 1000;
    expect(wallToEpoch(wall, UTC.local)).toBe(wall);
  });

  /**
   * Why the conversion goes through civil components rather than one offset.
   *
   * A reader in Los Angeles on 2026-10-30 types "nov 3 9am". That date is
   * past the DST change, so it is PST (UTC-8) even though today is PDT
   * (UTC-7). Applying today's offset would schedule 08:00, an hour early —
   * and the week of a clock change is exactly when people schedule things
   * around it.
   */
  it("uses the offset of the due date, not of today", () => {
    const pdtThenPst = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
      Date.UTC(y, mo, d, h, mi, s) + (d >= 1 && mo === 10 ? 480 : 420) * 60_000;
    const wall = Date.UTC(2026, 10, 3, 9, 0, 0) / 1000;
    const at = wallToEpoch(wall, pdtThenPst);
    expect(new Date(at * 1000).toISOString()).toBe("2026-11-03T17:00:00.000Z");
  });

  it("round-trips whatever the platform's zone happens to be", () => {
    // No stated zone here on purpose: this one asserts the two halves agree
    // wherever the test happens to run, including on a CI runner in UTC.
    const now = new Date();
    const back = wallToEpoch(wallNow(now));
    expect(Math.abs(back - Math.floor(now.getTime() / 1000))).toBeLessThanOrEqual(1);
  });
});
