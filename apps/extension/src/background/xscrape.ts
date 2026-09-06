/**
 * Reading X search results from a rendered page.
 *
 * `x.com/search` serves a JavaScript shell — no results exist in the HTML —
 * so the only way to see posts without paying per read is to let X's own
 * client render them in a tab the reader is already signed into, and read the
 * DOM afterwards.
 *
 * **This is off by default and requires an explicit opt-in**, because it is
 * against X's terms of service and enforcement falls on the reader's own
 * account. The settings UI states that plainly; nothing here should hide it.
 *
 * ## Pacing
 *
 * The cadence below is deliberately slower than a person browsing. That is
 * partly the point of the feature request, and partly simple courtesy: a new
 * tab page has no business generating more load than the human sitting in
 * front of it would. Concretely:
 *
 *   · one search at a time, never concurrent
 *   · a long minimum interval per search, with jitter so it never lands on a
 *     fixed schedule
 *   · a hard daily ceiling across all searches
 *   · a dwell after load, and at most two gentle scrolls, because X
 *     virtualises the list and only a screenful exists at once
 *   · nothing at all unless the browser is actually in use
 */
import { ext, getLocal, setLocal } from "../lib/ext";
import type { FeedItem, Instance } from "../lib/types";
import { wasm } from "./wasm-loader";

/**
 * Never fetch a given search more often than this, whatever the settings say.
 *
 * Fifteen minutes is roughly how often someone watching a live search would
 * flick back to the tab. Below that it stops resembling a person reading and
 * starts resembling a poller, which is the line this feature was asked to
 * stay on the right side of.
 */
export const MIN_INTERVAL_MIN = 15;

/**
 * Ceiling across every X search, per day.
 *
 * The real limiter is the idle check — nothing runs unless the browser is in
 * use — so this is a backstop against a short interval plus several saved
 * searches adding up to far more traffic than any of them looks like alone.
 */
export const MAX_LOADS_PER_DAY = 48;
/** Let the client render and settle before reading. */
const DWELL_MS = 4_500;
/** X virtualises the timeline; a couple of screens is all a person would see. */
const MAX_SCROLLS = 2;
const SCROLL_PAUSE_MS = 2_600;
/** Give up rather than leaving a tab open. */
const HARD_TIMEOUT_MS = 45_000;

export interface ScrapeState {
  /** Search id -> last load, epoch seconds. */
  last: Record<string, number>;
  /** `YYYY-MM-DD` -> loads that day. */
  perDay: Record<string, number>;
  /**
   * When the in-flight scrape started, epoch seconds.
   *
   * A timestamp rather than a boolean, and this is the whole point: MV3
   * terminates a service worker whenever it likes, so the `finally` that
   * clears the lock is not guaranteed to run. A boolean left `true` by a
   * killed worker is a permanent lock — "Another X search is loading."
   * forever, with nothing loading. A timestamp can go stale.
   */
  runningSince?: number;
}

/** A scrape cannot legitimately outlive this, so an older lock is debris. */
export const LOCK_STALE_SECS = 180;

const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);
const STATE_KEY = "opentabs:xscrape";

async function state(): Promise<ScrapeState> {
  return await getLocal<ScrapeState>(STATE_KEY, { last: {}, perDay: {} });
}

/**
 * Whether this search may run now.
 *
 * When it may not, returns either a `reason` (a fixed fact, safe to store) or
 * a `retryAt` timestamp for the caller to render live. Never a pre-computed
 * countdown: that is a number that starts decaying the instant it is stored.
 */
export interface Gate {
  ok: boolean;
  reason?: string;
  retryAt?: number;
}

/**
 * The pacing decision, as a pure function.
 *
 * Extracted because this gate has now been wrong twice — once storing a
 * countdown that decayed into a lie, once holding a lock a terminated worker
 * could never release. Both were invisible until someone read the message on
 * the card. Deciding is separable from fetching, so it is tested directly.
 */
export function gate(
  s: ScrapeState,
  id: string,
  intervalMin: number,
  now: number,
  today: string,
): Gate {
  // A lock older than a scrape could possibly take is debris from a worker
  // that was terminated mid-run, not a scrape in progress.
  if (s.runningSince && now - s.runningSince < LOCK_STALE_SECS) {
    // Genuinely busy. One at a time is deliberate, and a scheduling detail
    // is not a problem to report — no reason, so the card keeps its items.
    return { ok: false, retryAt: s.runningSince + LOCK_STALE_SECS };
  }

  const loads = s.perDay[today] ?? 0;
  if (loads >= MAX_LOADS_PER_DAY) {
    return { ok: false, reason: `Daily limit reached (${MAX_LOADS_PER_DAY} loads).` };
  }

  const gapSecs = Math.max(MIN_INTERVAL_MIN, intervalMin) * 60;
  // Jitter derived from the id, not Math.random: a value recomputed on every
  // call makes the countdown jump around, and one stable offset per search is
  // just as effective at avoiding a fixed global cadence.
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const jittered = gapSecs * (0.75 + ((h % 1000) / 1000) * 0.5);

  const last = s.last[id] ?? 0;
  if (now - last < jittered) {
    // An absolute time, never a countdown: a stored "in 131 minutes" is wrong
    // the moment it is written.
    return { ok: false, retryAt: Math.round(last + jittered) };
  }
  return { ok: true };
}

/**
 * Whether this search may run now.
 *
 * Adds the one thing `gate` cannot know: whether anyone is at the machine.
 */
export async function mayRun(inst: Instance, intervalMin: number): Promise<Gate> {
  const decision = gate(await state(), inst.id, intervalMin, now(), today());
  if (!decision.ok) return decision;

  // Nothing runs on an unattended machine. An extension that keeps loading
  // pages overnight is the behaviour worth avoiding.
  try {
    const idle = await ext.idle.queryState(600);
    if (idle !== "active") return { ok: false, reason: "Waiting until the browser is in use." };
  } catch {
    /* the idle API is optional; carry on without it */
  }
  return { ok: true };
}

async function noteRun(id: string) {
  const s = await state();
  s.last[id] = now();
  s.perDay[today()] = (s.perDay[today()] ?? 0) + 1;
  // Keep only today and yesterday.
  for (const day of Object.keys(s.perDay)) {
    if (day < today()) delete s.perDay[day];
  }
  await setLocal(STATE_KEY, s);
}

async function setRunning(running: boolean) {
  const s = await state();
  if (running) s.runningSince = now();
  else delete s.runningSince;
  await setLocal(STATE_KEY, s);
}

/**
 * Drop a lock left behind by a terminated worker.
 *
 * Called when the worker starts: if it is only starting now, nothing it
 * started is still running, whatever the stored state claims.
 */
export async function clearStaleLock(): Promise<void> {
  const s = await state();
  if (s.runningSince) {
    delete s.runningSince;
    await setLocal(STATE_KEY, s);
  }
}

/**
 * Runs inside the page. Self-contained by necessity — `executeScript` gives it
 * no access to anything in this module.
 *
 * Reads `data-testid` attributes rather than class names: X's classes are
 * obfuscated and rotate, the test ids are comparatively stable. Everything is
 * optional; the normaliser in Rust decides what is trustworthy.
 */
function extractFromPage(scrolls: number, pause: number, dwell: number) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const readArticles = () => {
    const out: Record<string, unknown>[] = [];
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      const textEl = art.querySelector('[data-testid="tweetText"]');
      const timeEl = art.querySelector("time[datetime]");
      const link = timeEl?.closest("a");
      const href = link?.getAttribute("href") ?? "";
      const handle = href.startsWith("/") ? href.slice(1).split("/")[0] : "";
      const metric = (name: string) => {
        const el = art.querySelector(`[data-testid="${name}"]`);
        const label = el?.getAttribute("aria-label") ?? "";
        const n = label.match(/(\d[\d,.]*)/);
        return n ? Number(n[1]!.replace(/[,.]/g, "")) : null;
      };
      out.push({
        id: "",
        text: (textEl as HTMLElement | null)?.innerText ?? "",
        handle,
        name: "",
        time: timeEl?.getAttribute("datetime") ?? "",
        url: href ? `https://x.com${href}` : "",
        replies: metric("reply"),
        reposts: metric("retweet"),
        likes: metric("like"),
      });
    }
    return out;
  };

  return (async () => {
    // Wait for posts to actually render rather than trusting a fixed pause.
    // X fetches results after the URL settles, and how long that takes
    // depends on the network, not on us.
    const deadline = Date.now() + dwell + 8000;
    while (Date.now() < deadline) {
      if (document.querySelector('article[data-testid="tweet"]')) break;
      // "No results" is a legitimate outcome, not something to wait out.
      if (document.body.innerText.includes("No results for")) break;
      await sleep(400);
    }
    await sleep(dwell);
    const byUrl = new Map<string, Record<string, unknown>>();
    const collect = () => {
      for (const p of readArticles()) {
        const key = String(p.url || p.text);
        if (key && !byUrl.has(key)) byUrl.set(key, p);
      }
    };
    collect();
    // The list is virtualised: a screenful at a time, so scroll gently and
    // gather what appears. Two screens is what a person glancing would see.
    for (let i = 0; i < scrolls; i++) {
      window.scrollBy({ top: window.innerHeight * 0.9, behavior: "smooth" });
      await sleep(pause);
      collect();
    }
    return { posts: [...byUrl.values()] };
  })();
}

/**
 * Open the search in a background tab, let it render, read it, close it.
 *
 * The tab is never focused and is always closed, including on failure — an
 * extension that leaves x.com tabs lying around is worse than one that fails.
 */
export async function scrapeSearch(
  inst: Instance,
  webUrl: string,
): Promise<{ items: FeedItem[]; notes: string[] }> {
  if (!(await ext.permissions.contains({ origins: ["https://x.com/*"] }).catch(() => false))) {
    return { items: [], notes: ["No access to x.com — grant it in Settings."] };
  }

  await setRunning(true);
  let tabId: number | undefined;
  try {
    const tab = await ext.tabs.create({ url: webUrl, active: false });
    tabId = tab.id;
    if (tabId === undefined) return { items: [], notes: ["Could not open a tab."] };

    // Wait for the page to *settle*, not merely to report "complete".
    //
    // x.com is a single-page app: it fires `complete` and then navigates
    // again on its own — to a login flow when signed out, or to a rewritten
    // search URL when signed in. Injecting during that navigation tears down
    // frame 0 mid-injection, which is exactly the "Frame with ID 0 was
    // removed" failure. So poll until the URL stops changing.
    const settled = await waitForSettle(tabId);
    if (!settled.ok) return { items: [], notes: [settled.reason!] };

    const payload = await extractWithRetry(tabId);
    if (!payload) {
      return {
        items: [],
        notes: [
          "Could not read the page. If you are signed out of X, sign in once in a " +
            "normal tab and try again.",
        ],
      };
    }

    const core = await wasm();
    const items = core.normalizeXPosts(JSON.stringify(payload), "xscrape", now()) as FeedItem[];
    await noteRun(inst.id);

    if (items.length === 0) {
      return {
        items: [],
        notes: [
          "Nothing readable on the page. Either the search has no results in that " +
            "window, you are signed out, or X changed its markup.",
        ],
      };
    }
    return { items, notes: [] };
  } catch (e) {
    return { items: [], notes: [`X could not be read (${e instanceof Error ? e.message : e}).`] };
  } finally {
    if (tabId !== undefined) await ext.tabs.remove(tabId).catch(() => {});
    await setRunning(false);
  }
}

/**
 * Poll until the tab has finished loading *and* stopped navigating.
 *
 * Also the place a signed-out session is detected: X redirects away from
 * `/search` to a login route, and saying so is far more useful than the
 * frame-removed error the injection would otherwise produce.
 */
async function waitForSettle(
  tabId: number,
): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + HARD_TIMEOUT_MS;
  let lastUrl = "";
  let stableFor = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    let tab: chrome.tabs.Tab;
    try {
      tab = await ext.tabs.get(tabId);
    } catch {
      return { ok: false, reason: "The tab closed before it could be read." };
    }
    const url = tab.url ?? "";

    if (url && !/^https:\/\/x\.com\/search/.test(url)) {
      // Redirected off the search page: login, or an interstitial.
      if (/\/(i\/flow|login|account)/.test(url)) {
        return {
          ok: false,
          reason: "X sent that to a sign-in page — sign in to X in a normal tab first.",
        };
      }
      return { ok: false, reason: `X redirected to ${new URL(url).pathname} instead of the search.` };
    }

    if (tab.status === "complete" && url === lastUrl) {
      stableFor += 700;
      // Two consecutive stable polls: the SPA has stopped moving.
      if (stableFor >= 1400) return { ok: true };
    } else {
      stableFor = 0;
      lastUrl = url;
    }
  }
  return { ok: false, reason: "X did not finish loading in time." };
}

/**
 * Inject and read, retrying once if the frame goes away underneath us.
 *
 * Runs in the isolated world, not `MAIN`. Reading the DOM needs no page
 * globals, and the isolated world survives the page's own script activity.
 */
async function extractWithRetry(tabId: number): Promise<{ posts: unknown[] } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const results = (await Promise.race([
        ext.scripting.executeScript({
          target: { tabId, allFrames: false },
          func: extractFromPage,
          args: [MAX_SCROLLS, SCROLL_PAUSE_MS, DWELL_MS],
        }),
        new Promise((r) => setTimeout(() => r(null), HARD_TIMEOUT_MS)),
      ])) as { result?: { posts: unknown[] } }[] | null;

      const payload = results?.[0]?.result;
      if (payload) return payload;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // "Frame with ID 0 was removed" means the page navigated mid-inject.
      // One more try after it settles is usually enough.
      if (attempt === 0 && /Frame with ID|no tab with id|Cannot access/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      throw e;
    }
  }
  return null;
}

/**
 * Forget when a search last ran.
 *
 * Called when its settings change, so a shortened interval takes effect now
 * rather than after the old one elapses — someone who moves 4 hours down to
 * 15 minutes means "check sooner", not "wait out the old timer first".
 */
export async function resetSchedule(id: string): Promise<void> {
  const s = await state();
  if (s.last[id]) {
    delete s.last[id];
    await setLocal(STATE_KEY, s);
  }
}
