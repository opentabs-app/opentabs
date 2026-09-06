/**
 * Lets the marketplace site hand a pack straight to the extension.
 *
 * Registered dynamically from `background/session.ts` once the reader has
 * granted access to the marketplace origin — which happens the first time
 * they open Settings → Marketplace. Someone who never does is never asked,
 * and the site falls back to showing an address to paste.
 *
 * Plain JavaScript with no imports, because a registered content script is a
 * classic script and cannot import the constants module. It needs no
 * constant: it runs only on the page it was registered for, so
 * `location.origin` is the origin to trust, and the worker checks the sender
 * again against the real marketplace host before fetching anything.
 */
(function () {
  "use strict";

  if (window.__openTabsMarketRelay) return;
  window.__openTabsMarketRelay = true;

  window.addEventListener("message", function (event) {
    if (event.source !== window || event.origin !== location.origin) return;
    var d = event.data;
    if (!d || d.type !== "opentabs:install" || typeof d.url !== "string") return;

    chrome.runtime.sendMessage({ type: "installFromUrl", url: d.url }, function (res) {
      // A dead worker leaves `res` undefined and sets lastError. Reading it
      // is what stops Chrome logging "Unchecked runtime.lastError", and the
      // site's own 700ms fallback covers the silence.
      void chrome.runtime.lastError;
      if (!res || !res.ok) return;
      window.postMessage({ type: "opentabs:installed", id: d.id }, location.origin);
    });
  });
})();
