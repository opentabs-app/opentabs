/**
 * Every advanced-search field must have a control.
 *
 * `XQuery` gained `to`, `replies`, `links` and the three engagement
 * thresholds early, and the settings editor never grew controls for them. The
 * query engine handled them correctly the whole time, so nothing failed and
 * nothing warned — the editor just quietly looked like a subset of X's
 * advanced search, and the only way to reach those fields was to paste a URL.
 *
 * A missing field here is invisible by nature: there is no error, only an
 * absence. So it is checked rather than trusted.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..", "..", "..");
const rustSrc = readFileSync(resolve(root, "crates/tabs-core/src/xsearch/mod.rs"), "utf8");
const tsSrc = readFileSync(resolve(__dirname, "..", "src/settings/settings.ts"), "utf8");

/** The field names of `struct XQuery`. */
function queryFields(): string[] {
  const start = rustSrc.indexOf("pub struct XQuery {");
  const body = rustSrc.slice(start, rustSrc.indexOf("\n}", start));
  return [...body.matchAll(/^\s*pub (\w+):/gm)].map((m) => m[1]!);
}

/** The editor is everything between `function xEditor` and the next top-level fn. */
function editorSrc(): string {
  const start = tsSrc.indexOf("function xEditor");
  return tsSrc.slice(start, tsSrc.indexOf("\nfunction ", start + 20));
}

describe("the X editor mirrors X's advanced search", () => {
  const fields = queryFields();
  const editor = editorSrc();

  it("found the fields to check", () => {
    expect(fields.length).toBeGreaterThan(15);
    expect(fields).toContain("replies");
    expect(fields).toContain("min_likes");
  });

  it.each(queryFields())("has a control for %s", (field) => {
    expect(editor, `no control for query field "${field}"`).toContain(`"${field}"`);
  });

  it("offers every value the engine understands for a filter", () => {
    // `any` / `only` / `none` — a select missing one silently makes a whole
    // search mode unreachable.
    for (const v of ["any", "only", "none"]) {
      expect(editor).toContain(`["${v}"`);
    }
  });
});
