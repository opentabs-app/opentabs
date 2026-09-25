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
 * What the Web Apps group starts with: nothing.
 *
 * It used to ship the sibling products of the suite this was built in, and
 * the served catalogue was a release valve for adding more. Both are gone.
 * A tab manager that arrives with ten links to one vendor's other products
 * is advertising, and it tied a product that stands on its own to a platform
 * its readers have never heard of.
 *
 * So the group is the feature and the contents are the reader's: Settings →
 * Web Apps takes a name and an address, the card offers the same in its empty
 * state, and `arrangeApps` still layers `hidden` and `custom` over whatever
 * the catalogue says — which is now an empty list rather than a suite.
 *
 * Kept as a named export, empty, rather than deleted: it is what ships when
 * the served file is unreachable, `arrangeApps` needs a base to layer on, and
 * the drift test in test/origins-drift.test.ts still holds it against the
 * feedgen catalogue so the two cannot disagree again.
 */
export const BUNDLED_APPS: WebApp[] = [];

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
