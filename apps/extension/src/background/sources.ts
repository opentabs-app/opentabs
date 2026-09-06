/**
 * One refresh function per group def. Each returns render-ready data and
 * nothing else — the new tab page must never compute, only paint.
 *
 * The client fetches its own data (decision D1). Extensions bypass CORS with
 * host permissions, so same-origin policy is not a constraint here; what is
 * a constraint is that several of these endpoints block anything that looks
 * like a server (D11), which is exactly why they are called from the user's
 * own browser rather than proxied.
 */
import { ext, KEY, getLocal, setLocal } from "../lib/ext";
import type { Binding, Config, FeedItem, Instance, RankedItem, CalEvent } from "../lib/types";
import { conditionalGet, forgetValidator, staggered } from "./fetcher";
import {
  blockedUntil, hostOf, isPushback, noteSuccess, notePushback, pruneCooldowns, pushbackNote,
  type Cooldowns,
} from "../lib/backoff";
import { sameLink } from "../lib/link";
import { has, originOf, originsOf } from "./permissions";
import { FEEDS_BASE, SITE_MATCH } from "../lib/openapps";
import { wasm } from "./wasm-loader";
import { mayRun, scrapeSearch } from "./xscrape";

const now = () => Math.floor(Date.now() / 1000);

/** Resolve every binding on a topic to a URL, dropping ones we can't build. */
async function bindingUrls(inst: Instance): Promise<{ url: string; b: Binding }[]> {
  const core = await wasm();
  const query = String(inst.opts.query ?? "");
  const bindings = (inst.opts.sources as Binding[] | undefined) ?? [];
  const out: { url: string; b: Binding }[] = [];
  for (const b of bindings) {
    const url = core.bindingUrl(b as unknown as object, query) as string | null;
    if (url) out.push({ url, b });
  }
  return out;
}

/**
 * A topic (D12). Not "AI news" or "Finance news" — one engine, instantiated,
 * so a topic the user invents behaves identically to a shipped one.
 */
export interface TopicResult {
  items: RankedItem[];
  /** Why a topic is thin or empty, in words a person can act on. */
  notes: string[];
}

type ItemCache = Record<string, { items: FeedItem[]; at: number }>;

/** Items cached per binding URL, so a 304 has something to answer with. */
const CACHE_TTL = 6 * 3600;

export async function refreshTopic(inst: Instance): Promise<TopicResult> {
  const core = await wasm();
  const resolved = await bindingUrls(inst);
  const notes: string[] = [];

  const allowed: typeof resolved = [];
  for (const r of resolved) {
    if (await has(originsOf([r.url]))) allowed.push(r);
    else notes.push(`No access to ${originOf(r.url) ?? r.url} — grant it in Settings.`);
  }
  if (resolved.length === 0) {
    // "No sources configured" was wrong for the common case and sent people
    // looking in the wrong place. Having sources and resolving none is a
    // different problem: every query source needs search terms, so a topic
    // whose query is empty and whose only sources are query templates
    // produces no URLs at all.
    const configured = ((inst.opts.sources as Binding[] | undefined) ?? []).length;
    notes.push(
      configured === 0
        ? "No sources configured. Add one in Settings → Topics."
        : `${configured} source${configured > 1 ? "s" : ""} configured but none are usable — ` +
          `search sources need words in the topic's Query box, or add a feed URL instead.`,
    );
  }

  let cooldowns = pruneCooldowns(await getLocal<Cooldowns>(KEY.cooldowns, {}), now());
  const cache = await getLocal<ItemCache>(KEY.items, {});
  // Keyed by instance *and* url. Keyed by url alone, refreshing one topic
  // evicted every other topic's cached items, because `resolved` only ever
  // holds the bindings of the topic being refreshed.
  const ck = (url: string) => `${inst.id}|${url}`;
  const pooled: FeedItem[] = [];

  await staggered(allowed, async ({ url, b }) => {
    const label = b.tmpl ?? b.url ?? "feed";

    // A host that asked for room gets it. Knocking again while a throttle is
    // in force is what turns a short one into a long one, and the cached
    // items below mean the card is not empty in the meantime.
    const paused = blockedUntil(cooldowns, url, now());
    if (paused !== null) {
      notes.push(pushbackNote(hostOf(url)!, paused));
      const hit = cache[ck(url)];
      if (hit) pooled.push(...hit.items);
      return;
    }

    const res = await conditionalGet(url);
    const host = hostOf(url);
    if (host) {
      cooldowns = isPushback(res.status)
        ? notePushback(cooldowns, host, now(), res.retryAfter)
        : res.ok
          ? noteSuccess(cooldowns, host)
          : cooldowns;
    }
    if (host && isPushback(res.status)) {
      notes.push(pushbackNote(host, cooldowns[host]!.until));
      // Serve what we last got rather than blanking the card over a throttle.
      const hit = cache[ck(url)];
      if (hit) pooled.push(...hit.items);
      return;
    }

    // 304 means "what you already have is current" — which is only true if
    // we kept it. This is the fallback that makes conditional GET sound.
    if (res.notModified) {
      const hit = cache[ck(url)];
      if (hit && now() - hit.at < CACHE_TTL) {
        pooled.push(...hit.items);
      } else {
        // Cache gone but the server thinks we have it: drop the validator so
        // the next cycle refetches in full rather than looping on 304.
        await forgetValidator(url);
      }
      return;
    }
    if (!res.ok || !res.body) {
      notes.push(`${label} did not answer${res.status ? ` (HTTP ${res.status})` : ""}.`);
      return;
    }

    // Three of the sources answer JSON rather than a feed document.
    const items =
      b.tmpl === "hn"
        ? (core.parseHackerNews(res.body, label, now()) as FeedItem[])
        : b.tmpl === "bluesky"
          ? (core.parseBluesky(res.body, label, now()) as FeedItem[])
          : b.tmpl === "mastodon"
            ? (core.parseMastodon(res.body, label, now()) as FeedItem[])
            : ((core.parseFeed(res.body, label, now()) as { items: FeedItem[] }).items ?? []);
    if (items.length === 0) notes.push(`${label} returned nothing readable.`);
    cache[ck(url)] = { items, at: now() };
    pooled.push(...items);
  });

  // Drop only this instance's stale entries. A removed source's items must
  // go immediately — that is the whole point of removing it.
  const live = new Set(resolved.map((r) => ck(r.url)));
  const mine = `${inst.id}|`;
  for (const key of Object.keys(cache)) {
    if (key.startsWith(mine) && !live.has(key)) delete cache[key];
  }
  await setLocal(KEY.items, cache);
  await setLocal(KEY.cooldowns, cooldowns);

  // Several bindings can share a throttled host, and the same sentence three
  // times reads like three faults.
  const said = [...new Set(notes)];
  if (pooled.length === 0) return { items: [], notes: said };

  const weights: Record<string, number> = {};
  for (const { b } of resolved) {
    const label = b.tmpl ?? b.url ?? "feed";
    weights[label] = b.weight ?? 1;
  }
  const ranked = core.rankItems(
    pooled as unknown as object,
    {
      half_life_hours: 12,
      weights,
      exclude: (inst.opts.exclude as string[]) ?? [],
      include: (inst.opts.include as string[]) ?? [],
      // Defaulted here rather than by migration, so topics that predate the
      // window get it too without their stored config being rewritten.
      max_age_hours: Number(inst.opts.max_age_hours ?? 24),
      limit: Number(inst.opts.limit ?? 8),
    } as unknown as object,
    now(),
  ) as RankedItem[];

  if (ranked.length === 0 && pooled.length > 0) {
    said.push(`${pooled.length} items fetched but all were filtered out — check Exclude words.`);
  }
  return { items: ranked, notes: said };
}

/** One bookmark, as the card needs it. */
export interface RecentBookmark {
  id: string;
  title: string;
  url: string;
  /** Enclosing folder, when it is a real one rather than a root. */
  folder: string;
  /** Unix seconds. */
  added: number;
}

/**
 * Folders every browser makes for you. Naming one of these as the enclosing
 * folder tells the reader nothing they did not already know.
 */
const ROOT_FOLDERS = new Set([
  "Bookmarks bar", "Other bookmarks", "Mobile bookmarks", "Bookmarks Menu",
  "Bookmarks Toolbar", "Other Bookmarks", "",
]);

/** Has the reader granted us the bookmarks API? */
async function mayReadBookmarks(): Promise<boolean> {
  return await ext.permissions.contains({ permissions: ["bookmarks"] }).catch(() => false);
}

/** Every folder in the tree, flattened, for the settings picker. */
export async function bookmarkFolders(): Promise<{ id: string; path: string }[]> {
  if (!(await mayReadBookmarks())) return [];
  const out: { id: string; path: string }[] = [];
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], trail: string[]) => {
    for (const n of nodes) {
      if (n.url) continue;
      // A root has no title worth showing but its children do, so descend
      // through it without adding an empty segment to the path.
      const named = n.title?.trim() ?? "";
      const path = named ? [...trail, named] : trail;
      if (named) out.push({ id: n.id, path: path.join(" / ") });
      if (n.children) walk(n.children, path);
    }
  };
  try {
    walk(await ext.bookmarks.getTree(), []);
  } catch {
    return [];
  }
  return out;
}

/** Every bookmark URL currently saved, so a tab row can show it is already in. */
export async function bookmarkedUrls(): Promise<string[] | null> {
  if (!(await mayReadBookmarks())) return null;
  const urls: string[] = [];
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
    for (const n of nodes) {
      if (n.url) urls.push(n.url);
      if (n.children) walk(n.children);
    }
  };
  try {
    walk(await ext.bookmarks.getTree());
  } catch {
    return null;
  }
  return urls;
}

/**
 * The browser's own bookmark store — local, instant, no network.
 *
 * Two shapes, one def: with no folder chosen it is the most recently added
 * across everything; with a folder it is that folder, which is what makes a
 * reading list or a project shelf its own card. Both are the same group type
 * instantiated differently, exactly as a topic is (D12).
 *
 * The `bookmarks` permission is optional and asked for when the group is
 * switched on, so the common case is that we do not have it: that is not an
 * error, it is a state the card has to explain.
 */
export async function refreshBookmarks(
  inst: Instance,
): Promise<{ items: RecentBookmark[]; notes: string[] }> {
  const limit = Math.min(50, Math.max(1, Number(inst.opts.limit ?? 10)));
  const folderId = String(inst.opts.folder_id ?? "").trim();
  if (!(await mayReadBookmarks())) {
    return {
      items: [],
      notes: ["OpenTabs cannot read your bookmarks yet — grant access in Settings."],
    };
  }
  try {
    const shape = async (
      nodes: chrome.bookmarks.BookmarkTreeNode[],
    ): Promise<RecentBookmark[]> => {
      const parents = [...new Set(nodes.map((b) => b.parentId).filter(Boolean))] as string[];
      const names = new Map<string, string>();
      await Promise.all(
        parents.map(async (id) => {
          const [node] = await ext.bookmarks.get(id).catch(() => []);
          if (node?.title) names.set(id, node.title);
        }),
      );
      return nodes
        .filter((b) => !!b.url)
        .map((b) => {
          const folder = names.get(b.parentId ?? "") ?? "";
          return {
            id: b.id,
            title: b.title?.trim() || b.url!,
            url: b.url!,
            folder: ROOT_FOLDERS.has(folder) ? "" : folder,
            added: Math.round((b.dateAdded ?? Date.now()) / 1000),
          };
        });
    };

    if (!folderId) {
      return withEmptyNote(await shape(await ext.bookmarks.getRecent(limit)), "");
    }

    // A folder the reader chose and then deleted must say so, not silently
    // fall back to something else that looks like it worked.
    const [node] = await ext.bookmarks.get(folderId).catch(() => []);
    if (!node) {
      return {
        items: [],
        notes: [`That bookmark folder is gone. Pick another in Settings.`],
      };
    }
    // Sub-folders included: a reading list with a "done" folder inside it is
    // still one shelf to the person who made it.
    const collect = (n: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode[] =>
      n.flatMap((c) => (c.url ? [c] : collect(c.children ?? [])));
    const [tree] = await ext.bookmarks.getSubTree(folderId);
    const inFolder = collect(tree?.children ?? []).sort(
      (a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0),
    );
    return withEmptyNote(await shape(inFolder.slice(0, limit)), node.title ?? "");
  } catch (e) {
    return { items: [], notes: [e instanceof Error ? e.message : String(e)] };
  }
}

function withEmptyNote(
  items: RecentBookmark[],
  folder: string,
): { items: RecentBookmark[]; notes: string[] } {
  if (items.length > 0) return { items, notes: [] };
  return { items, notes: [folder ? `Nothing in “${folder}” yet.` : "No bookmarks yet."] };
}

/**
 * Bookmarks for this page.
 *
 * `bookmarks.search({url})` matches the string exactly, which is not the same
 * question. A bookmark typed by hand, imported from another browser, or saved
 * before a site moved to https differs from the tab in ways nobody would call
 * a different page — and an exact match then reports "not bookmarked" for a
 * page that plainly is. The text search is a net; `sameLink` is the filter.
 */
async function matchingBookmarks(url: string): Promise<chrome.bookmarks.BookmarkTreeNode[]> {
  const exact = await ext.bookmarks.search({ url }).catch(() => []);
  if (exact.length > 0) return exact;
  let host = url;
  try {
    host = new URL(url).host.replace(/^www\./, "");
  } catch {
    /* searched as written */
  }
  const near = await ext.bookmarks.search(host).catch(() => []);
  return near.filter((b) => b.url && sameLink(b.url, url));
}

/**
 * Save or unsave, deciding from what is actually stored.
 *
 * The page must not be the one deciding: its idea of whether a tab is
 * bookmarked is a decoration applied after paint, and if that decoration is
 * ever wrong the button does the opposite of what the reader asked. Asking
 * here costs one lookup and cannot be out of date.
 */
export async function toggleBookmark(
  title: string,
  url: string,
  folderId?: string,
): Promise<{ ok: boolean; saved: boolean; folderId?: string; folderName?: string; error?: string }> {
  const hits = await matchingBookmarks(url).catch(() => []);
  if (hits.length > 0) {
    const res = await removeBookmark(url);
    return { ok: res.ok, saved: !res.ok, error: res.error };
  }
  const res = await addBookmark(title, url, folderId);
  return {
    ok: res.ok,
    saved: res.ok,
    folderId: res.folderId,
    folderName: res.folderName,
    error: res.error,
  };
}

/** Move an already-saved page into another folder. */
export async function moveBookmark(
  url: string,
  folderId: string,
): Promise<{ ok: boolean; folderName?: string; error?: string }> {
  try {
    const hits = await matchingBookmarks(url);
    if (hits.length === 0) return { ok: false, error: "That page is not bookmarked." };
    for (const h of hits) await ext.bookmarks.move(h.id, { parentId: folderId });
    await setLocal(KEY.lastFolder, folderId);
    const [node] = await ext.bookmarks.get(folderId).catch(() => []);
    return { ok: true, folderName: node?.title ?? "" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Where a bookmark lived, so putting it back puts it back properly. *//** Where a bookmark lived, so putting it back puts it back properly. */
export interface RemovedBookmark {
  title: string;
  parentId?: string;
  index?: number;
  at: number;
}

type UndoStore = Record<string, RemovedBookmark>;

/** Keep the store bounded — this is an undo buffer, not a history. */
const UNDO_MAX = 50;

export function capUndo(store: UndoStore, max = UNDO_MAX): UndoStore {
  const keys = Object.keys(store);
  if (keys.length <= max) return store;
  // Oldest out first: the link you just unbookmarked is the one you are most
  // likely to want back.
  const keep = keys.sort((a, b) => store[b]!.at - store[a]!.at).slice(0, max);
  return Object.fromEntries(keep.map((k) => [k, store[k]!]));
}

/**
 * Remove every bookmark pointing at this URL.
 *
 * Every one, not the first: the mark is filled because at least one exists,
 * so "remove it" has to mean the state the reader can see. Where each lived
 * is remembered so a second click restores them exactly.
 */
export async function removeBookmark(
  url: string,
): Promise<{ ok: boolean; removed: number; error?: string }> {
  try {
    const hits = await matchingBookmarks(url);
    if (hits.length === 0) return { ok: true, removed: 0 };
    const store = await getLocal<UndoStore>(KEY.bookmarkUndo, {});
    // The first is enough to restore: several copies of one link in several
    // folders is rare, and putting back the one that was filed deliberately
    // beats putting back all of them.
    const first = hits[0]!;
    store[url] = {
      title: first.title ?? url,
      parentId: first.parentId,
      index: first.index,
      at: now(),
    };
    await setLocal(KEY.bookmarkUndo, capUndo(store));
    for (const h of hits) await ext.bookmarks.remove(h.id);
    return { ok: true, removed: hits.length };
  } catch (e) {
    return { ok: false, removed: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Save a URL, back into the folder it came from when we know of one. */
/**
 * Save a URL.
 *
 * Where it lands, in order of what the reader most recently meant: the folder
 * asked for now, then the folder it was in before it was unsaved (so undoing
 * a mis-click puts it back where it was filed), then the folder they last
 * chose, then the browser's default.
 */
export async function addBookmark(
  title: string,
  url: string,
  folderId?: string,
): Promise<{
  ok: boolean;
  already?: boolean;
  folderId?: string;
  folderName?: string;
  error?: string;
}> {
  try {
    const existing = await matchingBookmarks(url);
    // Saving the same page twice is a mis-click, not an instruction.
    if (existing.length > 0) {
      const [node] = await ext.bookmarks.get(existing[0]!.parentId ?? "").catch(() => []);
      return { ok: true, already: true, folderId: node?.id, folderName: node?.title };
    }

    const store = await getLocal<UndoStore>(KEY.bookmarkUndo, {});
    const prior = store[url];
    const lastUsed = await getLocal<string>(KEY.lastFolder, "");
    const wanted = folderId || prior?.parentId || lastUsed || "";

    let created: chrome.bookmarks.BookmarkTreeNode | undefined;
    if (wanted) {
      try {
        created = await ext.bookmarks.create({
          title: prior?.title || title || url,
          url,
          parentId: wanted,
          ...(folderId ? {} : { index: prior?.index }),
        });
      } catch {
        // The folder may be gone. Fall through rather than fail the save.
      }
    }
    created ??= await ext.bookmarks.create({ title: title || url, url });

    if (prior) {
      delete store[url];
      await setLocal(KEY.bookmarkUndo, store);
    }
    if (folderId) await setLocal(KEY.lastFolder, folderId);
    const [parent] = await ext.bookmarks.get(created.parentId ?? "").catch(() => []);
    return { ok: true, folderId: parent?.id, folderName: parent?.title };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Open-Meteo: free, keyless, CORS-open. Verified live. *//** Open-Meteo: free, keyless, CORS-open. Verified live. *//** Open-Meteo: free, keyless, CORS-open. Verified live. */
export async function refreshWeather(inst: Instance) {
  const lat = Number(inst.opts.lat ?? 1.3521);
  const lon = Number(inst.opts.lon ?? 103.8198);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min` +
    `&forecast_days=1&timezone=auto`;
  const res = await conditionalGet(url);
  if (!res.ok || !res.body) return null;
  const j = JSON.parse(res.body);
  return {
    place: String(inst.opts.place ?? ""),
    temp: j?.current?.temperature_2m ?? null,
    code: j?.current?.weather_code ?? 0,
    isDay: j?.current?.is_day === 1,
    max: j?.daily?.temperature_2m_max?.[0] ?? null,
    min: j?.daily?.temperature_2m_min?.[0] ?? null,
  };
}

/** Binance public ticker: keyless, CORS-open, no rate-limit trouble. */
export async function refreshCrypto(inst: Instance) {
  const symbols = (inst.opts.symbols as string[]) ?? [];
  const out: { symbol: string; price: number; changePct: number }[] = [];
  await staggered(
    symbols,
    async (sym) => {
      const res = await conditionalGet(
        `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym)}`,
      );
      if (!res.ok || !res.body) return;
      const j = JSON.parse(res.body);
      out.push({
        symbol: sym.replace(/USDT$/, ""),
        price: Number(j.lastPrice),
        changePct: Number(j.priceChangePercent),
      });
    },
    150,
  );
  return out;
}

/**
 * Equities via Yahoo's undocumented chart endpoint.
 *
 * Client-direct on purpose (D11): it answered 429 to a datacenter IP on the
 * very first request during design, and works from a browser. There is no
 * SLA here and the shape can change without notice — so this is delayed,
 * labelled as such in the UI, off by default, and fails silently.
 */
export async function refreshEquities(inst: Instance) {
  const symbols = (inst.opts.symbols as string[]) ?? [];
  const out: { symbol: string; price: number; changePct: number; currency: string }[] = [];
  await staggered(
    symbols,
    async (sym) => {
      const res = await conditionalGet(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`,
      );
      if (!res.ok || !res.body) return;
      try {
        const meta = JSON.parse(res.body)?.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) return;
        const prev = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
        out.push({
          symbol: sym,
          price: meta.regularMarketPrice,
          changePct: prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0,
          currency: meta.currency ?? "",
        });
      } catch {
        /* shape changed — one row missing beats a broken group */
      }
    },
    250,
  );
  return out;
}

/** Public status endpoints. Tiny payloads, genuinely useful to a dev audience. */
export async function refreshStatus() {
  const services = [
    { name: "GitHub", url: "https://www.githubstatus.com/api/v2/status.json" },
    { name: "Cloudflare", url: "https://www.cloudflarestatus.com/api/v2/status.json" },
    { name: "OpenAI", url: "https://status.openai.com/api/v2/status.json" },
    { name: "Anthropic", url: "https://status.anthropic.com/api/v2/status.json" },
  ];
  const out: { name: string; indicator: string; description: string }[] = [];
  await staggered(
    services,
    async (s) => {
      const res = await conditionalGet(s.url);
      if (!res.ok || !res.body) return;
      try {
        const j = JSON.parse(res.body);
        out.push({
          name: s.name,
          indicator: j?.status?.indicator ?? "unknown",
          description: j?.status?.description ?? "",
        });
      } catch {
        /* skip */
      }
    },
    150,
  );
  return out;
}

/**
 * The suite, bundled.
 *
 * The served `apps.json` is the release valve — it makes a new product appear
 * without an extension update — but it must not be a *dependency*. Shipping
 * only the fetch meant Web Apps rendered nothing until the file existed,
 * which is the opposite of the point: this group is the reason someone keeps
 * the extension installed.
 */
const BUNDLED_APPS = [
  { id: "opensubs", name: "OpenSubs", url: "https://app.opensubs.app/", tagline: "Subtitles and translation" },
  { id: "openpdfedit", name: "OpenPDFEdit", url: "https://app.openpdfedit.com/", tagline: "Edit PDFs in the browser" },
  { id: "opencapture", name: "OpenCapture", url: "https://opencapture.app/", tagline: "Full-page screenshots" },
  { id: "openapps", name: "OpenApps ID", url: "https://auth.opentabs.app/", tagline: "Account and credits" },
];

/** Served catalogue when reachable, bundled list otherwise. Never empty. */
export async function refreshApps() {
  try {
    if (await has([SITE_MATCH])) {
      const res = await conditionalGet(`${FEEDS_BASE}/apps.json`);
      if (res.ok && res.body) {
        const apps = JSON.parse(res.body).apps;
        if (Array.isArray(apps) && apps.length > 0) return apps;
      }
    }
  } catch {
    /* fall through to the bundled list */
  }
  return BUNDLED_APPS;
}

/**
 * GitHub trending: the served file first, the page itself as a fallback.
 *
 * The 8 KB served object is politer — one fetch for everyone instead of a
 * 682 KB page per user — but making it a *dependency* meant the group simply
 * never appeared until the file was deployed, with no explanation. The
 * parser already runs in wasm and is fixture-tested against the real markup,
 * so the browser can do it alone.
 */
export async function refreshTrending(inst: Instance) {
  const limit = Number(inst.opts.limit ?? 8);

  if (await has([SITE_MATCH])) {
    const res = await conditionalGet(`${FEEDS_BASE}/github-trending.json`);
    if (res.ok && res.body) {
      try {
        const repos = JSON.parse(res.body).repos ?? [];
        if (repos.length > 0) return repos.slice(0, limit);
      } catch {
        /* fall through to the page */
      }
    }
  }

  if (!(await has(["https://github.com/*"]))) return null;
  const page = await conditionalGet("https://github.com/trending");
  if (!page.ok || !page.body) return null;
  const core = await wasm();
  const repos = core.parseTrending(page.body) as unknown[];
  return repos.length > 0 ? repos.slice(0, limit) : null;
}

/**
 * Calendars by ICS subscription (D7). One parser covers Google, Outlook,
 * iCloud, Fastmail, Proton, Notion, Linear and Cal.com.
 *
 * The URLs are bearer credentials, so they live in `storage.local` and are
 * passed in here rather than read from the synced config.
 */
/** Accepts both the labelled shape and the plain strings that preceded it. */
export type CalendarSub = string | { label?: string; url: string };

export async function refreshCalendar(
  subs: CalendarSub[],
  days: number,
): Promise<{ events: CalEvent[]; notes: string[] }> {
  const urls = subs.map((s) => (typeof s === "string" ? { url: s } : s));
  const core = await wasm();
  const from = now();
  const to = from + days * 86_400;
  const events: CalEvent[] = [];
  const notes: string[] = [];

  if (urls.length === 0) {
    return {
      events: [],
      notes: ["No calendar added yet — paste a secret iCal address in Settings → Calendar."],
    };
  }

  await staggered(urls, async (sub) => {
    const url = core.normalizeWebcal(sub.url) as string;
    const name = sub.label?.trim() || "";
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    })();

    if (!(await has(originsOf([url])))) {
      notes.push(`No access to ${name || host} — grant it in Settings.`);
      return;
    }
    const res = await conditionalGet(url);
    if (res.notModified) return;
    if (!res.ok) {
      // A wrong or reset secret address is the common case, and a bare
      // "nothing scheduled" would hide it completely.
      notes.push(
        res.status === 404 || res.status === 403
          ? `${host} rejected that address (HTTP ${res.status}) — it may have been reset.`
          : `${host} did not answer${res.status ? ` (HTTP ${res.status})` : ""}.`,
      );
      return;
    }
    if (!res.body.includes("BEGIN:VCALENDAR")) {
      notes.push(`${host} returned something that is not a calendar.`);
      return;
    }
    const parsed = core.parseIcs(res.body, from, to) as CalEvent[];
    if (parsed.length === 0) {
      notes.push(`Nothing in the next ${days} days on ${name || host}.`);
    }
    events.push(...parsed.map((e) => (name ? { ...e, calendar: name } : e)));
  });

  events.sort((a, b) => a.start - b.start);
  return { events, notes: events.length > 0 ? [] : notes };
}

/** Every origin the enabled config needs — used by the settings page. */
export async function requiredOrigins(cfg: Config): Promise<string[]> {
  const core = await wasm();
  return core.requiredOrigins(cfg as unknown as object) as string[];
}

// ---------- X advanced search ----------

/**
 * X search, through the reader's own API key.
 *
 * There is no other way in. `x.com/search` answers 289 KB of JavaScript shell
 * with no results in it, Nitter is gone, and the free API tier ended in
 * February 2026. So this is bring-your-own-key (A5): the token lives in
 * `storage.local`, never syncs, and never leaves the browser except to X.
 *
 * Reads are billed to the key holder at roughly $0.005 per post, which is why
 * this fetches once per refresh with a modest page size rather than paging.
 */
export async function refreshXSearch(
  inst: Instance,
  token: string | undefined,
): Promise<{ items: FeedItem[]; notes: string[]; retryAt?: number }> {
  const mode = String(inst.opts.mode ?? "launcher");

  // Reading the rendered page. Opt-in, paced, and the risk is stated in
  // Settings — see background/xscrape.ts.
  if (mode === "scrape") {
    const core0 = await wasm();
    const url = core0.xWebUrl((inst.opts.query_fields ?? {}) as object, now()) as string;
    const gate = await mayRun(inst, Number(inst.opts.interval_min ?? 240));
    if (!gate.ok) {
      return {
        items: [],
        notes: gate.reason ? [gate.reason] : [],
        retryAt: gate.retryAt,
      };
    }
    return await scrapeSearch(inst, url);
  }
  if (mode === "launcher") {
    return {
      items: [],
      notes: ["Set to open in X only. Switch to reading results in Settings."],
    };
  }

  const core = await wasm();
  const q = (inst.opts.query_fields ?? {}) as object;
  const built = core.xApiQuery(q, now()) as {
    query: string;
    start_time: string | null;
    end_time: string | null;
    limitations: string[];
    empty: boolean;
  };
  const notes = [...built.limitations];

  if (built.empty) {
    return { items: [], notes: ["This search has no terms yet — add some words in Settings."] };
  }
  if (!token) {
    return {
      items: [],
      notes: [
        "X needs your own API key: it removed free reads in 2026 and its search page " +
          "cannot be read without one. Add a key in Settings, or open the search in X.",
      ],
    };
  }
  if (!(await has(["https://api.x.com/*"]))) {
    return { items: [], notes: ["No access to api.x.com — grant it in Settings."] };
  }

  const max = Math.min(100, Math.max(10, Number(inst.opts.limit ?? 10) * 2));
  const params = new URLSearchParams({
    query: built.query,
    max_results: String(max),
    "tweet.fields": "created_at,public_metrics,author_id",
    expansions: "author_id",
    "user.fields": "username,name",
  });
  if (built.start_time) params.set("start_time", built.start_time);
  if (built.end_time) params.set("end_time", built.end_time);

  try {
    const res = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "omit",
    });
    if (res.status === 401) return { items: [], notes: ["X rejected that API key."] };
    if (res.status === 429) {
      return { items: [], notes: ["X rate-limited this key; it will retry on the next refresh."] };
    }
    if (!res.ok) return { items: [], notes: [`X answered HTTP ${res.status}.`] };

    const body = await res.json();
    const users = new Map<string, { username: string; name: string }>(
      (body?.includes?.users ?? []).map((u: { id: string; username: string; name: string }) => [
        u.id,
        u,
      ]),
    );
    const items: FeedItem[] = (body?.data ?? []).map(
      (t: {
        id: string;
        text: string;
        created_at?: string;
        author_id?: string;
        public_metrics?: { like_count?: number; reply_count?: number };
      }) => {
        const user = t.author_id ? users.get(t.author_id) : undefined;
        const handle = user?.username ?? "x";
        const url = `https://x.com/${handle}/status/${t.id}`;
        const likes = t.public_metrics?.like_count ?? 0;
        const replies = t.public_metrics?.reply_count ?? 0;
        return {
          id: `x:${t.id}`,
          title: t.text.replace(/\s+/g, " ").trim(),
          url,
          source: user ? `@${handle}` : "X",
          published: t.created_at ? Math.floor(Date.parse(t.created_at) / 1000) : now(),
          summary: likes || replies ? `${likes} likes · ${replies} replies` : undefined,
          binding: "xsearch",
        };
      },
    );
    if (items.length === 0) notes.push("No posts matched in the last 7 days.");
    return { items, notes };
  } catch (e) {
    return { items: [], notes: [`Could not reach X (${e instanceof Error ? e.message : String(e)}).`] };
  }
}

/** The openable advanced-search URL, for the link-out when there is no key. */
export async function xWebUrl(inst: Instance): Promise<string> {
  const core = await wasm();
  return core.xWebUrl((inst.opts.query_fields ?? {}) as object, now()) as string;
}
