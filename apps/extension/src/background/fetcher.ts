/**
 * Fetching, with the manners a background job owes the sources it pulls.
 *
 * Conditional GET first: most feeds honour ETag/Last-Modified, so the steady
 * state is a 304 of a few hundred bytes rather than the 130 KB a Google News
 * query actually weighs. That matters — five topics with several bindings
 * each is real bandwidth on someone's laptop.
 *
 * Failures are values, not exceptions. A source that 403s (several do from
 * anything that looks like a server) must degrade one group, never take down
 * a refresh cycle.
 */
import { ext, KEY, getLocal, setLocal } from "../lib/ext";

export interface FetchResult {
  ok: boolean;
  status: number;
  /** True when the server said 304 — the previous payload is still current. */
  notModified: boolean;
  body: string;
  error?: string;
  /** Seconds the server asked us to wait, from `Retry-After`, when it said. */
  retryAfter?: number;
}

/**
 * `Retry-After` is either a count of seconds or an HTTP date. Both are used in
 * the wild, so both are read; anything else is treated as absent rather than
 * as zero, because a misparsed header must never mean "retry immediately".
 */
export function parseRetryAfter(raw: string | null, now = Date.now()): number | undefined {
  if (!raw) return undefined;
  const secs = Number(raw.trim());
  if (Number.isFinite(secs)) return secs > 0 ? Math.round(secs) : undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const delta = Math.round((at - now) / 1000);
  return delta > 0 ? delta : undefined;
}

type Validators = Record<string, { etag?: string; lastModified?: string }>;

const TIMEOUT_MS = 20_000;

/**
 * Minimum spacing between two requests to the same host, in milliseconds.
 *
 * `staggered` spreads the bindings *within* one topic, which is not the case
 * that gets throttled. The case that does is a forced refresh: every topic
 * refreshes back to back, and if several of them hold a Reddit binding that
 * is a handful of requests to one host inside a few seconds — reliably a 429,
 * and then a longer one for having tried again.
 *
 * The default is small enough to be invisible. The overrides are measured
 * behaviour of specific hosts, not guesses, and naming them here is more
 * honest than pretending one number suits everyone.
 */
const DEFAULT_GAP_MS = 250;
const HOST_GAP_MS: Record<string, number> = {
  "www.reddit.com": 2_500,
  "old.reddit.com": 2_500,
  "reddit.com": 2_500,
};

export function gapFor(host: string): number {
  return HOST_GAP_MS[host] ?? DEFAULT_GAP_MS;
}

/**
 * In memory only, and deliberately so: a terminated worker means real time
 * has passed, which is exactly what the gap was waiting for.
 */
const lastRequestAt = new Map<string, number>();

async function spaceOut(url: string): Promise<void> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const gap = gapFor(host);
  const wait = (lastRequestAt.get(host) ?? 0) + gap - Date.now();
  // Claim the slot before waiting, so two concurrent callers queue behind
  // each other rather than both measuring against the same old timestamp.
  lastRequestAt.set(host, Math.max(Date.now(), (lastRequestAt.get(host) ?? 0) + gap));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function conditionalGet(url: string): Promise<FetchResult> {
  await spaceOut(url);
  const validators = await getLocal<Validators>(KEY.etags, {});
  const prev = validators[url];
  const headers: Record<string, string> = { Accept: "*/*" };
  if (prev?.etag) headers["If-None-Match"] = prev.etag;
  if (prev?.lastModified) headers["If-Modified-Since"] = prev.lastModified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      credentials: "omit",
      cache: "no-cache",
      redirect: "follow",
    });
    if (res.status === 304) {
      return { ok: true, status: 304, notModified: true, body: "" };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        notModified: false,
        body: "",
        error: `HTTP ${res.status}`,
        retryAfter: parseRetryAfter(res.headers.get("retry-after")),
      };
    }
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    if (etag || lastModified) {
      validators[url] = { etag, lastModified };
      await setLocal(KEY.etags, validators);
    }
    return { ok: true, status: res.status, notModified: false, body: await res.text() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, notModified: false, body: "", error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forget a URL's cached validators.
 *
 * Needed when our parsed-item cache is gone but the server still believes we
 * hold a copy: without this the next request sends the same `If-None-Match`,
 * gets another 304, and the binding never produces items again.
 */
export async function forgetValidator(url: string): Promise<void> {
  const validators = await getLocal<Validators>(KEY.etags, {});
  if (validators[url]) {
    delete validators[url];
    await setLocal(KEY.etags, validators);
  }
}

/**
 * Spread N fetches over a window instead of firing them at once.
 *
 * Two reasons, both measured during design: Reddit 429s on a second quick
 * request, and a burst of a dozen large query fetches is a visible spike on
 * a laptop's network. Jitter also stops every install in the world hitting
 * the same source on the same second.
 */
export async function staggered<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  gapMs = 350,
): Promise<void> {
  for (const item of items) {
    await fn(item);
    if (gapMs > 0) {
      const jitter = gapMs * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, jitter));
    }
  }
}

/** Keep the worker alive across an await chain that outlives its idle timer. */
export function keepAlive(): () => void {
  const id = setInterval(() => void ext.runtime.getPlatformInfo(), 20_000);
  return () => clearInterval(id);
}
