/** Shapes shared between the service worker and the pages. */

export interface Binding {
  kind: "query" | "feed";
  tmpl?: string;
  url?: string;
  arg?: string;
  weight?: number;
}

export interface Instance {
  def: string;
  id: string;
  name: string;
  enabled: boolean;
  opts: Record<string, unknown>;
}

/** A theme carried by a pack. Mirrors `tabs_core::pack::Theme`. */
export interface Theme {
  base: string;
  font?: string;
  mono?: string;
  colors: Record<string, string>;
}

/** A theme carried by a pack. Mirrors `tabs_core::pack::Theme`. */
export interface Theme {
  base: string;
  font?: string;
  mono?: string;
  colors: Record<string, string>;
}

export interface Config {
  version: number;
  instances: Instance[];
  theme: string;
  assistant: string;
  /** Installed from a pack, or built in Settings. Part of the config document
   *  so it travels with everything else when the string is copied (D4). */
  custom_theme?: Theme | null;
}

export interface FeedItem {
  title: string;
  url: string;
  id: string;
  source: string;
  published: number;
  summary?: string;
  binding: string;
}

export interface RankedItem extends FeedItem {
  corroboration: number;
  also_in: string[];
  score: number;
  /** Older than the chosen window, shown because nothing newer existed. */
  outside_window?: boolean;
}

export interface GroupedTab {
  id: number;
  window_id: number;
  title: string;
  url: string;
  fav_icon_url: string | null;
  active: boolean;
  pinned: boolean;
  duplicate_of: number[];
}

export interface TabGroup {
  key: string;
  label: string;
  is_homepage: boolean;
  tabs: GroupedTab[];
}

export interface Grouping {
  groups: TabGroup[];
  total: number;
  duplicates: number;
  skipped: number;
}

export interface CalEvent {
  uid: string;
  summary: string;
  start: number;
  end: number;
  all_day: boolean;
  floating: boolean;
  location?: string;
  join_url?: string;
  /** Which subscribed calendar this came from, when the user labelled it. */
  calendar?: string;
  /** IANA zone named by `DTSTART;TZID=`, resolved in the browser. */
  tzid?: string;
}

/** One line on the Focus checklist. Behaviour lives in `lib/focus.ts`. */
export interface FocusItem {
  id: string;
  text: string;
  done: boolean;
  /** When it was ticked — the clock its clearing window is measured from. */
  doneAt?: number;
  created: number;
  /**
   * The task this is a step of, when it is one.
   *
   * Flat with a parent id rather than nested children: the sweep, the
   * clearing window and the stored shape all stay a plain array, so adding
   * this cost no migration and no rewrite of the rules. One level only — a
   * card whose whole point is "the thing that matters today" does not want a
   * tree.
   */
  parent?: string;
  /**
   * Where this task sits in the list, once it has been dragged.
   *
   * Absent until someone reorders — the list is in the order it was written
   * in until they say otherwise, and writing an order onto every item up
   * front would freeze that before anyone asked for it. Steps do not carry
   * one: they follow their task, in the order they were added.
   */
  order?: number;
  /**
   * Whether this task's steps are folded away. Tasks only.
   *
   * Stored rather than kept in the page: a task you deliberately folded up
   * should still be folded when you open the next new tab, or folding it
   * achieves nothing on the one surface you look at fifty times a day.
   */
  collapsed?: boolean;
}

export interface Todo {
  id: string;
  text: string;
  due: number | null;
  hasTime: boolean;
  done: boolean;
  created: number;
  /** Set when the to-do was made from a tab — "close the tab, keep the task". */
  url?: string;
}

/**
 * What the worker writes and the page reads. `generated_at` and `stale_after`
 * are the staleness contract: past its budget a group hides itself rather
 * than showing old data as if it were current.
 */
export interface Payload<T = unknown> {
  instanceId: string;
  data: T;
  generated_at: number;
  stale_after: number;
  error?: string;
  /**
   * Fingerprint of the options this data was produced from.
   *
   * Keeping old data through a failed refresh is right; keeping it after the
   * user changed the sources is not. Without this, removing a feed left its
   * articles on screen indefinitely, because the remaining sources failed and
   * the "don't overwrite with nothing" rule protected the stale result.
   */
  config_hash?: string;
  /**
   * When a paced source may next run, epoch seconds.
   *
   * Absolute on purpose: the page renders the countdown from this at paint
   * time. Storing "in 131 minutes" produces a number that is wrong a minute
   * later and cannot notice a settings change.
   */
  retry_at?: number;
}

export type Payloads = Record<string, Payload>;

export interface LocalState {
  /**
   * The old single-line Focus note. Kept on read only: `focusItems` supersedes
   * it, and `focusItems()` folds this in once so the line is never lost.
   */
  focus?: { text: string; date: string };
  /** The Focus checklist. See `lib/focus.ts`. */
  focusItems?: FocusItem[];
  scratch?: string;
  todos?: Todo[];
  /**
   * Subscribed calendars. `storage.local` ONLY — the URLs are bearer secrets.
   *
   * Plain strings are the pre-label shape and are still accepted on read, so
   * an existing subscription is never dropped by an upgrade.
   */
  calendarUrls?: (string | { label?: string; url: string })[];
  apiKey?: string;
  /**
   * X API bearer token. `storage.local` only — never synced, never included
   * in an export, same as a calendar's secret address.
   */
  xToken?: string;
}
