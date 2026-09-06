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
import { existsSync, readFileSync, statSync } from "node:fs";
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

  it("the new tab page makes no network request", () => {
    const src = read("newtab.js");
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/XMLHttpRequest/);
  });

  it("the new tab bundle stays under 15 KB gzipped", () => {
    // Tightened from 30 KB, which was never going to fail: the bundle has sat
    // around 8 KB through every feature so far, so a cap at nearly four times
    // that could only catch a catastrophe. 15 KB still leaves room to grow and
    // would actually notice a library finding its way onto the paint path.
    const gz = gzipSync(readFileSync(resolve(dist, "newtab.js"))).length;
    expect(gz).toBeLessThan(15 * 1024);
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

  it("self-hosts its fonts, because MV3 blocks remote font loads", () => {
    expect(existsSync(resolve(dist, "fonts", "Geist-Regular.woff2"))).toBe(true);
    expect(read("assets/main.css")).not.toMatch(/https:\/\/fonts\.googleapis/);
  });
});

describe.runIf(built)("shipped size", () => {
  it("the whole extension stays small", () => {
    // "Light" is a stated property of this product, so it gets a number.
    //
    // Raised twice now, deliberately and not quietly. 120 → 140 KB covered
    // the focus checklist, per-host backoff, the bookmarks group and X's
    // filter controls; 140 → 170 KB covers the marketplace — a pane, a
    // publish dialog, a pack validator and a theme engine.
    //
    // What has *not* moved is the paint path, which is what "light" actually
    // means here and which carries its own, tighter cap. Marketplace code is
    // in the settings page and the worker; the new tab page gained only the
    // theme application, and the assertion below keeps that honest. This
    // number moving cannot hide the number that matters.
    const files = ["newtab.js", "settings.js", "background.js", "assets/main.css"];
    const total = files.reduce((n, f) => n + statSync(resolve(dist, f)).size, 0);
    expect(total).toBeLessThan(170 * 1024);
  });
});
