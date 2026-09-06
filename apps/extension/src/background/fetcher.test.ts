import { describe, expect, it } from "vitest";
import { gapFor, parseRetryAfter } from "./fetcher";

const NOW = Date.parse("2026-08-31T12:00:00Z");

describe("parseRetryAfter — both forms are used in the wild", () => {
  it("reads a count of seconds", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120);
    expect(parseRetryAfter("  600 ", NOW)).toBe(600);
  });

  it("reads an HTTP date", () => {
    expect(parseRetryAfter("Mon, 31 Aug 2026 12:05:00 GMT", NOW)).toBe(300);
  });

  it("treats anything unreadable as absent, never as zero", () => {
    // A misparsed header must not read as "retry immediately", which is the
    // one behaviour a throttled host is asking us not to do.
    for (const raw of [null, "", "soon", "later today", "NaN"]) {
      expect(parseRetryAfter(raw, NOW)).toBeUndefined();
    }
  });

  it("ignores a time already past", () => {
    expect(parseRetryAfter("Mon, 31 Aug 2026 11:00:00 GMT", NOW)).toBeUndefined();
    expect(parseRetryAfter("0", NOW)).toBeUndefined();
    expect(parseRetryAfter("-5", NOW)).toBeUndefined();
  });
});

describe("gapFor — spacing requests to one host", () => {
  it("gives reddit the room it demonstrably needs", () => {
    expect(gapFor("www.reddit.com")).toBeGreaterThanOrEqual(2_000);
  });

  it("keeps everything else brisk", () => {
    expect(gapFor("news.google.com")).toBeLessThanOrEqual(500);
    expect(gapFor("hnrss.org")).toBeLessThanOrEqual(500);
  });
});
