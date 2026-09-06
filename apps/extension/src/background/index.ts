/**
 * The service worker — the only place work happens.
 *
 * chrome.alarms wakes it, it fetches and parses and ranks (in wasm), and it
 * writes render-ready JSON to storage.local. The new tab page then reads one
 * key and paints, with zero network and zero wasm on its critical path.
 *
 * The asymmetry is the design. Latency here is invisible; latency on the new
 * tab page is the entire product.
 */
import { ext, KEY, getLocal, getSync, setLocal, setSync } from "../lib/ext";
import { type Cooldowns, pruneCooldowns } from "../lib/backoff";
import { DEFAULT_CLEAR_HOURS, sweepFocus } from "../lib/focus";
import { configHashOf, mergePayload, withoutErrors } from "../lib/payload";
import type { CalEvent, Config, Instance, LocalState, Payloads, Todo } from "../lib/types";
import { conditionalGet, keepAlive } from "./fetcher";
import {
  addBookmark, bookmarkFolders, bookmarkedUrls, refreshApps, refreshBookmarks, refreshCalendar,
  refreshCrypto, refreshEquities, refreshStatus, refreshTopic, refreshTrending,
  moveBookmark, refreshWeather, refreshXSearch, removeBookmark, toggleBookmark, xWebUrl,
} from "./sources";
import { explainNow, pruneIntervalMinutes, pruneNewTabs, pruneOptionsFrom } from "./prune";
import * as session from "./session";
import { clearStaleLock, resetSchedule } from "./xscrape";
import { wasm } from "./wasm-loader";

const ALARM_REFRESH = "opentabs:refresh";
const ALARM_TODO = "opentabs:todo";
const ALARM_PRUNE = "opentabs:prune";

/**
 * How long a group's data stays believable. Past this the page hides the
 * group rather than showing stale data as current — a dead scheduler must
 * not look like quiet news.
 */
const TTL: Record<string, number> = {
  topic: 45 * 60,
  weather: 30 * 60,
  crypto: 5 * 60,
  equities: 15 * 60,
  status: 5 * 60,
  // Reads are billed per post, so this refreshes far less eagerly than a feed.
  xsearch: 30 * 60,
  apps: 24 * 3600,
  trending: 12 * 3600,
  calendar: 20 * 60,
  tabs: 60,
  // Local like tabs, and refreshed on bookmark events, so the budget only has
  // to outlast a quiet browser rather than pace a fetch.
  bookmarks: 10 * 60,
};

const now = () => Math.floor(Date.now() / 1000);

/**
 * Load the config, and **write it back when it was absent or out of date**.
 *
 * The write is not an optimisation. The new tab page reads config straight
 * from storage and renders nothing when it finds none — so without this, a
 * fresh install shows an empty page until the user happens to open settings.
 * Migration happening only in memory is exactly the kind of bug that never
 * shows up for a developer whose profile already has a config.
 */
async function loadConfig(): Promise<Config> {
  const core = await wasm();
  const stored = await getSync<{ version?: number } | null>(KEY.config, null);
  const cfg = core.migrateConfig(stored as object) as Config;
  if (!stored || stored.version !== cfg.version) {
    await setSync(KEY.config, cfg);
  }
  return cfg;
}

async function writePayload(
  id: string,
  def: string,
  data: unknown,
  error?: string,
  configHash?: string,
  retryAt?: number,
) {
  const payloads = await getLocal<Payloads>(KEY.payloads, {});
  const merged = mergePayload(id, payloads[id], data, TTL[def] ?? 3600, now(), error, configHash);
  payloads[id] = retryAt ? { ...merged, retry_at: retryAt } : merged;
  await setLocal(KEY.payloads, payloads);
}

/**
 * Drop every stored `error` note.
 *
 * A note describes the *last attempt*, but it is stored beside the data and
 * so outlives the code that produced it. That is how "Another X search is
 * loading." survived: the message was deleted from the source, the condition
 * it described was fixed, and the string kept rendering because it was in
 * storage, not in the build. Nothing rewrites a note except a refresh of that
 * exact group, and a group that is gated writes nothing at all.
 *
 * Called on install, update and browser start — a worker that is only
 * starting now has attempted nothing, so it holds no diagnosis. Anything
 * still true is written again by the refresh that follows immediately.
 */
async function clearStoredErrors(): Promise<void> {
  const { payloads, touched } = withoutErrors(await getLocal<Payloads>(KEY.payloads, {}));
  if (touched) await setLocal(KEY.payloads, payloads);
}

/** Shape a tab list for the grouper. The worker sends nothing else about tabs. */
function shapeTabs(tabs: chrome.tabs.Tab[]) {
  return tabs.map((t) => ({
    id: t.id ?? 0,
    window_id: t.windowId ?? 0,
    title: t.title ?? "",
    url: t.url ?? "",
    fav_icon_url: t.favIconUrl ?? null,
    active: !!t.active,
    pinned: !!t.pinned,
  }));
}

/** Re-read every tab, group it, write the card. */
async function regroup(): Promise<void> {
  const core = await wasm();
  const shaped = shapeTabs(await ext.tabs.query({}));
  await writePayload("tabs", "tabs", core.groupTabs(shaped as unknown as object));
  await updateBadge(shaped.length);
}

/**
 * Close what the settings say to close, then redraw so the card does not list
 * tabs that are gone.
 */
export async function pruneNow(): Promise<number> {
  try {
    const cfg = await loadConfig();
    const closed = await pruneNewTabs(cfg.instances.find((i) => i.def === "tabs"));
    if (closed > 0) await regroup();
    return closed;
  } catch {
    return 0;
  }
}

/** Tab grouping. Local, instant, never network — refreshed on tab events. */
export async function refreshTabs(): Promise<void> {
  try {
    await regroup();
    // Both behaviours are off by default; this is a no-op until switched on.
    await pruneNow();
  } catch {
    /* a failed grouping must never throw out of an event handler */
  }
}

/** Toolbar badge: green under control, amber busy, red time to cull. */
async function updateBadge(_total: number) {
  try {
    const tabs = await ext.tabs.query({});
    const count = tabs.filter((t) => {
      const u = t.url ?? "";
      return u && !/^(chrome|edge|brave|about|moz-extension|chrome-extension|vivaldi|opera):/.test(u);
    }).length;
    await ext.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    if (count === 0) return;
    const color = count <= 10 ? "#00916c" : count <= 20 ? "#c2661f" : "#c0392b";
    await ext.action.setBadgeBackgroundColor({ color });
  } catch {
    /* badge is cosmetic */
  }
}

async function refreshInstance(inst: Instance, local: LocalState): Promise<void> {
  try {
    switch (inst.def) {
      case "topic": {
        const { items, notes } = await refreshTopic(inst);
        // Report the notes whether or not items came back. Reporting them
        // only when empty hid the real problem: with stale data on screen,
        // "no access to news.google.com" was never shown, so a topic looked
        // like it was working off one source by choice.
        return await writePayload(
          inst.id,
          "topic",
          items,
          notes.length > 0 ? notes.join(" ") : undefined,
          configHashOf(inst.opts),
        );
      }
      case "weather":
        return await writePayload(inst.id, "weather", await refreshWeather(inst));
      case "crypto":
        return await writePayload(inst.id, "crypto", await refreshCrypto(inst));
      case "equities":
        return await writePayload(inst.id, "equities", await refreshEquities(inst));
      case "status":
        return await writePayload(inst.id, "status", await refreshStatus());
      case "xsearch": {
        const hash = configHashOf(inst.opts);
        // Settings changed: forget when it last ran, so a shortened interval
        // applies now instead of after the old one expires.
        const prev = (await getLocal<Payloads>(KEY.payloads, {}))[inst.id];
        if (prev?.config_hash && prev.config_hash !== hash) {
          await resetSchedule(inst.id);
        }
        const { items, notes, retryAt } = await refreshXSearch(inst, local.xToken);
        return await writePayload(
          inst.id,
          "xsearch",
          items,
          notes.length > 0 ? notes.join(" ") : undefined,
          hash,
          retryAt,
        );
      }
      case "apps":
        return await writePayload(inst.id, "apps", await refreshApps());
      case "trending":
        return await writePayload(inst.id, "trending", await refreshTrending(inst));
      case "bookmarks": {
        const { items, notes } = await refreshBookmarks(inst);
        return await writePayload(
          inst.id,
          "bookmarks",
          items,
          notes.length > 0 ? notes.join(" ") : undefined,
          configHashOf(inst.opts),
        );
      }
      case "calendar": {
        const urls = local.calendarUrls ?? [];
        const days = Number(inst.opts.days ?? 7);
        const { events, notes } = await refreshCalendar(urls, days);
        return await writePayload(
          inst.id,
          "calendar",
          events,
          notes.length > 0 ? notes.join(" ") : undefined,
          // The URL list lives in storage.local, so fold it into the
          // fingerprint: removing a calendar must drop its events.
          configHashOf({ ...inst.opts, urls }),
        );
      }
      default:
        return; // local defs (focus, scratch, todos) have nothing to fetch
    }
  } catch (e) {
    await writePayload(inst.id, inst.def, null, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Clear focus items whose window is up.
 *
 * The page already hides them, so this is not what the reader sees — it is
 * what stops the list growing without bound in storage. Writes only when
 * something actually changed, because a needless write to `local` is a
 * chance to lose a note the page wrote a moment ago.
 */
async function sweepFocusItems(cfg: Config): Promise<void> {
  const inst = cfg.instances.find((i) => i.def === "focus");
  if (!inst) return;
  const local = await getLocal<LocalState>(KEY.local, {});
  if (!Array.isArray(local.focusItems) || local.focusItems.length === 0) return;
  const hours = Number(inst.opts.clear_after_hours ?? DEFAULT_CLEAR_HOURS);
  const { items, changed } = sweepFocus(local.focusItems, now(), hours);
  if (!changed) return;
  // Re-read immediately before writing: the page owns this key, and a value
  // fetched at the top of a refresh cycle is old by the time we get here.
  const fresh = await getLocal<LocalState>(KEY.local, {});
  const again = sweepFocus(fresh.focusItems ?? items, now(), hours);
  await setLocal(KEY.local, { ...fresh, focusItems: again.items });
}

/** One refresh cycle: every enabled instance whose data has gone stale. *//** One refresh cycle: every enabled instance whose data has gone stale. */
export async function refreshAll(force = false): Promise<void> {
  const stop = keepAlive();
  try {
    const cfg = await loadConfig();
    const local = await getLocal<LocalState>(KEY.local, {});
    const payloads = await getLocal<Payloads>(KEY.payloads, {});
    const due = cfg.instances.filter((i) => {
      if (!i.enabled) return false;
      if (force) return true;
      const p = payloads[i.id];
      return !p || p.stale_after <= now();
    });
    for (const inst of due) {
      await refreshInstance(inst, local);
    }
    await refreshTabs();
    await sweepFocusItems(cfg);
  } finally {
    stop();
  }
}

// ---------- to-do reminders (M8) ----------

/**
 * One rolling alarm for the next due item, recomputed on change — never one
 * alarm per to-do, which would grow without bound.
 *
 * Alarms do not fire while the browser is closed, so this is best-effort by
 * platform design. `sweepOverdue` on startup is what turns that limitation
 * into a feature: you get one digest of what you missed instead of silence.
 */
export async function scheduleNextReminder(): Promise<void> {
  const local = await getLocal<LocalState>(KEY.local, {});
  const pending = (local.todos ?? [])
    .filter((t) => !t.done && t.due && t.due * 1000 > Date.now())
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  await ext.alarms.clear(ALARM_TODO);
  const next = pending[0];
  if (!next?.due) return;
  // Chrome ignores periods under 30s; a floor of one minute keeps us clear.
  const whenMs = Math.max(next.due * 1000, Date.now() + 60_000);
  await ext.alarms.create(ALARM_TODO, { when: whenMs });
}

async function notify(title: string, message: string) {
  try {
    const ok = await ext.permissions.contains({ permissions: ["notifications"] });
    if (!ok) return;
    await ext.notifications.create({
      type: "basic",
      iconUrl: ext.runtime.getURL("icons/icon128.png"),
      title,
      message,
    });
  } catch {
    /* notifications are optional by design */
  }
}

async function fireDueReminders() {
  const local = await getLocal<LocalState>(KEY.local, {});
  const due = (local.todos ?? []).filter(
    (t) => !t.done && t.due && t.due * 1000 <= Date.now() + 30_000,
  );
  if (due.length === 1) await notify("Due now", due[0]!.text);
  else if (due.length > 1) await notify(`${due.length} to-dos due`, due.map((t) => t.text).join(", "));
  await scheduleNextReminder();
}

/** On browser startup, one digest of everything that came due while away. */
async function sweepOverdue() {
  const local = await getLocal<LocalState>(KEY.local, {});
  const overdue = (local.todos ?? []).filter((t: Todo) => !t.done && t.due && t.due * 1000 < Date.now());
  if (overdue.length > 0) {
    await notify(
      `${overdue.length} to-do${overdue.length > 1 ? "s" : ""} came due`,
      overdue.slice(0, 3).map((t) => t.text).join(", "),
    );
  }
}

/**
 * Paste any URL and get a feed: is-it-a-feed, then `<link rel="alternate">`
 * autodiscovery, then the well-known paths. Candidate ranking demotes
 * comment feeds — verified necessary against mingtiandi.com, which
 * advertises both a site feed and a comments feed.
 */
export async function discoverFeed(input: string): Promise<{
  candidates?: { url: string; title: string; score: number }[];
  preview?: { title: string; url: string }[];
  error?: string;
}> {
  const core = await wasm();
  const url = core.normalizeWebcal(input.trim()) as string;
  if (!/^https?:\/\//i.test(url)) return { error: "That does not look like a web address." };

  const preview = (body: string) => {
    const feed = core.parseFeed(body, "preview", now()) as { title: string; items: { title: string; url: string }[] };
    return (feed.items ?? []).slice(0, 3).map((i) => ({ title: i.title, url: i.url }));
  };

  const direct = await conditionalGet(url);
  if (direct.ok && direct.body && core.looksLikeFeed(direct.body)) {
    return { candidates: [{ url, title: "", score: 100 }], preview: preview(direct.body) };
  }

  if (direct.ok && direct.body) {
    const found = core.discoverFeeds(direct.body, url) as { url: string; title: string; score: number }[];
    if (found.length > 0) {
      const best = await conditionalGet(found[0]!.url);
      return {
        candidates: found,
        preview: best.ok && best.body ? preview(best.body) : [],
      };
    }
  }

  for (const guess of core.wellKnownFeedUrls(url) as string[]) {
    const res = await conditionalGet(guess);
    if (res.ok && res.body && core.looksLikeFeed(res.body)) {
      return { candidates: [{ url: guess, title: "", score: 90 }], preview: preview(res.body) };
    }
  }
  return { error: "No feed found there." };
}

// ---------- wiring ----------

async function installAlarms() {
  // Recreate on every worker start: alarms survive eviction, but a version
  // update or a cleared profile can lose them silently.
  await ext.alarms.create(ALARM_REFRESH, { periodInMinutes: 5, delayInMinutes: 0.1 });
  await scheduleNextReminder();
  await schedulePrune();
}

/**
 * Give the tab prune its own alarm, sized to the user's cutoff.
 *
 * A New Tab left alone fires no tab events, so the prune cannot ride on them:
 * the one situation "close an untouched New Tab" describes is precisely the
 * one where nothing would have woken us. The alarm exists only while a
 * closing behaviour is switched on, so the default install still sleeps.
 */
async function schedulePrune(): Promise<void> {
  const cfg = await loadConfig();
  const every = pruneIntervalMinutes(
    pruneOptionsFrom(cfg.instances.find((i) => i.def === "tabs")),
  );
  if (every === null) {
    await ext.alarms.clear(ALARM_PRUNE);
    return;
  }
  const existing = await ext.alarms.get(ALARM_PRUNE);
  // Recreating resets the countdown, so leave a correct alarm alone — a
  // settings page that saves on every keystroke would otherwise starve it.
  if (existing?.periodInMinutes === every) return;
  await ext.alarms.create(ALARM_PRUNE, { periodInMinutes: every, delayInMinutes: every });
}

ext.runtime.onInstalled.addListener(() => {
  void installAlarms();
  // An update replaces the extension's files, and a registration that points
  // at the old ones is not carried across. Re-registering here is what stops
  // "Add to OpenTabs" quietly dying at the next version bump.
  void session.ensureRelays();
  void clearStoredErrors().then(() => refreshAll(true));
});

ext.runtime.onStartup.addListener(() => {
  void installAlarms();
  void session.ensureRelays();
  void sweepOverdue();
  void clearStoredErrors().then(() => refreshAll());
});

// Permissions can be revoked from the browser's own settings, where nothing
// tells this extension to tidy up. A relay left registered on an origin we
// no longer hold is one Chrome refuses to run anyway; re-running the check
// keeps the registration honest.
//
// Only for the two origins a relay is registered against. Every feed,
// weather API and calendar the reader adds also fires these, and rewriting
// the script registry on each is work the worker does for nothing — while a
// page is waiting on it for something else.
ext.permissions.onRemoved.addListener((p) => {
  if (session.touchesRelay(p)) void session.ensureRelays();
});
ext.permissions.onAdded.addListener((p) => {
  if (session.touchesRelay(p)) void session.ensureRelays();
});

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_REFRESH) void refreshAll();
  if (alarm.name === ALARM_TODO) void fireDueReminders();
  if (alarm.name === ALARM_PRUNE) void pruneNow();
});

ext.tabs.onCreated.addListener(() => void refreshTabs());
ext.tabs.onRemoved.addListener(() => void refreshTabs());
ext.tabs.onUpdated.addListener(() => void refreshTabs());
// Switching away is what makes a tab idle in the first place, and it changes
// no tab's own properties — without this the card keeps showing the old
// active tab, and the prune clock starts only at the next unrelated event.
ext.tabs.onActivated.addListener(() => void refreshTabs());

/**
 * Bookmarks change rarely but visibly: you save one *in order to* come back
 * to it, so a card that only catches up on the next refresh cycle is wrong at
 * exactly the moment it is being looked at. Guarded because the listeners do
 * not exist until the optional permission is granted.
 */
function watchBookmarks() {
  const bm = (ext as typeof chrome).bookmarks;
  if (!bm?.onCreated) return;
  const again = () => void refreshBookmarksCard();
  bm.onCreated.addListener(again);
  bm.onRemoved.addListener(again);
  bm.onChanged.addListener(again);
}

/** Every bookmarks card, since a reader can keep one per folder. */
async function refreshBookmarksCard(): Promise<void> {
  const cfg = await loadConfig();
  const cards = cfg.instances.filter((i) => i.def === "bookmarks" && i.enabled);
  if (cards.length === 0) return;
  const local = await getLocal<LocalState>(KEY.local, {});
  for (const inst of cards) await refreshInstance(inst, local);
}

watchBookmarks();
// Granting the permission is what makes the API appear, so attach then too.
ext.permissions.onAdded?.addListener(() => {
  watchBookmarks();
  void refreshBookmarksCard();
});

// The settings page writes config straight to storage, so this is how the
// worker learns the cutoff changed. Without it a new interval took effect
// only after the next browser restart.
ext.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" || area === "local") && changes[KEY.config]) void schedulePrune();
});

/**
 * Whoever is waiting for a sign-in to finish.
 *
 * A promise per waiting page rather than a broadcast, so the settings page
 * gets one answer to one question instead of having to listen for an event
 * that may arrive while it is not looking.
 */
const signInWaiters: ((ok: boolean) => void)[] = [];

function settleSignIn(ok: boolean) {
  const waiting = signInWaiters.splice(0);
  for (const resolve of waiting) resolve(ok);
}

/** Messages from the pages. The pages never fetch; they ask the worker to. */
ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = (msg as { type?: string })?.type;

  // ---------- OpenApps sign-in ----------

  /**
   * The session, relayed from the platform's sign-in page.
   *
   * The sender check is the whole security boundary here, and it compares
   * whole origins: `startsWith` would accept
   * `https://auth.opentabs.app.evil.test`, which is a site anyone can
   * register.
   */
  if (type === "openapps:session") {
    if (!session.fromSignInPage(sender?.url)) {
      sendResponse({ ok: false });
      return false;
    }
    const { accessToken, refreshToken } = msg as {
      accessToken?: string;
      refreshToken?: string | null;
    };
    if (!accessToken) {
      sendResponse({ ok: false });
      return false;
    }
    void session.accept(accessToken, refreshToken ?? null).then(() => {
      settleSignIn(true);
      // The sign-in tab has done its job. Leaving it open leaves the reader
      // looking at a page that says nothing about what just happened.
      const tabId = sender?.tab?.id;
      if (tabId !== undefined) void ext.tabs.remove(tabId).catch(() => {});
      sendResponse({ ok: true });
    });
    return true;
  }
  if (type === "authState") {
    void session.signedIn().then((yes) => sendResponse({ signedIn: yes }));
    return true;
  }
  if (type === "authToken") {
    void session.token().then((t) => sendResponse({ token: t }));
    return true;
  }
  if (type === "authSignIn") {
    void session.openSignIn().then((tabId) => {
      if (tabId === null) return sendResponse({ ok: false });
      signInWaiters.push((ok) => sendResponse({ ok }));
      // Long, because it spans reading a consent screen, a password manager
      // and possibly a phone. Not unbounded, because a page waiting forever
      // on a tab the reader closed is a spinner with no end.
      setTimeout(() => settleSignIn(false), 5 * 60_000);
    });
    return true;
  }
  if (type === "authSignOut") {
    void session.signOut().then(() => sendResponse({ ok: true }));
    return true;
  }
  /** Registered relays follow the permissions, so the pane re-checks after
   *  a grant rather than waiting for the next browser start. */
  if (type === "ensureRelays") {
    void session.ensureRelays().then(() => sendResponse({ ok: true }));
    return true;
  }
  /**
   * Install a pack the marketplace site handed over.
   *
   * Two checks, and both matter. The *sender* must be the marketplace page —
   * otherwise any site that guessed the message shape could ask. And the
   * *URL* must be on the marketplace's own origin, because what comes back
   * is about to be applied to the reader's configuration.
   */
  if (type === "installFromUrl") {
    const url = (msg as { url?: string }).url ?? "";
    if (!session.installableUrl(sender?.url ?? "") || !session.installableUrl(url)) {
      sendResponse({ ok: false });
      return false;
    }
    void (async () => {
      try {
        const res = await fetch(url, { headers: { accept: "application/json" }, credentials: "omit" });
        if (!res.ok) return sendResponse({ ok: false });
        const pack = await res.json();
        const core = await wasm();
        const cfg = await loadConfig();
        const out = core.applyPack(cfg as unknown as object, pack as object) as {
          config: Config;
          result: { added: string[]; renamed: string[]; theme_applied: boolean };
        } | null;
        if (!out) return sendResponse({ ok: false });
        if (out.result.added.length === 0 && !out.result.theme_applied) {
          return sendResponse({ ok: false });
        }
        await setSync(KEY.config, out.config);
        // Same reason as `installPack` above, and it matters more here: the
        // marketplace site gives up after 700ms and shows an address to
        // paste instead. Awaiting the refresh would mean "Add to OpenTabs"
        // always fell back, even with the extension installed and working.
        void refreshAll(true);
        sendResponse({ ok: true, result: out.result });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (type === "refresh") {
    void refreshAll(true).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (type === "refreshTabs") {
    void refreshTabs().then(() => sendResponse({ ok: true }));
    return true;
  }
  // Feed discovery runs in the worker because it fetches; the *permission*
  // for that origin must already have been requested by the settings page,
  // which is the only context with a user gesture.
  // The worker owns config migration, so the settings page and the worker
  // can never disagree about what a stored document means.
  if (type === "config") {
    void loadConfig().then((config) => sendResponse({ config })).catch(() => sendResponse(null));
    return true;
  }
  if (type === "defaults") {
    void wasm()
      .then((core) => sendResponse({ config: core.defaultConfig() }))
      .catch(() => sendResponse(null));
    return true;
  }
  // Origins for ONE instance — the settings page then asks Chrome for
  // exactly these and nothing wider (D6).
  if (type === "originsFor") {
    const inst = (msg as { instance?: Instance }).instance;
    void wasm()
      .then((core) =>
        sendResponse({
          origins: inst
            ? (core.requiredOrigins({ version: 1, instances: [{ ...inst, enabled: true }], theme: "auto", assistant: "claude" } as unknown as object) as string[])
            : [],
        }),
      )
      .catch(() => sendResponse({ origins: [] }));
    return true;
  }
  if (type === "allOrigins") {
    void loadConfig()
      .then(async (config) => {
        const core = await wasm();
        sendResponse({ origins: core.requiredOrigins(config as unknown as object) as string[] });
      })
      .catch(() => sendResponse({ origins: [] }));
    return true;
  }
  /**
   * Everything the worker actually sees, per group.
   *
   * Built because three separate faults presented identically — an empty
   * card — and the only way to tell them apart was to guess. What the
   * settings page shows and what the worker resolves can disagree, so this
   * reports the worker's view, not the config's.
   */
  /**
   * What auto-close sees, and what it decided about every tab.
   *
   * Built because "my New Tab pages are not closing" has exactly one useful
   * answer — *which guard is holding them* — and that is not something the
   * reader can work out from the outside, or that I can work out for them.
   */
  /** The folder list for the settings picker. Empty when access is not held. */
  /**
   * Apply a pack to the stored config.
   *
   * Done here rather than on the settings page because the worker owns the
   * config and owns the wasm that validates a pack. Two places that merge
   * packs is two places to get the merge wrong.
   */
  if (type === "installPack") {
    void (async () => {
      try {
        const core = await wasm();
        const cfg = await loadConfig();
        const out = core.applyPack(cfg as unknown as object, (msg as { pack: unknown }).pack as object) as {
          config: Config;
          result: { added: string[]; renamed: string[]; theme_applied: boolean; problems: unknown[] };
        } | null;
        if (!out) return sendResponse({ ok: false });
        // Written only when something was actually added: a pack that failed
        // validation must not rewrite a good config with an identical one.
        if (out.result.added.length > 0 || out.result.theme_applied) {
          await setSync(KEY.config, out.config);
          // NOT awaited. `refreshAll` fetches every enabled group, which can
          // take twenty seconds against slow or unreachable sources — and
          // the caller is a settings page waiting to say "Added". Awaiting it
          // meant pressing the button did nothing visible for that whole
          // time, which reads as a broken button and gets pressed again.
          //
          // The answer does not depend on the refresh: the merge has already
          // succeeded and been stored by this line. The groups fill in behind
          // the confirmation, which is the order the reader experiences as
          // fast rather than the one that is technically most complete.
          void refreshAll(true);
        }
        sendResponse({ ok: out.result.problems.length === 0, result: out.result });
      } catch (e) {
        sendResponse({ ok: false, result: { added: [], renamed: [], theme_applied: false,
          problems: [{ field: "pack", message: e instanceof Error ? e.message : String(e) }] } });
      }
    })();
    return true;
  }

  /** Build a shareable pack from one of the reader's own groups. */
  if (type === "packFromInstance") {
    void (async () => {
      const core = await wasm();
      const cfg = await loadConfig();
      const { instanceId, author, description } = msg as {
        instanceId: string;
        author?: string;
        description?: string;
      };
      const pack = core.packFromInstance(
        cfg as unknown as object,
        instanceId,
        author ?? "",
        description ?? "",
      );
      sendResponse({ pack: pack ?? null });
    })();
    return true;
  }

  /** Clean a pack and report its problems, for the publish form. */
  if (type === "cleanPack") {
    void (async () => {
      const core = await wasm();
      sendResponse(core.cleanPack((msg as { pack: unknown }).pack as object));
    })();
    return true;
  }

  if (type === "bookmarkFolders") {
    void bookmarkFolders()
      .then((folders) => sendResponse({ folders }))
      .catch(() => sendResponse({ folders: [] }));
    return true;
  }
  /**
   * Which open tabs are already saved.
   *
   * Answered by the worker rather than looked up on the page: the new tab
   * page must do no work before it paints, and this is asked for *after*.
   * `null` means we cannot see the bookmarks at all, which the page shows
   * differently from "saved nothing".
   */
  if (type === "bookmarkedUrls") {
    void bookmarkedUrls()
      .then((urls) => sendResponse({ urls }))
      .catch(() => sendResponse({ urls: null }));
    return true;
  }
  /**
   * Save or unsave one tab. The page holds the gesture; the worker holds the
   * API. One message for both directions, so the page never has to work out
   * which it meant and get it wrong.
   */
  if (
    type === "bookmarkAdd" ||
    type === "bookmarkRemove" ||
    type === "bookmarkToggle" ||
    type === "bookmarkMove"
  ) {
    const { title, url, folderId } = msg as {
      title?: string;
      url?: string;
      folderId?: string;
    };
    void (async () => {
      if (!url) return sendResponse({ ok: false, error: "No address." });
      const may = await ext.permissions
        .contains({ permissions: ["bookmarks"] })
        .catch(() => false);
      if (!may) return sendResponse({ ok: false, needsPermission: true });
      const res =
        type === "bookmarkToggle"
          ? await toggleBookmark(title ?? "", url, folderId)
          : type === "bookmarkMove"
            ? { ...(await moveBookmark(url, folderId ?? "")), saved: true }
            : type === "bookmarkRemove"
              ? { ...(await removeBookmark(url)), saved: false }
              : { ...(await addBookmark(title ?? "", url, folderId)), saved: true };
      if (res.ok) await refreshBookmarksCard();
      sendResponse(res);
    })();
    return true;
  }

  if (type === "pruneProbe") {
    void (async () => {
      const cfg = await loadConfig();
      const seen = await explainNow(cfg.instances.find((i) => i.def === "tabs"));
      const alarm = await ext.alarms.get(ALARM_PRUNE);
      sendResponse({
        ...seen,
        alarm: alarm
          ? { periodInMinutes: alarm.periodInMinutes, inSecs: Math.round((alarm.scheduledTime - Date.now()) / 1000) }
          : null,
      });
    })();
    return true;
  }

  if (type === "diagnostics") {
    void (async () => {
      const cfg = await loadConfig();
      const payloads = await getLocal<Payloads>(KEY.payloads, {});
      const core = await wasm();
      const rows = [];
      for (const inst of cfg.instances) {
        const sources = Array.isArray((inst.opts as { sources?: unknown[] })?.sources)
          ? ((inst.opts as { sources: unknown[] }).sources as unknown[])
          : [];
        const query = String((inst.opts as { query?: string })?.query ?? "");
        const urls: string[] = [];
        for (const b of sources) {
          const u = core.bindingUrl(b as object, query) as string | null;
          if (u) urls.push(u);
        }
        const fixed = core.requiredOrigins({
          version: 2,
          instances: [{ ...inst, enabled: true }],
          theme: "auto",
          assistant: "claude",
        } as unknown as object) as string[];
        const granted = fixed.length
          ? await ext.permissions.contains({ origins: fixed }).catch(() => false)
          : true;
        const p = payloads[inst.id];
        rows.push({
          mode: (inst.opts as { mode?: string })?.mode ?? "",
          id: inst.id,
          def: inst.def,
          name: inst.name,
          enabled: inst.enabled,
          optsIsObject: !!inst.opts && typeof inst.opts === "object" && !(inst.opts instanceof Map),
          sources: sources.length,
          resolved: urls.length,
          origins: fixed,
          granted,
          items: Array.isArray(p?.data) ? p.data.length : p?.data ? 1 : 0,
          age: p?.generated_at ? Math.round(now() - p.generated_at) : null,
          error: p?.error ?? null,
        });
      }
      // Hosts currently being left alone. A group can be thin for a reason
      // that belongs to no group in particular, and without this the table
      // says "0 items, no problem" while a throttle is the whole story.
      const cooling = Object.entries(
        pruneCooldowns(await getLocal<Cooldowns>(KEY.cooldowns, {}), now()),
      ).map(([host, s]) => ({ host, until: s.until, strikes: s.strikes }));
      sendResponse({ rows, cooling });
    })().catch((e: unknown) =>
      sendResponse({ error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  }
  // The openable advanced-search URL, for the link-out when there is no key.
  if (type === "xWebUrl") {
    const inst = (msg as { instance?: Instance }).instance;
    if (!inst) {
      sendResponse({ url: "https://x.com/search-advanced" });
      return true;
    }
    void xWebUrl(inst)
      .then((url) => sendResponse({ url }))
      .catch(() => sendResponse({ url: "https://x.com/search-advanced" }));
    return true;
  }
  // Parse a pasted advanced-search URL back into fields.
  if (type === "xParse") {
    const q = String((msg as { q?: string }).q ?? "");
    void wasm()
      .then((core) => sendResponse({ fields: core.xParseQuery(q) }))
      .catch(() => sendResponse(null));
    return true;
  }
  /**
   * Fetch one calendar and report exactly what was on the wire and what it
   * became — raw DTSTART lines beside the parsed instant, the floating flag
   * and the rendered clock.
   *
   * Built because two rounds of reasoning about timezones from the outside
   * produced two wrong fixes. The ICS is the only thing that settles it.
   */
  if (type === "calendarProbe") {
    void (async () => {
      const local = await getLocal<LocalState>(KEY.local, {});
      const subs = (local.calendarUrls ?? []).map((c) =>
        typeof c === "string" ? { url: c } : c,
      );
      if (subs.length === 0) return sendResponse({ error: "No calendar added." });

      const core = await wasm();
      const url = core.normalizeWebcal(subs[0]!.url) as string;
      if (!(await ext.permissions.contains({ origins: [`${new URL(url).origin}/*`] }).catch(() => false))) {
        return sendResponse({ error: `No access to ${new URL(url).hostname}.` });
      }
      const res = await conditionalGet(url);
      if (!res.ok || !res.body) {
        return sendResponse({ error: `HTTP ${res.status} fetching the calendar.` });
      }

      // Unfold, then walk VEVENT blocks only.
      //
      // Filtering by line prefix was useless: a Google calendar opens with
      // VTIMEZONE blocks whose daylight-saving rules are themselves DTSTART
      // and RRULE lines, so the first dozen matches were all timezone
      // definitions and the actual event never appeared.
      const lines = res.body.split(/\r?\n/).reduce<string[]>((acc, l) => {
        if (/^[ \t]/.test(l) && acc.length) acc[acc.length - 1] += l.slice(1);
        else acc.push(l);
        return acc;
      }, []);

      const raw: string[] = [];
      const tz = lines.find((l) => /^X-WR-TIMEZONE/i.test(l));
      if (tz) raw.push(tz);

      let depth = 0;
      let block: string[] = [];
      let blocks = 0;
      for (const line of lines) {
        const u = line.trim().toUpperCase();
        if (u === "BEGIN:VEVENT") {
          depth = 1;
          block = [];
          continue;
        }
        if (u === "END:VEVENT" && depth) {
          depth = 0;
          // Prefer blocks that recur. The first six in file order were all
          // one-offs from 2023-2025, which explained nothing.
          const recurs = block.some((l) => /^(RRULE|EXDATE|RECURRENCE-ID)/i.test(l));
          if (recurs && blocks < 8) {
            raw.push(`--- VEVENT ${++blocks} (recurring) ---`, ...block);
          } else if (!recurs && blocks < 3) {
            raw.push(`--- VEVENT ${++blocks} ---`, ...block);
          }
          continue;
        }
        if (depth && /^(DTSTART|DTEND|RRULE|EXDATE|RDATE|RECURRENCE-ID|SUMMARY|STATUS|UID)/i.test(u)) {
          // Truncate UIDs: they are long and identify nothing useful here.
          block.push(line.length > 120 ? `${line.slice(0, 120)}…` : line);
        }
      }

      const from = now() - 86_400;
      // A month, not a week: a weekly series only shows its problem across
      // several occurrences.
      const parsed = (core.parseIcs(res.body, from, from + 30 * 86_400) as CalEvent[])
        .slice(0, 12)
        .map((e) => ({
          summary: e.summary,
          start: e.start,
          floating: e.floating,
          all_day: e.all_day,
          tzid: e.tzid ?? "",
          iso_utc: new Date(e.start * 1000).toISOString(),
        }));

      sendResponse({
        host: new URL(url).hostname,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
        browserNow: new Date().toISOString(),
        raw,
        parsed,
      });
    })().catch((e: unknown) =>
      sendResponse({ error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  }
  if (type === "discover") {
    const url = String((msg as { url?: string }).url ?? "");
    // A parser fault must reach the user as a sentence, not a hung dialog.
    // A wasm panic surfaces here as a thrown RuntimeError.
    void discoverFeed(url)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({
          error: `Could not read that page (${e instanceof Error ? e.message : String(e)}).`,
        }),
      );
    return true;
  }
  if (type === "parseDue") {
    const text = String((msg as { text?: string }).text ?? "");
    void wasm()
      .then((core) => sendResponse(core.parseDueDate(text, Math.floor(Date.now() / 1000))))
      .catch(() => sendResponse(null));
    return true;
  }
  if (type === "rescheduleReminder") {
    void scheduleNextReminder().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// The worker may be starting cold on a new tab open; get data moving.
//
// Clearing the scrape lock first: if this worker is only starting now, then
// nothing it started is still running, and a lock left by a terminated worker
// would otherwise block every X search indefinitely.
void clearStaleLock();
void installAlarms();
void refreshTabs();
