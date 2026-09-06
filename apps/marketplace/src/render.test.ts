import { describe, expect, it } from "vitest";
import { compact, relTime, safeMedia } from "./render";

describe("safeMedia — what may reach a src attribute", () => {
  it("accepts https and nothing else", () => {
    expect(safeMedia("https://cdn.test/a.png")).toBe("https://cdn.test/a.png");
    // A `javascript:` or `data:` URL in a src is script execution, and the
    // strings being rendered here were typed by strangers.
    for (const u of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://cdn.test/a.png",
      "//cdn.test/a.png",
      "not a url",
      "",
      null,
      undefined,
    ]) {
      expect(safeMedia(u), String(u)).toBeNull();
    }
  });
});

describe("compact", () => {
  it("stops spelling out numbers once they stop being worth reading", () => {
    expect(compact(0)).toBe("0");
    expect(compact(999)).toBe("999");
    expect(compact(1_200)).toBe("1.2k");
    expect(compact(12_000)).toBe("12k");
    expect(compact(1_500_000)).toBe("1.5M");
  });
});

describe("relTime", () => {
  const now = 1_788_048_000;
  it("counts up through the units", () => {
    expect(relTime(now - 90, now)).toBe("2m ago");
    expect(relTime(now - 7200, now)).toBe("2h ago");
    expect(relTime(now - 3 * 86_400, now)).toBe("3d ago");
  });

  it("never reports the future as a long time ago", () => {
    // Clock skew between a publisher and a reader is ordinary.
    expect(relTime(now + 600, now)).toBe("1m ago");
  });

  it("falls back to a date once relative time stops meaning anything", () => {
    expect(relTime(now - 200 * 86_400, now)).toMatch(/\d{4}/);
  });
});
