/**
 * Rendering. Every node is built with `document.createElement` and text is set
 * through `textContent`.
 *
 * There is no `innerHTML` anywhere in this file and that is deliberate: every
 * string here — a name, a description, an author's handle — was typed by a
 * stranger and is being displayed to everyone else. One template literal is
 * all it takes for that to become stored XSS, and the way not to have that
 * bug is to make it unexpressible rather than to remember to escape.
 */
import type { Detail, Listing, Pack } from "./api";

export function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** A count, shortened once it stops being worth reading digit by digit. */
export function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function relTime(unixSecs: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - unixSecs);
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m ago`;
  if (d < 86_400) return `${Math.round(d / 3600)}h ago`;
  if (d < 30 * 86_400) return `${Math.round(d / 86_400)}d ago`;
  return new Date(unixSecs * 1000).toLocaleDateString([], { month: "short", year: "numeric" });
}

/**
 * A media URL we are willing to put in a `src`.
 *
 * The server validates this too. Doing it again here is not redundancy for
 * its own sake: this page may one day render a pack from somewhere else, and
 * an `https`-only check costs one comparison.
 */
export function safeMedia(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function heart(filled: boolean): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("fill", filled ? "currentColor" : "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute(
    "d",
    "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z",
  );
  svg.append(p);
  return svg;
}

function download(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"]) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/** One card in the grid. */
export function listingCard(l: Listing, onOpen: (id: string) => void): HTMLElement {
  const card = el("article", "listing");
  card.tabIndex = 0;
  card.setAttribute("role", "link");

  const img = safeMedia(l.image);
  if (img) {
    const cover = el("div", "cover");
    const im = document.createElement("img");
    im.src = img;
    im.alt = "";
    im.loading = "lazy";
    // A cover that fails to load must leave a tidy card, not a broken icon.
    im.addEventListener("error", () => cover.remove());
    cover.append(im);
    card.append(cover);
  }

  const head = el("div", "listing-head");
  head.append(el("h3", "listing-name", l.name));
  if (l.kind === "theme") head.append(el("span", "kind", "theme"));
  card.append(head);

  card.append(el("p", "listing-desc", l.description));

  if (l.tags.length) {
    const tags = el("div", "tags");
    for (const t of l.tags.slice(0, 4)) tags.append(el("span", "tag", t));
    card.append(tags);
  }

  const foot = el("div", "listing-foot");
  foot.append(el("span", "author", l.author || "anonymous"));

  const stats = el("div", "stats");
  const likes = el("span", "stat");
  likes.append(heart(false), el("span", undefined, compact(l.likes)));
  likes.title = `${l.likes} likes`;
  const installs = el("span", "stat");
  installs.append(download(), el("span", undefined, compact(l.installs)));
  installs.title = `${l.installs} installs`;
  stats.append(likes, installs);
  foot.append(stats);
  card.append(foot);

  const open = () => onOpen(l.id);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  return card;
}

/** What a pack will actually add, spelled out before anyone installs it. */
export function packContents(pack: Pack): HTMLElement {
  const box = el("div", "contents");
  box.append(el("h4", undefined, "What this adds"));

  if (pack.kind === "theme" && pack.theme) {
    const list = el("ul", "contents-list");
    list.append(el("li", undefined, `Base palette: ${pack.theme.base}`));
    if (pack.theme.font) list.append(el("li", undefined, `Font: ${pack.theme.font}`));
    if (pack.theme.mono) list.append(el("li", undefined, `Monospace: ${pack.theme.mono}`));
    const swatches = el("div", "swatches");
    for (const [name, value] of Object.entries(pack.theme.colors)) {
      const s = el("span", "swatch");
      s.title = `${name}: ${value}`;
      // A colour the server already validated; `style` rather than a class
      // because the value is data.
      s.style.background = value;
      swatches.append(s);
    }
    if (swatches.childElementCount) list.append(el("li", undefined, "Colours:"), swatches);
    box.append(list);
    return box;
  }

  const list = el("ul", "contents-list");
  for (const inst of pack.instances) {
    const li = el("li");
    li.append(el("strong", undefined, inst.name), document.createTextNode(` — ${inst.def}`));
    const sources = (inst.opts?.sources as unknown[]) ?? [];
    const query = String(inst.opts?.query ?? "");
    const bits: string[] = [];
    if (query) bits.push(`query “${query}”`);
    if (sources.length) bits.push(`${sources.length} source${sources.length > 1 ? "s" : ""}`);
    if (bits.length) li.append(el("span", "muted", ` · ${bits.join(", ")}`));
    list.append(li);
  }
  box.append(list);

  // The sources themselves, because "12 sources" is a number and the thing
  // people want to know is which twelve.
  const urls = pack.instances
    .flatMap((i) => ((i.opts?.sources as Binding[]) ?? []))
    .map((b) => b?.url || b?.tmpl || "")
    .filter(Boolean);
  if (urls.length) {
    const d = el("details", "sources");
    d.append(el("summary", undefined, `See all ${urls.length} sources`));
    const ul = el("ul", "contents-list");
    for (const u of urls) ul.append(el("li", "muted", u));
    d.append(ul);
    box.append(d);
  }
  return box;
}

interface Binding {
  url?: string;
  tmpl?: string;
}

/** The detail panel. */
export function detailView(
  d: Detail,
  handlers: {
    onLike: (on: boolean) => void;
    onInstall: () => void;
    onBack: () => void;
    onTag: (tag: string) => void;
  },
): HTMLElement {
  const wrap = el("div", "detail");

  const back = el("button", "linkish", "← All packs");
  back.addEventListener("click", handlers.onBack);
  wrap.append(back);

  const head = el("header", "detail-head");
  head.append(el("h1", undefined, d.listing.name));
  const by = el("p", "muted");
  by.append(
    document.createTextNode(`by ${d.listing.author || "anonymous"} · `),
    el("span", undefined, relTime(d.listing.published)),
  );
  if (d.listing.updated > d.listing.published + 60) {
    by.append(document.createTextNode(` · updated ${relTime(d.listing.updated)}`));
  }
  head.append(by);
  wrap.append(head);

  const media = el("div", "media");
  const img = safeMedia(d.listing.image);
  if (img) {
    const im = document.createElement("img");
    im.src = img;
    im.alt = "";
    im.addEventListener("error", () => im.remove());
    media.append(im);
  }
  const vid = safeMedia(d.listing.video);
  if (vid) {
    // A frame rather than a <video>: a publisher's link is usually to a host
    // that serves a player, not a raw file, and guessing wrong shows a broken
    // element instead of the thing they meant to show.
    const frame = document.createElement("iframe");
    frame.src = vid;
    frame.title = `${d.listing.name} video`;
    frame.loading = "lazy";
    frame.setAttribute("allowfullscreen", "");
    // Third-party content in a frame on our origin gets no more than it needs.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
    frame.setAttribute("referrerpolicy", "no-referrer");
    media.append(frame);
  }
  if (media.childElementCount) wrap.append(media);

  wrap.append(el("p", "detail-desc", d.listing.description));

  if (d.listing.tags.length) {
    const tags = el("div", "tags");
    for (const t of d.listing.tags) {
      const b = el("button", "tag", t);
      b.addEventListener("click", () => handlers.onTag(t));
      tags.append(b);
    }
    wrap.append(tags);
  }

  const actions = el("div", "actions");

  const install = el("button", "btn primary", "Add to OpenTabs");
  install.addEventListener("click", handlers.onInstall);
  actions.append(install);

  const likeBtn = el("button", `btn like${d.liked ? " on" : ""}`);
  const likeCount = el("span", undefined, compact(d.listing.likes));
  likeBtn.append(heart(!!d.liked), likeCount);
  likeBtn.title =
    d.liked === null ? "Sign in to like this" : d.liked ? "Remove your like" : "Like this pack";
  likeBtn.addEventListener("click", () => handlers.onLike(!d.liked));
  actions.append(likeBtn);

  const installs = el("span", "stat muted");
  installs.append(download(), el("span", undefined, `${compact(d.listing.installs)} installs`));
  actions.append(installs);
  wrap.append(actions);

  wrap.append(packContents(d.pack));
  return wrap;
}

/** An empty state that says which of the several reasons applies. */
export function emptyState(message: string, action?: { label: string; run: () => void }): HTMLElement {
  const box = el("div", "empty");
  box.append(el("p", undefined, message));
  if (action) {
    const b = el("button", "btn", action.label);
    b.addEventListener("click", action.run);
    box.append(b);
  }
  return box;
}
