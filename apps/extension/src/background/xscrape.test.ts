import { describe, expect, it } from "vitest";
import { gate, LOCK_STALE_SECS, MAX_LOADS_PER_DAY, MIN_INTERVAL_MIN, type ScrapeState } from "./xscrape";

const NOW = 1_788_048_000;
const TODAY = "2026-08-30";
const empty = (): ScrapeState => ({ last: {}, perDay: {} });

describe("gate — the stuck-lock regression", () => {
  it("a lock left by a terminated worker goes stale instead of blocking forever", () => {
    // MV3 kills service workers whenever it likes, so the `finally` that
    // clears the lock is not guaranteed to run. A boolean would have stayed
    // true and every X search would read "Another X search is loading."
    // permanently, with nothing loading.
    const s: ScrapeState = { ...empty(), runningSince: NOW - LOCK_STALE_SECS - 1 };
    expect(gate(s, "x", 15, NOW, TODAY).ok).toBe(true);
  });

  it("a genuinely in-flight scrape still holds the others off", () => {
    const s: ScrapeState = { ...empty(), runningSince: NOW - 10 };
    const g = gate(s, "x", 15, NOW, TODAY);
    expect(g.ok).toBe(false);
    expect(g.retryAt).toBe(NOW - 10 + LOCK_STALE_SECS);
  });

  it("being busy is not reported as a problem", () => {
    // A scheduling detail is not an error; surfacing one replaced the items
    // on the card with a message about nothing being wrong.
    const s: ScrapeState = { ...empty(), runningSince: NOW - 10 };
    expect(gate(s, "x", 15, NOW, TODAY).reason).toBeUndefined();
  });
});

describe("gate — pacing", () => {
  it("lets a first run through", () => {
    expect(gate(empty(), "x", 15, NOW, TODAY).ok).toBe(true);
  });

  it("holds a search that ran moments ago, and says when it may go", () => {
    const s: ScrapeState = { ...empty(), last: { x: NOW - 60 } };
    const g = gate(s, "x", 15, NOW, TODAY);
    expect(g.ok).toBe(false);
    expect(g.retryAt).toBeGreaterThan(NOW);
    // Never a countdown — an absolute time the page renders live.
    expect(g.reason).toBeUndefined();
  });

  it("honours the floor even when a shorter interval is asked for", () => {
    const s: ScrapeState = { ...empty(), last: { x: NOW - 60 } };
    // One minute requested; the floor is 15, so it must still be held.
    expect(gate(s, "x", 1, NOW, TODAY).ok).toBe(false);
    const g = gate(s, "x", 1, NOW, TODAY);
    expect(g.retryAt! - (NOW - 60)).toBeGreaterThanOrEqual(MIN_INTERVAL_MIN * 60 * 0.75);
  });

  it("releases once the interval has elapsed", () => {
    const s: ScrapeState = { ...empty(), last: { x: NOW - 60 * 60 } };
    expect(gate(s, "x", 15, NOW, TODAY).ok).toBe(true);
  });

  it("jitter is stable per search, so the countdown counts down", () => {
    const s: ScrapeState = { ...empty(), last: { x: NOW - 60 } };
    const a = gate(s, "x", 15, NOW, TODAY).retryAt;
    const b = gate(s, "x", 15, NOW + 30, TODAY).retryAt;
    expect(a).toBe(b);
  });

  it("different searches get different offsets", () => {
    const s: ScrapeState = { ...empty(), last: { a: NOW - 60, b: NOW - 60 } };
    const ra = gate(s, "a", 15, NOW, TODAY).retryAt;
    const rb = gate(s, "bbbb", 15, NOW, TODAY).retryAt;
    expect(ra).not.toBe(rb);
  });

  it("stops at the daily ceiling, and says so", () => {
    const s: ScrapeState = { ...empty(), perDay: { [TODAY]: MAX_LOADS_PER_DAY } };
    const g = gate(s, "x", 15, NOW, TODAY);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("Daily limit");
  });

  it("yesterday's loads do not count against today", () => {
    const s: ScrapeState = { ...empty(), perDay: { "2026-08-29": 99 } };
    expect(gate(s, "x", 15, NOW, TODAY).ok).toBe(true);
  });

  it("a live lock takes precedence over the daily cap message", () => {
    const s: ScrapeState = {
      ...empty(),
      runningSince: NOW - 5,
      perDay: { [TODAY]: MAX_LOADS_PER_DAY },
    };
    expect(gate(s, "x", 15, NOW, TODAY).reason).toBeUndefined();
  });
});
