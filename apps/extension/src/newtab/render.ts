/**
 * Renderers — one per group def. Pure DOM, no fetching, no parsing.
 *
 * Everything here receives data the service worker already finished with.
 * If a renderer ever needs to compute something, it belongs in the worker.
 */
import type {
  CalEvent, FocusItem, Grouping, Instance, LocalState, Payload, RankedItem, Todo,
} from "../lib/types";
import { ext } from "../lib/ext";
import { canonicalLink, linkSet } from "../lib/link";
import {
  byOrder, childrenOf, clearsIn, DEFAULT_CLEAR_HOURS, focusItems, moveTask, progressOf,
  removeItem, setCollapsed, setDone, topLevel, visibleFocus,
} from "../lib/focus";

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export function card(
  title: string,
  count?: string,
  icon?: SVGElement,
): { root: HTMLElement; body: HTMLElement } {
  const root = el("section", "card");
  const head = el("div", "card-head");
  if (icon) head.append(icon);
  head.append(el("span", "card-title", title), el("span", "rule"));
  if (count) head.append(el("span", "card-count", count));
  const body = el("div", "card-body");
  root.append(head, body);
  return { root, body };
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The X mark, as a card icon.
 *
 * Drawn rather than fetched: a remote image would put a network request on
 * the paint path, which is the one thing the new tab page never does. It
 * takes `currentColor` and the same muted tone as the card title, so it reads
 * as part of the heading rather than as branding dropped on top of it.
 */
function xLogo(): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "card-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68" +
      "l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
  );
  svg.append(path);
  return svg;
}

export function relTime(ts: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - ts);
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
  if (d < 86_400) return `${Math.round(d / 3600)}h`;
  return `${Math.round(d / 86_400)}d`;
}

/**
 * Turn a wall-clock stamp plus an IANA zone into a real instant.
 *
 * `tabs-core` stamps a `TZID=` time as if it were UTC, because resolving the
 * zone there would mean shipping a timezone database inside the wasm bundle.
 * The browser already has one, so the conversion happens here: format the
 * naive stamp *as* that zone, measure how far the result drifts, and subtract
 * the drift. That handles daylight saving too, since `Intl` knows the rules
 * for the actual date rather than a fixed offset.
 *
 * Returns the input unchanged if the zone name is unknown — a wrong hour is
 * better than a blank card.
 */
export function zonedToInstant(wallClockStamp: number, tz: string): number {
  try {
    const d = new Date(wallClockStamp * 1000);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    const asIfUtc = Date.UTC(
      get("year"), get("month") - 1, get("day"),
      get("hour") % 24, get("minute"), get("second"),
    );
    const offsetMs = asIfUtc - d.getTime();
    return Math.round((d.getTime() - offsetMs) / 1000);
  } catch {
    return wallClockStamp;
  }
}

/** The instant an event actually occurs at, resolving its zone if it named one. */
export function eventInstant(e: { start: number; floating: boolean; tzid?: string }): {
  at: number;
  floating: boolean;
} {
  if (e.floating && e.tzid) {
    return { at: zonedToInstant(e.start, e.tzid), floating: false };
  }
  return { at: e.start, floating: e.floating };
}

export function clockTime(ts: number, floating = false): string {
  const d = new Date(ts * 1000);
  // A `TZID=` local time was parsed as wall-clock and stamped as if UTC (see
  // tabs-core::ical). Converting it again would shift it by the reader's own
  // offset — 09:00 in the calendar showing as 17:00 here. Read it back in UTC
  // so the wall clock matches what the calendar says.
  // 24-hour, always. A locale-driven 12-hour clock renders "03:00" for 3pm
  // once the meridiem is clipped by the narrow time column — which is worse
  // than useless, because it is wrong by twelve hours and looks fine.
  const hh = String(floating ? d.getUTCHours() : d.getHours()).padStart(2, "0");
  const mm = String(floating ? d.getUTCMinutes() : d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * The calendar day an event falls on, as `YYYY-MM-DD`.
 *
 * Day boundaries are the reader's, not UTC's. `Math.floor(ts / 86400)` counts
 * UTC days, so for anyone east or west of UTC an evening event was filed
 * under the wrong day — in Singapore, anything after 08:00 local is already
 * the next UTC day.
 *
 * A `floating` time is wall clock stamped as if UTC (see tabs-core::ical), so
 * its date must be read back in UTC for the same reason its clock is.
 */
function dayKey(ts: number, floating = false): string {
  const d = new Date(ts * 1000);
  const [y, m, day] = floating
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "Today", "Tomorrow", then a weekday and date — in the reader's timezone. */
export function dayLabel(ts: number, now = Date.now() / 1000, floating = false): string {
  const key = dayKey(ts, floating);
  const todayKey = dayKey(now);
  if (key === todayKey) return "Today";
  if (key === dayKey(now + 86_400)) return "Tomorrow";
  if (key === dayKey(now - 86_400)) return "Yesterday";
  const d = new Date(ts * 1000);
  return floating
    ? d.toLocaleDateString([], {
        weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
      })
    : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

/** WMO weather codes → a glyph. Open-Meteo's vocabulary, condensed. */
export function wxGlyph(code: number, isDay: boolean): string {
  if (code === 0) return isDay ? "☀️" : "🌙";
  if (code <= 2) return isDay ? "🌤️" : "☁️";
  if (code === 3) return "☁️";
  if (code <= 48) return "🌫️";
  if (code <= 57) return "🌦️";
  if (code <= 67) return "🌧️";
  if (code <= 77) return "🌨️";
  if (code <= 82) return "🌧️";
  if (code <= 86) return "🌨️";
  return "⛈️";
}

// ---------- tabs ----------

export function renderTabs(inst: Instance, g: Grouping): HTMLElement {
  const { root, body } = card(inst.name, `${g.total} open`);
  root.classList.add("tabs");

  // Only offer the merge when there is something to merge — a button that
  // does nothing is worse than no button.
  const windows = new Set(g.groups.flatMap((grp) => grp.tabs.map((t) => t.window_id)));
  if (windows.size > 1) {
    const merge = el("button", "corrob", `Merge ${windows.size} windows`);
    merge.title = "Move every tab into this window";
    merge.addEventListener("click", () => {
      merge.textContent = "Merging…";
      void mergeWindows().then((moved) => {
        merge.textContent = moved > 0 ? `Moved ${moved} tabs` : "Nothing to move";
        void ext.runtime.sendMessage({ type: "refreshTabs" }).catch(() => {});
      });
    });
    root.querySelector(".card-head")?.append(merge);
  }

  // In the head, beside the title, rather than under a long list of tabs.
  // It is an action on the whole card, and at the bottom it was below the
  // fold on exactly the cluttered browser that most needs it.
  if (g.duplicates > 0 && inst.opts.show_dupes !== false) {
    const btn = el("button", "corrob dupe", `Close ${g.duplicates} duplicate${g.duplicates > 1 ? "s" : ""}`);
    btn.title = "Close every second and later copy of a page";
    btn.addEventListener("click", () => {
      const seen = new Set<string>();
      const kill: number[] = [];
      for (const grp of g.groups) {
        for (const t of grp.tabs) {
          if (t.duplicate_of.length === 0) continue;
          const key = [t.id, ...t.duplicate_of].sort((a, b) => a - b).join(",");
          if (seen.has(key)) kill.push(t.id);
          else seen.add(key);
        }
      }
      if (kill.length) onTabs(ext.tabs.remove(kill));
      btn.remove();
    });
    root.querySelector(".card-head")?.append(btn);
  }

  if (g.groups.length === 0) {
    body.append(el("div", "empty", "No open tabs. Enjoy the quiet."));
    return root;
  }
  const collapseAfter = Number(inst.opts.collapse_after ?? 8);
  const wrap = el("div", "tabgroups");

  for (const grp of g.groups) {
    const box = el("div", "tabgroup");
    const head = el("div", "tabgroup-head");
    head.append(
      el("span", "tabgroup-name", grp.label),
      el("span", "tabgroup-n", String(grp.tabs.length)),
    );
    const closeAll = el("button", "closeall", "close all");
    closeAll.addEventListener("click", () => {
      onTabs(ext.tabs.remove(grp.tabs.map((t) => t.id)));
      box.remove();
    });
    head.append(closeAll);
    box.append(head);

    const shown = grp.tabs.slice(0, collapseAfter);
    for (const t of shown) box.append(tabRow(t));

    if (grp.tabs.length > shown.length) {
      const more = el("button", "tagbroup-more empty", `+${grp.tabs.length - shown.length} more`);
      more.addEventListener("click", () => {
        more.remove();
        for (const t of grp.tabs.slice(collapseAfter)) box.append(tabRow(t));
      });
      box.append(more);
    }
    wrap.append(box);
  }
  body.append(wrap);

  return root;
}

/**
 * Act on a tab that may already be gone.
 *
 * The card paints a snapshot. By the time it is clicked the tab may have been
 * closed elsewhere — by the reader in another window, or by auto-close — and
 * an unhandled rejection surfaced in the console as
 * `Uncaught (in promise) Error: No tab with id: …`.
 *
 * A stale id is not an error worth showing; it means the snapshot is out of
 * date, so ask the worker to take a fresh one.
 */
function onTabs(p: Promise<unknown>): void {
  void p.catch(() => {
    void ext.runtime.sendMessage({ type: "refreshTabs" }).catch(() => {});
  });
}

/**
 * The bookmark mark, outline or filled.
 *
 * Two states of one shape rather than two shapes: "saved" and "not saved" are
 * the same object in different conditions, and swapping the glyph entirely
 * would read as a different control.
 */
function bookmarkGlyph(saved: boolean): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("fill", saved ? "currentColor" : "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z");
  svg.append(path);
  return svg;
}

/**
 * Can this page be saved as a bookmark?
 *
 * Browsers refuse to bookmark their own internal pages, so offering it there
 * produces a button whose only outcome is an error.
 */
export function bookmarkable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function tabRow(t: Grouping["groups"][number]["tabs"][number]): HTMLElement {
  const a = el("a", "tablink") as HTMLAnchorElement;
  a.href = t.url;
  a.dataset.url = t.url;
  if (t.fav_icon_url) {
    const img = document.createElement("img");
    img.src = t.fav_icon_url;
    img.alt = "";
    img.addEventListener("error", () => img.remove());
    a.append(img);
  }
  a.append(el("span", undefined, t.title || t.url));

  const x = el("span", "x", "\u2715");

  // Save without leaving the page. The state is filled in after paint, by
  // `markBookmarked` — looking it up here would put a bookmarks read on the
  // critical path for every tab on screen.
  //
  // Not offered on a browser page: browsers refuse to bookmark their own
  // internal pages, and a control whose only outcome is an error is worse
  // than one that is not there.
  const mark = bookmarkable(t.url) ? el("button", "bm") : null;
  if (mark) {
    mark.title = "Save as a bookmark";
    mark.setAttribute("aria-label", "Save as a bookmark");
    mark.append(bookmarkGlyph(false));
    a.append(mark);
  }
  a.append(x);

  /**
   * A toggle, decided by the worker.
   *
   * The page deliberately does not choose the direction from `data-saved`.
   * That flag is a decoration applied after paint, and if it is ever wrong —
   * a bookmark made in another window, a URL that differs from the tab's by a
   * slash — the button then does the opposite of what was asked, which is
   * exactly how "I cannot unbookmark" happens. The worker reads what is
   * actually stored and reports the state it ended in.
   *
   * Unsaving remembers the original folder, so a re-save puts it back where
   * it was and a mis-click costs nothing — see `addBookmark` in the worker.
   */
  mark?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const send = () =>
      ext.runtime.sendMessage({
        type: "bookmarkToggle",
        title: t.title,
        url: t.url,
      }) as Promise<{
        ok?: boolean;
        saved?: boolean;
        folderName?: string;
        needsPermission?: boolean;
      }>;

    void send()
      .then((r) => {
        if (r?.ok) {
          setSaved(a, !!r.saved);
          // Saved: say where, and offer to put it somewhere else. Asking
          // first would put a menu in front of every single save; this keeps
          // the one click and still answers "not that folder".
          if (r.saved) showFolderPopover(mark, t.url, r.folderName ?? "");
          return;
        }
        if (!r?.needsPermission) return;
        // The click is the gesture, and nothing may be awaited before
        // spending it — so this asks directly rather than via the worker.
        void ext.permissions
          .request({ permissions: ["bookmarks"] })
          .then((granted) => {
            if (!granted) return;
            void send().then((again) => {
              if (again?.ok) {
                setSaved(a, !!again.saved);
                if (again.saved) showFolderPopover(mark, t.url, again.folderName ?? "");
              }
            });
          })
          .catch(() => {});
      })
      .catch(() => {});
  });

  a.addEventListener("click", (e) => {
    e.preventDefault();
    if (e.target === x) {
      onTabs(ext.tabs.remove(t.id));
      a.remove();
      return;
    }
    // Jump to the existing tab rather than opening a second copy — the
    // point of a tab dashboard.
    onTabs(ext.tabs.update(t.id, { active: true }));
    onTabs(ext.windows.update(t.window_id, { focused: true }));
  });
  return a;
}

/**
 * "Saved to Reading — change?", anchored to the mark that was just pressed.
 *
 * The pattern a browser's own star uses, and for the same reason: making the
 * folder a question asked *before* every save would tax the common case,
 * where the last folder used is the right one. Saving first and offering to
 * move it costs nothing when the guess was right.
 */
function showFolderPopover(anchorEl: HTMLElement, url: string, folderName: string) {
  document.querySelector(".bmpop")?.remove();
  const pop = el("div", "bmpop");
  pop.append(el("span", "bmpop-t", `Saved to ${folderName || "your bookmarks"}`));

  const sel = document.createElement("select");
  sel.append(new Option("Move to\u2026", ""));
  pop.append(sel);

  const close = () => {
    pop.remove();
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("keydown", onEsc, true);
  };
  const onOutside = (e: Event) => {
    if (!pop.contains(e.target as Node) && e.target !== anchorEl) close();
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

  sel.addEventListener("change", () => {
    if (!sel.value) return;
    void ext.runtime
      .sendMessage({ type: "bookmarkMove", url, folderId: sel.value })
      .then((r: { ok?: boolean; folderName?: string }) => {
        if (r?.ok) {
          pop.querySelector(".bmpop-t")!.textContent = `Moved to ${r.folderName ?? "folder"}`;
          setTimeout(close, 900);
        }
      })
      .catch(() => {});
  });

  void ext.runtime
    .sendMessage({ type: "bookmarkFolders" })
    .then((r: { folders?: { id: string; path: string }[] }) => {
      for (const f of r?.folders ?? []) sel.append(new Option(f.path, f.id));
    })
    .catch(() => {});

  // Positioned against the mark rather than nested inside the row: the row is
  // an anchor with `overflow: hidden` ancestors, which would clip it.
  const box = anchorEl.getBoundingClientRect();
  pop.style.top = `${box.bottom + window.scrollY + 6}px`;
  pop.style.left = `${Math.max(8, box.right + window.scrollX - 210)}px`;
  document.body.append(pop);
  // Deferred: this runs inside the click that opened it, and a listener added
  // now would see that same click bubble and close it immediately.
  setTimeout(() => {
    document.addEventListener("click", onOutside, true);
    document.addEventListener("keydown", onEsc, true);
  }, 0);
}

function setSaved(row: HTMLElement, saved: boolean) {
  row.dataset.saved = saved ? "1" : "0";
  const mark = row.querySelector<HTMLElement>(".bm");
  if (!mark) return;
  mark.replaceChildren(bookmarkGlyph(saved));
  // The label names what the click will do, not what the state is: a control
  // that reads "Already bookmarked" tells you nothing about pressing it.
  mark.title = saved ? "Remove bookmark" : "Save as a bookmark";
  mark.setAttribute("aria-label", mark.title);
}

/**
 * Fill in which tabs are already saved, after the page has painted.
 *
 * `null` means we cannot see the bookmarks at all — leave every mark in the
 * "save this" state, because claiming nothing is saved would be a lie.
 */
export function markBookmarked(root: ParentNode, urls: string[] | null): void {
  if (urls === null) return;
  // Compared as pages, not as strings: a bookmark saved before a site moved
  // to https, or without the trailing slash the tab reports, is still this
  // page and the mark has to say so.
  const set = linkSet(urls);
  for (const row of root.querySelectorAll<HTMLElement>(".tablink[data-url]")) {
    if (set.has(canonicalLink(row.dataset.url!))) setSaved(row, true);
  }
}

// ---------- topics ----------

export function renderTopic(inst: Instance, items: RankedItem[], note?: string): HTMLElement {
  const { root, body } = card(inst.name);
  if (items.length === 0) {
    // Say *why*. "Nothing yet" with no cause is the most annoying possible
    // empty state, because it is indistinguishable from a bug.
    body.append(el("div", "empty", note || "Nothing yet."));
    if (note) {
      const fix = el("button", "corrob", "Open settings");
      fix.addEventListener("click", () => void ext.runtime.openOptionsPage());
      body.append(fix);
    }
    return root;
  }
  if (note) {
    // Visible even when there are items: a topic quietly running off one
    // source because the others are blocked looks fine until you are told.
    const warn = el("div", "row-sub");
    warn.style.color = "var(--warning-fg, #c2661f)";
    warn.textContent = note;
    body.append(warn);
  }
  const rows = el("div", "rows");
  for (const it of items) {
    const row = el("div", "row");
    const main = el("div", "row-main");
    const a = el("a", "row-title", it.title) as HTMLAnchorElement;
    a.href = it.url;
    a.rel = "noopener noreferrer";
    main.append(a);

    const sub = el("div", "row-sub");
    sub.append(document.createTextNode(it.source || ""));
    if (it.corroboration > 1) {
      // The corroboration signal made visible: this is why a wide query
      // source is an asset rather than noise.
      const c = el("span", "corrob", `+${it.corroboration - 1}`);
      c.title = it.also_in.length ? `Also in ${it.also_in.join(", ")}` : "";
      sub.append(document.createTextNode(" "), c);
    }
    if (it.outside_window) {
      // Say it plainly rather than quietly widening the window the user set.
      const old = el("span", "corrob", "older");
      old.title = "Nothing newer was found in the window you chose";
      sub.append(document.createTextNode(" "), old);
    }
    main.append(sub);
    row.append(main, el("span", "row-meta", relTime(it.published)));
    rows.append(row);
  }
  body.append(rows);
  return root;
}

// ---------- small groups ----------

export function renderApps(inst: Instance, apps: { name: string; url: string; tagline?: string }[]): HTMLElement {
  const { root, body } = card(inst.name);
  const wrap = el("div", "apps");
  for (const app of apps ?? []) {
    const a = el("a", "app") as HTMLAnchorElement;
    a.href = app.url;
    a.append(el("div", "n", app.name));
    if (app.tagline) a.append(el("div", "t", app.tagline));
    wrap.append(a);
  }
  body.append(wrap.children.length ? wrap : el("div", "empty", "No apps listed."));
  return root;
}

export function renderWeather(inst: Instance, w: { place: string; temp: number; code: number; isDay: boolean; max: number; min: number } | null): HTMLElement {
  const { root, body } = card(inst.name);
  if (!w || w.temp === null) {
    body.append(el("div", "empty", "Weather unavailable."));
    return root;
  }
  const wrap = el("div", "wx");
  wrap.append(el("span", "glyph", wxGlyph(w.code, w.isDay)));
  const right = el("div");
  right.append(el("div", "temp num", `${Math.round(w.temp)}°`));
  const range = `${Math.round(w.min)}–${Math.round(w.max)}°`;
  right.append(el("div", "place", w.place ? `${w.place} · ${range}` : range));
  wrap.append(right);
  body.append(wrap);
  return root;
}

export function renderTickers(
  inst: Instance,
  rows: { symbol: string; price: number; changePct: number; currency?: string }[],
  delayed = false,
): HTMLElement {
  const { root, body } = card(inst.name, delayed ? "15 min delayed" : undefined);
  if (!rows?.length) {
    body.append(el("div", "empty", "No prices."));
    return root;
  }
  const wrap = el("div", "tickers");
  for (const r of rows) {
    const t = el("div", "ticker");
    t.append(el("div", "sym mono", r.symbol));
    t.append(el("div", "px num", r.price >= 1000 ? r.price.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(Number(r.price.toPrecision(6)))));
    const chg = el("div", `row-meta num ${r.changePct >= 0 ? "up" : "down"}`, `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%`);
    t.append(chg);
    wrap.append(t);
  }
  body.append(wrap);
  return root;
}

/**
 * Recent bookmarks.
 *
 * You save a bookmark *in order to* come back to it, so the useful view is
 * the newest first — a bookmark manager is for finding one you saved months
 * ago, which is a different problem and not this card's.
 */
export function renderBookmarks(
  inst: Instance,
  items: { id: string; title: string; url: string; folder: string; added: number }[],
  note?: string,
): HTMLElement {
  const { root, body } = card(inst.name);
  if (note) {
    const warn = el("div", "row-sub");
    warn.style.color = "var(--warning-fg, #c2661f)";
    warn.textContent = note;
    body.append(warn);
    // Never a dead end: the note names the cause, the button goes to the fix.
    const open = el("button", "corrob", "Open settings");
    open.addEventListener("click", () => {
      void ext.tabs
        .create({ url: ext.runtime.getURL(`settings.html#i=${encodeURIComponent(inst.id)}`) })
        .catch(() => {});
    });
    body.append(open);
    if (items.length === 0) return root;
  }
  const rows = el("div", "rows");
  const showFolder = inst.opts.show_folder !== false;
  for (const b of items) {
    const row = el("div", "row");
    const main = el("div", "row-main");
    const a = el("a", "row-title", b.title) as HTMLAnchorElement;
    a.href = b.url;
    a.rel = "noopener noreferrer";
    main.append(a);
    let host = b.url;
    try {
      host = new URL(b.url).host.replace(/^www\./, "");
    } catch {
      /* a bookmark can hold anything, including a URL that will not parse */
    }
    main.append(el("div", "row-sub", [host, showFolder ? b.folder : ""].filter(Boolean).join(" \u00b7 ")));
    row.append(main, el("span", "row-meta", relTime(b.added)));
    rows.append(row);
  }
  body.append(rows);
  return root;
}

export function renderStatus(inst: Instance, rows: { name: string; indicator: string; description: string }[]): HTMLElement {
  const { root, body } = card(inst.name);
  const rowsEl = el("div", "rows");
  for (const s of rows ?? []) {
    const row = el("div", "row");
    const main = el("div", "row-main");
    const dot = el("span", `dot ${s.indicator}`);
    main.append(dot, document.createTextNode(` ${s.name}`));
    row.append(main, el("span", "row-meta", s.description));
    rowsEl.append(row);
  }
  body.append(rowsEl.children.length ? rowsEl : el("div", "empty", "No status."));
  return root;
}

/**
 * A card that says this group could not be drawn.
 *
 * Shown instead of the group when its renderer throws. The alternative — the
 * behaviour this replaced — was that the whole page went blank, because one
 * exception aborted the loop that builds every card. A reader cannot tell a
 * blank new tab from a broken extension, and neither can a bug report.
 */
export function renderFailed(inst: Instance): HTMLElement {
  const { root, body } = card(inst.name || inst.def);
  body.append(
    el(
      "div",
      "empty",
      "This group could not be drawn. The rest of the page is unaffected — " +
        "open Settings to check its options, or remove it.",
    ),
  );
  return root;
}

export function renderTrending(inst: Instance, repos: { repo: string; url: string; language?: string; stars_today: number; description?: string }[]): HTMLElement {
  const { root, body } = card(inst.name);
  if (!repos?.length) {
    body.append(
      el("div", "empty", "No trending data yet — grant access to github.com in Settings."),
    );
    const fix = el("button", "corrob", "Open settings");
    fix.addEventListener("click", () => void ext.runtime.openOptionsPage());
    body.append(fix);
    return root;
  }
  const rows = el("div", "rows");
  for (const r of repos) {
    const row = el("div", "row");
    const main = el("div", "row-main");
    const a = el("a", "row-title", r.repo) as HTMLAnchorElement;
    a.href = r.url;
    main.append(a);
    if (r.description) main.append(el("div", "row-sub", r.description));
    row.append(main, el("span", "row-meta num", `+${r.stars_today.toLocaleString()}`));
    rows.append(row);
  }
  body.append(rows);
  return root;
}

export function renderCalendar(
  inst: Instance,
  events: CalEvent[],
  note?: string,
): HTMLElement {
  const { root, body } = card(inst.name);
  const nowSec = Date.now() / 1000;
  // Resolve each event's zone before anything else: filtering, grouping and
  // the clock all have to agree about when it happens.
  const resolved = (events ?? []).map((e) => {
    const { at, floating } = eventInstant(e);
    return { ...e, start: at, end: at + (e.end - e.start), floating };
  });
  const upcoming = resolved.filter((e) => e.end > nowSec).slice(0, 8);

  if (upcoming.length === 0) {
    body.append(el("div", "empty", note || "Nothing scheduled."));
    if (note) {
      const fix = el("button", "corrob", "Open settings");
      fix.addEventListener("click", () => void ext.runtime.openOptionsPage());
      body.append(fix);
    }
    return root;
  }

  const multiple = new Set(upcoming.map((e) => e.calendar).filter(Boolean)).size > 1;

  // Grouped under day headings. A bare "14:00" is unreadable across a
  // multi-day window — you cannot tell today's from Friday's.
  let lastDay = "";
  for (const e of upcoming) {
    const label = dayLabel(e.start, nowSec, e.floating);
    if (label !== lastDay) {
      lastDay = label;
      const head = el("div", "daysep", label);
      body.append(head);
    }
    const row = el("div", "ev");
    const when = el("div", "when mono", e.all_day ? "all day" : clockTime(e.start, e.floating));
    if (e.all_day) when.classList.add("allday");
    row.append(when);
    const what = el("div", "what", e.summary);
    // Name the calendar when there is more than one, so an event from work
    // and one from home are tellable apart.
    if (e.calendar && multiple) {
      what.append(el("span", "calname", e.calendar));
    }
    row.append(what);
    if (e.join_url) {
      const j = el("a", "join", "Join") as HTMLAnchorElement;
      j.href = e.join_url;
      j.rel = "noopener noreferrer";
      row.append(j);
    }
    body.append(row);
  }

  // Meeting load, but only for today — "hours of meetings" across a week is
  // a number nobody acts on.
  const mins = upcoming
    .filter((e) => !e.all_day && dayLabel(e.start, nowSec, e.floating) === "Today")
    .reduce((n, e) => n + (e.end - e.start) / 60, 0);
  if (mins > 0) {
    body.append(el("div", "empty", `${(mins / 60).toFixed(1)} hours of meetings today.`));
  }
  return root;
}


// ---------- local groups ----------

/**
 * Focus, as a short checklist with steps.
 *
 * Ticking strikes an item through and starts a clock; it clears itself once
 * the window is up. The remaining time is shown on the row, because an item
 * that disappears on its own without ever having said it would is
 * indistinguishable from one the app lost.
 *
 * A task can hold steps, one level deep. Deeper would make this a project
 * tool, and the card exists to answer "what is today about", which is a
 * question a tree is bad at.
 */
export function renderFocus(inst: Instance, local: LocalState, save: (s: LocalState) => void): HTMLElement {
  const hours = Number(inst.opts.clear_after_hours ?? DEFAULT_CLEAR_HOURS);
  const now = () => Math.floor(Date.now() / 1000);
  let items = focusItems(local);
  const { root, body } = card(inst.name);
  const count = el("span", "card-count");
  root.querySelector(".card-head")?.append(count);

  const list = el("div", "rows");

  const persist = () => {
    local.focusItems = items;
    // The legacy line has been folded into the list; leaving it behind would
    // resurrect it on any device that has not written the list yet.
    delete local.focus;
    save(local);
    // Tasks, not steps: this answers "how many things am I on the hook for",
    // and counting every sub-step would inflate it into noise.
    const open = topLevel(visibleFocus(items, now(), hours)).filter((i) => !i.done).length;
    count.textContent = open ? `${open} open` : "";
  };

  /** Rebuild the list. Only on add and remove — see `tick`. */
  function draw() {
    list.replaceChildren();
    const shown = visibleFocus(items, now(), hours);
    // Open first, then the struck-through ones on their way out.
    // Done last, then the reader's own order. `byOrder` and not `created`:
    // re-sorting here by creation time is what silently undid every drag.
    const tasks = topLevel(shown).sort((a, b) => Number(a.done) - Number(b.done) || byOrder(a, b));
    for (const task of tasks) {
      // One block per task, so "add a step" can be scoped to hovering *that*
      // task. Hanging it off the card meant every task showed its own input
      // at once, which is a column of empty lines between everything.
      const block = el("div", `task${task.collapsed ? " collapsed" : ""}`);
      block.dataset.task = task.id;
      block.append(focusRow(task));
      for (const step of childrenOf(shown, task.id)) block.append(focusRow(step));
      block.append(addStepRow(task.id));
      makeTaskDraggable(block, task.id);
      list.append(block);
    }
    if (shown.length === 0) {
      list.append(el("div", "empty", "Nothing yet. Add the one thing that matters."));
    } else if (tasks.length > 1) {
      // Somewhere to drop a task so it lands last. Without it the bottom of
      // the list is the one position a drag cannot reach.
      const tail = el("div", "taskend");
      tail.addEventListener("dragover", (e) => {
        e.preventDefault();
        tail.classList.add("dropbefore");
      });
      tail.addEventListener("dragleave", () => tail.classList.remove("dropbefore"));
      tail.addEventListener("drop", (e) => {
        e.preventDefault();
        tail.classList.remove("dropbefore");
        const moved = dragging ?? e.dataTransfer?.getData("text/plain");
        if (!moved) return;
        items = moveTask(items, moved, null);
        persist();
        draw();
      });
      list.append(tail);
    }
  }

  /** The countdown label on a ticked row, or nothing on an open one. */
  function dueLabel(row: HTMLElement, id: string) {
    row.querySelector(".due")?.remove();
    const it = items.find((x) => x.id === id);
    const left = it ? clearsIn(it, now(), hours) : null;
    if (left === null) return;
    const h = Math.floor(left / 3600);
    const label = el("span", "due", h >= 1 ? `clears in ${h}h` : "clears shortly");
    row.querySelector(".x")?.before(label);
  }

  /**
   * `2/3 ▾` beside a task: how its steps are going, and the control that
   * folds them away.
   *
   * The count is the toggle rather than a separate caret, for two reasons: it
   * only exists when there is something to fold, so no row has to reserve
   * space for a control it will never show; and when the steps are hidden the
   * count is exactly the summary you want in their place.
   */
  function progressLabel(row: HTMLElement, id: string) {
    row.querySelector(".prog")?.remove();
    const { done, total } = progressOf(items, id);
    if (total === 0) return;
    const task = items.find((x) => x.id === id);
    const folded = task?.collapsed === true;
    const tag = el("button", `prog${done === total ? " all" : ""}`);
    tag.append(
      document.createTextNode(`${done}/${total}`),
      el("span", "caret", folded ? "\u25b8" : "\u25be"),
    );
    tag.title = folded ? `Show ${total} step${total > 1 ? "s" : ""}` : "Hide the steps";
    tag.setAttribute("aria-expanded", folded ? "false" : "true");
    tag.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = !folded;
      items = setCollapsed(items, id, next);
      persist();
      // In place: folding is not a reason to rebuild and reorder the list
      // under the cursor, and the button must stay where it was pressed.
      row.closest(".task")?.classList.toggle("collapsed", next);
      progressLabel(row, id);
    });
    row.querySelector(".due, .x")?.before(tag);
  }

  /**
   * Tick or untick, **in place**.
   *
   * Redrawing here would delete the checkbox the reader is still touching and
   * reorder the list under their cursor — which also made the click land on
   * whatever slid into that position. Reordering waits for the next paint.
   */
  function tick(row: HTMLElement, id: string, done: boolean) {
    items = setDone(items, id, done, now());
    row.classList.toggle("done", done);
    dueLabel(row, id);
    persist();

    const it = items.find((x) => x.id === id);
    if (it && !it.parent) {
      // Ticking a task also ticked its open steps; their rows are on screen.
      for (const kid of childrenOf(items, id)) {
        const kidRow = list.querySelector<HTMLElement>(`[data-item="${CSS.escape(kid.id)}"]`);
        if (!kidRow) continue;
        kidRow.classList.toggle("done", kid.done);
        kidRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = kid.done;
        dueLabel(kidRow, kid.id);
      }
      progressLabel(row, id);
    } else if (it?.parent) {
      const parentRow = list.querySelector<HTMLElement>(`[data-item="${CSS.escape(it.parent)}"]`);
      if (parentRow) progressLabel(parentRow, it.parent);
    }

    if (visibleFocus(items, now(), hours).every((i) => i.id !== id)) draw();
  }

  /**
   * Drag a task, with its steps, to reorder the list.
   *
   * The drag starts from a grip and nowhere else, exactly as the cards do:
   * the rows hold a checkbox, an editable sentence and two buttons, and a
   * whole-row drag would fight all four.
   */
  /**
   * Which task is in the air.
   *
   * `dataTransfer` is the documented channel and is set below, but it is not
   * always readable on the receiving end — its store goes protected outside a
   * real user drag, and payloads can be dropped between contexts. The id is
   * needed by the same page that set it, so keeping it here is both simpler
   * and more reliable; `dataTransfer` stays for anything outside us.
   */
  let dragging: string | null = null;

  function makeTaskDraggable(block: HTMLElement, id: string) {
    const grip = el("span", "taskgrip", "\u2807");
    grip.title = "Drag to reorder";
    grip.addEventListener("pointerdown", () => {
      block.draggable = true;
    });
    grip.addEventListener("pointerup", () => {
      block.draggable = false;
    });
    block.querySelector(".todo")?.prepend(grip);

    block.addEventListener("dragstart", (e) => {
      dragging = id;
      e.dataTransfer?.setData("text/plain", id);
      block.classList.add("dragging");
    });
    block.addEventListener("dragend", () => {
      dragging = null;
      block.draggable = false;
      block.classList.remove("dragging");
      for (const b of list.querySelectorAll(".task")) b.classList.remove("dropbefore");
    });
    block.addEventListener("dragover", (e) => {
      e.preventDefault();
      block.classList.add("dropbefore");
    });
    block.addEventListener("dragleave", () => block.classList.remove("dropbefore"));
    block.addEventListener("drop", (e) => {
      e.preventDefault();
      block.classList.remove("dropbefore");
      const moved = dragging ?? e.dataTransfer?.getData("text/plain");
      if (!moved || moved === id) return;
      items = moveTask(items, moved, id);
      persist();
      draw();
    });
  }

  function focusRow(it: FocusItem): HTMLElement {
    const row = el("div", `todo${it.done ? " done" : ""}${it.parent ? " step" : ""}`);
    row.dataset.item = it.id;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = it.done;
    box.setAttribute("aria-label", "Done");
    box.addEventListener("change", () => tick(row, it.id, box.checked));

    const text = el("span", "t", it.text);
    // Editable in place: a focus item is a sentence someone wrote, and
    // retyping it to fix a word is the kind of friction that empties a list.
    text.contentEditable = "true";
    text.spellcheck = false;
    text.addEventListener("blur", () => {
      const next = text.textContent?.trim() ?? "";
      const current = items.find((x) => x.id === it.id);
      if (!current || next === current.text) return;
      if (!next) {
        items = removeItem(items, it.id);
        persist();
        draw();
        return;
      }
      items = items.map((x) => (x.id === it.id ? { ...x, text: next } : x));
      persist();
    });
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        text.blur();
      }
    });

    const rm = el("button", "x", "\u2715");
    rm.title = it.parent ? "Remove step" : "Remove task and its steps";
    rm.addEventListener("click", () => {
      items = removeItem(items, it.id);
      persist();
      draw();
    });

    row.append(box, text, rm);
    dueLabel(row, it.id);
    if (!it.parent) progressLabel(row, it.id);
    return row;
  }

  /** The one-line "add a step" input that sits under each task. */
  function addStepRow(parent: string): HTMLElement {
    const row = el("div", "todo step addstep");
    const input = document.createElement("input");
    input.className = "newtodo";
    input.placeholder = "Add a step";
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      items = [...items, { id: crypto.randomUUID(), text, done: false, created: now(), parent }];
      persist();
      draw();
      // Keep going: adding one step usually means adding the next.
      list
        .querySelector<HTMLInputElement>(`.addstep[data-parent="${CSS.escape(parent)}"] input`)
        ?.focus();
    });
    row.dataset.parent = parent;
    row.append(input);
    return row;
  }

  draw();
  persist();

  const input = document.createElement("input");
  input.className = "newtodo";
  input.placeholder = String(inst.opts.prompt ?? "What's today about?");
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    items = [...items, { id: crypto.randomUUID(), text, done: false, created: now() }];
    persist();
    draw();
  });

  body.append(list, input);
  return root;
}

export function renderScratch(inst: Instance, local: LocalState, save: (s: LocalState) => void): HTMLElement {
  const { root, body } = card(inst.name);
  const ta = document.createElement("textarea");
  ta.className = "scratch";
  ta.placeholder = "Notes…";
  ta.value = local.scratch ?? "";
  let timer: number | undefined;
  ta.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      local.scratch = ta.value;
      save(local);
    }, 400);
  });
  body.append(ta);
  return root;
}

export function renderTodos(
  inst: Instance,
  local: LocalState,
  save: (s: LocalState) => void,
  parseDue: (text: string) => Promise<{ at: number; hasTime: boolean; rest: string } | null>,
): HTMLElement {
  const todos = (local.todos ??= []);
  const open = todos.filter((t) => !t.done);
  const { root, body } = card(inst.name, open.length ? `${open.length} open` : undefined);

  const list = el("div", "rows");
  const draw = () => {
    list.replaceChildren();
    const sorted = [...todos].sort(
      (a, b) => Number(a.done) - Number(b.done) || (a.due ?? Infinity) - (b.due ?? Infinity),
    );
    for (const t of sorted.slice(0, 8)) list.append(todoRow(t, todos, save, draw));
    if (todos.length === 0) list.append(el("div", "empty", "Nothing due. Add one below."));
  };
  draw();

  const input = document.createElement("input");
  input.className = "newtodo";
  input.placeholder = "Add a to-do — try “email vendor fri 3pm”";
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !input.value.trim()) return;
    void (async () => {
      const raw = input.value.trim();
      const parsed = await parseDue(raw);
      todos.push({
        id: crypto.randomUUID(),
        text: parsed?.rest?.trim() || raw,
        due: parsed?.at ?? null,
        hasTime: parsed?.hasTime ?? false,
        done: false,
        created: Math.floor(Date.now() / 1000),
      });
      input.value = "";
      save(local);
      draw();
    })();
  });

  body.append(list, input);
  return root;
}

function todoRow(t: Todo, todos: Todo[], save: (s: LocalState) => void, draw: () => void): HTMLElement {
  const row = el("div", `todo${t.done ? " done" : ""}`);
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = t.done;
  box.addEventListener("change", () => {
    t.done = box.checked;
    save({ todos } as LocalState);
    draw();
  });
  row.append(box, el("span", "t", t.text));
  if (t.due) {
    const over = t.due * 1000 < Date.now() && !t.done;
    const label = t.hasTime
      ? new Date(t.due * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
      : new Date(t.due * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    row.append(el("span", `due${over ? " over" : ""}`, label));
  }
  return row;
}

export function renderStale(inst: Instance, p: Payload | undefined): HTMLElement | null {
  // A group past its staleness budget hides itself. Showing old data as if
  // it were current is the failure mode this prevents.
  if (!p || !p.data) return null;
  if (p.stale_after > 0 && p.stale_after < Date.now() / 1000 - 3600) return null;
  void inst;
  return null;
}

/**
 * X search results.
 *
 * Posts are prose, not headlines, so they get two clamped lines rather than
 * the single title line a news item uses — and the whole card links out to
 * the same search on X, because a key-less reader still deserves a way in.
 */
export function renderXSearch(
  inst: Instance,
  items: RankedItem[],
  note: string | undefined,
  openSearch: () => void,
  retryAt?: number,
): HTMLElement {
  const { root, body } = card(
    inst.name,
    items.length ? undefined : "no key needed to open in X",
    xLogo(),
  );

  // Computed here, at paint time, from an absolute timestamp — so it is right
  // whenever you look at it and reflects the current setting immediately.
  if (retryAt) {
    const mins = Math.max(0, Math.ceil((retryAt - Date.now() / 1000) / 60));
    const when = mins <= 1 ? "shortly" : `in about ${mins} minute${mins === 1 ? "" : "s"}`;
    body.append(el("div", "row-sub", `Next check ${when}.`));
  }
  if (note) {
    const warn = el("div", "row-sub");
    warn.style.color = "var(--warning-fg, #c2661f)";
    warn.textContent = note;
    body.append(warn);
  }
  if (items.length === 0) {
    const open = el("button", "corrob", "Open this search in X");
    open.addEventListener("click", openSearch);
    body.append(open);
    return root;
  }
  const rows = el("div", "rows");
  for (const it of items) {
    const row = el("div", "row");
    const main = el("div", "row-main");
    const a = el("a", "row-title xpost", it.title) as HTMLAnchorElement;
    a.href = it.url;
    a.rel = "noopener noreferrer";
    main.append(a);
    const sub = el("div", "row-sub", [it.source, it.summary].filter(Boolean).join(" · "));
    main.append(sub);
    row.append(main, el("span", "row-meta", relTime(it.published)));
    rows.append(row);
  }
  body.append(rows);
  const open = el("button", "corrob", "Open in X");
  open.addEventListener("click", openSearch);
  body.append(open);
  return root;
}

/**
 * Move every tab into the window this page is in.
 *
 * Pinned tabs are moved first and re-pinned afterwards: `tabs.move` to the end
 * of a window drops the pinned flag, and silently unpinning someone's pinned
 * tabs is a worse outcome than not merging at all.
 */
async function mergeWindows(): Promise<number> {
  try {
    const here = await ext.windows.getCurrent();
    if (here.id === undefined) return 0;

    const all = await ext.tabs.query({});
    const elsewhere = all.filter((t) => t.windowId !== here.id && t.id !== undefined);
    if (elsewhere.length === 0) return 0;

    const pinned = elsewhere.filter((t) => t.pinned).map((t) => t.id!);
    const rest = elsewhere.filter((t) => !t.pinned).map((t) => t.id!);

    if (pinned.length > 0) {
      await ext.tabs.move(pinned, { windowId: here.id, index: 0 });
      for (const id of pinned) await ext.tabs.update(id, { pinned: true }).catch(() => {});
    }
    if (rest.length > 0) {
      await ext.tabs.move(rest, { windowId: here.id, index: -1 });
    }
    return elsewhere.length;
  } catch {
    return 0;
  }
}
