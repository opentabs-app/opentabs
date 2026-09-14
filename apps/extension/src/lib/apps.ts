/**
 * The suite, and how a reader's changes to it are applied.
 *
 * Shared by the worker, which fetches the served catalogue, and the settings
 * pane, which has to draw the list before any fetch has happened. It lived in
 * `background/sources.ts` until the pane needed it: opening Settings on a
 * fresh profile showed an empty picker, because the only copy of the list was
 * a payload the worker had not written yet.
 */

export interface WebApp {
  id?: string;
  name: string;
  url: string;
  tagline?: string;
}

/**
 * Every web app the server actually serves to a person, read off its nginx
 * hosts on 13 September 2026 — not the list of folders with a web app in
 * them, most of which are built and deployed nowhere, and a card linking to
 * one would be a link to nothing. Infrastructure hosts (auth, gateway,
 * market, media, the relay) are not apps, and neither is this product or the
 * platform.
 *
 * Apex URLs, not the `app.` hosts. Every one of those is a 301 to exactly
 * this, and a redirect on a link clicked from the new tab page is a round
 * trip spent arriving where the link could have pointed.
 *
 * OpenTabs is deliberately absent — a card linking you to the page you are
 * already on — and so is the platform, which `deploy/verify.sh` keeps off
 * every page a reader can see, for the same reason: it is the one name here
 * that nobody has heard of.
 */
export const BUNDLED_APPS: WebApp[] = [
  { id: "opensubs", name: "OpenSubs", url: "https://opensubs.app/", tagline: "Subtitles and translation" },
  { id: "openpdfedit", name: "OpenPDFEdit", url: "https://openpdfedit.com/app/", tagline: "Edit PDFs in the browser" },
  { id: "opencapture", name: "OpenCapture", url: "https://opencapture.app/", tagline: "Full-page screenshots" },
  { id: "opendocscan", name: "OpenDocScan", url: "https://opendocscan.com/", tagline: "Scan documents to PDF" },
  { id: "opendownloader", name: "OpenDownloader", url: "https://opendownloader.app/", tagline: "Save video and audio" },
  { id: "opennotetaker", name: "OpenNoteTaker", url: "https://opennotetaker.app/", tagline: "Meeting notes, on your machine" },
  { id: "openphotoid", name: "OpenPhotoId", url: "https://openphotoid.com/", tagline: "Passport and ID photos" },
  { id: "openpixels", name: "OpenPixels", url: "https://openpixels.app/", tagline: "Upscale and restore photos" },
  { id: "openclipboard", name: "OpenClipboard", url: "https://clipboard.opensync.network/", tagline: "Clipboard history across devices" },
  { id: "openpassword", name: "OpenPassword", url: "https://passwords.opensync.network/", tagline: "Passwords and secrets, encrypted" },
];

/** A stable id for an app the catalogue named, or one someone typed. */
export function appKey(app: { id?: string; url: string }): string {
  return app.id ?? app.url;
}

/** An address as typed. A scheme-less one resolves against the extension's
 *  own origin, which opens a blank page inside the extension, not the site. */
export function normaliseUrl(raw: string): string {
  const u = raw.trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/**
 * The catalogue, as this reader has arranged it.
 *
 * Three layers, and the order matters: the catalogue is whatever the server
 * last said, or the bundled list; `hidden` takes entries out of it; `custom`
 * adds their own on the end.
 *
 * Deliberately *not* "copy the catalogue into the config and let them edit
 * it". That is the obvious design and it quietly breaks the release valve —
 * once the list is a snapshot in someone's settings, a product shipped next
 * month never reaches them. Storing only the differences keeps new apps
 * arriving while a removal still sticks.
 */
export function arrangeApps(catalogue: WebApp[], opts: Record<string, unknown>): WebApp[] {
  const hidden = new Set(Array.isArray(opts.hidden) ? (opts.hidden as string[]) : []);
  const custom = Array.isArray(opts.custom) ? (opts.custom as WebApp[]) : [];
  const kept = catalogue.filter((app) => !hidden.has(appKey(app)));
  // A custom entry repeating one already listed replaces it rather than
  // showing twice — renaming a bundled app is a reasonable thing to want.
  const mine = new Map(custom.filter((a) => a?.name && a?.url).map((a) => [appKey(a), a]));
  const merged = kept.map((app) => mine.get(appKey(app)) ?? app);
  const seen = new Set(merged.map(appKey));
  return [...merged, ...[...mine.values()].filter((a) => !seen.has(appKey(a)))];
}
