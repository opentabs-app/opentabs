/**
 * The marketplace site.
 *
 * Three views, one page: a grid, a detail panel, and the sign-in state. The
 * route lives in the URL — `#/`, `#/trending`, `#/pack/<id>` — so a listing
 * can be linked to, which is most of what a marketplace is for.
 */
import * as api from "./api";
import * as auth from "./auth";
import { detailView, el, emptyState, listingCard } from "./render";
import "./styles.css";

type Sort = "trending" | "top" | "new";

interface View {
  route: "browse" | "detail";
  id?: string;
  sort: Sort;
  q: string;
  tag: string | null;
}

const state: View = { route: "browse", sort: "trending", q: "", tag: null };

const $ = (id: string) => document.getElementById(id)!;

// ---------- routing ----------

function readRoute(): View {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path = "/", rawQuery] = hash.split("?");
  const params = new URLSearchParams(rawQuery ?? "");
  const parts = path.split("/").filter(Boolean);

  if (parts[0] === "pack" && parts[1]) {
    return { ...state, route: "detail", id: decodeURIComponent(parts[1]) };
  }
  const sort: Sort =
    parts[0] === "top" ? "top" : parts[0] === "new" ? "new" : "trending";
  return {
    route: "browse",
    id: undefined,
    sort,
    q: params.get("q") ?? "",
    tag: params.get("tag"),
  };
}

function go(path: string) {
  location.hash = path;
}

// ---------- browse ----------

let inFlight = 0;

async function renderBrowse() {
  const view = $("view");
  const mine = ++inFlight;
  view.replaceChildren(el("div", "loading", "Loading…"));

  const res = await api.browse({ q: state.q, tag: state.tag, sort: state.sort });
  // A slower earlier request must not overwrite a faster later one.
  if (mine !== inFlight) return;

  if (!res.ok) {
    view.replaceChildren(
      emptyState(res.message, { label: "Try again", run: () => void renderBrowse() }),
    );
    return;
  }

  drawTags(res.tags);

  if (res.listings.length === 0) {
    // Naming which of the reasons applies, rather than one blank shrug for
    // "nothing published yet", "nothing matches" and "nothing under that tag".
    const why = state.q
      ? `Nothing matches “${state.q}”.`
      : state.tag
        ? `Nothing tagged “${state.tag}” yet.`
        : "No packs have been published yet. Yours could be the first.";
    view.replaceChildren(
      emptyState(
        why,
        state.q || state.tag
          ? {
              label: "Clear the filters",
              run: () => {
                state.q = "";
                state.tag = null;
                ($("search") as HTMLInputElement).value = "";
                go(`/${state.sort}`);
              },
            }
          : undefined,
      ),
    );
    return;
  }

  const grid = el("div", "grid");
  for (const l of res.listings) {
    grid.append(listingCard(l, (id) => go(`/pack/${encodeURIComponent(id)}`)));
  }
  view.replaceChildren(grid);

  const count = el("p", "muted count", `${res.total} pack${res.total === 1 ? "" : "s"} published`);
  view.append(count);
}

function drawTags(tags: { tag: string; count: number }[]) {
  const row = $("tagrow");
  row.replaceChildren();
  if (tags.length === 0) return;

  const all = el("button", `tag${state.tag ? "" : " on"}`, "All");
  all.addEventListener("click", () => {
    state.tag = null;
    go(`/${state.sort}`);
  });
  row.append(all);

  for (const t of tags) {
    const b = el("button", `tag${state.tag === t.tag ? " on" : ""}`, `${t.tag} ${t.count}`);
    b.addEventListener("click", () => {
      state.tag = t.tag;
      const p = new URLSearchParams();
      p.set("tag", t.tag);
      if (state.q) p.set("q", state.q);
      go(`/${state.sort}?${p}`);
    });
    row.append(b);
  }
}

// ---------- detail ----------

async function renderDetail(id: string) {
  const view = $("view");
  const mine = ++inFlight;
  view.replaceChildren(el("div", "loading", "Loading…"));

  const res = await api.detail(id);
  if (mine !== inFlight) return;

  if (!res.ok) {
    view.replaceChildren(
      emptyState(
        res.status === 404 ? "That pack is not here — it may have been withdrawn." : res.message,
        { label: "← All packs", run: () => go(`/${state.sort}`) },
      ),
    );
    return;
  }

  const draw = (d: api.Detail) => {
    view.replaceChildren(
      detailView(d, {
        onBack: () => go(`/${state.sort}`),
        onTag: (tag) => {
          state.tag = tag;
          go(`/${state.sort}?tag=${encodeURIComponent(tag)}`);
        },
        onInstall: () => install(d),
        onLike: async (on) => {
          // Sign in *here*, rather than telling someone to find the button
          // in the header and come back. The intent is already expressed.
          if (!api.signedIn() && !(await auth.signIn())) return;
          drawAuth();
          const r = await api.like(d.listing.id, on);
          if (!r.ok) return toast(r.message);
          // Redrawn from the server's count, not an optimistic guess: two
          // devices and one account should not disagree about the number.
          draw({ ...d, liked: r.liked, listing: { ...d.listing, likes: r.likes } });
        },
      }),
    );
  };
  draw(res);
  document.title = `${res.listing.name} — OpenTabs packs`;
}

/**
 * Hand a pack to the extension.
 *
 * The extension listens for this message on its own settings page. If it is
 * not installed nothing answers, so after a moment the site falls back to
 * showing the address to paste — which works whatever browser this is.
 */
function install(d: api.Detail) {
  const url = api.installUrl(d.listing.id);
  let answered = false;

  const onReply = (e: MessageEvent) => {
    if (e.data?.type === "opentabs:installed") {
      answered = true;
      toast(`Added “${d.listing.name}” to OpenTabs.`);
      window.removeEventListener("message", onReply);
    }
  };
  window.addEventListener("message", onReply);
  window.postMessage({ type: "opentabs:install", url, id: d.listing.id }, location.origin);

  setTimeout(() => {
    if (answered) return;
    window.removeEventListener("message", onReply);
    showInstallFallback(d, url);
  }, 700);
}

function showInstallFallback(d: api.Detail, url: string) {
  const dlg = el("div", "modal");
  const box = el("div", "modal-box");
  box.append(el("h3", undefined, "Add it by hand"));
  box.append(
    el(
      "p",
      "muted",
      "OpenTabs did not answer — it may not be installed in this browser. " +
        "Copy this address, then paste it into Settings → Marketplace.",
    ),
  );
  const field = document.createElement("input");
  field.readOnly = true;
  field.value = url;
  field.addEventListener("focus", () => field.select());
  box.append(field);

  const row = el("div", "row-actions");
  const copy = el("button", "btn primary", "Copy address");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = "Copied";
    } catch {
      field.select();
      copy.textContent = "Press ⌘C";
    }
  });
  const close = el("button", "btn", "Close");
  const dismiss = () => dlg.remove();
  close.addEventListener("click", dismiss);
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dismiss();
  });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") {
      dismiss();
      document.removeEventListener("keydown", esc);
    }
  });
  row.append(copy, close);
  box.append(row);
  dlg.append(box);
  document.body.append(dlg);
  field.focus();
  void d;
}

// ---------- chrome ----------

function toast(message: string) {
  const t = $("toast");
  t.textContent = message;
  t.classList.add("on");
  window.setTimeout(() => t.classList.remove("on"), 2600);
}

function drawSort() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#sortnav button")) {
    b.classList.toggle("on", b.dataset.sort === state.sort);
  }
}

function drawAuth() {
  const btn = $("auth") as HTMLButtonElement;
  btn.textContent = api.signedIn() ? "Sign out" : "Sign in";
}

/**
 * Sign in, or out.
 *
 * The form itself is `<openapps-login>` from the platform — see `auth.ts`
 * for why it is the shared element rather than a button of our own, and why
 * none of it is downloaded until this is pressed.
 */
function toggleAuth() {
  if (api.signedIn()) {
    auth.signOut();
    drawAuth();
    void route();
    return;
  }
  void auth.signIn().then((token) => {
    drawAuth();
    if (token) {
      toast("Signed in.");
      // Redrawn because the answer to "have you liked this" changes with the
      // session, and a stale outline heart on a pack you have liked is the
      // kind of thing that gets liked twice.
      void route();
    }
  });
}

async function route() {
  Object.assign(state, readRoute());
  drawSort();
  ($("search") as HTMLInputElement).value = state.q;
  if (state.route === "detail" && state.id) {
    await renderDetail(state.id);
  } else {
    document.title = "OpenTabs packs";
    await renderBrowse();
  }
}

function main() {
  api.restoreToken();
  drawAuth();

  for (const b of document.querySelectorAll<HTMLButtonElement>("#sortnav button")) {
    b.addEventListener("click", () => {
      const p = new URLSearchParams();
      if (state.q) p.set("q", state.q);
      if (state.tag) p.set("tag", state.tag);
      const qs = p.toString();
      go(`/${b.dataset.sort}${qs ? `?${qs}` : ""}`);
    });
  }

  const search = $("search") as HTMLInputElement;
  let timer: number | undefined;
  search.addEventListener("input", () => {
    // Debounced: a request per keystroke is a request per keystroke.
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const p = new URLSearchParams();
      if (search.value.trim()) p.set("q", search.value.trim());
      if (state.tag) p.set("tag", state.tag);
      const qs = p.toString();
      go(`/${state.sort}${qs ? `?${qs}` : ""}`);
    }, 250);
  });

  $("auth").addEventListener("click", toggleAuth);
  window.addEventListener("hashchange", () => void route());
  void route();
}

main();
