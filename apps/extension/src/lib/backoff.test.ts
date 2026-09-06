import { describe, expect, it } from "vitest";
import {
  BASE_COOLDOWN_SECS, MAX_COOLDOWN_SECS, blockedUntil, hostOf, isPushback,
  notePushback, noteSuccess, pruneCooldowns, pushbackNote, type Cooldowns,
} from "./backoff";

const NOW = 1_788_048_000;
const RED = "www.reddit.com";
const URL_RED = "https://www.reddit.com/search.rss?q=ai";

describe("which statuses mean stop asking", () => {
  it("treats a throttle as an instruction", () => {
    expect(isPushback(429)).toBe(true);
    expect(isPushback(503)).toBe(true);
  });

  it("does not back off a host for a broken binding", () => {
    // A 404 is our mistake and retrying costs the host nothing; backing off
    // would hide a fixable misconfiguration behind a six-hour silence.
    for (const s of [200, 304, 400, 403, 404, 500]) expect(isPushback(s)).toBe(false);
  });
});

describe("the wait grows while a host keeps pushing back", () => {
  it("starts at the base wait", () => {
    const s = notePushback({}, RED, NOW);
    expect(s[RED]!.until).toBe(NOW + BASE_COOLDOWN_SECS);
    expect(s[RED]!.strikes).toBe(1);
  });

  it("doubles on each consecutive strike", () => {
    let s: Cooldowns = notePushback({}, RED, NOW);
    s = notePushback(s, RED, NOW);
    expect(s[RED]!.until).toBe(NOW + BASE_COOLDOWN_SECS * 2);
    s = notePushback(s, RED, NOW);
    expect(s[RED]!.until).toBe(NOW + BASE_COOLDOWN_SECS * 4);
  });

  it("never sulks longer than the cap", () => {
    let s: Cooldowns = {};
    for (let i = 0; i < 20; i++) s = notePushback(s, RED, NOW);
    expect(s[RED]!.until).toBe(NOW + MAX_COOLDOWN_SECS);
  });

  it("obeys Retry-After when the server asks for longer", () => {
    const s = notePushback({}, RED, NOW, 4 * 3600);
    expect(s[RED]!.until).toBe(NOW + 4 * 3600);
  });

  it("does not let Retry-After shorten a backoff strikes have earned", () => {
    // Arguing a throttle down is how it becomes a ban.
    let s: Cooldowns = notePushback({}, RED, NOW);
    s = notePushback(s, RED, NOW);
    s = notePushback(s, RED, NOW, 30);
    expect(s[RED]!.until).toBe(NOW + BASE_COOLDOWN_SECS * 4);
  });

  it("forgets a host entirely once it answers", () => {
    const s = noteSuccess(notePushback({}, RED, NOW), RED);
    expect(s[RED]).toBeUndefined();
    // And the next strike starts from the base wait, not where it left off.
    expect(notePushback(s, RED, NOW)[RED]!.until).toBe(NOW + BASE_COOLDOWN_SECS);
  });

  it("does not mutate the state it was given", () => {
    const before: Cooldowns = {};
    notePushback(before, RED, NOW);
    expect(before[RED]).toBeUndefined();
  });
});

describe("blockedUntil — the check before every request", () => {
  it("blocks until the time is up, then stops", () => {
    const s = notePushback({}, RED, NOW);
    expect(blockedUntil(s, URL_RED, NOW)).toBe(NOW + BASE_COOLDOWN_SECS);
    expect(blockedUntil(s, URL_RED, NOW + BASE_COOLDOWN_SECS)).toBeNull();
  });

  it("is per host, so every topic sharing it waits together", () => {
    const s = notePushback({}, RED, NOW);
    expect(blockedUntil(s, "https://www.reddit.com/r/LocalLLaMA/top/.rss", NOW)).not.toBeNull();
    expect(blockedUntil(s, "https://news.google.com/rss/search?q=ai", NOW)).toBeNull();
  });

  it("never blocks on a URL it cannot parse", () => {
    expect(blockedUntil(notePushback({}, RED, NOW), "not a url", NOW)).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("housekeeping and wording", () => {
  it("drops records that have expired", () => {
    const s = { a: { until: NOW - 1, strikes: 1 }, b: { until: NOW + 60, strikes: 1 } };
    expect(Object.keys(pruneCooldowns(s, NOW))).toEqual(["b"]);
  });

  it("names the host and an absolute time, never a countdown", () => {
    // A stored "in 12 minutes" is wrong the moment it is written — the same
    // mistake the X countdown made.
    const note = pushbackNote(RED, NOW + 900);
    expect(note).toContain(RED);
    expect(note).toContain("429");
    expect(note).not.toMatch(/\bin \d+ minute/);
    expect(note).toMatch(/\d{2}:\d{2}/);
  });
});
