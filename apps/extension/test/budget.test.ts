/**
 * The non-negotiables, asserted against the built output.
 *
 * These are the budgets the whole architecture exists to hold. They are
 * checked here rather than left to review because the failure they prevent
 * is silent: an innocuous-looking import in the new tab page drags wasm or a
 * network call onto the paint path, and nothing visibly breaks — the page
 * just gets slower every release until someone notices.
 *
 * Run against `dist/`, so `npm run build` must precede `npm test` in CI.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dist = resolve(__dirname, "..", "dist");
const read = (f: string) => readFileSync(resolve(dist, f), "utf8");
const built = existsSync(resolve(dist, "newtab.js"));

describe.runIf(built)("paint-path budgets", () => {
  it("the new tab page ships no wasm", () => {
    // The single most important line in this file. wasm belongs in the
    // service worker, where latency is invisible.
    expect(read("newtab.js")).not.toMatch(/wasm/i);
  });

  /**
   * The extension carries no analytics, and this is what holds it to that.
   *
   * The marketing site has a Google tag; these pages must never get one. The
   * manifest's CSP is `script-src 'self' 'wasm-unsafe-eval'`, so gtag could
   * not load even if someone pasted it — which makes it exactly the kind of
   * mistake that ships: no error, no failed request, nothing in review, and a
   * promise on the privacy page quietly no longer true.
   *
   * Checked over the built output rather than the source, because a
   * dependency could bring one in without anyone typing it here.
   */
  it("ships no analytics of any kind", () => {
    for (const file of ["newtab.js", "settings.js", "background.js", "newtab.html", "settings.html"]) {
      const body = read(file);
      expect(body).not.toMatch(/googletagmanager|google-analytics|gtag\(/);
      expect(body).not.toMatch(/\bG-[A-Z0-9]{10}\b/);
    }
  });

  it("the new tab page makes no network request", () => {
    const src = read("newtab.js");
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/XMLHttpRequest/);
  });

  /**
   * The claim on the website is about the *page*, not about one file.
   *
   * `newtab.js` alone was 10.9 KB gzipped while the README, the site and its
   * structured data all said "4 KB gzipped" — a figure that had been true of
   * something once and was off by five times by the time anyone checked. The
   * page also pulls its markup, its stylesheet and two shared chunks, and a
   * reader counting bytes counts all of them.
   *
   * So the cap is on everything the new tab loads, and the number in the
   * documentation is this number.
   */
  it("everything the new tab loads stays under 25 KB gzipped", () => {
    const files = [
      resolve(dist, "newtab.html"),
      resolve(dist, "newtab.js"),
      ...readdirSync(resolve(dist, "assets"))
        .filter((f) => f === "main.css")
        .map((f) => resolve(dist, "assets", f)),
      ...readdirSync(resolve(dist, "chunks")).map((f) => resolve(dist, "chunks", f)),
    ];
    const total = files.reduce((n, f) => n + gzipSync(readFileSync(f)).length, 0);
    // 19.3 KB today. The cap is close enough to notice a library arriving and
    // far enough not to fail on a paragraph of copy.
    expect(total, `paint path is ${(total / 1024).toFixed(1)} KB gzipped`).toBeLessThan(25 * 1024);
  });

  it("the new tab bundle stays under 15 KB gzipped", () => {
    // Tightened from 30 KB, which was never going to fail: the bundle has sat
    // around 8 KB through every feature so far, so a cap at nearly four times
    // that could only catch a catastrophe. 15 KB still leaves room to grow and
    // would actually notice a library finding its way onto the paint path.
    const gz = gzipSync(readFileSync(resolve(dist, "newtab.js"))).length;
    expect(gz).toBeLessThan(15 * 1024);
  });

  /**
   * The wasm is worker-only, so it is not on the paint path and its size is
   * not felt when a tab opens. It is still 220 KB over the wire on install
   * and on every update, and it grew 130 KB the day the Public Suffix List
   * went in — a deliberate trade for grouping every site on the web rather
   * than 145 hand-picked ones, and one worth being able to see happen again.
   */
  it("the wasm stays around its known size", () => {
    const gz = gzipSync(readFileSync(resolve(dist, "assets", "tabs_core_bg.wasm"))).length;
    expect(gz, `wasm is ${(gz / 1024).toFixed(0)} KB gzipped`).toBeLessThan(280 * 1024);
  });

  it("the service worker is where wasm actually lives", () => {
    // The inverse assertion: if this fails, the wasm was dropped entirely
    // and every parser silently became a no-op.
    expect(read("background.js")).toMatch(/wasm/i);
  });
});

describe.runIf(built)("manifest", () => {
  const manifest = () => JSON.parse(read("manifest.json"));

  it("does not request <all_urls> at install time", () => {
    // D6: the difference between a plausible store review and a hard one.
    const hosts: string[] = manifest().host_permissions ?? [];
    expect(hosts).not.toContain("<all_urls>");
    expect(hosts.some((h) => h === "https://*/*")).toBe(false);
  });

  it("keeps site access optional and asks per site", () => {
    expect(manifest().optional_host_permissions).toContain("https://*/*");
  });

  it("asks for only the permissions it needs, and no host access", () => {
    // `scripting` and `idle` exist for the opt-in X reader: one to read a
    // rendered page, one to avoid doing so on an unattended machine. Neither
    // grants site access on its own — that stays optional and per-site.
    expect(manifest().permissions.sort()).toEqual([
      "alarms", "idle", "scripting", "storage", "tabs",
    ]);
  });

  it("makes notifications optional, requested at first reminder", () => {
    expect(manifest().optional_permissions).toContain("notifications");
  });

  it("declares wasm-unsafe-eval, without which every parser is dead", () => {
    // MV3's default CSP blocks WebAssembly.instantiate outright. This is a
    // required field, not a nicety.
    expect(manifest().content_security_policy.extension_pages).toMatch(/wasm-unsafe-eval/);
  });

  it("overrides the new tab page", () => {
    expect(manifest().chrome_url_overrides.newtab).toBe("newtab.html");
  });

  it("points at files that exist", () => {
    const m = manifest();
    for (const f of [m.chrome_url_overrides.newtab, m.background.service_worker, m.options_page]) {
      expect(existsSync(resolve(dist, f)), `${f} missing from dist`).toBe(true);
    }
    for (const size of ["16", "48", "128"]) {
      expect(existsSync(resolve(dist, m.icons[size]))).toBe(true);
    }
  });

  /**
   * Firefox's floor is 128, and it is not the same number as Chrome's.
   *
   * `minimum_chrome_version` is 121 because that is where `tabs.lastAccessed`
   * arrives. Firefox's floor is 128 for an unrelated reason:
   * `optional_host_permissions` landed there, and that key is how every "may
   * I use this site?" prompt in this extension works. On 121–127 the
   * extension installs, runs, and simply never obtains a host permission —
   * the permission model failing silently, which is the worst way for it to
   * fail. `web-ext lint` is what found it.
   *
   * `data_collection_permissions` is declared even though it needs 140:
   * AMO requires it for new extensions, older Firefox ignores unknown keys
   * under `gecko`, and raising the floor to 140 to silence a lint warning
   * would drop twelve versions of users for no functional reason. The two
   * remaining warnings are advisory and stay.
   */
  it("declares a Firefox floor that can actually run the permission model", () => {
    // The source manifest, not dist-firefox/. The floor is a property of the
    // file the build copies verbatim, and reading the built copy made this
    // depend on the Firefox build having run first — which CI's extension job
    // does *after* `npm test`. It passed locally on a stale dist-firefox and
    // failed on the first clean checkout.
    const gecko = JSON.parse(
      readFileSync(resolve(__dirname, "..", "public", "manifest.firefox.json"), "utf8"),
    ).browser_specific_settings.gecko;
    expect(Number(gecko.strict_min_version.split(".")[0])).toBeGreaterThanOrEqual(128);
    expect(gecko.data_collection_permissions).toEqual({ required: ["none"] });
  });

  it("self-hosts its fonts, because MV3 blocks remote font loads", () => {
    expect(existsSync(resolve(dist, "fonts", "Geist-Regular.woff2"))).toBe(true);
    expect(read("assets/main.css")).not.toMatch(/https:\/\/fonts\.googleapis/);
  });
});

describe.runIf(built)("shipped size", () => {
  it("the whole extension stays small", () => {
    // "Light" is a stated property of this product, so it gets a number.
    //
    // Raised four times now, deliberately and not quietly. 120 → 140 KB
    // covered the focus checklist, per-host backoff, the bookmarks group and
    // X's filter controls; 140 → 170 KB covered the marketplace — a pane, a
    // publish dialog, a pack validator and a theme engine; 170 → 240 KB
    // covers OpenSync, which is a whole encryption engine's worth of glue.
    //
    // 240 → 260 KB on 2026-09-25: the engine's client gained a NIP-46 signer,
    // which brings `nostr-tools` with it. That is 7 KB in the worker and it
    // arrived with the vendored copy rather than with anything written here.
    // The barrel that also re-exports the engine's account module is
    // deliberately not imported (see src/background/sync.ts), which keeps the
    // rest of that package out.
    //
    // The engine's own wasm is not in this number and should not be: it is a
    // separate asset the worker loads off disk, it is not parsed unless sync
    // is switched on, and counting it here would make this cap a proxy for
    // "how big is wasm" rather than "how much JavaScript runs".
    //
    // What has *not* moved is the paint path, which is what "light" actually
    // means here and which carries its own, tighter cap. Sync is entirely in
    // the settings page and the worker; `newtab.js` did not gain a byte, and
    // the wasm assertion above keeps that honest. This number moving cannot
    // hide the number that matters.
    const files = ["newtab.js", "settings.js", "background.js", "assets/main.css"];
    const total = files.reduce((n, f) => n + statSync(resolve(dist, f)).size, 0);
    expect(total).toBeLessThan(260 * 1024);
  });
});
