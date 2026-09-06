/**
 * User-arranged layout: drag to reorder, drag to resize, collapse, maximise.
 *
 * Two decisions worth stating.
 *
 * **Resizing snaps to grid columns rather than pixels.** The grid is
 * responsive (`auto-fit, minmax(320px, 1fr)`), so a card sized in pixels is
 * wrong the moment the window changes — and a "700px" card on a narrow laptop
 * is simply broken. A span of 1–3 columns, or full width, survives every
 * viewport.
 *
 * **State lives in the config document**, not `localStorage`, so a layout
 * moves with the config string like everything else (D4) and an agent can
 * write it (A3).
 *
 * This runs on the new tab page, so it does no network and no wasm — it
 * mutates the DOM and persists a small object. The paint path stays clean.
 */
import { ext, KEY, getSync, setSync } from "../lib/ext";
import type { Config } from "../lib/types";

export type Span = 1 | 2 | 3 | "full";

/** Grid row unit and the margin separating cards. Must match main.css. */
const ROW = 8;
const GAP = 16;

/** Smallest useful card: header plus a couple of lines. */
const MIN_ROWS = 8;

/**
 * Give every card a row span matching its content, so short cards stop
 * reserving the height of the tallest card in their row.
 *
 * Measured rather than declared, because content height is only known after
 * layout — a topic with three headlines and one with ten are different sizes
 * and neither is knowable up front.
 */
export function packGrid(grid: HTMLElement): void {
  for (const card of grid.querySelectorAll<HTMLElement>(".card")) {
    if (card.dataset.rows) {
      // A height the user set explicitly wins over the measured one.
      const rows = Number(card.dataset.rows);
      card.style.gridRow = `span ${rows}`;
      card.style.height = `${rows * ROW - GAP}px`;
      card.classList.add("fixedheight");
      continue;
    }
    card.classList.remove("fixedheight");
    card.style.height = "";
    // Read the natural height with no span applied, then round up to rows.
    card.style.gridRow = "";
    const h = card.getBoundingClientRect().height;
    card.style.gridRow = `span ${Math.max(MIN_ROWS, Math.ceil((h + GAP) / ROW))}`;
  }
}

/**
 * Re-pack when anything changes size: a feed arriving, a card collapsing, the
 * window resizing, a font finishing loading. Batched into one frame so a
 * dozen observations do not become a dozen layout passes.
 */
export function watchGrid(grid: HTMLElement): void {
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      packGrid(grid);
    });
  };

  const ro = new ResizeObserver(schedule);
  for (const card of grid.querySelectorAll<HTMLElement>(".card")) {
    // Observe the body, not the card: observing the card would see the height
    // this very function sets and loop.
    const body = card.querySelector(".card-body");
    if (body) ro.observe(body);
  }
  window.addEventListener("resize", schedule);
  document.fonts?.ready.then(schedule).catch(() => {});
}

/** Persist a single instance's layout options without disturbing the rest. */
async function patchOpts(id: string, patch: Record<string, unknown>): Promise<void> {
  const cfg = await getSync<Config | null>(KEY.config, null);
  if (!cfg) return;
  const inst = cfg.instances.find((i) => i.id === id);
  if (!inst) return;
  inst.opts = { ...inst.opts, ...patch };
  await setSync(KEY.config, cfg);
}

/** Persist the order the cards are currently in. */
async function persistOrder(order: string[]): Promise<void> {
  const cfg = await getSync<Config | null>(KEY.config, null);
  if (!cfg) return;
  const rank = new Map(order.map((id, i) => [id, i]));
  // Instances with no card (disabled ones) keep their relative position at
  // the end rather than being shuffled by a sort that cannot see them.
  cfg.instances.sort(
    (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  await setSync(KEY.config, cfg);
}

function currentOrder(grid: HTMLElement): string[] {
  return [...grid.querySelectorAll<HTMLElement>(".card[data-id]")].map((c) => c.dataset.id!);
}

const SPANS: Span[] = [1, 2, 3, "full"];

function applySpan(card: HTMLElement, span: Span) {
  card.dataset.span = String(span);
}

/**
 * Wire one card. `span` and `collapsed` come from the instance's options, so
 * a reload restores exactly what the user arranged.
 */
export function makeArrangeable(
  card: HTMLElement,
  id: string,
  opts: { span?: Span; collapsed?: boolean; rows?: number },
  grid: HTMLElement,
): void {
  card.dataset.id = id;
  applySpan(card, opts.span ?? 1);
  if (opts.rows) card.dataset.rows = String(opts.rows);
  if (opts.collapsed) card.classList.add("collapsed");

  const head = card.querySelector(".card-head");
  if (!head) return;

  // --- grip: the only place a drag can start, so links stay clickable ---
  const grip = document.createElement("span");
  grip.className = "grip";
  grip.textContent = "⠿";
  grip.title = "Drag to move";
  grip.addEventListener("pointerdown", () => {
    card.draggable = true;
  });
  grip.addEventListener("pointerup", () => {
    card.draggable = false;
  });
  head.prepend(grip);

  // --- collapse / maximise ---
  const ctl = document.createElement("span");
  ctl.className = "cardctl";

  const min = document.createElement("button");
  min.type = "button";
  min.title = "Minimise";
  min.setAttribute("aria-label", "Minimise");
  min.textContent = "–";
  min.addEventListener("click", () => {
    const collapsed = card.classList.toggle("collapsed");
    min.textContent = collapsed ? "+" : "–";
    min.title = collapsed ? "Expand" : "Minimise";
    // A collapsed card must shrink its row span too, or it leaves behind the
    // hole it was filling.
    delete card.dataset.rows;
    packGrid(grid);
    void patchOpts(id, { collapsed, rows: 0 });
  });
  if (opts.collapsed) {
    min.textContent = "+";
    min.title = "Expand";
  }

  const max = document.createElement("button");
  max.type = "button";
  max.title = "Maximise";
  max.setAttribute("aria-label", "Maximise");
  max.textContent = "⤢";
  max.addEventListener("click", () => {
    const next: Span = card.dataset.span === "full" ? 1 : "full";
    applySpan(card, next);
    packGrid(grid);
    void patchOpts(id, { span: next });
  });

  // --- settings for this group, deep-linked ---
  //
  // The gear is per-card and carries the card's id, so it lands on the editor
  // for *this* group rather than on a settings page the reader then has to
  // search. A new tab rather than a navigation: the new tab page is somewhere
  // people leave open, and replacing it with settings loses whatever else is
  // on it.
  const gear = document.createElement("button");
  gear.type = "button";
  gear.title = "Edit this group";
  gear.setAttribute("aria-label", "Edit this group");
  gear.className = "gear";
  gear.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 ' +
    "1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 " +
    "19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 " +
    "15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 " +
    "0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 " +
    "1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 " +
    "2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.61.77 1 1.42 1H21a2 2 0 1 1 0 " +
    '4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  gear.addEventListener("click", () => {
    const url = ext.runtime.getURL(`settings.html#i=${encodeURIComponent(id)}`);
    void ext.tabs.create({ url }).catch(() => {
      window.open(url, "_blank", "noopener");
    });
  });

  ctl.append(gear, min, max);
  head.append(ctl);

  // --- resizing: right edge for width, bottom for height, corner for both ---
  //
  // Width snaps to columns; height is free, because vertical space has no
  // grid to snap to and "a bit taller" is a real thing to want. Both persist.
  const startWidthDrag = (e: PointerEvent, el: HTMLElement) => {
    const startX = e.clientX;
    const startSpan = card.dataset.span === "full" ? 4 : Number(card.dataset.span ?? 1);
    const step = card.getBoundingClientRect().width / Math.max(1, startSpan) + GAP;
    return (ev: PointerEvent) => {
      const delta = Math.round((ev.clientX - startX) / step);
      const idx = Math.min(SPANS.length - 1, Math.max(0, startSpan - 1 + delta));
      applySpan(card, SPANS[idx]!);
      packGrid(grid);
      void el;
    };
  };

  const startHeightDrag = (e: PointerEvent) => {
    const startY = e.clientY;
    const startH = card.getBoundingClientRect().height;
    return (ev: PointerEvent) => {
      const h = Math.max(MIN_ROWS * ROW, startH + (ev.clientY - startY));
      const rows = Math.max(MIN_ROWS, Math.round((h + GAP) / ROW));
      card.dataset.rows = String(rows);
      packGrid(grid);
    };
  };

  const handle = (cls: string, title: string, axes: "x" | "y" | "xy") => {
    const el = document.createElement("div");
    el.className = cls;
    el.title = title;
    card.append(el);
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      const moves = [
        axes !== "y" ? startWidthDrag(e, el) : null,
        axes !== "x" ? startHeightDrag(e) : null,
      ].filter(Boolean) as ((ev: PointerEvent) => void)[];

      const move = (ev: PointerEvent) => {
        for (const m of moves) m(ev);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        const span = card.dataset.span === "full" ? "full" : (Number(card.dataset.span) as Span);
        void patchOpts(id, {
          span,
          rows: card.dataset.rows ? Number(card.dataset.rows) : 0,
        });
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
    // Double-click any handle to hand the axis back to automatic sizing.
    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      delete card.dataset.rows;
      packGrid(grid);
      void patchOpts(id, { rows: 0 });
    });
    return el;
  };

  handle("resizer", "Drag to change width", "x");
  handle("resizer-y", "Drag to change height · double-click to fit content", "y");
  handle("resizer-xy", "Drag to resize · double-click to fit content", "xy");

  // --- drag to reorder ---
  card.addEventListener("dragstart", (e) => {
    card.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    card.draggable = false;
    for (const c of grid.querySelectorAll(".card")) {
      c.classList.remove("dropbefore", "dropafter");
    }
    void persistOrder(currentOrder(grid));
    void ext.runtime.sendMessage({ type: "refresh" }).catch(() => {});
  });

  card.addEventListener("dragover", (e) => {
    const dragging = grid.querySelector<HTMLElement>(".card.dragging");
    if (!dragging || dragging === card) return;
    e.preventDefault();
    const box = card.getBoundingClientRect();
    const after = e.clientX > box.left + box.width / 2;
    card.classList.toggle("dropafter", after);
    card.classList.toggle("dropbefore", !after);
    // Move live, so the layout you see while dragging is the one you get.
    if (after) card.after(dragging);
    else card.before(dragging);
  });

  card.addEventListener("dragleave", () => {
    card.classList.remove("dropbefore", "dropafter");
  });
  card.addEventListener("drop", (e) => e.preventDefault());
}
