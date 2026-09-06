import { describe, expect, it } from "vitest";
import {
  decideClosures,
  explainClosures,
  isOurNewTab,
  pruneIntervalMinutes,
  pruneOptionsFrom,
} from "./prune";

const SELF = "chrome-extension://abc/newtab.html";
const NOW = 1_788_048_000_000;
const MIN = 60_000;

type T = Parameters<typeof decideClosures>[0][number];
const nt = (id: number, over: Partial<T> = {}): T => ({
  id,
  url: SELF,
  active: false,
  pinned: false,
  windowId: 1,
  lastAccessed: NOW - 30 * MIN,
  ...over,
});

const both = { closeDuplicates: true, closeAfterMin: 10 };

describe("decideClosures — what it refuses to close", () => {
  it("closes nothing when both behaviours are off", () => {
    const tabs = [nt(1), nt(2), nt(3), nt(4, { url: "https://a.test" })];
    expect(decideClosures(tabs, SELF, { closeDuplicates: false, closeAfterMin: 0 }, NOW)).toEqual([]);
  });

  it("never closes the tab you are looking at", () => {
    const tabs = [nt(1, { active: true }), nt(2), nt(9, { url: "https://a.test" })];
    expect(decideClosures(tabs, SELF, both, NOW)).not.toContain(1);
  });

  it("never closes a pinned tab", () => {
    const tabs = [nt(1, { pinned: true }), nt(2), nt(9, { url: "https://a.test" })];
    expect(decideClosures(tabs, SELF, both, NOW)).not.toContain(1);
  });

  it("never closes the only tab in a window, which would close the window", () => {
    const tabs = [nt(1, { windowId: 7 })];
    expect(decideClosures(tabs, SELF, both, NOW)).toEqual([]);
  });

  it("never closes a page that is not ours", () => {
    const tabs = [
      nt(1, { url: "https://example.com", lastAccessed: NOW - 300 * MIN }),
      nt(2),
    ];
    expect(decideClosures(tabs, SELF, both, NOW)).not.toContain(1);
  });

  it("never closes a tab opened moments ago", () => {
    // Opened, then glanced away from — not abandoned.
    const tabs = [nt(1, { lastAccessed: NOW - 5_000 }), nt(2), nt(3)];
    expect(decideClosures(tabs, SELF, both, NOW)).not.toContain(1);
  });
});

describe("decideClosures — duplicates", () => {
  it("leaves one new tab page behind, not none", () => {
    const tabs = [
      nt(1, { lastAccessed: NOW - 20 * MIN }),
      nt(2, { lastAccessed: NOW - 30 * MIN }),
      nt(3, { lastAccessed: NOW - 40 * MIN }),
      nt(9, { url: "https://a.test" }),
    ];
    const close = decideClosures(tabs, SELF, { closeDuplicates: true, closeAfterMin: 0 }, NOW);
    expect(close.sort()).toEqual([2, 3]);
    expect(close).not.toContain(1);
  });

  it("keeps the freshest of the duplicates", () => {
    const tabs = [
      nt(1, { lastAccessed: NOW - 90 * MIN }),
      nt(2, { lastAccessed: NOW - 2 * MIN }),
      nt(9, { url: "https://a.test" }),
    ];
    const close = decideClosures(tabs, SELF, { closeDuplicates: true, closeAfterMin: 0 }, NOW);
    expect(close).toEqual([1]);
  });

  it("closes every spare copy when one of them is the active tab", () => {
    // You are on a new tab page: the others are all spares.
    const tabs = [
      nt(1, { active: true }),
      nt(2, { lastAccessed: NOW - 20 * MIN }),
      nt(3, { lastAccessed: NOW - 25 * MIN }),
      nt(9, { url: "https://a.test" }),
    ];
    const close = decideClosures(tabs, SELF, { closeDuplicates: true, closeAfterMin: 0 }, NOW);
    expect(close.sort()).toEqual([2, 3]);
  });

  it("does nothing with a single new tab page", () => {
    const tabs = [nt(1), nt(9, { url: "https://a.test" })];
    expect(decideClosures(tabs, SELF, { closeDuplicates: true, closeAfterMin: 0 }, NOW)).toEqual([]);
  });
});

describe("decideClosures — idle", () => {
  it("closes one untouched past the cutoff", () => {
    const tabs = [nt(1, { lastAccessed: NOW - 45 * MIN }), nt(9, { url: "https://a.test" })];
    const close = decideClosures(tabs, SELF, { closeDuplicates: false, closeAfterMin: 30 }, NOW);
    expect(close).toEqual([1]);
  });

  it("leaves one inside the cutoff alone", () => {
    const tabs = [nt(1, { lastAccessed: NOW - 5 * MIN }), nt(9, { url: "https://a.test" })];
    expect(decideClosures(tabs, SELF, { closeDuplicates: false, closeAfterMin: 30 }, NOW)).toEqual([]);
  });

  it("still respects every guard", () => {
    const ancient = NOW - 999 * MIN;
    const tabs = [
      nt(1, { active: true, lastAccessed: ancient }),
      nt(2, { pinned: true, lastAccessed: ancient }),
      nt(3, { windowId: 8, lastAccessed: ancient }),
      nt(4, { lastAccessed: ancient }),
      nt(9, { url: "https://a.test" }),
    ];
    expect(decideClosures(tabs, SELF, { closeDuplicates: false, closeAfterMin: 1 }, NOW)).toEqual([4]);
  });
});

describe("pruneOptionsFrom", () => {
  it("is off unless explicitly switched on", () => {
    expect(pruneOptionsFrom(undefined)).toEqual({ closeDuplicates: false, closeAfterMin: 0 });
    const inst = { def: "tabs", id: "tabs", name: "t", enabled: true, opts: {} };
    expect(pruneOptionsFrom(inst)).toEqual({ closeDuplicates: false, closeAfterMin: 0 });
  });

  it("reads both settings", () => {
    const inst = {
      def: "tabs", id: "tabs", name: "t", enabled: true,
      opts: { auto_close_dupes: true, auto_close_after_min: 20 },
    };
    expect(pruneOptionsFrom(inst)).toEqual({ closeDuplicates: true, closeAfterMin: 20 });
  });
});

describe("pruneIntervalMinutes — the clock the feature was missing", () => {
  const opts = (closeAfterMin: number, closeDuplicates = false) => ({
    closeDuplicates,
    closeAfterMin,
  });

  it("asks for no alarm at all when nothing is switched on", () => {
    expect(pruneIntervalMinutes(opts(0))).toBeNull();
  });

  it("checks twice per cutoff, so closing lags by at most half of it", () => {
    expect(pruneIntervalMinutes(opts(4))).toBe(2);
    expect(pruneIntervalMinutes(opts(9))).toBe(4.5);
  });

  it("never asks for a period Chrome would ignore", () => {
    // The bug this whole function fixes: a one-minute cutoff that never fired.
    expect(pruneIntervalMinutes(opts(1))).toBe(0.5);
    expect(pruneIntervalMinutes(opts(0.25))).toBe(0.5);
  });

  it("does not wake the worker every half-minute for a long cutoff", () => {
    expect(pruneIntervalMinutes(opts(120))).toBe(5);
  });

  it("sweeps slowly for duplicates, which tab events already catch", () => {
    expect(pruneIntervalMinutes(opts(0, true))).toBe(1);
  });

  it("lets the cutoff win when both are on", () => {
    expect(pruneIntervalMinutes(opts(3, true))).toBe(1.5);
  });
});

describe("the focused window is what \"you are looking at\" means", () => {
  const idle = { closeDuplicates: false, closeAfterMin: 5 };

  it("protects the selected tab of the window you are in", () => {
    const tabs = [nt(1, { active: true, lastAccessed: NOW - 99 * MIN }), nt(2)];
    expect(decideClosures(tabs, SELF, idle, NOW, 1)).not.toContain(1);
  });

  it("closes a New Tab left selected in a window you are not in", () => {
    // The reported failure: open a New Tab, switch elsewhere, and it stays
    // selected in its own window forever. Selected is not the same as read.
    const tabs = [
      nt(1, { active: true, windowId: 2, lastAccessed: NOW - 99 * MIN }),
      nt(2, { windowId: 2, url: "https://a.test" }),
      nt(3, { active: true, windowId: 1, url: "https://b.test" }),
      nt(4, { windowId: 1, url: "https://c.test" }),
    ];
    expect(decideClosures(tabs, SELF, idle, NOW, 1)).toEqual([1]);
  });

  it("falls back to protecting every selected tab when focus is unknown", () => {
    const tabs = [
      nt(1, { active: true, windowId: 2, lastAccessed: NOW - 99 * MIN }),
      nt(2, { windowId: 2, url: "https://a.test" }),
    ];
    expect(decideClosures(tabs, SELF, idle, NOW, undefined)).toEqual([]);
  });
});

describe("explainClosures — every tab gets a stated reason", () => {
  it("names the guard holding each tab, so a probe can show it", () => {
    const tabs = [
      nt(1, { active: true, lastAccessed: NOW - 99 * MIN }),
      nt(2, { pinned: true, lastAccessed: NOW - 99 * MIN }),
      nt(3, { windowId: 9, lastAccessed: NOW - 99 * MIN }),
      nt(4, { lastAccessed: NOW - 10_000 }),
      nt(5, { lastAccessed: NOW - 99 * MIN }),
      nt(6, { url: "https://a.test" }),
    ];
    const why = Object.fromEntries(
      explainClosures(tabs, SELF, { closeDuplicates: false, closeAfterMin: 5 }, NOW, 1).map(
        (v) => [v.id, v.why],
      ),
    );
    expect(why[1]).toBe("you are looking at it");
    expect(why[2]).toBe("pinned");
    expect(why[3]).toBe("the only tab in its window");
    expect(why[4]).toMatch(/grace/);
    expect(why[5]).toMatch(/^untouched for/);
    expect(why[6]).toBe("not a New Tab page");
  });

  it("says so plainly when the feature is simply off", () => {
    const v = explainClosures([nt(1), nt(2)], SELF, { closeDuplicates: false, closeAfterMin: 0 }, NOW, 1);
    expect(v.every((x) => !x.close)).toBe(true);
    expect(v[0]!.why).toBe("auto-close is switched off");
  });

  it("reports the idle age against the cutoff when nothing else applies", () => {
    const tabs = [nt(1, { lastAccessed: NOW - 3 * MIN }), nt(2, { url: "https://a.test" })];
    const v = explainClosures(tabs, SELF, { closeDuplicates: false, closeAfterMin: 30 }, NOW, 1);
    expect(v[0]!.why).toBe("idle 3m 0s, cutoff is 30m");
  });
});

describe("what counts as a New Tab page", () => {
  // The bug that made auto-close a no-op everywhere: overriding the new tab
  // page does not change the URL the browser reports for it. Pressing Ctrl+T
  // never produces the extension URL, which was the only thing matched.
  it("recognises the URL a real new tab actually reports", () => {
    for (const url of [
      "chrome://newtab/",
      "chrome://newtab",
      "edge://newtab/",
      "brave://newtab/",
      "chrome://new-tab-page/",
      "chrome://new-tab-page-third-party/",
      "about:newtab",
      "about:home",
    ]) {
      expect(isOurNewTab({ url }, SELF), url).toBe(true);
    }
  });

  it("still recognises the page navigated to by hand", () => {
    expect(isOurNewTab({ url: SELF }, SELF)).toBe(true);
    expect(isOurNewTab({ url: `${SELF}?x=1` }, SELF)).toBe(true);
  });

  it("uses pendingUrl while the tab is still loading", () => {
    expect(isOurNewTab({ pendingUrl: "chrome://newtab/" }, SELF)).toBe(true);
  });

  it("does not match an ordinary page, or a settings page, or a blank tab", () => {
    for (const url of [
      "https://example.com",
      "https://newtab.example.com/",
      "chrome://settings/",
      "chrome://history/",
      "about:blank",
      "",
    ]) {
      expect(isOurNewTab({ url }, SELF), url).toBe(false);
    }
  });

  it("closes a browser new tab, which is what the reader sees our page in", () => {
    const tabs = [
      { id: 1, url: "chrome://newtab/", windowId: 1, lastAccessed: NOW - 40 * MIN },
      { id: 2, url: "https://a.test", windowId: 1, lastAccessed: NOW },
    ];
    expect(decideClosures(tabs, SELF, { closeDuplicates: false, closeAfterMin: 5 }, NOW, 1)).toEqual([1]);
  });
});
