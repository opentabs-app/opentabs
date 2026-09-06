/**
 * The permission broker (decision D6).
 *
 * `<all_urls>` at install reads to a user as "read and change all your data
 * on all websites", and on a new-tab override that invites the hardest
 * review Chrome does. Instead the manifest declares
 * `optional_host_permissions` and we ask for one origin at the moment the
 * user adds the thing that needs it.
 *
 * `chrome.permissions.request()` requires a user gesture, so this can only
 * be called from a page in response to a click — never from the worker's
 * alarm. The worker's job is to *check*, and to skip sources it may not
 * fetch rather than throwing.
 */
import { ext } from "../lib/ext";

export async function has(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return true;
  try {
    return await ext.permissions.contains({ origins });
  } catch {
    return false;
  }
}

/** Must be called from a user gesture. Batched, so adding three feeds is one prompt. */
export async function request(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return true;
  try {
    return await ext.permissions.request({ origins });
  } catch {
    return false;
  }
}

export async function granted(): Promise<string[]> {
  try {
    const all = await ext.permissions.getAll();
    return all.origins ?? [];
  } catch {
    return [];
  }
}

/** `https://news.google.com/rss/search?q=x` -> `https://news.google.com/*` */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export function originsOf(urls: string[]): string[] {
  return [...new Set(urls.map(originOf).filter((o): o is string => o !== null))];
}
