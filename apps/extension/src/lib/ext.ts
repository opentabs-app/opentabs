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

/**
 * Firefox, for the few places a real difference has to be branched on.
 *
 * This used to be `!!g.browser?.runtime`, on the reasoning above that only
 * Firefox exposes `browser`. That stopped being true: Chromium now defines a
 * `browser` global of its own — a distinct object, not an alias of `chrome` —
 * so the old test reported Firefox on Chrome. It went unnoticed because
 * `ext` works out the same either way and nothing else consulted this.
 *
 * `getBrowserInfo` is a capability instead of a guess: it is part of the
 * WebExtensions standard that Chromium has never implemented, and it does not
 * depend on which vendors happen to define which globals this year.
 */
export const isFirefox =
  typeof (g.browser?.runtime as { getBrowserInfo?: unknown } | undefined)?.getBrowserInfo ===
  "function";

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
  /**
   * OpenSync keys, relay address and sync bookkeeping.
   *
   * `storage.local` and **never** `storage.sync`. The whole point of this
   * feature is that the settings leave the device sealed; writing the key
   * that unseals them into a Google-synced bucket would hand it over in
   * plaintext and make the encryption theatre. `setLocal` is the only writer.
   */
  sync: "opentabs:sync",
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
