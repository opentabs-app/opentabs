/**
 * The Marketplace pane's DOM.
 *
 * Split from `settings.ts` because that file is already the biggest thing in
 * the extension, and because this pane is the one part of Settings that talks
 * to a server — keeping it separate makes "what does Settings send anywhere"
 * a question with a one-file answer.
 *
 * No `innerHTML` anywhere. Every string rendered here — a name, a
 * description, an author's handle — was typed by a stranger and is being
 * shown inside the extension's own pages, which is the most privileged place
 * it could possibly land.
 */
import { ext } from "../lib/ext";
import { OPENAPPS_MATCH } from "../lib/openapps";
import type { Config } from "../lib/types";
import * as market from "./market";

type Deps = {
  el: (tag: string, cls?: string, text?: string) => HTMLElement;
  $: (id: string) => HTMLElement;
  toast: (m: string) => void;
  cfg: () => Config;
  afterInstall: () => void;
};

let sort = "trending";
let tag: string | null = null;
let query = "";
let loaded = false;

export function initMarketPane(d: Deps) {
  for (const b of d.$("marketsort").querySelectorAll<HTMLButtonElement>("button")) {
    b.addEventListener("click", () => {
      sort = b.dataset.sort ?? "trending";
      for (const other of d.$("marketsort").querySelectorAll("button")) {
        other.classList.toggle("on", other === b);
      }
      void draw(d);
    });
  }

  const search = d.$("marketsearch") as HTMLInputElement;
  let timer: number | undefined;
  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      query = search.value.trim();
      void draw(d);
    }, 250);
  });

  d.$("packload").addEventListener("click", () => {
    const input = d.$("packpaste") as HTMLInputElement;
    void loadPasted(d, input.value);
  });
}

/** Called when the pane is shown. Asks for access the first time only. */
export async function showMarketPane(d: Deps) {
  const granted = await market.hasAccess();
  d.$("marketaccess").hidden = granted;
  if (!granted) {
    const note = d.$("marketaccess");
    if (!note.querySelector("button")) {
      const ask = d.el("button", "btn", "Allow the marketplace");
      // Requested from this click. An await before `permissions.request`
      // spends the user activation and the prompt silently never appears.
      ask.addEventListener("click", () => {
        void ext.permissions
          .request({ origins: [market.MARKET_API] })
          .then((ok) => {
            if (!ok) return d.toast("Access declined — the marketplace cannot load.");
            d.$("marketaccess").hidden = true;
            // Now that the origin is granted, the worker can register the
            // relay that makes "Add to OpenTabs" work on the website itself.
            // Asking here rather than at the next browser start is the
            // difference between that button working today and tomorrow.
            void ext.runtime.sendMessage({ type: "ensureRelays" }).catch(() => {});
            void draw(d);
          })
          .catch(() => {});
      });
      note.append(document.createElement("br"), ask);
    }
    d.$("marketlist").replaceChildren();
    return;
  }
  if (!loaded) {
    loaded = true;
    await draw(d);
  }
}

async function draw(d: Deps) {
  const list = d.$("marketlist");
  list.replaceChildren(d.el("div", "hint", "Loading…"));

  const res = await market.browse({ q: query, sort, tag });
  if (!res.ok) {
    list.replaceChildren(d.el("div", "warn", res.message));
    return;
  }

  drawTags(d, res.data.tags);

  if (res.data.listings.length === 0) {
    list.replaceChildren(
      d.el(
        "div",
        "hint",
        query
          ? `Nothing matches “${query}”.`
          : tag
            ? `Nothing tagged “${tag}” yet.`
            : "No packs published yet. Yours could be the first — open a group and press Share.",
      ),
    );
    return;
  }

  const box = d.el("div");
  for (const l of res.data.listings) box.append(row(d, l));
  list.replaceChildren(box);
}

function drawTags(d: Deps, tags: { tag: string; count: number }[]) {
  const row = d.$("markettags");
  row.replaceChildren();
  if (tags.length === 0) return;

  const all = d.el("button", `tag${tag ? "" : " on"}`, "All");
  all.addEventListener("click", () => {
    tag = null;
    void draw(d);
  });
  row.append(all);
  for (const t of tags.slice(0, 12)) {
    const b = d.el("button", `tag${tag === t.tag ? " on" : ""}`, `${t.tag} ${t.count}`);
    b.addEventListener("click", () => {
      tag = tag === t.tag ? null : t.tag;
      void draw(d);
    });
    row.append(b);
  }
}

function row(d: Deps, l: market.Listing): HTMLElement {
  const box = d.el("div", "titem");
  const head = d.el("div", "titem-head");
  head.append(d.el("span", "gitem-name", l.name));
  if (l.kind === "theme") head.append(d.el("span", "gitem-def", "theme"));
  head.append(d.el("span", "gitem-def", `♥ ${l.likes} · ↓ ${l.installs}`));

  const add = d.el("button", "btn", "Add") as HTMLButtonElement;
  add.addEventListener("click", () => {
    add.disabled = true;
    add.textContent = "Adding…";
    void addPack(d, l.id).finally(() => {
      add.disabled = false;
      add.textContent = "Add";
    });
  });
  head.append(add);
  box.append(head);

  box.append(d.el("div", "hint", l.description));
  const by = d.el("div", "hint", `by ${l.author || "anonymous"}`);
  box.append(by);
  return box;
}

async function addPack(d: Deps, id: string) {
  const got = await market.fetchPack(id);
  if (!got.ok) return d.toast(got.message);
  await applyAndReport(d, got.data);
}

async function applyAndReport(d: Deps, pack: market.Pack) {
  const res = await market.install(pack);
  if (res.problems.length > 0) {
    return d.toast(res.problems[0]!.message);
  }
  if (!res.ok) return d.toast("That pack could not be added.");

  // Naming what happened, because "renamed" is the surprising case and a
  // silent rename is how someone concludes the install did nothing.
  if (res.themeApplied) d.toast("Theme applied.");
  else if (res.renamed.length > 0) {
    d.toast(`Added as “${res.renamed[0]}” — you already had one with that name.`);
  } else {
    d.toast(`Added “${res.added[0] ?? "pack"}”.`);
  }
  d.afterInstall();
}

async function loadPasted(d: Deps, raw: string) {
  const preview = d.$("packpreview");
  preview.replaceChildren();
  if (!raw.trim()) return;

  const got = await market.fetchPastedPack(raw);
  if (!got.ok) {
    preview.replaceChildren(d.el("div", "warn", got.message));
    return;
  }
  const pack = got.data;

  // Shown before it is applied. A pack is a document from a stranger, and
  // "press this and find out" is not a reasonable thing to ask of one.
  const box = d.el("div", "titem");
  box.append(d.el("div", "gitem-name", pack.name || "Untitled pack"));
  box.append(d.el("div", "hint", pack.description || "No description."));
  const list = d.el("ul", "contents-list");
  if (pack.kind === "theme" && pack.theme) {
    list.append(d.el("li", undefined, `Theme, base ${pack.theme.base}`));
    if (pack.theme.font) list.append(d.el("li", undefined, `Font ${pack.theme.font}`));
  } else {
    for (const inst of pack.instances ?? []) {
      list.append(d.el("li", undefined, `${inst.name} — ${inst.def}`));
    }
  }
  box.append(list);

  const add = d.el("button", "btn primary", "Add to OpenTabs");
  add.addEventListener("click", () => {
    void applyAndReport(d, pack).then(() => {
      preview.replaceChildren();
      (d.$("packpaste") as HTMLInputElement).value = "";
    });
  });
  box.append(add);
  preview.replaceChildren(box);
}

// ---------- publishing ----------

/**
 * The Share dialog for one group.
 *
 * Two ways out, deliberately: publish to the marketplace, which needs an
 * account, or copy the pack and send it to somebody. The second needs no
 * account at all, and a sharing feature that *only* works signed in is one
 * most people will never use.
 */
export function openShareDialog(d: Deps, instanceId: string) {
  const inst = d.cfg().instances.find((i) => i.id === instanceId);
  if (!inst) return;

  const dlg = d.el("div", "modal");
  const box = d.el("div", "modal-box");
  box.append(d.el("h3", undefined, `Share “${inst.name}”`));
  box.append(
    d.el(
      "p",
      "hint",
      "Your API keys, calendar addresses, coordinates and card sizes are stripped out " +
        "before anything leaves this browser. What is shared is the sources and the query.",
    ),
  );

  const nameField = d.el("div", "field");
  nameField.append(d.el("label", undefined, "Your name, as it should appear"));
  const author = document.createElement("input");
  author.placeholder = "a handle, not your email";
  author.value = localStorage.getItem("opentabs:author") ?? "";
  nameField.append(author);
  box.append(nameField);

  const descField = d.el("div", "field");
  descField.append(d.el("label", undefined, "What is this for?"));
  const desc = document.createElement("textarea");
  desc.rows = 3;
  desc.placeholder = "A sentence or two. Listings with no description are the ones nobody installs.";
  descField.append(desc);
  box.append(descField);

  const status = d.el("div", "hint");
  box.append(status);

  const row = d.el("div", "row-actions");

  const copy = d.el("button", "btn", "Copy the pack");
  copy.addEventListener("click", () => {
    void market
      .packFrom(d.cfg(), instanceId, author.value.trim(), desc.value.trim())
      .then(async (pack) => {
        if (!pack) return void (status.textContent = "This group cannot be shared.");
        await navigator.clipboard.writeText(JSON.stringify(pack, null, 2));
        copy.textContent = "Copied";
        status.textContent = "Send it to anyone — they paste it into Marketplace.";
      });
  });

  const pub = d.el("button", "btn primary", "Publish") as HTMLButtonElement;
  pub.addEventListener("click", () => {
    // Everything before `permissions.request` must be synchronous. One
    // `await` spends the user activation and the prompt then never appears —
    // no error, no dialog, just a button that does nothing.
    if (desc.value.trim().length < 10) {
      status.textContent = "Say what it is for first — a listing without that is noise.";
      return;
    }
    status.textContent = "";
    pub.disabled = true;
    pub.textContent = "Publishing…";
    // Already granted resolves immediately with no prompt, so this is safe
    // to call every time — and calling it every time is what keeps it first.
    void ext.permissions
      .request({ origins: [OPENAPPS_MATCH, market.MARKET_API] })
      .then((ok) => (ok ? doPublish() : Promise.reject(new Error("declined"))))
      .catch((e: Error) => {
        status.textContent =
          e.message === "declined"
            ? "Publishing needs access to your OpenApps account. Copying the pack does not."
            : "That did not go through.";
      })
      .finally(() => {
        pub.disabled = false;
        pub.textContent = "Publish";
      });
  });

  async function doPublish() {
    const pack = await market.packFrom(d.cfg(), instanceId, author.value.trim(), desc.value.trim());
    if (!pack) {
      status.textContent = "This group cannot be shared.";
      return;
    }
    localStorage.setItem("opentabs:author", author.value.trim());

    status.textContent = "Signing in…";
    const token = await signIn();
    if (!token) {
      status.textContent = "Publishing needs an OpenApps account. Copying the pack does not.";
      return;
    }

    status.textContent = "Publishing…";
    const res = await market.publish(pack, token);
    if (!res.ok) {
      status.textContent = res.problems?.[0]?.message ?? res.message;
      return;
    }
    status.textContent = "Published.";
    d.toast(`“${pack.name}” is on the marketplace.`);
  }

  const close = d.el("button", "btn", "Close");
  const dismiss = () => dlg.remove();
  close.addEventListener("click", dismiss);
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dismiss();
  });
  row.append(pub, copy, close);
  box.append(row);
  dlg.append(box);
  document.body.append(dlg);
  author.focus();
}

/**
 * Sign in to OpenApps.
 *
 * The worker owns the session — see `background/session.ts` for why, and for
 * why this cannot be a page on our own origin. From here it is two messages:
 * ask for a token, and if there is none, ask for a sign-in and wait.
 *
 * Nothing about the credential passes through this file except the access
 * token, for the length of one publish.
 */
async function signIn(): Promise<string | null> {
  const held = (await ext.runtime.sendMessage({ type: "authToken" }).catch(() => null)) as {
    token?: string | null;
  } | null;
  if (held?.token) return held.token;

  const done = (await ext.runtime.sendMessage({ type: "authSignIn" }).catch(() => null)) as {
    ok?: boolean;
  } | null;
  if (!done?.ok) return null;

  const fresh = (await ext.runtime.sendMessage({ type: "authToken" }).catch(() => null)) as {
    token?: string | null;
  } | null;
  return fresh?.token ?? null;
}
