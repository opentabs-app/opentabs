/**
 * Comparing two links for "the same page".
 *
 * A tab's URL and a bookmark's URL are written by different things at
 * different times, so byte equality is the wrong test: a bookmark typed by
 * hand, imported from another browser, or saved before a redirect can differ
 * from the tab in ways nobody would call a different page.
 *
 * Deliberately conservative. A query string can change what you are looking
 * at, so it is kept; a fragment usually cannot, so it is not.
 */
export function canonicalLink(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.host.toLowerCase().replace(/^www\./, "");
    // A bare origin is the same page with or without its slash.
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    // http and https to the same page are the same page to a reader.
    const scheme = u.protocol === "http:" || u.protocol === "https:" ? "web" : u.protocol;
    return `${scheme}://${host}${path}${u.search}`;
  } catch {
    // Not a URL we can parse — compare it as written rather than dropping it.
    return raw.trim();
  }
}

/** Are these the same page? */
export function sameLink(a: string, b: string): boolean {
  return canonicalLink(a) === canonicalLink(b);
}

/** A lookup set for "is this page bookmarked". */
export function linkSet(urls: string[]): Set<string> {
  return new Set(urls.map(canonicalLink));
}
