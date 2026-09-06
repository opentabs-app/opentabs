/**
 * Per-host cooling off, after a source says stop.
 *
 * A 429 is not an error to report and move past — it is an instruction. The
 * failure mode this prevents is the one that makes it worse: the request
 * fails, the group stays empty, the group is therefore due again next cycle,
 * and we knock on the same door harder while it is being held shut. Reddit in
 * particular escalates from a short throttle to a long one under exactly that
 * pattern.
 *
 * So a host that pushes back is left alone until it says otherwise, and the
 * wait doubles as long as it keeps pushing back. Held per **host**, not per
 * URL: the limit is on the door, and several topics can be knocking on it.
 *
 * Pure and in Unix seconds. The store is a plain record so it serialises
 * straight into `storage.local`.
 */

export interface HostState {
  /** No request to this host before this time. */
  until: number;
  /** Consecutive push-backs, which is what makes the wait grow. */
  strikes: number;
}

export type Cooldowns = Record<string, HostState>;

/** First wait after a host pushes back. */
export const BASE_COOLDOWN_SECS = 15 * 60;
/** However many strikes, never sulk longer than this. */
export const MAX_COOLDOWN_SECS = 6 * 3600;

/**
 * Statuses that mean "stop asking", as opposed to "that went wrong".
 *
 * A 404 is a broken binding and retrying it costs the host nothing; a 429 or
 * a 503 is the host itself asking for room.
 */
export function isPushback(status: number): boolean {
  return status === 429 || status === 503 || status === 509;
}

/** Host of a URL, or `null` if it will not parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Record a push-back and say when we may knock again.
 *
 * `retryAfter` is the server's own answer, in seconds, when it sent one. It
 * wins whenever it is longer than our own guess — arguing with an explicit
 * `Retry-After` is how a throttle becomes a ban — but never shortens the
 * backoff below what repeated strikes have earned.
 */
export function notePushback(
  state: Cooldowns,
  host: string,
  now: number,
  retryAfter?: number,
): Cooldowns {
  const strikes = (state[host]?.strikes ?? 0) + 1;
  const ours = Math.min(BASE_COOLDOWN_SECS * 2 ** (strikes - 1), MAX_COOLDOWN_SECS);
  const wait = Math.max(ours, retryAfter && retryAfter > 0 ? retryAfter : 0);
  return { ...state, [host]: { until: now + wait, strikes } };
}

/** A host answered. Forget its record entirely. */
export function noteSuccess(state: Cooldowns, host: string): Cooldowns {
  if (!state[host]) return state;
  const next = { ...state };
  delete next[host];
  return next;
}

/** When this host may be asked again, or `null` if now is fine. */
export function blockedUntil(state: Cooldowns, url: string, now: number): number | null {
  const host = hostOf(url);
  if (!host) return null;
  const until = state[host]?.until;
  return until && until > now ? until : null;
}

/** Drop expired records, so the store does not accumulate every host ever seen. */
export function pruneCooldowns(state: Cooldowns, now: number): Cooldowns {
  const next: Cooldowns = {};
  for (const [host, s] of Object.entries(state)) {
    if (s.until > now) next[host] = s;
  }
  return next;
}

/**
 * What to tell the reader.
 *
 * An absolute clock time, never "in 12 minutes": a note is stored beside the
 * data and rendered later, so a relative time is wrong the moment it is
 * written. This is the same mistake the X countdown made.
 */
export function pushbackNote(host: string, until: number): string {
  const at = new Date(until * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${host} is rate-limiting requests (HTTP 429) — paused until ${at}.`;
}
