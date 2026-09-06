import { describe, expect, it } from "vitest";
import { applyTheme, baseClass, safeColor, safeFont, THEME_VARS } from "./theme";

/** A stand-in for `document.documentElement` — the tests run without a DOM. */
function root() {
  const props = new Map<string, string>();
  return {
    props,
    style: {
      setProperty: (k: string, v: string) => void props.set(k, v),
      removeProperty: (k: string) => void props.delete(k),
    },
  } as unknown as HTMLElement & { props: Map<string, string> };
}

describe("safeColor — what may reach a stylesheet", () => {
  it("accepts the notations a theme needs", () => {
    for (const c of ["#fff", "#a1b2c3", "#a1b2c3ff", "rgb(1,2,3)", "rgba(1,2,3,.5)", "hsl(200 50% 40%)", "red"]) {
      expect(safeColor(c), c).toBe(true);
    }
  });

  it("refuses anything that could leave the declaration", () => {
    // A custom property whose value is attacker-controlled is a stylesheet
    // injection, and `url()` alone is a request that reports who is reading.
    for (const c of [
      "url(https://t.test/p.gif)",
      "red; background: url(https://t.test/x)",
      "#fff}body{display:none",
      "var(--x)",
      "expression(alert(1))",
      "",
    ]) {
      expect(safeColor(c), c).toBe(false);
    }
  });
});

describe("safeFont", () => {
  it("accepts a stack of names", () => {
    expect(safeFont("Inter, Helvetica Neue, sans-serif")).toBe(true);
  });

  it("refuses anything that could fetch", () => {
    for (const f of ["url(https://e.test/f.woff2)", "@import url(x)", "Inter; } body {", "local(F)"]) {
      expect(safeFont(f), f).toBe(false);
    }
  });
});

describe("applyTheme", () => {
  it("sets only the properties the stylesheet reads", () => {
    const r = root();
    applyTheme({ base: "dark", colors: { bg: "#101010", "--text-strong": "#fff", display: "none" } }, r);
    expect(r.props.get("--bg")).toBe("#101010");
    expect(r.props.get("--text-strong")).toBe("#fff");
    expect(r.props.has("--display")).toBe(false);
  });

  it("drops a value that would not survive validation, keeping the rest", () => {
    // Re-checked here because this runs on data a pack wrote, possibly under
    // an older build's rules.
    const r = root();
    applyTheme({ base: "dark", colors: { bg: "#101010", "border-focus": "url(https://t.test/x)" } }, r);
    expect(r.props.get("--bg")).toBe("#101010");
    expect(r.props.has("--border-focus")).toBe(false);
  });

  it("clears the previous theme before applying a new one", () => {
    // Otherwise a theme that sets two colours leaves eight behind from the
    // one that set ten, which reads as a rendering bug rather than a choice.
    const r = root();
    const everything = Object.fromEntries(
      // The two scalar properties take a length, not a colour.
      THEME_VARS.map((v) => [v, v === "card-radius" ? "14px" : v === "font-scale" ? "1.1" : "#111"]),
    );
    applyTheme({ base: "dark", colors: everything }, r);
    expect(r.props.size).toBe(THEME_VARS.length);
    applyTheme({ base: "light", colors: { bg: "#fff" } }, r);
    expect(r.props.size).toBe(1);
    expect(r.props.get("--bg")).toBe("#fff");
  });

  it("removes everything when there is no theme", () => {
    const r = root();
    applyTheme({ base: "dark", colors: { bg: "#111" }, font: "Inter" }, r);
    applyTheme(null, r);
    expect(r.props.size).toBe(0);
  });

  it("sets the fonts, and only safe ones", () => {
    const r = root();
    applyTheme({ base: "auto", colors: {}, font: "Inter, sans-serif", mono: "url(evil)" }, r);
    expect(r.props.get("--font")).toBe("Inter, sans-serif");
    expect(r.props.has("--mono")).toBe(false);
  });

  it("validates the two scalar properties as numbers rather than colours", () => {
    const r = root();
    applyTheme({ base: "auto", colors: { "card-radius": "14px", "font-scale": "red" } }, r);
    expect(r.props.get("--card-radius")).toBe("14px");
    expect(r.props.has("--font-scale")).toBe(false);
  });
});

describe("baseClass", () => {
  it("maps to the classes the stylesheet already understands", () => {
    expect(baseClass("dark")).toBe("oa-dark");
    expect(baseClass("light")).toBe("oa-light");
    expect(baseClass(undefined)).toBe("oa-auto");
    expect(baseClass("neon")).toBe("oa-auto");
  });
});
