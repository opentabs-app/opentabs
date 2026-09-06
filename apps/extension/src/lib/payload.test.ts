import { describe, expect, it } from "vitest";
import { configHashOf, isEmptyResult, mergePayload, withoutErrors } from "./payload";
import type { Payload } from "./types";

const NOW = 1_788_048_000;
const TTL = 2700;
const good = (at: number): Payload => ({
  instanceId: "ai",
  data: [{ title: "a story" }],
  generated_at: at,
  stale_after: at + TTL,
});

describe("isEmptyResult", () => {
  it("treats an empty array as empty — the case `??` misses", () => {
    expect(isEmptyResult([])).toBe(true);
    expect(isEmptyResult(null)).toBe(true);
    expect(isEmptyResult(undefined)).toBe(true);
  });
  it("does not treat real data as empty", () => {
    expect(isEmptyResult([1])).toBe(false);
    expect(isEmptyResult({ temp: 30 })).toBe(false);
    // A weather object with falsy fields is still data.
    expect(isEmptyResult({ temp: 0 })).toBe(false);
  });
});

describe("mergePayload", () => {
  it("THE regression: an empty refresh never wipes working data", () => {
    // Every source answered 304, so the pool came back empty. The topic must
    // keep what it had rather than going blank forever.
    const prev = good(NOW - 600);
    const next = mergePayload("ai", prev, [], TTL, NOW);
    expect(next.data).toEqual(prev.data);
  });

  it("keeps the ORIGINAL timestamp, so stale data still ages out", () => {
    // If the kept payload were restamped with `now`, a dead source would
    // look permanently fresh and never hide itself.
    const prev = good(NOW - 600);
    const next = mergePayload("ai", prev, [], TTL, NOW);
    expect(next.generated_at).toBe(NOW - 600);
    expect(next.stale_after).toBe(NOW - 600 + TTL);
  });

  it("accepts real data and stamps it now", () => {
    const next = mergePayload("ai", good(NOW - 600), [{ title: "fresh" }], TTL, NOW);
    expect(next.data).toEqual([{ title: "fresh" }]);
    expect(next.generated_at).toBe(NOW);
  });

  it("an empty result with nothing stored stays empty and never looks fresh", () => {
    const next = mergePayload("ai", undefined, [], TTL, NOW);
    expect(next.generated_at).toBe(0);
    expect(next.stale_after).toBe(TTL);
  });

  it("carries an error note without discarding the data behind it", () => {
    const prev = good(NOW - 600);
    const next = mergePayload("ai", prev, [], TTL, NOW, "No access to news.google.com");
    expect(next.error).toBe("No access to news.google.com");
    expect(next.data).toEqual(prev.data);
  });

  it("repeated empty refreshes do not erode the payload", () => {
    let p: Payload = good(NOW - 600);
    for (let i = 0; i < 20; i++) p = mergePayload("ai", p, [], TTL, NOW + i * 300);
    expect(p.data).toEqual(good(0).data);
    expect(p.generated_at).toBe(NOW - 600);
  });
});

describe("mergePayload with a config fingerprint", () => {
  const withHash = (at: number, hash: string): Payload => ({
    instanceId: "ai",
    data: [{ title: "a TechCrunch article" }],
    generated_at: at,
    stale_after: at + TTL,
    config_hash: hash,
  });

  it("THE regression: removing a source drops its articles even if the rest fail", () => {
    // Sources changed, so the old pool is a different question's answer.
    // Keeping it is what left TechCrunch on screen after it was removed.
    const prev = withHash(NOW - 600, "oldsources");
    const next = mergePayload("ai", prev, [], TTL, NOW, undefined, "newsources");
    expect(next.data).toEqual([]);
    expect(next.generated_at).toBe(0);
  });

  it("still protects good data when the config is unchanged", () => {
    const prev = withHash(NOW - 600, "same");
    const next = mergePayload("ai", prev, [], TTL, NOW, undefined, "same");
    expect(next.data).toEqual(prev.data);
    expect(next.generated_at).toBe(NOW - 600);
  });

  it("records the fingerprint it was produced under", () => {
    const next = mergePayload("ai", undefined, [{ t: 1 }], TTL, NOW, undefined, "h1");
    expect(next.config_hash).toBe("h1");
  });
});

describe("configHashOf", () => {
  it("is stable across key order, so a settings round trip is not a change", () => {
    const a = { query: "ai", sources: [{ kind: "feed", url: "u" }], limit: 8 };
    const b = { limit: 8, sources: [{ url: "u", kind: "feed" }], query: "ai" };
    expect(configHashOf(a)).toBe(configHashOf(b));
  });

  it("changes when a source is removed", () => {
    const before = { sources: [{ kind: "feed", url: "a" }, { kind: "feed", url: "b" }] };
    const after = { sources: [{ kind: "feed", url: "a" }] };
    expect(configHashOf(before)).not.toBe(configHashOf(after));
  });

  it("changes when the query changes", () => {
    expect(configHashOf({ query: "ai" })).not.toBe(configHashOf({ query: "robotics" }));
  });

  it("is order-sensitive for arrays, because binding order is meaningful", () => {
    expect(configHashOf({ s: [1, 2] })).not.toBe(configHashOf({ s: [2, 1] }));
  });
});

describe("payloads written before fingerprinting existed", () => {
  it("are not trusted through an empty refresh", () => {
    // Upgrading users all have these. Treating "no fingerprint" as "same
    // config" left removed sources on screen forever.
    const legacy: Payload = {
      instanceId: "ai",
      data: [{ title: "a removed source's article" }],
      generated_at: NOW - 600,
      stale_after: NOW - 600 + TTL,
    };
    const next = mergePayload("ai", legacy, [], TTL, NOW, undefined, "h1");
    expect(next.data).toEqual([]);
  });

  it("are still replaced normally by a successful refresh", () => {
    const legacy: Payload = {
      instanceId: "ai",
      data: [{ title: "old" }],
      generated_at: NOW - 600,
      stale_after: NOW - 600 + TTL,
    };
    const next = mergePayload("ai", legacy, [{ title: "new" }], TTL, NOW, undefined, "h1");
    expect(next.data).toEqual([{ title: "new" }]);
    expect(next.config_hash).toBe("h1");
  });
});

describe("paced sources", () => {
  it("a retry time is absolute, so the countdown cannot go stale", () => {
    // The bug: "Next check in about 131 minutes" was computed once and stored,
    // so it survived a change from 4 hours down to 15 minutes and kept
    // reporting the old wait.
    const retryAt = NOW + 900;
    const p = { ...mergePayload("x", undefined, [], TTL, NOW), retry_at: retryAt };

    // Rendered ten minutes later, the same payload yields a smaller number.
    const at = (t: number) => Math.ceil((p.retry_at! - t) / 60);
    expect(at(NOW)).toBe(15);
    expect(at(NOW + 600)).toBe(5);
    expect(at(NOW + 900)).toBe(0);
  });

  it("changing settings changes the fingerprint, which is what resets pacing", () => {
    const before = configHashOf({ interval_min: 240, mode: "scrape" });
    const after = configHashOf({ interval_min: 15, mode: "scrape" });
    expect(before).not.toBe(after);
  });
});

describe("withoutErrors — a note must not outlive the code that wrote it", () => {
  const p = (over: Partial<Payload> = {}): Payload => ({
    instanceId: "x",
    data: [1],
    generated_at: 100,
    stale_after: 200,
    ...over,
  });

  it("drops the note and keeps everything else", () => {
    const before = { a: p({ error: "Another X search is loading.", config_hash: "h" }) };
    const { payloads, touched } = withoutErrors(before);
    expect(touched).toBe(true);
    expect(payloads.a).not.toHaveProperty("error");
    expect(payloads.a.data).toEqual([1]);
    expect(payloads.a.config_hash).toBe("h");
    expect(payloads.a.generated_at).toBe(100);
  });

  it("reports nothing to do when no note is stored", () => {
    const { touched } = withoutErrors({ a: p(), b: p() });
    expect(touched).toBe(false);
  });

  it("does not mutate what it was given", () => {
    const before = { a: p({ error: "boom" }) };
    withoutErrors(before);
    expect(before.a.error).toBe("boom");
  });

  it("sweeps every group, not only the first", () => {
    const { payloads } = withoutErrors({ a: p({ error: "one" }), b: p(), c: p({ error: "two" }) });
    expect(payloads.a).not.toHaveProperty("error");
    expect(payloads.c).not.toHaveProperty("error");
  });
});
