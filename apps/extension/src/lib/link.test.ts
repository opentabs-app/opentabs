import { describe, expect, it } from "vitest";
import { canonicalLink, linkSet, sameLink } from "./link";

describe("sameLink — the same page, written differently", () => {
  it("ignores a trailing slash on a bare origin", () => {
    expect(sameLink("https://example.com", "https://example.com/")).toBe(true);
  });

  it("ignores a trailing slash on a path", () => {
    expect(sameLink("https://a.test/docs/", "https://a.test/docs")).toBe(true);
  });

  it("ignores www and case in the host", () => {
    expect(sameLink("https://WWW.Example.com/x", "https://example.com/x")).toBe(true);
  });

  it("treats http and https as the same page", () => {
    // A bookmark saved years ago, before the site moved to https.
    expect(sameLink("http://a.test/x", "https://a.test/x")).toBe(true);
  });

  it("ignores a fragment, which does not change the page", () => {
    expect(sameLink("https://a.test/x#top", "https://a.test/x")).toBe(true);
  });

  it("keeps the query, which does change the page", () => {
    expect(sameLink("https://a.test/s?q=rust", "https://a.test/s?q=go")).toBe(false);
    expect(sameLink("https://a.test/s?q=rust", "https://a.test/s")).toBe(false);
  });

  it("does not conflate different paths or hosts", () => {
    expect(sameLink("https://a.test/x", "https://a.test/y")).toBe(false);
    expect(sameLink("https://a.test/x", "https://b.test/x")).toBe(false);
  });

  it("does not treat a non-web scheme as web", () => {
    expect(sameLink("chrome://newtab/", "https://newtab/")).toBe(false);
  });

  it("compares something unparseable as written, rather than dropping it", () => {
    expect(sameLink("not a url", "not a url")).toBe(true);
    expect(sameLink("not a url", "other")).toBe(false);
    expect(canonicalLink("  spaced  ")).toBe("spaced");
  });

  it("builds a set that matches on the same rules", () => {
    const set = linkSet(["https://www.Example.com/docs/"]);
    expect(set.has(canonicalLink("http://example.com/docs"))).toBe(true);
  });
});
