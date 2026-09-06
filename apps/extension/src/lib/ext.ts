/**
 * The WebExtension runtime, resolved once.
 *
 * Firefox exposes `browser` with promises; Chrome exposes `chrome`, which is
 * also promise-based on MV3. One shared bundle picks whichever is present at
 * load time, so the Chrome and Firefox builds differ only in their manifest.
 */
// Read through globalThis rather than the bare identifiers: a bare `chrome`
// throws a ReferenceError under a plain Node test runner, which would make
// every module that transitively imports this one untestable.
const g = globalThis as typeof globalThis & {
  browser?: typeof chrome;
  chrome?: typeof chrome;
};

export const ext: typeof chrome = (g.browser?.runtime ? g.browser : g.chrome) as typeof chrome;

export const isFirefox = !!g.browser?.runtime;

/** Storage keys. One place, so the worker and the page cannot drift. */
export const KEY = {
  /** The user's config document — `storage.sync`, so it follows the profile. */
  config: "opentabs:config",
  /** Render-ready payloads the worker writes — `storage.local`. */
  payloads: "opentabs:payloads",
  /** Local-only state: focus line, scratchpad, to-dos, calendar secrets. */
  local: "opentabs:local",
  /** Per-binding HTTP validators for conditional GET. */
  etags: "opentabs:etags",
  /**
   * Parsed items per binding URL.
   *
   * Conditional GET is only sound if a 304 has something to fall back on.
   * Without this cache, "not modified" meant "no items", and a topic went
   * permanently blank one refresh after it first worked.
   */
  items: "opentabs:items",
  /**
   * Per-host cooling off after a source pushed back. See `lib/backoff.ts`.
   *
   * Kept out of the payloads: it is about a *host*, and several groups can be
   * knocking on the same one.
   */
  cooldowns: "opentabs:cooldowns",
  /**
   * Where a bookmark was, so unbookmarking is undoable.
   *
   * Without it, un-then-re-bookmarking silently moves a link out of the
   * folder someone filed it in and into the default one — a one-click toggle
   * that quietly loses curation is worse than no toggle.
   */
  bookmarkUndo: "opentabs:bmundo",
  /** The folder last chosen when saving a tab, so the next save defaults to it. */
  lastFolder: "opentabs:bmfolder",
} as const;

export async function getSync<T>(key: string, fallback: T): Promise<T> {
  try {
    const got = await ext.storage.sync.get(key);
    return (got?.[key] as T) ?? fallback;
  } catch {
    // sync can be unavailable (quota, a locked profile). Local still works,
    // and a config that fails to load must not blank the page.
    try {
      const got = await ext.storage.local.get(key);
      return (got?.[key] as T) ?? fallback;
    } catch {
      return fallback;
    }
  }
}

export async function setSync(key: string, value: unknown): Promise<void> {
  try {
    await ext.storage.sync.set({ [key]: value });
  } catch {
    await ext.storage.local.set({ [key]: value });
  }
}

export async function getLocal<T>(key: string, fallback: T): Promise<T> {
  try {
    const got = await ext.storage.local.get(key);
    return (got?.[key] as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setLocal(key: string, value: unknown): Promise<void> {
  try {
    await ext.storage.local.set({ [key]: value });
  } catch {
    /* storage full or unavailable — the page renders from what it has */
  }
}
