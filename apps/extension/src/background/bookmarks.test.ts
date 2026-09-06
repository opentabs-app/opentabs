import { describe, expect, it } from "vitest";
import { capUndo } from "./sources";

const at = (n: number) => ({ title: "t", parentId: "1", index: 0, at: n });

describe("capUndo — an undo buffer, not a history", () => {
  it("leaves a small store alone", () => {
    const s = { a: at(1), b: at(2) };
    expect(capUndo(s, 5)).toBe(s);
  });

  it("drops the oldest first", () => {
    // The link you just unbookmarked is the one you are most likely to want
    // back, so recency is what survives.
    const s = { old: at(1), mid: at(2), fresh: at(3) };
    expect(Object.keys(capUndo(s, 2)).sort()).toEqual(["fresh", "mid"]);
  });

  it("keeps exactly the cap, never more", () => {
    const s = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`u${i}`, at(i)]));
    expect(Object.keys(capUndo(s, 50))).toHaveLength(50);
    // And keeps the newest of them.
    expect(capUndo(s, 50)["u79"]).toBeDefined();
    expect(capUndo(s, 50)["u0"]).toBeUndefined();
  });
});
