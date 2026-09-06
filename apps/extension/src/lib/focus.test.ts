import { describe, expect, it } from "vitest";
import type { FocusItem, LocalState } from "./types";
import {
  childrenOf, clearsIn, focusItems, moveTask, progressOf, removeItem, setCollapsed, setDone,
  sweepFocus, topLevel, visibleFocus,
} from "./focus";

const NOW = 1_788_048_000;
const H = 3600;
const item = (over: Partial<FocusItem> = {}): FocusItem => ({
  id: "a",
  text: "ship the thing",
  done: false,
  created: NOW - 8 * H,
  ...over,
});

describe("focusItems — the old single line is not thrown away", () => {
  it("turns a legacy note into the first item", () => {
    const local = { focus: { text: "close the round", date: "2026-08-30" } } as LocalState;
    const got = focusItems(local);
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe("close the round");
    expect(got[0]!.done).toBe(false);
  });

  it("ignores a legacy note once a list exists", () => {
    const local = {
      focus: { text: "old", date: "2026-08-30" },
      focusItems: [item({ text: "new" })],
    } as LocalState;
    expect(focusItems(local).map((i) => i.text)).toEqual(["new"]);
  });

  it("treats an empty list as a list, not as absent", () => {
    const local = { focus: { text: "old", date: "x" }, focusItems: [] } as LocalState;
    expect(focusItems(local)).toEqual([]);
  });

  it("returns nothing when there is nothing", () => {
    expect(focusItems({} as LocalState)).toEqual([]);
    expect(focusItems({ focus: { text: "   ", date: "x" } } as LocalState)).toEqual([]);
  });
});

describe("ticking starts a clock", () => {
  it("stamps the moment it was ticked", () => {
    const [t] = setDone([item()], "a", true, NOW);
    expect(t!.done).toBe(true);
    expect(t!.doneAt).toBe(NOW);
  });

  it("unticking gives back a full window, not a partly spent one", () => {
    const ticked = setDone([item()], "a", true, NOW);
    const [back] = setDone(ticked, "a", false, NOW + H);
    expect(back!.done).toBe(false);
    expect(back!.doneAt).toBeUndefined();
    const [again] = setDone([back!], "a", true, NOW + 2 * H);
    expect(clearsIn(again!, NOW + 2 * H, 6)).toBe(6 * H);
  });

  it("leaves other items alone", () => {
    const list = [item(), item({ id: "b" })];
    expect(setDone(list, "a", true, NOW)[1]!.done).toBe(false);
  });
});

describe("visibleFocus — six hours of strikethrough, then gone", () => {
  it("keeps an open item forever", () => {
    expect(visibleFocus([item()], NOW + 900 * H, 6)).toHaveLength(1);
  });

  it("keeps a ticked item inside the window, so you can see what you finished", () => {
    const list = [item({ done: true, doneAt: NOW })];
    expect(visibleFocus(list, NOW + 5 * H, 6)).toHaveLength(1);
    expect(visibleFocus(list, NOW + 5 * H + 3599, 6)).toHaveLength(1);
  });

  it("drops it once the window is up", () => {
    const list = [item({ done: true, doneAt: NOW })];
    expect(visibleFocus(list, NOW + 6 * H, 6)).toHaveLength(0);
    expect(visibleFocus(list, NOW + 7 * H, 6)).toHaveLength(0);
  });

  it("clears on tick when the window is zero", () => {
    expect(visibleFocus([item({ done: true, doneAt: NOW })], NOW, 0)).toHaveLength(0);
  });

  it("does not depend on the sweep having run", () => {
    // The reader's view must be right even if the worker has been asleep for
    // a day — hiding is the page's job, deleting is only housekeeping.
    const stale = [item({ done: true, doneAt: NOW - 48 * H })];
    expect(visibleFocus(stale, NOW, 6)).toEqual([]);
  });
});

describe("sweepFocus — housekeeping, and never a silent deletion", () => {
  it("removes what has aged out and says it changed", () => {
    const list = [item({ id: "a", done: true, doneAt: NOW - 7 * H }), item({ id: "b" })];
    const { items, changed } = sweepFocus(list, NOW, 6);
    expect(items.map((i) => i.id)).toEqual(["b"]);
    expect(changed).toBe(true);
  });

  it("reports no change when there is nothing to do, so nothing is written", () => {
    const { changed } = sweepFocus([item(), item({ id: "b" })], NOW, 6);
    expect(changed).toBe(false);
  });

  it("gives a ticked item from an older build a stamp instead of deleting it", () => {
    // No doneAt means it was ticked before the field existed. Treating that
    // as "ticked at the epoch" would erase it the first time the sweep ran.
    const { items, changed } = sweepFocus([item({ done: true })], NOW, 6);
    expect(items).toHaveLength(1);
    expect(items[0]!.doneAt).toBe(NOW);
    expect(changed).toBe(true);
  });

  it("does not mutate the list it was given", () => {
    const list = [item({ done: true })];
    sweepFocus(list, NOW, 6);
    expect(list[0]!.doneAt).toBeUndefined();
  });
});

describe("clearsIn — what the row shows", () => {
  it("is null for anything not ticked", () => {
    expect(clearsIn(item(), NOW, 6)).toBeNull();
  });

  it("counts down", () => {
    const t = item({ done: true, doneAt: NOW });
    expect(clearsIn(t, NOW, 6)).toBe(6 * H);
    expect(clearsIn(t, NOW + 2 * H, 6)).toBe(4 * H);
  });
});

describe("steps under a task", () => {
  const task = item({ id: "t", text: "ship release", created: NOW - 9 * H });
  const kids = [
    item({ id: "s1", text: "write notes", parent: "t", created: NOW - 8 * H }),
    item({ id: "s2", text: "tag it", parent: "t", created: NOW - 7 * H }),
  ];
  const list = [task, ...kids];

  it("separates tasks from steps", () => {
    expect(topLevel(list).map((i) => i.id)).toEqual(["t"]);
    expect(childrenOf(list, "t").map((i) => i.id)).toEqual(["s1", "s2"]);
  });

  it("orders steps as they were written, not by anything clever", () => {
    const shuffled = [kids[1]!, task, kids[0]!];
    expect(childrenOf(shuffled, "t").map((i) => i.id)).toEqual(["s1", "s2"]);
  });

  it("counts progress for the row label", () => {
    expect(progressOf(list, "t")).toEqual({ done: 0, total: 2 });
    expect(progressOf(setDone(list, "s1", true, NOW), "t")).toEqual({ done: 1, total: 2 });
    expect(progressOf(list, "s1")).toEqual({ done: 0, total: 0 });
  });

  it("ticking a task ticks the steps still open under it", () => {
    // Saying the whole thing is done and leaving its parts open contradicts
    // itself.
    const after = setDone(list, "t", true, NOW);
    expect(after.every((i) => i.done)).toBe(true);
    expect(after.find((i) => i.id === "s1")!.doneAt).toBe(NOW);
  });

  it("unticking a task does not reopen steps that were ticked one by one", () => {
    // Undoing one click must not undo five.
    let after = setDone(list, "s1", true, NOW);
    after = setDone(after, "t", true, NOW);
    after = setDone(after, "t", false, NOW + 60);
    expect(after.find((i) => i.id === "t")!.done).toBe(false);
    expect(after.find((i) => i.id === "s1")!.done).toBe(true);
    expect(after.find((i) => i.id === "s2")!.done).toBe(true);
  });

  it("ticking a step leaves its task alone", () => {
    const after = setDone(list, "s1", true, NOW);
    expect(after.find((i) => i.id === "t")!.done).toBe(false);
  });

  it("removes a task with its steps, never leaving them behind", () => {
    expect(removeItem(list, "t")).toEqual([]);
  });

  it("removes a single step without touching the task", () => {
    expect(removeItem(list, "s1").map((i) => i.id)).toEqual(["t", "s2"]);
  });
});

describe("steps and the clearing window", () => {
  const task = item({ id: "t", created: NOW - 9 * H });
  const kid = item({ id: "s", parent: "t", created: NOW - 8 * H });

  it("takes the steps with the task when the task clears", () => {
    // A step outlives its task for nobody.
    const list = [{ ...task, done: true, doneAt: NOW - 7 * H }, kid];
    expect(visibleFocus(list, NOW, 6)).toEqual([]);
  });

  it("never clears a step on a clock of its own", () => {
    // Ticking off three steps of a five-step task and watching the first
    // three vanish one by one leaves a task that looks like it never had
    // them. A step is cleared by its task, or not at all.
    const list = [task, { ...kid, done: true, doneAt: NOW - 400 * H }];
    expect(visibleFocus(list, NOW, 6).map((i) => i.id)).toEqual(["t", "s"]);
  });

  it("promises no countdown on a step, because it would not keep it", () => {
    expect(clearsIn({ ...kid, done: true, doneAt: NOW }, NOW, 6)).toBeNull();
    // A task still counts down.
    expect(clearsIn({ ...task, done: true, doneAt: NOW }, NOW, 6)).toBe(6 * H);
  });

  it("shows an orphaned step rather than swallowing it", () => {
    // Its task is gone — edited by hand, or written by an older build.
    // Silently hiding someone's note because a field will not resolve is the
    // worse failure.
    expect(visibleFocus([{ ...kid, parent: "missing" }], NOW, 6)).toHaveLength(1);
  });
});

describe("moving a task", () => {
  const t = (id: string, created: number, order?: number) =>
    item({ id, text: id, created, ...(order === undefined ? {} : { order }) });
  const list = [t("a", 1), t("b", 2), t("c", 3)];
  const ids = (xs: FocusItem[]) => topLevel(xs).map((i) => i.id);

  it("reads in the order it was written until someone says otherwise", () => {
    expect(ids(list)).toEqual(["a", "b", "c"]);
    // Even when storage happens to hold them shuffled.
    expect(ids([list[2]!, list[0]!, list[1]!])).toEqual(["a", "b", "c"]);
  });

  it("moves a task before another", () => {
    expect(ids(moveTask(list, "c", "a"))).toEqual(["c", "a", "b"]);
    expect(ids(moveTask(list, "a", "c"))).toEqual(["b", "a", "c"]);
  });

  it("moves a task to the end when there is nothing to sit before", () => {
    expect(ids(moveTask(list, "a", null))).toEqual(["b", "c", "a"]);
  });

  it("does nothing when a task is dropped on itself", () => {
    expect(moveTask(list, "b", "b")).toBe(list);
  });

  it("does nothing when either end of the move is unknown", () => {
    expect(moveTask(list, "nope", "a")).toBe(list);
    expect(moveTask(list, "a", "nope")).toBe(list);
  });

  it("keeps steps with their task rather than reordering them", () => {
    const withKids = [...list, item({ id: "s", parent: "b", created: 9 })];
    const after = moveTask(withKids, "b", "a");
    expect(ids(after)).toEqual(["b", "a", "c"]);
    // A step carries no order of its own; it is found through its parent.
    expect(after.find((i) => i.id === "s")!.order).toBeUndefined();
    expect(childrenOf(after, "b").map((i) => i.id)).toEqual(["s"]);
  });

  it("survives a round trip through a second move", () => {
    const once = moveTask(list, "c", "a");
    expect(ids(moveTask(once, "c", null))).toEqual(["a", "b", "c"]);
  });
});

describe("folding a task's steps away", () => {
  const list = [
    item({ id: "t", created: 1 }),
    item({ id: "s", parent: "t", created: 2 }),
    item({ id: "u", created: 3 }),
  ];

  it("folds and unfolds one task", () => {
    const folded = setCollapsed(list, "t", true);
    expect(folded.find((i) => i.id === "t")!.collapsed).toBe(true);
    expect(setCollapsed(folded, "t", false).find((i) => i.id === "t")!.collapsed).toBe(false);
  });

  it("leaves other tasks alone", () => {
    expect(setCollapsed(list, "t", true).find((i) => i.id === "u")!.collapsed).toBeUndefined();
  });

  it("refuses to fold a step, which has nothing under it", () => {
    // A flag nothing ever reads is worse than no flag.
    expect(setCollapsed(list, "s", true).find((i) => i.id === "s")!.collapsed).toBeUndefined();
  });

  it("does not change what is visible — folding is a view, not a filter", () => {
    // The steps still exist and still count; only the card hides them.
    const folded = setCollapsed(list, "t", true);
    expect(visibleFocus(folded, NOW, 6)).toHaveLength(3);
    expect(progressOf(folded, "t")).toEqual({ done: 0, total: 1 });
  });

  it("does not mutate the list it was given", () => {
    setCollapsed(list, "t", true);
    expect(list[0]!.collapsed).toBeUndefined();
  });
});
