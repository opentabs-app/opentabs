/**
 * Wall clock in, instant out — the boundary the to-do parser sits behind.
 *
 * `parseDueDate` is pure arithmetic on seconds and knows nothing about
 * timezones: it reads the number it is given as civil time and returns civil
 * time. Handing it `Date.now()` therefore made "10:30" mean 10:30 **UTC**, so
 * every reader outside UTC saw their to-do at the wrong hour and was reminded
 * at the wrong hour — eight hours late in Shanghai, seven early in Los
 * Angeles, right only on the prime meridian (APP-181).
 *
 * The parser stays timezone-free. The conversion happens here, in the one
 * place that can ask the platform what the reader's zone actually does:
 *
 *   epoch → `wallNow()` → parser → `wallToEpoch()` → epoch
 *
 * Both hops go through `Date`'s local constructors rather than a fixed offset,
 * so a due date on the far side of a daylight-saving change gets that day's
 * offset and not today's. A fixed offset is wrong twice a year, and wrong in
 * exactly the week people schedule things around the change.
 */

/** Civil time now, as seconds, for a parser that treats seconds as civil time. */
export function wallNow(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000) - now.getTimezoneOffset() * 60;
}

/**
 * The instant at which the reader's clock reads this civil time.
 *
 * `local` builds a Date from local components; it is injectable only so the
 * arithmetic can be tested against a stated zone instead of the machine's.
 */
export function wallToEpoch(
  wall: number,
  local: (y: number, mo: number, d: number, h: number, mi: number, s: number) => number = (y, mo, d, h, mi, s) =>
    new Date(y, mo, d, h, mi, s).getTime(),
): number {
  const w = new Date(wall * 1000);
  return Math.floor(
    local(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds()) /
      1000,
  );
}

/**
 * Correct a due date stored by a build that skipped the conversion above.
 *
 * Everything the old code stored is civil time wearing an instant's clothes,
 * so the repair is the same conversion, applied once. The reader's zone now
 * stands in for their zone then: someone who has since moved is out by the
 * difference, which is the best that can be done from a number that never
 * recorded where it was typed.
 */
export const repairStoredDue = wallToEpoch;
