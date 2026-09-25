import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appKey, arrangeApps, BUNDLED_APPS, normaliseUrl } from "./apps";

const catalogue = [
  { id: "opensubs", name: "OpenSubs", url: "https://opensubs.app/" },
  { id: "opencapture", name: "OpenCapture", url: "https://opencapture.app/" },
  { id: "openpixels", name: "OpenPixels", url: "https://openpixels.app/" },
];

describe("what ships in the Web Apps group", () => {
  /** The point of the change: no vendor's products, ours included. Whoever
   *  installs this gets an empty group and fills it themselves. */
  it("ships no apps at all", () => {
    expect(BUNDLED_APPS).toEqual([]);
  });

  it("is still a list the layering can build on", () => {
    const mine = [{ name: "Excalidraw", url: "https://excalidraw.com/" }];
    expect(arrangeApps(BUNDLED_APPS, { custom: mine })).toEqual(mine);
    expect(arrangeApps(BUNDLED_APPS, {})).toEqual([]);
  });
});

describe("arrangeApps", () => {
  it("shows the whole catalogue when nothing has been changed", () => {
    expect(arrangeApps(catalogue, {}).map((a) => a.name)).toEqual(["OpenSubs", "OpenCapture", "OpenPixels"]);
  });

  it("drops the ones that were removed", () => {
    expect(arrangeApps(catalogue, { hidden: ["opencapture"] }).map((a) => a.name)).toEqual(["OpenSubs", "OpenPixels"]);
  });

  it("appends the ones someone added", () => {
    const out = arrangeApps(catalogue, { custom: [{ name: "Excalidraw", url: "https://excalidraw.com/" }] });
    expect(out.at(-1)).toMatchObject({ name: "Excalidraw" });
    expect(out).toHaveLength(4);
  });

  /** The reason this stores differences rather than a copy of the list. */
  it("still shows a product the catalogue gained after the reader customised it", () => {
    const opts = { hidden: ["opencapture"], custom: [{ name: "Mine", url: "https://mine.test/" }] };
    const grown = [...catalogue, { id: "opennew", name: "OpenNew", url: "https://opennew.test/" }];
    expect(arrangeApps(grown, opts).map((a) => a.name)).toContain("OpenNew");
  });

  it("lets a custom entry rename a listed one instead of duplicating it", () => {
    const out = arrangeApps(catalogue, { custom: [{ id: "opensubs", name: "Subtitles", url: "https://opensubs.app/" }] });
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ name: "Subtitles" });
  });

  it("ignores half-typed rows rather than rendering a nameless link", () => {
    expect(arrangeApps(catalogue, { custom: [{ name: "", url: "https://x.test/" }, { name: "No URL", url: "" }] })).toHaveLength(3);
  });

  it("survives options written by an older build", () => {
    expect(arrangeApps(catalogue, { hidden: "nonsense", custom: 42 })).toHaveLength(3);
  });

  it("keys a catalogue app by id and a typed one by its address", () => {
    expect(appKey({ id: "x", url: "https://x.test/" })).toBe("x");
    expect(appKey({ url: "https://y.test/" })).toBe("https://y.test/");
  });
});

describe("normaliseUrl", () => {
  /** A scheme-less href resolves against the extension's own origin, which
   *  opens a blank page inside the extension rather than the site. */
  it("adds the scheme people leave off", () => {
    expect(normaliseUrl("excalidraw.com")).toBe("https://excalidraw.com");
    expect(normaliseUrl(" figma.com/file ")).toBe("https://figma.com/file");
  });

  it("leaves a full address alone", () => {
    expect(normaliseUrl("http://intranet.local/")).toBe("http://intranet.local/");
    expect(normaliseUrl("https://x.test/")).toBe("https://x.test/");
  });

  it("gives nothing back for nothing", () => {
    expect(normaliseUrl("   ")).toBe("");
  });
});

/**
 * The same list exists twice: here, and in the Rust that generates the served
 * `apps.json`. That is not duplication for its own sake — the served file is
 * the release valve, and the bundled copy is what renders when it is
 * unreachable — but two copies drift, and these two already had. The served
 * file was still advertising an entry that answered 404 long after the
 * generator dropped it.
 */
describe("the bundled list and the served one", () => {
  const rust = readFileSync(
    resolve(__dirname, "..", "..", "..", "..", "crates", "tabs-feedgen", "src", "main.rs"),
    "utf8",
  );
  const catalogue = rust.slice(rust.indexOf('"apps": ['), rust.indexOf("]", rust.indexOf('"apps": [')));
  const ids = [...catalogue.matchAll(/"id":\s*"([a-z]+)"/g)].map((m) => m[1]);
  const urls = [...catalogue.matchAll(/"url":\s*"([^"]+)"/g)].map((m) => m[1]);

  it("names the same products", () => {
    expect(ids).toEqual(BUNDLED_APPS.map((a) => a.id));
  });

  it("points them at the same addresses", () => {
    expect(urls).toEqual(BUNDLED_APPS.map((a) => a.url));
  });
});
