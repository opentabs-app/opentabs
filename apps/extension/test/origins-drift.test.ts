/**
 * The origin tables in Rust and TypeScript must agree.
 *
 * They are duplicated on purpose: `chrome.permissions.request()` needs a live
 * user gesture, and a message round-trip to the worker to fetch the origins
 * spends it, so the settings page has to know them synchronously. The cost of
 * that decision is drift — and drift here is invisible, because a group with
 * a missing origin simply never loads.
 *
 * So the duplication is allowed and checked, rather than allowed and trusted.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..", "..", "..");
const rustSrc = readFileSync(resolve(root, "crates/tabs-core/src/config/mod.rs"), "utf8");
const tsSrc = readFileSync(resolve(__dirname, "..", "src/settings/settings.ts"), "utf8");
const constSrc = readFileSync(resolve(__dirname, "..", "src/lib/openapps.ts"), "utf8");

/**
 * The named match patterns from `lib/openapps.ts`.
 *
 * The TypeScript table refers to our own hostnames by name rather than by
 * literal, because they are defined once and a second copy is exactly the
 * drift this file exists to catch. Resolving them here keeps the comparison
 * against real values rather than against the word `SITE_MATCH`.
 */
function constants(): Record<string, string> {
  const out: Record<string, string> = {};
  // `export const SITE_ORIGIN = "https://opentabs.app";`
  for (const m of constSrc.matchAll(/export const (\w+) = "([^"]+)";/g)) {
    out[m[1]!] = m[2]!;
  }
  // `export const SITE_MATCH = `${SITE_ORIGIN}/*`;`
  for (const m of constSrc.matchAll(/export const (\w+) = `\$\{(\w+)\}([^`]*)`;/g)) {
    const base = out[m[2]!];
    if (base) out[m[1]!] = base + m[3]!;
  }
  return out;
}

/** Parse `fixed_origins`'s match arms out of the Rust source. */
function rustTable(): Record<string, string[]> {
  const body = rustSrc.slice(
    rustSrc.indexOf("pub fn fixed_origins"),
    rustSrc.indexOf("pub fn required_origins"),
  );
  const out: Record<string, string[]> = {};
  const arm = /"([a-z]+)"(?:\s*\|\s*"([a-z]+)")?\s*=>\s*&\[([^\]]*)\]/g;
  for (const m of body.matchAll(arm)) {
    const urls = [...m[3]!.matchAll(/"(https:[^"]+)"/g)].map((u) => u[1]!);
    if (urls.length === 0) continue;
    for (const def of [m[1], m[2]].filter(Boolean) as string[]) out[def] = urls.sort();
  }
  return out;
}

/** Parse the FIXED_ORIGINS literal out of the TypeScript source. */
function tsTable(): Record<string, string[]> {
  const start = tsSrc.indexOf("const FIXED_ORIGINS");
  const body = tsSrc.slice(start, tsSrc.indexOf("};", start));
  const named = constants();
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    const entries = m[2]!
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => {
        const literal = /^"(https:[^"]+)"$/.exec(e);
        return literal ? literal[1]! : (named[e] ?? "");
      })
      .filter((u) => u.startsWith("https:"));
    out[m[1]!] = entries.sort();
  }
  return out;
}

describe("fixed origin tables", () => {
  const rust = rustTable();
  const ts = tsTable();

  it("both tables parse (the test is worthless if they silently do not)", () => {
    expect(Object.keys(rust).length).toBeGreaterThan(4);
    expect(Object.keys(ts).length).toBeGreaterThan(4);
  });

  it("cover exactly the same group types", () => {
    expect(Object.keys(ts).sort()).toEqual(Object.keys(rust).sort());
  });

  it("list exactly the same origins for each", () => {
    for (const def of Object.keys(rust)) {
      expect(ts[def], `origins for "${def}" drifted`).toEqual(rust[def]);
    }
  });

  it("include the hosts the sources actually fetch", () => {
    // A spot check that both tables are right, not merely equal.
    expect(rust.crypto).toContain("https://api.binance.com/*");
    expect(rust.equities).toContain("https://query1.finance.yahoo.com/*");
    expect(rust.trending).toContain("https://github.com/*");
    expect(rust.weather).toContain("https://api.open-meteo.com/*");
  });
});
