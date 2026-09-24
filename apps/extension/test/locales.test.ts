/**
 * The store name and description, in every language we ship.
 *
 * These two strings are the whole listing headline: they are what a shopper
 * reads in the Chrome, Edge and Firefox stores, and they are what the browser
 * shows beside the extension afterwards. A store rejects an overlong one and
 * a missing locale silently falls back to English, so both are worth a test
 * rather than a proofread.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = resolve(root, "public/_locales");
const locales = readdirSync(localesDir).filter((d) => !d.startsWith("."));
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const messages = (locale: string) => read(resolve(localesDir, locale, "messages.json"));

// Chrome Web Store: the name is cut off past 75 characters and the short
// description is rejected past 132. Firefox and Edge are looser, and one
// shared file has to satisfy the strictest of them.
const NAME_MAX = 75;
const DESCRIPTION_MAX = 132;

describe("store locales", () => {
  it("ships more than just English", () => {
    expect(locales).toContain("en");
    expect(locales.length).toBeGreaterThan(1);
  });

  it.each(locales)("%s has a name and description within the store's limits", (locale) => {
    const m = messages(locale);
    expect(Object.keys(m).sort()).toEqual(["description", "name"]);
    for (const key of ["name", "description"] as const) {
      const text: unknown = m[key].message;
      expect(typeof text).toBe("string");
      expect((text as string).trim()).not.toBe("");
      // A placeholder left in a translation ships to the store as-is.
      expect(text as string).not.toMatch(/__MSG_|\{\{|TODO/);
    }
    expect(m.name.message.length).toBeLessThanOrEqual(NAME_MAX);
    expect(m.description.message.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  it.each(["manifest.json", "manifest.firefox.json"])(
    "%s asks for the translated strings, and names a locale that exists",
    (file) => {
      const manifest = read(resolve(root, "public", file));
      expect(manifest.name).toBe("__MSG_name__");
      expect(manifest.description).toBe("__MSG_description__");
      // Without this the browser cannot resolve either placeholder and
      // refuses to load the extension at all.
      expect(locales).toContain(manifest.default_locale);
    },
  );

  /**
   * The listing copy is written per locale by hand, and a locale with no file
   * is one the store gets in English while the extension beside it is
   * translated — the mismatch this catches.
   */
  it("has listing copy for every locale, and no orphans", () => {
    const listingDir = resolve(root, "../../docs/store-listing");
    const files = readdirSync(listingDir)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => f.replace(/\.txt$/, ""));
    expect(files.sort()).toEqual([...locales].sort());
  });

  /**
   * Vite copies `public/` wholesale, which is how `_locales` reaches a build —
   * so this is a check that the copy still happens, not that the files exist.
   */
  describe.runIf(existsSync(resolve(root, "dist/manifest.json")))("the built extension", () => {
    it.each(["dist", "dist-firefox"])("%s ships every locale", (out) => {
      if (!existsSync(resolve(root, out, "manifest.json"))) return;
      for (const locale of locales) {
        const built = resolve(root, out, "_locales", locale, "messages.json");
        expect(existsSync(built), `${out}/_locales/${locale}`).toBe(true);
        expect(read(built)).toEqual(messages(locale));
      }
    });
  });
});
