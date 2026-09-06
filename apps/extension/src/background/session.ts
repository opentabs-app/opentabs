/**
 * Signing in to OpenApps, from an extension.
 *
 * The worker owns the session, for the same reason it owns the config: a
 * settings page that held its own token would lose it on every navigation,
 * and the marketplace pane is exactly where someone navigates away and back.
 *
 * # Where the token lives
 *
 * `storage.session` — memory-backed, cleared when the browser closes, never
 * written to disk and never synced. That is the correct home for a
 * credential in MV3 and the reason `storage.local` is not used here: a
 * refresh token in `local` outlives the browser as a file, and this
 * extension already keeps its one other credential-shaped thing (an X API
 * key) out of exports on the same principle.
 *
 * It does have to survive a *worker* restart, which is why it is stored at
 * all rather than kept in a module variable. MV3 terminates the worker
 * whenever it likes, and "sign in, write a description, publish" spans far
 * more than the seconds of idle time that takes.
 *
 * # Why there is a refresh at all
 *
 * Access tokens last fifteen minutes. Writing a good description takes
 * longer than that more often than it doesn't, and "your session expired,
 * do it again" after someone has typed two paragraphs is the sort of thing
 * that ends the habit of publishing.
 */
import { ext } from "../lib/ext";
import { OPENAPPS_BASE_URL, OPENAPPS_MATCH, SIGNIN_URL } from "../lib/openapps";

/** The stored session. `refresh` may be absent — some flows return only one. */
export interface Session {
  access: string;
  refresh: string | null;
  /** Unix seconds, read from the token rather than assumed. */
  expires: number;
}

const STORE_KEY = "opentabs:openapps:session";

/**
 * Renew this far before expiry.
 *
 * A token that is valid *now* can be expired by the time a publish arrives
 * at the server, and the round trip that discovers it costs the body of the
 * request. Sixty seconds is longer than any of these calls take.
 */
const RENEW_MARGIN = 60;

/** Read the expiry out of a JWT without verifying it.
 *
 * Not a security decision — the server verifies, and this side has no key.
 * It is only used to decide when to renew, and a tampered value would at
 * worst cause a needless refresh or one avoidable 401. */
export function expiryOf(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) return 0;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp : 0;
  } catch {
    return 0;
  }
}

const now = () => Math.floor(Date.now() / 1000);

async function read(): Promise<Session | null> {
  try {
    const got = await ext.storage.session.get(STORE_KEY);
    return (got?.[STORE_KEY] as Session) ?? null;
  } catch {
    return null;
  }
}

async function write(s: Session | null): Promise<void> {
  try {
    if (s) await ext.storage.session.set({ [STORE_KEY]: s });
    else await ext.storage.session.remove(STORE_KEY);
  } catch {
    // Storage refused. Sign-in still works for as long as this worker lives.
  }
}

/** Whether the reader has allowed OpenTabs to reach the sign-in origin. */
export function hasAuthAccess(): Promise<boolean> {
  return ext.permissions.contains({ origins: [OPENAPPS_MATCH] }).catch(() => false);
}

/**
 * Store a session handed over by the sign-in page.
 *
 * The caller must have checked the sender. This does not, because by the
 * time a token is a string in a variable there is nothing left to check.
 */
export async function accept(accessToken: string, refreshToken: string | null): Promise<void> {
  await write({
    access: accessToken,
    refresh: refreshToken,
    expires: expiryOf(accessToken),
  });
}

/**
 * Verify that a relayed session really came from the sign-in page.
 *
 * Compared as a whole origin, never with `startsWith`: that would count
 * `https://auth.opentabs.app.evil.test` as ours, which is the entire trick.
 */
export function fromSignInPage(senderUrl: string | undefined): boolean {
  if (!senderUrl) return false;
  try {
    return new URL(senderUrl).origin === new URL(OPENAPPS_BASE_URL).origin;
  } catch {
    return false;
  }
}

/** Whether there is a session at all — expired or not. */
export async function signedIn(): Promise<boolean> {
  const s = await read();
  // An expired access token with a refresh token beside it is still a
  // session; the page should show "signed in", not a sign-in button that
  // would be a no-op.
  return !!s && (s.expires > now() || !!s.refresh);
}

/**
 * A usable access token, renewed if it is about to lapse.
 *
 * `null` means "ask the reader to sign in" and nothing more specific,
 * because there is nothing more specific the caller can do about it.
 */
export async function token(): Promise<string | null> {
  const s = await read();
  if (!s) return null;
  if (s.expires - RENEW_MARGIN > now()) return s.access;
  if (!s.refresh) {
    await write(null);
    return null;
  }
  return renew(s.refresh);
}

async function renew(refresh: string): Promise<string | null> {
  let body: { access_token?: string; refresh_token?: string } | null = null;
  try {
    const res = await fetch(`${OPENAPPS_BASE_URL}/v1/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "omit",
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) {
      // A refused refresh is final: the family was rotated or revoked, and
      // retrying with the same token is what reuse detection is watching
      // for. Drop it rather than keep a credential that can only fail.
      await write(null);
      return null;
    }
    body = (await res.json()) as { access_token?: string; refresh_token?: string };
  } catch {
    // The network, not the credential. Keep what we have — the reader may
    // be offline for a moment and should not be signed out over it.
    return null;
  }
  if (!body?.access_token) return null;
  await accept(body.access_token, body.refresh_token ?? refresh);
  return body.access_token;
}

/** Forget the session, and tell the platform to retire it. */
export async function signOut(): Promise<void> {
  const s = await read();
  await write(null);
  if (!s?.refresh) return;
  try {
    await fetch(`${OPENAPPS_BASE_URL}/v1/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({ refresh_token: s.refresh }),
    });
  } catch {
    // Best effort. The local copy is already gone, which is the part this
    // device controls.
  }
}

/**
 * Make sure the relay runs on the sign-in page.
 *
 * Registered rather than declared in the manifest, so the permission is
 * asked for at the moment someone chooses to sign in — not at install, from
 * everyone, including the majority who never will.
 *
 * Registration survives worker restarts, so this is idempotent by design:
 * it updates an existing registration instead of failing on the duplicate.
 */
export async function ensureRelay(): Promise<void> {
  if (!(await hasAuthAccess())) return;
  const script: chrome.scripting.RegisteredContentScript = {
    id: "openapps-signin-relay",
    matches: [`${OPENAPPS_BASE_URL}/signin*`],
    js: ["signin-relay.js"],
    // The page can post the session as soon as it loads, on the leg back
    // from Google. A listener registered at document_idle would miss it.
    runAt: "document_start",
    persistAcrossSessions: true,
  };
  try {
    const existing = await ext.scripting.getRegisteredContentScripts({ ids: [script.id] });
    if (existing.length > 0) await ext.scripting.updateContentScripts([script]);
    else await ext.scripting.registerContentScripts([script]);
  } catch {
    // Firefox before 101 and some enterprise policies refuse dynamic
    // registration. Sign-in then simply does not complete, and the page
    // says so rather than spinning.
  }
}

/** Open the sign-in page. Returns the tab, so the caller can close it. */
export async function openSignIn(): Promise<number | null> {
  await ensureRelay();
  const tab = await ext.tabs.create({ url: SIGNIN_URL });
  return tab.id ?? null;
}
