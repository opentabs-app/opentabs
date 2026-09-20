import { describe, expect, it } from "vitest";
import { decide, decode, encode, fingerprint, type SyncDoc } from "./sync-doc";
import type { Config, LocalState } from "./types";

const config = (theme = "dawn"): Config => ({
  version: 1,
  instances: [{ def: "topic", id: "a", name: "News", enabled: true, opts: { q: "rust" } }],
  theme,
  assistant: "none",
});

const doc = (over: Partial<SyncDoc> = {}): SyncDoc => ({
  v: 1,
  updated: 1000,
  device: "Laptop",
  config: config(),
  local: {},
  ...over,
});

describe("fingerprint", () => {
  it("ignores who wrote it and when", () => {
    const a = doc({ device: "Laptop", updated: 1 });
    const b = doc({ device: "Phone", updated: 999 });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("notices a changed setting", () => {
    expect(fingerprint(doc())).not.toBe(fingerprint(doc({ config: config("dusk") })));
  });

  it("notices a changed to-do, not just a changed config", () => {
    const local: LocalState = { todos: [{ id: "1", text: "milk", due: null, hasTime: false, done: false, created: 5 }] };
    expect(fingerprint(doc())).not.toBe(fingerprint(doc({ local })));
  });

  it("does not depend on key order", () => {
    const one = { config: config(), local: { scratch: "x", apiKey: "k" } as LocalState };
    const two = { config: config(), local: { apiKey: "k", scratch: "x" } as LocalState };
    expect(fingerprint(one)).toBe(fingerprint(two));
  });
});

describe("encode / decode", () => {
  it("round-trips", () => {
    const original = doc({ local: { scratch: "note", xToken: "secret" } });
    expect(decode(encode(original))).toEqual(original);
  });

  it("carries the secrets, because sealing them is the point", () => {
    const back = decode(encode(doc({ local: { apiKey: "weather-key", calendarUrls: ["https://x/y.ics"] } })));
    expect(back?.local.apiKey).toBe("weather-key");
    expect(back?.local.calendarUrls).toEqual(["https://x/y.ics"]);
  });

  it("returns null for a document from a future version rather than guessing", () => {
    expect(decode(encode({ ...doc(), v: 2 }))).toBeNull();
  });

  it("returns null for bytes that are not a document at all", () => {
    expect(decode(new TextEncoder().encode("not json"))).toBeNull();
    expect(decode(new TextEncoder().encode("null"))).toBeNull();
  });

  it("tolerates a document with no local state", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, updated: 3, device: "P", config: config() }));
    expect(decode(bytes)?.local).toEqual({});
  });
});

describe("decide", () => {
  const hashOf = (d: SyncDoc) => fingerprint(d);

  it("pushes when the relay holds nothing", () => {
    expect(decide("h", 5, null, null).action).toBe("push");
  });

  it("does nothing when both sides already match", () => {
    const remote = doc();
    expect(decide(hashOf(remote), 5, remote, null).action).toBe("idle");
  });

  // The rule that protects the account you were just invited into.
  it("takes the remote on a newly paired device, even though local is newer", () => {
    const remote = doc({ updated: 1 });
    const plan = decide("local-hash", 99999, remote, null);
    expect(plan.action).toBe("pull");
  });

  it("pushes when only this device changed", () => {
    const remote = doc();
    const agreed = { hash: hashOf(remote), updated: remote.updated };
    expect(decide("changed-here", 2000, remote, agreed).action).toBe("push");
  });

  it("pulls when only the other device changed", () => {
    const agreed = { hash: "what-we-agreed", updated: 900 };
    const remote = doc({ updated: 1500, device: "Phone" });
    const plan = decide(agreed.hash, 900, remote, agreed);
    expect(plan.action).toBe("pull");
    expect(plan.why).toContain("Phone");
  });

  it("gives it to the newer edit when both changed", () => {
    const agreed = { hash: "old", updated: 500 };
    const remote = doc({ updated: 1500 });
    expect(decide("mine", 1400, remote, agreed).action).toBe("pull");
    expect(decide("mine", 1600, remote, agreed).action).toBe("push");
  });

  // A device that syncs without editing must not look like an editor, or two
  // idle browsers push a document back and forth forever.
  it("stays idle when the other device merely re-published the same content", () => {
    const body = doc();
    const agreed = { hash: hashOf(body), updated: 100 };
    const republished = doc({ updated: 9999, device: "Phone" });
    expect(decide(hashOf(body), 100, republished, agreed).action).toBe("idle");
  });

  it("converges rather than fighting if the fingerprint scheme ever changes", () => {
    const remote = doc();
    const agreed = { hash: "a-hash-from-an-older-build", updated: 100 };
    expect(decide("a-hash-from-an-older-build", 100, remote, agreed).action).toBe("pull");
  });
});
