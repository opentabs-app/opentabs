/**
 * Every hostname OpenTabs talks to, in one file.
 *
 * Defined once because the alternative has already cost real time
 * elsewhere: a backend URL kept as a literal at two call sites, so moving to
 * a custom domain fixed one and silently left the other pointing at the old
 * host. Every origin the extension uses is named here and nowhere else.
 */

/** The product site. Also where the daily feeds are published. */
export const SITE_ORIGIN = "https://opentabs.app";

/**
 * The apps catalogue and the trending feed, regenerated daily by
 * `tabs-feedgen` and served as static files from the site.
 */
export const FEEDS_BASE = `${SITE_ORIGIN}/tabs/v1`;

/** The marketplace. The site and its API share this origin. */
export const MARKET_ORIGIN = "https://market.opentabs.app";

/** Accounts, credits and sign-in. */
export const PLATFORM_BASE_URL = "https://auth.opentabs.app";

/**
 * The sign-in page.
 *
 * An extension cannot host this itself, and the reason is worth stating so
 * nobody tries: Chrome injects `window.ethereum` and `window.nostr` from
 * content scripts, and content scripts never run on `chrome-extension://`
 * pages — one extension cannot inject into another's. Wallet and Nostr
 * sign-in are therefore *impossible* on our own pages, however long we wait
 * for the globals to appear. This page is an https origin, so they work
 * there, and it hands the session back by posting it to its own window
 * where our content script can hear it.
 */
export const SIGNIN_URL = `${PLATFORM_BASE_URL}/signin`;

/** Match patterns, for `permissions.request` and the manifest. */
export const SITE_MATCH = `${SITE_ORIGIN}/*`;
export const MARKET_MATCH = `${MARKET_ORIGIN}/*`;
export const PLATFORM_MATCH = `${PLATFORM_BASE_URL}/*`;
