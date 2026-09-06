/**
 * Closing spare OpenTabs pages.
 *
 * Opening a new tab to check something and leaving it is how you end up with
 * six identical new-tab pages. This closes the ones you are demonstrably not
 * using — but closing tabs is destructive and unasked-for closure is far worse
 * than clutter, so every rule here is a reason *not* to close something.
 *
 * Never closed:
 *   · the selected tab of the focused window — you are looking at it
 *   · the only tab in a window — that would close the window
 *   · a pinned tab — pinning is an explicit "keep this"
 *   · anything that is not a new tab page
 *   · a tab younger than the grace period, so a tab you just opened and
 *     switched away from for a moment survives
 *   · the most recently used new tab page, when pruning duplicates — that
 *     should leave you with one, not none. The idle cutoff is deliberately
 *     stricter: if every copy is stale, every copy goes.
 *
 * Both behaviours are off by default.
 */
import { ext } from "../lib/ext";
import type { Instance } from "../lib/types";

/** A tab opened seconds ago is not "inactive", whatever its access time says. */
export const GRACE_MS = 60_000;

export interface PruneOptions {
  /** Close all but the most recently used new tab page. */
  closeDuplicates: boolean;
  /** Close a new tab page untouched for this many minutes. 0 disables it. */
  closeAfterMin: number;
}

export function pruneOptionsFrom(inst: Instance | undefined): PruneOptions {
  return {
    closeDuplicates: inst?.opts?.auto_close_dupes === true,
    closeAfterMin: Number(inst?.opts?.auto_close_after_min ?? 0),
  };
}

export interface TabView {
  id?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active?: boolean;
  pinned?: boolean;
  windowId?: number;
  lastAccessed?: number;
}

/** One tab, and what the prune decided about it — the whole basis of the probe. */
export interface Verdict {
  id: number;
  windowId: number;
  /** Milliseconds since the tab was last selected. */
  idleMs: number;
  ours: boolean;
  close: boolean;
  /** Why it is closing, or which guard is holding it. Always populated. */
  why: string;
}

/**
 * The URL a browser reports for its own new tab page.
 *
 * **A real new tab does not report the extension's URL.** Overriding the new
 * tab page does not change what `tabs.query` says the tab is: pressing Ctrl+T
 * gives a tab whose url is `chrome://newtab/` (or `edge://newtab/`,
 * `about:newtab`), with our page rendered inside it. Matching only the
 * extension URL therefore matched nothing a reader ever actually opens, and
 * auto-close silently found no candidates on any browser.
 *
 * The reason this survived a test suite is worth stating: the tests navigated
 * a tab to the extension page by hand, which produces the one URL that never
 * occurs in use. They now open real new tabs.
 */
const BROWSER_NEW_TAB =
  /^(?:(?:chrome|edge|brave|vivaldi|opera|browser):\/\/(?:newtab|new-tab-page|new-tab-page-third-party)\/?|about:(?:newtab|home))$/i;

/** Is this a new tab page — ours, or the browser's own showing ours? */
export function isOurNewTab(tab: TabView, selfUrl: string): boolean {
  const url = tab.url || tab.pendingUrl || "";
  return url.startsWith(selfUrl) || BROWSER_NEW_TAB.test(url);
}

const mins = (ms: number) => `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

/**
 * Decide about every tab, with a stated reason either way. Pure, so the rules
 * can be tested without a browser — the part that must never be wrong is the
 * deciding, not the calling.
 *
 * `focusedWindowId` is what separates "you are looking at it" from "it happens
 * to be selected in some window you are not in". Conflating the two meant a
 * New Tab left selected in a background window was protected forever, which
 * is the exact tab this feature exists to close. Pass `undefined` when the
 * focused window is unknown and every selected tab is protected instead —
 * unknown must fall back to the cautious reading.
 */
export function explainClosures(
  tabs: TabView[],
  selfUrl: string,
  opts: PruneOptions,
  now: number,
  focusedWindowId?: number,
): Verdict[] {
  const perWindow = new Map<number, number>();
  for (const t of tabs) {
    perWindow.set(t.windowId ?? -1, (perWindow.get(t.windowId ?? -1) ?? 0) + 1);
  }

  const enabled = opts.closeDuplicates || opts.closeAfterMin > 0;

  // Candidates first, so "keep the freshest" can be decided over the set.
  const idleOf = (t: TabView) => now - (t.lastAccessed ?? now);
  const eligible = tabs.filter(
    (t) =>
      t.id !== undefined &&
      isOurNewTab(t, selfUrl) &&
      !t.pinned &&
      !(t.active && (focusedWindowId === undefined || t.windowId === focusedWindowId)) &&
      (perWindow.get(t.windowId ?? -1) ?? 0) > 1 &&
      idleOf(t) > GRACE_MS,
  );
  const byRecency = [...eligible].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const freshestSpare = byRecency[0]?.id;
  // If a new tab page is the one you are looking at, every spare is spare.
  const looking = tabs.some(
    (t) =>
      isOurNewTab(t, selfUrl) &&
      t.active &&
      (focusedWindowId === undefined || t.windowId === focusedWindowId),
  );

  return tabs.map((t): Verdict => {
    const idleMs = idleOf(t);
    const base = { id: t.id ?? -1, windowId: t.windowId ?? -1, idleMs };
    if (!isOurNewTab(t, selfUrl)) {
      return { ...base, ours: false, close: false, why: "not a New Tab page" };
    }
    const ours = true;
    if (!enabled) {
      return { ...base, ours, close: false, why: "auto-close is switched off" };
    }
    if (t.pinned) return { ...base, ours, close: false, why: "pinned" };
    if (t.active && (focusedWindowId === undefined || t.windowId === focusedWindowId)) {
      return { ...base, ours, close: false, why: "you are looking at it" };
    }
    if ((perWindow.get(t.windowId ?? -1) ?? 0) <= 1) {
      return { ...base, ours, close: false, why: "the only tab in its window" };
    }
    if (idleMs <= GRACE_MS) {
      return { ...base, ours, close: false, why: `opened ${mins(idleMs)} ago — inside the 1m grace` };
    }
    if (opts.closeAfterMin > 0 && idleMs > opts.closeAfterMin * 60_000) {
      return { ...base, ours, close: true, why: `untouched for ${mins(idleMs)}` };
    }
    if (opts.closeDuplicates && !(t.id === freshestSpare && !looking)) {
      return { ...base, ours, close: true, why: "a spare copy" };
    }
    if (opts.closeDuplicates && t.id === freshestSpare) {
      return { ...base, ours, close: false, why: "the one spare that is kept" };
    }
    return {
      ...base,
      ours,
      close: false,
      why: `idle ${mins(idleMs)}, cutoff is ${opts.closeAfterMin}m`,
    };
  });
}

/** The ids to close. */
export function decideClosures(
  tabs: TabView[],
  selfUrl: string,
  opts: PruneOptions,
  now: number,
  focusedWindowId?: number,
): number[] {
  if (!opts.closeDuplicates && opts.closeAfterMin <= 0) return [];
  return explainClosures(tabs, selfUrl, opts, now, focusedWindowId)
    .filter((v) => v.close)
    .map((v) => v.id);
}

/**
 * How often to look, in minutes — or `null` when there is nothing to look for.
 *
 * This exists because the prune used to run *only* from tab events. A New Tab
 * you open and then leave alone generates no events at all, so the one case
 * the feature is named after was the one case it never fired in. It needs its
 * own clock.
 *
 * Half the cutoff, so "close after N minutes" overshoots by at most N/2 rather
 * than by a whole period. Floored at 30s because Chrome ignores anything
 * shorter, and capped at 5 minutes so a long cutoff does not wake the worker
 * more often than it deserves.
 */
export function pruneIntervalMinutes(opts: PruneOptions): number | null {
  if (opts.closeAfterMin > 0) {
    return Math.min(Math.max(opts.closeAfterMin / 2, 0.5), 5);
  }
  // Duplicates appear only when a tab is opened, and that fires an event. A
  // slow sweep is just a backstop for events we missed.
  if (opts.closeDuplicates) return 1;
  return null;
}

/**
 * Which window the reader would return to.
 *
 * `getLastFocused` rather than "the focused window": when the browser itself
 * is behind another application there is no focused window, but there is
 * still a tab the reader left off on, and that is the one to protect.
 */
async function focusedWindow(): Promise<number | undefined> {
  try {
    const w = await ext.windows.getLastFocused();
    return typeof w?.id === "number" && w.id >= 0 ? w.id : undefined;
  } catch {
    return undefined;
  }
}

/** Everything the prune saw and decided, for the settings probe. */
export async function explainNow(inst: Instance | undefined): Promise<{
  opts: PruneOptions;
  everyMin: number | null;
  verdicts: Verdict[];
}> {
  const opts = pruneOptionsFrom(inst);
  const selfUrl = ext.runtime.getURL("newtab.html");
  const tabs = await ext.tabs.query({});
  return {
    opts,
    everyMin: pruneIntervalMinutes(opts),
    verdicts: explainClosures(tabs, selfUrl, opts, Date.now(), await focusedWindow()),
  };
}

/** Run a prune pass. Silent on failure: a tab that will not close is not an error. */
export async function pruneNewTabs(inst: Instance | undefined): Promise<number> {
  const opts = pruneOptionsFrom(inst);
  if (!opts.closeDuplicates && opts.closeAfterMin <= 0) return 0;
  try {
    const selfUrl = ext.runtime.getURL("newtab.html");
    const tabs = await ext.tabs.query({});
    const ids = decideClosures(tabs, selfUrl, opts, Date.now(), await focusedWindow());
    if (ids.length > 0) await ext.tabs.remove(ids);
    return ids.length;
  } catch {
    return 0;
  }
}
