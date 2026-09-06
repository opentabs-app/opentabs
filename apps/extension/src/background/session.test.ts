/**
 * The two pure decisions in the sign-in path.
 *
 * The rest of `session.ts` is storage and network, which the e2e suite
 * exercises. These two are the ones where being wrong is silent: a bad
 * origin check accepts a session from a site that guessed the message shape,
 * and a bad expiry read either signs someone out constantly or hands the
 * server a token it will refuse.
 */
import { describe, expect, it } from "vitest";
import { expiryOf, fromSignInPage, installableUrl } from "./session";

/** A JWT with the given payload. Unsigned — nothing here verifies. */
function jwt(payload: unknown): string {
  const b64 = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64('{"alg":"EdDSA"}')}.${b64(JSON.stringify(payload))}.sig`;
}

describe("expiryOf", () => {
  it("reads the expiry a real token carries", () => {
    expect(expiryOf(jwt({ sub: "u_1", exp: 1_788_048_900 }))).toBe(1_788_048_900);
  });

  it("reads base64url, which is not base64", () => {
    // A payload whose base64 contains `-` and `_` where standard base64 has
    // `+` and `/`. Decoding it as plain base64 throws, and the catch would
    // silently report "expired" for a perfectly good token.
    const payload = { sub: "u_1", exp: 1_788_048_900, note: "??>>~~ÿ" };
    expect(expiryOf(jwt(payload))).toBe(1_788_048_900);
  });

  it("returns 0 for anything it cannot read, rather than throwing", () => {
    // 0 is in the past, so the caller refreshes or asks for a sign-in —
    // which is the right thing to do with a token we cannot understand.
    for (const t of ["", "a", "a.b", "a.!!!.c", jwt({ sub: "u_1" }), jwt("not an object")]) {
      expect(expiryOf(t), t).toBe(0);
    }
  });
});

describe("fromSignInPage", () => {
  it("accepts the platform's sign-in page", () => {
    expect(fromSignInPage("https://auth.opentabs.app/signin")).toBe(true);
    expect(fromSignInPage("https://auth.opentabs.app/signin?ref=CODE")).toBe(true);
  });

  it("refuses a host that merely starts the same way", () => {
    // The whole reason this is a parsed-origin comparison and not
    // `startsWith`. Every one of these is registrable by anyone.
    for (const url of [
      "https://auth.opentabs.app.evil.test/signin",
      "https://auth.opentabs.appevil.test/signin",
      "https://evil.test/https://auth.opentabs.app/signin",
      "http://auth.opentabs.app/signin",
      "https://opentabs.app/signin",
      "https://market.opentabs.app/signin",
    ]) {
      expect(fromSignInPage(url), url).toBe(false);
    }
  });

  it("refuses a sender with no URL at all", () => {
    // A message from another extension page has no `sender.url` we can
    // trust. It is not the sign-in page, so it does not get to hand us one.
    expect(fromSignInPage(undefined)).toBe(false);
    expect(fromSignInPage("")).toBe(false);
    expect(fromSignInPage("not a url")).toBe(false);
  });
});

describe("installableUrl", () => {
  it("accepts a pack address on the marketplace", () => {
    expect(installableUrl("https://market.opentabs.app/v1/packs/ai/install")).toBe(true);
  });

  it("refuses everywhere else", () => {
    // What comes back is applied to the reader's configuration. "Fetch
    // whatever the page asked for" is an invitation to install arbitrary
    // settings from anywhere — including from a redirect they never saw.
    for (const url of [
      "https://market.opentabs.app.evil.test/v1/packs/x/install",
      "https://evil.test/v1/packs/x/install",
      "http://market.opentabs.app/v1/packs/x/install",
      "https://opentabs.app/v1/packs/x/install",
      "https://auth.opentabs.app/v1/packs/x/install",
      "data:application/json,{}",
      "",
      "not a url",
    ]) {
      expect(installableUrl(url), url).toBe(false);
    }
  });
});
