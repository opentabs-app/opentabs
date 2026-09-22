import { describe, expect, it } from "vitest";
import { CHROME_PICKER, EDGE_PROFILES, profilePickerUrl } from "./profiles";

// Read from real browsers on an extension page (userAgentData only exists in a
// secure context, so about:blank reports null): Edge 153 and Chromium 151.
const EDGE_BRANDS = [{ brand: "Microsoft Edge" }, { brand: "Not_A Brand" }, { brand: "Chromium" }];
const CHROMIUM_BRANDS = [{ brand: "Chromium" }, { brand: "Not=A?Brand" }];
const EDGE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

describe("profilePickerUrl", () => {
  it("sends Edge to its Profiles settings, not the picker it does not have (APP-122)", () => {
    expect(profilePickerUrl(EDGE_BRANDS, EDGE_UA)).toBe(EDGE_PROFILES);
  });

  it("keeps Chrome and Chromium on the profile picker", () => {
    expect(profilePickerUrl(CHROMIUM_BRANDS, CHROME_UA)).toBe(CHROME_PICKER);
    expect(profilePickerUrl([{ brand: "Google Chrome" }, ...CHROMIUM_BRANDS], CHROME_UA)).toBe(CHROME_PICKER);
  });

  it("falls back to the user agent when there is no brand list", () => {
    expect(profilePickerUrl(undefined, EDGE_UA)).toBe(EDGE_PROFILES);
    expect(profilePickerUrl(undefined, CHROME_UA)).toBe(CHROME_PICKER);
  });

  it("trusts the brand list over the user agent", () => {
    // A spoofed or reduced UA string must not flip a browser that names itself.
    expect(profilePickerUrl(CHROMIUM_BRANDS, EDGE_UA)).toBe(CHROME_PICKER);
  });
});
