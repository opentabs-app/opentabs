/**
 * Every hostname OpenTabs talks to, in one file.
 *
 * Defined once because the alternative has already cost this suite real
 * time: OpenCapture kept its backend URL as a literal at two call sites, so
 * moving to a custom domain fixed one and silently left the other pointing
 * at the old host. A grep for `openapps.network` outside this file must
 * return nothing.
 *
 * # Why none of these say `openapps.network`
 *
 * The platform runs at `accounts.openapps.network` and every product reaches
 * it through its own hostname instead. That is not decoration. A browser
 * names the host it is about to allow in the permission prompt, and
 * *"OpenTabs wants to communicate with market.openapps.network"* reads like
 * the extension is phoning someone else's server — which, to anyone who has
 * never heard of OpenApps, is exactly what it looks like.
 *
 * What the masking does **not** hide, said plainly rather than overclaimed:
 * Google sign-in visibly bounces through `accounts.openapps.network` on the
 * OAuth callback hop, and a wallet signature prompt names that host too. The
 * server builds both from its own `public_url` once at startup, so no
 * hostname added here changes them.
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

/**
 * OpenApps accounts, credits and sign-in — the platform, under our own name.
 */
export const OPENAPPS_BASE_URL = "https://auth.opentabs.app";

/**
 * The platform's own sign-in page.
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
export const SIGNIN_URL = `${OPENAPPS_BASE_URL}/signin`;

/** Match patterns, for `permissions.request` and the manifest. */
export const SITE_MATCH = `${SITE_ORIGIN}/*`;
export const MARKET_MATCH = `${MARKET_ORIGIN}/*`;
export const OPENAPPS_MATCH = `${OPENAPPS_BASE_URL}/*`;
