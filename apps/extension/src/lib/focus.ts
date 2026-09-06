/**
 * The focus list.
 *
 * Focus used to be one line of text for the day. It is now a short checklist:
 * tick an item and it strikes through, then clears itself a few hours later.
 *
 * The delay is the whole point. A to-do that vanishes the instant you tick it
 * takes the satisfaction with it, and gives you no way to undo a mis-tick; one
 * that stays forever turns today's list into a log. Keeping it visible and
 * struck through for the rest of the working day is the middle: you can see
 * what you got done, and tomorrow it is gone without anyone tidying up.
 *
 * Everything here is pure and works in Unix **seconds**, matching `Todo`.
 */
import type { FocusItem, LocalState } from "./types";

export type { FocusItem };

/** Hours a ticked item stays visible before it clears itself. */
export const DEFAULT_CLEAR_HOURS = 6;

/**
 * Read the list, folding in the single line the old Focus card stored.
 *
 * That line is someone's actual note. Dropping it on upgrade would be a small
 * betrayal of exactly the kind that makes people stop trusting a tool with
 * anything, so it becomes the first item instead.
 */
export function focusItems(local: LocalState): FocusItem[] {
  if (Array.isArray(local.focusItems)) return local.focusItems;
  const legacy = local.focus?.text?.trim();
  if (!legacy) return [];
  return [
    {
      id: `legacy-${local.focus?.date ?? "0"}`,
      text: legacy,
      done: false,
      created: Math.floor(Date.now() / 1000),
    },
  ];
}

/**
 * Seconds until a ticked item clears, or `null` if it never will on its own.
 *
 * A step returns `null` even when ticked: it is cleared by its task, not by a
 * clock of its own, and a row that promised "clears in 4h" and then did not
 * would be worse than a row that promised nothing.
 */
export function clearsIn(item: FocusItem, now: number, hours: number): number | null {
  if (item.parent) return null;
  if (!item.done || !item.doneAt) return null;
  return item.doneAt + hours * 3600 - now;
}

/** The steps of one task, oldest first — the order they were written in. */
export function childrenOf(items: FocusItem[], id: string): FocusItem[] {
  return items.filter((i) => i.parent === id).sort((a, b) => a.created - b.created);
}

/**
 * The tasks, as opposed to the steps, in the order they should be shown.
 *
 * `order` when it has one, `created` otherwise. A list nobody has reordered
 * therefore reads in the order it was written, and one task being dragged
 * does not renumber the rest.
 */
export function topLevel(items: FocusItem[]): FocusItem[] {
  return items.filter((i) => !i.parent).sort(byOrder);
}

/**
 * The one comparator for tasks, exported so no caller invents a second one.
 *
 * There was briefly a second: the renderer re-sorted by `created` right after
 * `topLevel` had ordered the list, which silently threw away every drag. A
 * sort key that lives in two places is a sort key that will disagree with
 * itself.
 */
export function byOrder(a: FocusItem, b: FocusItem): number {
  return (a.order ?? a.created) - (b.order ?? b.created);
}

/**
 * Move a task so it sits immediately before `beforeId`, or last when that is
 * null. Returns a new list.
 *
 * Every task is renumbered on a move rather than only the one that moved:
 * spacing the numbers out and hoping is how sort keys drift into ties, and a
 * list of a dozen items is not worth being clever about.
 */
export function moveTask(items: FocusItem[], id: string, beforeId: string | null): FocusItem[] {
  const tasks = topLevel(items);
  const moving = tasks.find((t) => t.id === id);
  if (!moving || id === beforeId) return items;

  const without = tasks.filter((t) => t.id !== id);
  const at = beforeId === null ? without.length : without.findIndex((t) => t.id === beforeId);
  if (at < 0) return items;
  const ordered = [...without.slice(0, at), moving, ...without.slice(at)];

  const rank = new Map(ordered.map((t, i) => [t.id, i]));
  return items.map((i) => (rank.has(i.id) ? { ...i, order: rank.get(i.id)! } : i));
}

/**
 * The items still worth showing.
 *
 * An item ticked longer ago than the window is gone whether or not the sweep
 * has run — the reader's view must not depend on whether a service worker
 * happened to be awake.
 *
 * **A step never clears on its own clock.** Only tasks have a window; a step
 * lives and dies with the task it belongs to. Ticking off three steps of a
 * five-step task and watching the first three vanish one by one leaves a task
 * that looks like it never had them — the checklist loses the very thing it
 * was recording. So a struck-through step stays as long as its task does.
 */
export function visibleFocus(items: FocusItem[], now: number, hours: number): FocusItem[] {
  const alive = (i: FocusItem) => {
    const left = clearsIn(i, now, hours);
    return left === null || left > 0;
  };
  const liveParents = new Set(items.filter((i) => !i.parent && alive(i)).map((i) => i.id));
  return items.filter((i) => {
    // An orphan — its task was deleted from an older build, or the data was
    // edited by hand — is shown rather than hidden. Silently swallowing
    // someone's note because a field does not resolve is the worse failure.
    if (i.parent) return items.some((p) => p.id === i.parent) ? liveParents.has(i.parent) : true;
    return alive(i);
  });
}

/** How many steps of a task are done, for the count on its row. */
export function progressOf(items: FocusItem[], id: string): { done: number; total: number } {
  const kids = childrenOf(items, id);
  return { done: kids.filter((k) => k.done).length, total: kids.length };
}

/**
 * Fold a task's steps away, or open them again.
 *
 * Only a task can be folded, because only a task has anything under it —
 * accepting a step here would store a flag that nothing ever reads.
 */
export function setCollapsed(items: FocusItem[], id: string, collapsed: boolean): FocusItem[] {
  return items.map((i) => (i.id === id && !i.parent ? { ...i, collapsed } : i));
}

/** Remove an item, and its steps with it — a step without its task is noise. */
export function removeItem(items: FocusItem[], id: string): FocusItem[] {
  return items.filter((i) => i.id !== id && i.parent !== id);
}

/**
 * Drop what has aged out. `changed` tells a caller whether a write is needed.
 *
 * A ticked item with no `doneAt` predates that field; give it one now rather
 * than clearing it immediately, so an upgrade never silently deletes something
 * that was on screen a moment ago.
 */
export function sweepFocus(
  items: FocusItem[],
  now: number,
  hours: number,
): { items: FocusItem[]; changed: boolean } {
  let changed = false;
  const stamped = items.map((i) => {
    // Steps have no clock of their own, so they need no stamp repairing.
    if (!i.parent && i.done && !i.doneAt) {
      changed = true;
      return { ...i, doneAt: now };
    }
    return i;
  });
  const kept = visibleFocus(stamped, now, hours);
  return { items: kept, changed: changed || kept.length !== items.length };
}

/**
 * Tick or untick, stamping the clock. Returns a new list.
 *
 * Ticking a task ticks the steps still open under it: saying the whole thing
 * is done and leaving its parts open contradicts itself. Unticking does *not*
 * reopen them — that would resurrect steps someone ticked off one by one, and
 * undoing one click should not undo five.
 */
export function setDone(items: FocusItem[], id: string, done: boolean, now: number): FocusItem[] {
  const tick = (i: FocusItem): FocusItem =>
    // Unticking clears the stamp, so a mis-tick costs nothing: the item is
    // simply open again, with its full window if it is ticked later.
    done ? { ...i, done: true, doneAt: now } : { ...i, done: false, doneAt: undefined };

  return items.map((i) => {
    if (i.id === id) return tick(i);
    if (done && i.parent === id && !i.done) return tick(i);
    return i;
  });
}
