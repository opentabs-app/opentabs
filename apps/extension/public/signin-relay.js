/**
 * Relays an OpenApps session from the platform's sign-in page to the worker.
 *
 * Registered dynamically — never at install — from `background/session.ts`,
 * once the reader has granted access to the sign-in origin. Someone who
 * never signs in is never asked for it and this file never runs.
 *
 * # Why a page on the platform's origin at all
 *
 * Chrome injects `window.ethereum` and `window.nostr` from content scripts,
 * and content scripts do not run on `chrome-extension://` URLs — one
 * extension cannot inject into another's pages. So wallet and Nostr sign-in
 * are not merely awkward on our own settings page, they are impossible, and
 * no amount of waiting makes the globals appear. The platform serves an
 * https page for exactly this, and hands the session back by posting it to
 * its own window, where a content script can hear it and a cross-origin
 * opener cannot.
 *
 * # Plain JavaScript, and no imports
 *
 * A registered content script is a classic script, not a module, so it
 * cannot import the constants module the rest of the extension shares. That
 * is fine here because it needs no constant: it only ever runs on the page
 * it was registered for, so `location.origin` *is* the origin to trust. The
 * check that actually matters — that this page is the platform's and not
 * some other site that guessed the message shape — happens in the worker,
 * against the sender's URL.
 */
(function () {
  "use strict";

  // Registered at document_start and possibly injected again on a later
  // navigation. Two listeners would relay every session twice.
  if (window.__openTabsSigninRelay) return;
  window.__openTabsSigninRelay = true;

  window.addEventListener("message", function (event) {
    // `event.source !== window` rejects anything posted by a frame; the
    // origin check rejects anything posted from another origin into this
    // one. The page posts to itself, so both hold for the real message.
    if (event.source !== window || event.origin !== location.origin) return;
    var d = event.data;
    if (!d || d.source !== "openapps" || d.type !== "openapps:session") return;
    if (!d.access_token) return;

    chrome.runtime.sendMessage({
      type: "openapps:session",
      accessToken: d.access_token,
      refreshToken: d.refresh_token || null,
    });
  });

  // Announce readiness. Without this, a Google sign-in that returns to this
  // page can deliver the session before the listener above exists, and it is
  // lost with nothing at all to show for it — the tab simply sits there.
  window.postMessage({ source: "openapps-host", type: "ready" }, location.origin);
})();
