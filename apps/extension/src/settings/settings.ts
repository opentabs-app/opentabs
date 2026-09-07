/**
 * Settings — rendered from the config document, not hand-written per group.
 *
 * The def/instance split (D12) is what this page exists to expose: one
 * `topic` def, as many instances as the user wants, all editable the same
 * way. Adding "Data Centre" is a row here, not a release.
 *
 * Permission requests live in this file and nowhere else, because
 * `chrome.permissions.request()` needs a user gesture — the worker cannot
 * ask, only check.
 */
import { ext, KEY, getLocal, getSync, setLocal, setSync } from "../lib/ext";
import { SITE_MATCH } from "../lib/openapps";
import { initMarketPane, openShareDialog, showMarketPane } from "./marketpane";
import type { Binding, Config, Instance, LocalState } from "../lib/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls?: string, text?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let cfg: Config;
let local: LocalState;

function toast(msg = "Saved") {
  const bar = $("savebar");
  bar.textContent = msg;
  bar.classList.add("show");
  setTimeout(() => bar.classList.remove("show"), 1400);
}

async function save(refresh = false) {
  await setSync(KEY.config, cfg);
  toast();
  if (refresh) void ext.runtime.sendMessage({ type: "refresh" }).catch(() => {});
}

async function saveLocal() {
  await setLocal(KEY.local, local);
  toast();
}

// ---------- option schemas ----------

/**
 * What each def exposes in settings.
 *
 * Topics had a bespoke editor and everything else had none, which meant a
 * user could not change their city, their tickers, or how many repos to show
 * — the groups looked broken rather than unconfigured. Declaring the fields
 * here keeps "add a group" a data change, which was the whole point of the
 * registry.
 */
type Field =
  | { key: string; label: string; kind: "text" | "number"; hint?: string; placeholder?: string }
  | { key: string; label: string; kind: "bool"; hint?: string }
  | { key: string; label: string; kind: "list"; hint?: string; placeholder?: string };

const FIELDS: Record<string, Field[]> = {
  tabs: [
    { key: "collapse_after", label: "Tabs shown per site", kind: "number" },
    { key: "show_dupes", label: "Offer to close duplicate pages", kind: "bool" },
    {
      key: "auto_close_dupes",
      label: "Close spare New Tab pages automatically",
      kind: "bool",
      hint: "Keeps the one you are using and the freshest spare. Never touches a pinned tab, the only tab in a window, or one opened in the last minute.",
    },
    {
      key: "auto_close_after_min",
      label: "Close an untouched New Tab after (minutes)",
      kind: "number",
      hint: "0 leaves them alone. Checked every half-cutoff, so closing can lag by up to half the time you set. The same guards apply — in particular the New Tab you are currently looking at is never closed, however long it has been open.",
    },
  ],
  weather: [
    { key: "place", label: "Place", kind: "text", placeholder: "Singapore",
      hint: "Search for a city below, or type any label you like." },
    { key: "lat", label: "Latitude", kind: "number" },
    { key: "lon", label: "Longitude", kind: "number" },
  ],
  crypto: [
    { key: "symbols", label: "Pairs", kind: "list", placeholder: "BTCUSDT, ETHUSDT, SOLUSDT",
      hint: "Binance symbols. Anything they list works — XRPUSDT, DOGEUSDT." },
  ],
  equities: [
    { key: "symbols", label: "Tickers", kind: "list", placeholder: "000660.KS, NVDA, TSM",
      hint: "Yahoo symbols. Non-US markets need their suffix: .KS Korea, .T Tokyo, .HK Hong Kong, .L London. Delayed, and unofficial." },
  ],
  trending: [{ key: "limit", label: "Repos shown", kind: "number" }],
  calendar: [{ key: "days", label: "Days ahead", kind: "number" }],
  bookmarks: [
    { key: "limit", label: "How many to show", kind: "number" },
    { key: "show_folder", label: "Show the folder each one is in", kind: "bool" },
  ],
  focus: [
    { key: "prompt", label: "Prompt", kind: "text", placeholder: "What's today about?" },
    {
      key: "clear_after_hours",
      label: "A ticked item clears after (hours)",
      kind: "number",
      hint: "It stays struck through until then, so you can see what you finished — and untick it if you were wrong. 0 clears it as soon as you tick it.",
    },
  ],
  todos: [{ key: "remind", label: "Remind me when something is due", kind: "bool" }],
};

/** The X advanced-search editor: fields, mode, and the risk stated plainly. */
function xEditor(inst: Instance): HTMLElement {
  const box = el("div", "opts");
  const q = (inst.opts.query_fields ?? {}) as Record<string, unknown>;
  const setQ = (k: string, v: unknown) => {
    inst.opts.query_fields = { ...q, [k]: v };
    void save(true);
  };

  const namef = el("div", "field");
  namef.append(el("label", undefined, "Name"));
  const nm = document.createElement("input");
  nm.value = inst.name;
  nm.addEventListener("change", () => {
    inst.name = nm.value.trim() || "X search";
    void save(true);
    drawGroups();
  });
  namef.append(nm, el("div", "hint", "What this card is called — e.g. “@elonmusk”."));
  box.append(namef);

  const paste = el("div", "field");
  paste.append(el("label", undefined, "Paste an advanced-search URL"));
  const prow = el("div", "addrow");
  const purl = document.createElement("input");
  purl.placeholder = "https://x.com/search-advanced?q=…";
  const pbtn = el("button", "btn", "Fill in");
  pbtn.addEventListener("click", () => {
    void (async () => {
      try {
        const u = new URL(purl.value.trim());
        const raw = u.searchParams.get("q") ?? "";
        const res = await ext.runtime.sendMessage({ type: "xParse", q: raw });
        if (res?.fields) {
          // A pasted URL carries literal dates, so honour them rather than
          // silently overriding with a rolling window.
          const hasDates = res.fields.since || res.fields.until;
          inst.opts.query_fields = { ...res.fields, window_days: hasDates ? 0 : 1 };
          await save(true);
          drawGroups();
          toast("Search fields filled in");
        }
      } catch {
        toast("That does not look like an X search URL.");
      }
    })();
  });
  prow.append(purl, pbtn);
  paste.append(prow);
  paste.append(el("div", "hint", "Or fill the fields below — they mirror X's own advanced search."));
  box.append(paste);

  const text = (key: string, label: string, ph: string, hint?: string) => {
    const f = el("div", "field");
    f.append(el("label", undefined, label));
    const i = document.createElement("input");
    i.placeholder = ph;
    i.value = String(q[key] ?? "");
    i.addEventListener("change", () => setQ(key, i.value));
    f.append(i);
    if (hint) f.append(el("div", "hint", hint));
    box.append(f);
  };
  text("all", "All of these words", "microduck");
  text("phrase", "This exact phrase", "happy hour");
  text("any", "Any of these words", "cats dogs");
  text("none", "None of these words", "crypto contract gem");
  text("from", "From these accounts", "@nasa esa");
  text("to", "To these accounts", "@sfbart");
  text("mentions", "Mentioning these accounts", "@sfbart");
  text("hashtags", "These hashtags", "throwbackthursday");
  text("lang", "Language code", "en", "Two letters — en, ja, zh. Blank means any language.");

  // --- Filters, as X's own advanced search groups them ---
  //
  // These were supported by the query engine from the start and simply had no
  // controls, which made the editor look like a subset of X's advanced search
  // rather than a mirror of it.
  const choice = (
    key: string,
    label: string,
    options: [string, string][],
    hint?: string,
  ) => {
    const f = el("div", "field");
    f.append(el("label", undefined, label));
    const sel = document.createElement("select");
    for (const [v, l] of options) sel.append(new Option(l, v));
    sel.value = String(q[key] ?? "any");
    sel.addEventListener("change", () => setQ(key, sel.value));
    f.append(sel);
    if (hint) f.append(el("div", "hint", hint));
    box.append(f);
  };

  box.append(el("div", "subhead", "Filters"));
  choice("replies", "Replies", [
    ["any", "Include replies and original posts"],
    ["none", "Exclude replies"],
    ["only", "Only show replies"],
  ]);
  choice("links", "Links", [
    ["any", "Include posts with and without links"],
    ["none", "Exclude posts with links"],
    ["only", "Only show posts with links"],
  ]);
  box.append(el("div", "subhead", "Engagement"));
  const engagement = (key: string, label: string) => {
    const f = el("div", "field");
    f.append(el("label", undefined, label));
    const i = document.createElement("input");
    i.type = "number";
    i.min = "0";
    i.placeholder = "0";
    i.value = Number(q[key] ?? 0) > 0 ? String(q[key]) : "";
    i.addEventListener("change", () => setQ(key, Math.max(0, Number(i.value) || 0)));
    f.append(i);
    box.append(f);
  };
  engagement("min_replies", "Minimum replies");
  engagement("min_likes", "Minimum likes");
  engagement("min_reposts", "Minimum reposts");
  box.append(
    el(
      "div",
      "hint",
      "Thresholds exist only in X's own search, not in its API — a search using " +
        "them still works in the other modes, but the numbers are ignored there.",
    ),
  );

  box.append(el("div", "subhead", "Dates"));
  const winf = el("div", "field");
  winf.append(el("label", undefined, "Time window"));
  const win = document.createElement("select");
  for (const [v, l] of [
    ["1", "Yesterday to today"],
    ["3", "Last 3 days"],
    ["7", "Last 7 days"],
    ["0", "Fixed dates below"],
  ] as const) {
    win.append(new Option(l, v));
  }
  win.value = String(q.window_days ?? 1);
  const fixed = el("div", "addrow");
  const showFixed = () => {
    fixed.style.display = win.value === "0" ? "flex" : "none";
  };
  win.addEventListener("change", () => {
    setQ("window_days", Number(win.value));
    showFixed();
  });
  winf.append(win);
  winf.append(
    el("div", "hint", "A rolling window recomputes each time, so a saved search never goes stale."),
  );

  for (const [key, ph] of [["since", "from YYYY-MM-DD"], ["until", "to YYYY-MM-DD"]] as const) {
    const i = document.createElement("input");
    i.placeholder = ph;
    i.value = String(q[key] ?? "");
    i.addEventListener("change", () => setQ(key, i.value));
    fixed.append(i);
  }
  showFixed();
  winf.append(fixed);
  box.append(winf);

  const rt = document.createElement("input");
  rt.type = "checkbox";
  rt.checked = q.exclude_retweets !== false;
  rt.addEventListener("change", () => setQ("exclude_retweets", rt.checked));
  const rtf = el("div", "field");
  const rtl = el("label", "inline");
  rtl.append(rt, document.createTextNode(" Exclude reposts"));
  rtf.append(el("label", undefined, "Reposts"), rtl);
  box.append(rtf);

  // --- how results are obtained ---
  const modef = el("div", "field");
  modef.append(el("label", undefined, "How to get results"));
  const mode = document.createElement("select");
  mode.append(
    new Option("Open the search in X (nothing is fetched)", "launcher"),
    new Option("Read results from a background tab", "scrape"),
    new Option("Use my own X API key", "api"),
  );
  mode.value = String(inst.opts.mode ?? "launcher");

  const warn = el("div", "warn");
  const explain = () => {
    warn.style.display = mode.value === "launcher" ? "none" : "block";
    if (mode.value === "scrape") {
      warn.textContent =
        "This opens your search in a background tab, using the X account you are " +
        "already signed into, and reads the posts it renders. X's terms prohibit " +
        "automated collection, and enforcement is account suspension — so this is " +
        "your account at risk, not OpenTabs'. It is paced well below human browsing " +
        "(at most a few loads a day, never while your machine is idle) and it breaks " +
        "whenever X changes its markup.";
    } else if (mode.value === "api") {
      warn.textContent =
        "X charges roughly $0.005 per post read against your own key, and the recent-" +
        "search endpoint only covers the last 7 days.";
    }
  };
  explain();
  mode.addEventListener("change", () => {
    inst.opts.mode = mode.value;
    explain();
    void save(true);
    if (mode.value === "scrape") {
      void ext.permissions.request({ origins: ["https://x.com/*"] }).catch(() => false);
    }
    if (mode.value === "api") {
      void ext.permissions.request({ origins: ["https://api.x.com/*"] }).catch(() => false);
    }
  });
  modef.append(mode, warn);
  box.append(modef);

  const gap = el("div", "field");
  gap.append(el("label", undefined, "Check at most every"));
  const iv = document.createElement("select");
  for (const [v, l] of [
    ["15", "15 minutes"],
    ["30", "30 minutes"],
    ["60", "1 hour"],
    ["120", "2 hours"],
    ["240", "4 hours"],
    ["480", "8 hours"],
  ] as const) {
    iv.append(new Option(l, v));
  }
  iv.value = String(inst.opts.interval_min ?? 240);
  iv.addEventListener("change", () => {
    inst.opts.interval_min = Number(iv.value);
    void save(true);
  });
  const capHint = el("div", "hint");
  const showCap = () => {
    const perDay = Math.min(48, Math.floor((16 * 60) / Number(iv.value)));
    capHint.textContent =
      `Jittered by ±25%, skipped while your machine is idle, and capped at 48 loads a ` +
      `day across all X searches — about ${perDay} for this one over a waking day.`;
  };
  showCap();
  iv.addEventListener("change", showCap);
  gap.append(iv, capHint);
  box.append(gap);

  const keyf = el("div", "field");
  keyf.append(el("label", undefined, "X API key (only for the API mode)"));
  const key = document.createElement("input");
  key.type = "password";
  key.placeholder = "Bearer token — stored on this device only, never synced";
  key.addEventListener("change", () => {
    void (async () => {
      local.xToken = key.value.trim() || undefined;
      await saveLocal();
    })();
  });
  keyf.append(key);
  box.append(keyf);
  return box;
}

/**
 * API permissions a group needs, beyond host access.
 *
 * Kept optional and asked for on enable, for the same reason the host
 * permissions are: an install-time prompt listing "read your bookmarks" for a
 * group that ships switched off is a worse first impression than an ask at
 * the moment it becomes true (D6, D8).
 */
const PERMS_FOR: Record<string, chrome.runtime.ManifestPermissions[]> = {
  bookmarks: ["bookmarks"],
};

/**
 * Defs that may be published. Mirrors `shareable_def` in Rust, and the
 * omissions are the point: `calendar` is a bearer secret, `tabs` and `apps`
 * carry nothing worth sharing.
 */
const SHAREABLE = new Set([
  "topic", "xsearch", "crypto", "equities", "status", "trending", "weather", "bookmarks",
]);

/**
 * Which bookmark folder a card shows.
 *
 * Populated from the worker, because the folder list needs the `bookmarks`
 * permission and the settings page may not have been granted it yet. An empty
 * list is therefore a normal state with a normal explanation, not a failure.
 */
function folderPicker(inst: Instance): HTMLElement {
  const f = el("div", "field");
  f.append(el("label", undefined, "Folder"));
  const sel = document.createElement("select");
  sel.append(new Option("Most recent, from anywhere", ""));
  const chosen = String(inst.opts.folder_id ?? "");
  if (chosen) sel.append(new Option(String(inst.opts.folder_name ?? "…"), chosen));
  sel.value = chosen;
  f.append(sel);
  const hint = el("div", "hint", "Reading the folder list\u2026");
  f.append(hint);

  sel.addEventListener("change", () => {
    inst.opts.folder_id = sel.value;
    inst.opts.folder_name = sel.value ? sel.selectedOptions[0]!.textContent : "";
    void save(true);
  });

  void ext.runtime
    .sendMessage({ type: "bookmarkFolders" })
    .then((r: { folders?: { id: string; path: string }[] }) => {
      const folders = r?.folders ?? [];
      if (folders.length === 0) {
        hint.textContent =
          "No folders to list yet — switch this group on and grant access, then reopen this.";
        return;
      }
      sel.replaceChildren(new Option("Most recent, from anywhere", ""));
      for (const fo of folders) sel.append(new Option(fo.path, fo.id));
      sel.value = folders.some((x) => x.id === chosen) ? chosen : "";
      if (chosen && sel.value !== chosen) {
        hint.textContent = "The folder this card used is gone. Pick another.";
        return;
      }
      hint.textContent = "One card per folder — add as many as you keep.";
    })
    .catch(() => {
      hint.textContent = "Could not read the folder list.";
    });
  return f;
}

function optionsEditor(inst: Instance): HTMLElement | null {
  if (inst.def === "xsearch") return xEditor(inst);
  const fields = FIELDS[inst.def];
  if (!fields?.length) return null;
  const box = el("div", "opts");
  if (inst.def === "bookmarks") box.append(folderPicker(inst));

  for (const f of fields) {
    const wrap = el("div", "field");
    wrap.append(el("label", undefined, f.label));

    if (f.kind === "bool") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      // Absent means off for anything destructive, on for a display toggle.
      const defaultOn = !f.key.startsWith("auto_close");
      cb.checked = defaultOn ? inst.opts[f.key] !== false : inst.opts[f.key] === true;
      cb.addEventListener("change", () => {
        inst.opts[f.key] = cb.checked;
        void save(true);
      });
      const line = el("label", "inline");
      line.append(cb, document.createTextNode(" enabled"));
      wrap.append(line);
    } else {
      const input = document.createElement("input");
      input.type = f.kind === "number" ? "number" : "text";
      if ("placeholder" in f && f.placeholder) input.placeholder = f.placeholder;
      const v = inst.opts[f.key];
      input.value = Array.isArray(v) ? v.join(", ") : v === undefined ? "" : String(v);
      input.addEventListener("change", () => {
        if (f.kind === "number") inst.opts[f.key] = Number(input.value);
        else if (f.kind === "list")
          inst.opts[f.key] = input.value.split(",").map((x) => x.trim()).filter(Boolean);
        else inst.opts[f.key] = input.value;
        void save(true);
      });
      wrap.append(input);
    }
    if (f.hint) wrap.append(el("div", "hint", f.hint));
    box.append(wrap);
  }

  if (inst.def === "weather") box.append(cityPicker(inst));
  return box;
}

/**
 * Free-text city search via Open-Meteo's geocoding endpoint — keyless, and
 * far kinder than asking someone for their latitude. Deliberately not the
 * browser geolocation permission: a location prompt on the first new tab
 * costs installs.
 */
function cityPicker(inst: Instance): HTMLElement {
  const wrap = el("div", "field");
  wrap.append(el("label", undefined, "Find a city"));
  const row = el("div", "addrow");
  const q = document.createElement("input");
  q.placeholder = "Singapore, Seoul, Zurich…";
  const go = el("button", "btn", "Search");
  const results = el("div", "preview");
  results.style.display = "none";

  const search = async () => {
    if (!q.value.trim()) return;
    results.style.display = "block";
    results.replaceChildren(el("div", undefined, "Searching…"));
    const ok = await ext.permissions
      .request({ origins: ["https://geocoding-api.open-meteo.com/*"] })
      .catch(() => false);
    if (!ok) {
      results.replaceChildren(el("div", undefined, "Access declined."));
      return;
    }
    try {
      const res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.value.trim())}&count=5`,
      );
      const hits = (await res.json())?.results ?? [];
      results.replaceChildren();
      if (hits.length === 0) return results.append(el("div", undefined, "No match."));
      for (const h of hits) {
        const label = [h.name, h.admin1, h.country].filter(Boolean).join(", ");
        const b = el("button", "btn", label);
        b.addEventListener("click", () => {
          inst.opts.place = h.name;
          inst.opts.lat = h.latitude;
          inst.opts.lon = h.longitude;
          void save(true);
          drawGroups();
          toast(`Weather set to ${h.name}`);
        });
        results.append(b);
      }
    } catch {
      results.replaceChildren(el("div", undefined, "Search failed."));
    }
  };
  go.addEventListener("click", () => void search());
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void search();
    }
  });
  row.append(q, go);
  wrap.append(row, results);
  return wrap;
}

// ---------- groups pane ----------

/**
 * "Add a bookmark folder" — the affordance that makes this def instantiable.
 *
 * It lives in Groups rather than Topics because that is where someone looking
 * for a group looks. The permission is asked for from the click itself: the
 * folder list cannot be read without it, so an empty list here is an access
 * question and not an empty-state.
 */
function drawBookmarkAdder() {
  const box = $("bmadder");
  box.replaceChildren();

  void ext.runtime
    .sendMessage({ type: "bookmarkFolders" })
    .then((r: { folders?: { id: string; path: string }[] }) => {
      const folders = r?.folders ?? [];
      box.replaceChildren();

      if (folders.length === 0) {
        const ask = el("button", "btn", "Add a bookmark folder as a group");
        ask.addEventListener("click", () => {
          // Requested straight from the click. An await before this spends
          // the user activation and the prompt never appears.
          void ext.permissions
            .request({ permissions: ["bookmarks"] })
            .then((ok) => {
              if (!ok) return toast("Access declined — folders cannot be listed.");
              drawBookmarkAdder();
            })
            .catch(() => {});
        });
        box.append(ask, el("div", "hint", "Needs permission to read your bookmarks."));
        return;
      }

      const sel = document.createElement("select");
      for (const f of folders) sel.append(new Option(f.path, f.id));
      const add = el("button", "btn", "Add as a group");
      add.addEventListener("click", () => {
        const id = `bm_${sel.value}`;
        if (cfg.instances.some((i) => i.id === id)) {
          return toast("That folder already has a group.");
        }
        const path = sel.selectedOptions[0]!.textContent ?? "Bookmarks";
        cfg.instances.push({
          def: "bookmarks",
          id,
          // The leaf, not the whole path: the card is called "Reading", not
          // "Bookmarks bar / Reading".
          name: path.split(" / ").pop() ?? path,
          enabled: true,
          opts: { limit: 10, show_folder: false, folder_id: sel.value, folder_name: path },
        });
        void save(true).then(() => ext.runtime.sendMessage({ type: "refresh" }).catch(() => {}));
        drawGroups();
        toast(`Added “${path}”.`);
      });
      box.append(sel, add);
    })
    .catch(() => {
      box.replaceChildren(el("div", "hint", "Could not read the folder list."));
    });
}

function drawGroups() {
  const list = $("grouplist");
  list.replaceChildren();
  cfg.instances.forEach((inst, i) => {
    const box = el("div", "gitem");
    box.dataset.instance = inst.id;
    const head = el("div", "gitem-head");

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = inst.enabled;
    toggle.addEventListener("change", () => {
      inst.enabled = toggle.checked;
      // Ask synchronously from inside the click. chrome.permissions.request
      // needs transient user activation, and an await before it can spend
      // the gesture — which silently returns false and leaves the group
      // enabled but permanently unable to fetch.
      if (inst.enabled) {
        const origins = originsFor(inst);
        const permissions = PERMS_FOR[inst.def] ?? [];
        if (origins.length || permissions.length) {
          void ext.permissions
            .request({
              ...(origins.length ? { origins } : {}),
              ...(permissions.length ? { permissions } : {}),
            })
            .then((ok) => {
              if (!ok) toast("Access declined — this group cannot load.");
              void save(true);
            })
            .catch(() => void save(true));
          return;
        }
      }
      void save(true);
    });

    const name = el("span", "gitem-name", inst.name);
    const def = el("span", "gitem-def", inst.def);

    const up = el("button", "move", "↑");
    up.addEventListener("click", () => {
      if (i === 0) return;
      [cfg.instances[i - 1], cfg.instances[i]] = [cfg.instances[i]!, cfg.instances[i - 1]!];
      void save();
      drawGroups();
    });
    const down = el("button", "move", "↓");
    down.addEventListener("click", () => {
      if (i >= cfg.instances.length - 1) return;
      [cfg.instances[i + 1], cfg.instances[i]] = [cfg.instances[i]!, cfg.instances[i + 1]!];
      void save();
      drawGroups();
    });

    // Only the folder groups a reader added themselves can be removed. The
    // shipped set is switched off, never deleted, so a config stays complete.
    const removable = inst.def === "bookmarks" && inst.id !== "bookmarks";
    const rm = el("button", "move", "remove");
    rm.addEventListener("click", () => {
      cfg.instances = cfg.instances.filter((x) => x.id !== inst.id);
      void save(true);
      drawGroups();
    });

    // Shareable defs only. A Share button on a calendar would be an offer to
    // publish a bearer secret, so the ones that cannot be shared do not ask.
    const share = el("button", "move", "share");
    share.addEventListener("click", () => openShareDialog(marketDeps(), inst.id));

    const editor = optionsEditor(inst);
    const tail = SHAREABLE.has(inst.def)
      ? removable
        ? [share, up, down, rm]
        : [share, up, down]
      : removable
        ? [up, down, rm]
        : [up, down];
    if (editor) {
      const edit = el("button", "move", "edit");
      edit.addEventListener("click", () => box.classList.toggle("open"));
      head.append(toggle, name, def, edit, ...tail);
      box.append(head, editor);
    } else {
      head.append(toggle, name, def, ...tail);
      box.append(head);
    }
    list.append(box);
  });
}

// ---------- topics pane ----------

const TEMPLATES = [
  "googlenews", "bingnews", "reddit", "subreddit", "arxiv", "arxiv_all", "hn",
  // Keyless social search — the free stand-in for X, which charges per read.
  "bluesky", "mastodon",
];

function drawTopics() {
  const list = $("topiclist");
  list.replaceChildren();
  for (const inst of cfg.instances.filter((i) => i.def === "topic")) {
    list.append(topicCard(inst));
  }
  drawXSearches();
}

/**
 * X searches are instances of one def, exactly like topics — so there can be
 * as many as the reader wants, one per thing they are watching.
 */
function drawXSearches() {
  const list = $("xlist");
  if (!list) return;
  list.replaceChildren();
  const searches = cfg.instances.filter((i) => i.def === "xsearch");
  if (searches.length === 0) {
    list.append(el("div", "hint", "No X searches yet."));
    return;
  }
  for (const inst of searches) {
    const box = el("div", "titem");
    box.dataset.instance = inst.id;
    const head = el("div", "titem-head");
    head.append(el("span", "gitem-name", inst.name));
    head.append(el("span", "gitem-def", inst.enabled ? "on" : "off"));

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = inst.enabled;
    toggle.title = "Show on the new tab page";
    toggle.addEventListener("change", () => {
      inst.enabled = toggle.checked;
      void save(true);
      drawGroups();
      drawXSearches();
    });

    const open = el("button", "move", "edit");
    open.addEventListener("click", () => box.classList.toggle("open"));
    const rm = el("button", "move", "remove");
    rm.addEventListener("click", () => {
      cfg.instances = cfg.instances.filter((x) => x.id !== inst.id);
      void save(true);
      drawXSearches();
      drawGroups();
    });
    head.append(toggle, open, rm);

    const body = el("div", "titem-body");
    body.append(xEditor(inst));
    box.append(head, body);
    list.append(box);
  }
}

function topicCard(inst: Instance): HTMLElement {
  const box = el("div", "titem");
  box.dataset.instance = inst.id;
  const head = el("div", "titem-head");
  const name = el("span", "gitem-name", inst.name);
  const open = el("button", "move", "edit");
  open.addEventListener("click", () => box.classList.toggle("open"));
  const rm = el("button", "move", "remove");
  rm.addEventListener("click", () => {
    cfg.instances = cfg.instances.filter((x) => x.id !== inst.id);
    void save(true);
    drawTopics();
    drawGroups();
  });
  head.append(name, el("span", "gitem-def", inst.enabled ? "on" : "off"), open, rm);
  box.append(head);

  const body = el("div", "titem-body");

  const q = document.createElement("input");
  q.value = String(inst.opts.query ?? "");
  q.placeholder = 'e.g. "high frequency trading" OR "market microstructure" -crypto';
  q.addEventListener("change", () => {
    inst.opts.query = q.value;
    void save(true);
  });
  const qf = el("div", "field");
  qf.append(el("label", undefined, "Query"), q);
  qf.append(el("div", "hint", "Quotes group a phrase; OR widens; a leading minus excludes."));
  body.append(qf);

  const srcs = el("div", "field");
  srcs.append(el("label", undefined, "Sources"));
  const bindings = (inst.opts.sources as Binding[] | undefined) ?? [];
  bindings.forEach((b, i) => {
    const row = el("div", "srcrow");
    row.append(el("span", "who", b.kind === "feed" ? (b.url ?? "") : `${b.tmpl}${b.arg ? `:${b.arg}` : ""}`));
    const del = el("button", "rm", "remove");
    del.addEventListener("click", () => {
      bindings.splice(i, 1);
      inst.opts.sources = bindings;
      void save(true);
      drawTopics();
    });
    row.append(del);
    srcs.append(row);
  });

  const add = el("div", "addrow");
  const sel = document.createElement("select");
  for (const t of TEMPLATES) sel.append(new Option(t, t));
  const arg = document.createElement("input");
  arg.placeholder = "argument — arXiv: q-fin.TR · reddit: LocalLLaMA · mastodon: a hashtag";
  const addBtn = el("button", "btn", "Add source");
  addBtn.addEventListener("click", () => {
    const b: Binding = { kind: "query", tmpl: sel.value, weight: 1 };
    if (arg.value.trim()) b.arg = arg.value.trim();
    bindings.push(b);
    inst.opts.sources = bindings;
    // Save first and unconditionally. Asking for permission before storing
    // meant an unanswered or declined prompt silently discarded the edit —
    // the user's change is theirs either way, and General names anything
    // that still lacks access.
    void save(true);
    // Requested with no await in front of it, so the click's user activation
    // is still live when Chrome checks for it.
    void requestFor(inst);
    drawTopics();
  });
  add.append(sel, arg, addBtn);
  srcs.append(add);

  // A topic can end up with no sources — through the Map fault, or by
  // removing them all. Retyping five bindings by hand is not a reasonable
  // recovery, so offer the shipped set back in one click.
  const needsQuery =
    bindings.length > 0 &&
    !String(inst.opts.query ?? "").trim() &&
    bindings.every((b) => b.kind === "query" && !b.arg);

  if (needsQuery) {
    const warn = el("div", "warn");
    warn.textContent =
      "Every source here is a search, but the Query box is empty — so nothing is fetched. " +
      "Type what this topic is about above, or add a feed URL below.";
    srcs.append(warn);
  }

  if (bindings.length === 0) {
    const warn = el("div", "warn");
    warn.textContent =
      "This topic has no sources, so it can never fill. Restore the defaults, " +
      "or add one below.";
    const restore = el("button", "btn primary", "Restore default sources");
    restore.addEventListener("click", () => {
      void (async () => {
        const res = await ext.runtime.sendMessage({ type: "defaults" }).catch(() => null);
        const seed = res?.config?.instances?.find((i: Instance) => i.id === inst.id);
        inst.opts = seed
          ? { ...seed.opts }
          : {
              query: inst.name,
              sources: [{ kind: "query", tmpl: "googlenews", weight: 1 }],
              limit: 8,
              exclude: [],
              include: [],
            };
        await save(true);
        drawTopics();
        toast("Sources restored");
      })();
    });
    srcs.append(warn, restore);
  }

  const feedRow = el("div", "addrow");
  const feedUrl = document.createElement("input");
  feedUrl.placeholder = "…or paste any site or feed URL";
  const feedBtn = el("button", "btn", "Find feed");
  const preview = el("div", "preview");
  preview.style.display = "none";
  feedBtn.addEventListener("click", () => void addByUrl(inst, feedUrl, preview, bindings));
  feedRow.append(feedUrl, feedBtn);
  srcs.append(feedRow, preview);
  body.append(srcs);

  const limit = document.createElement("input");
  limit.type = "number";
  limit.value = String(inst.opts.limit ?? 8);
  limit.addEventListener("change", () => {
    inst.opts.limit = Number(limit.value) || 8;
    void save(true);
  });
  const lf = el("div", "field");
  lf.append(el("label", undefined, "Items shown"), limit);
  body.append(lf);

  const age = document.createElement("select");
  for (const [v, label] of [
    ["6", "Last 6 hours"],
    ["24", "Last 24 hours"],
    ["72", "Last 3 days"],
    ["168", "Last week"],
    ["0", "No limit"],
  ] as const) {
    age.append(new Option(label, v));
  }
  age.value = String(inst.opts.max_age_hours ?? 24);
  age.addEventListener("change", () => {
    inst.opts.max_age_hours = Number(age.value);
    void save(true);
  });
  const af = el("div", "field");
  af.append(el("label", undefined, "Only show items from"), age);
  af.append(
    el(
      "div",
      "hint",
      "If nothing that recent exists, the newest few are shown and marked as older.",
    ),
  );
  body.append(af);

  const ex = document.createElement("input");
  ex.value = ((inst.opts.exclude as string[]) ?? []).join(", ");
  ex.placeholder = "sponsored, advertorial";
  ex.addEventListener("change", () => {
    inst.opts.exclude = ex.value.split(",").map((s) => s.trim()).filter(Boolean);
    void save(true);
  });
  const ef = el("div", "field");
  ef.append(el("label", undefined, "Exclude words"), ex);
  ef.append(el("div", "hint", "“Data centre” pulls property news, and vice versa — this is the fix."));
  body.append(ef);

  box.append(body);
  return box;
}

/**
 * Paste any URL → is-it-a-feed → autodiscovery → well-known paths, with a
 * live preview before anything is saved. The preview is what makes this feel
 * trustworthy rather than hopeful.
 */
async function addByUrl(inst: Instance, input: HTMLInputElement, preview: HTMLElement, bindings: Binding[]) {
  const raw = input.value.trim();
  if (!raw) return;
  preview.style.display = "block";
  preview.replaceChildren(el("div", undefined, "Looking…"));

  let origin: string;
  try {
    origin = `${new URL(raw).protocol}//${new URL(raw).hostname}/*`;
  } catch {
    preview.replaceChildren(el("div", undefined, "That does not look like a web address."));
    return;
  }
  // Ask for this one site, right where the user asked for it.
  const ok = await ext.permissions.request({ origins: [origin] });
  if (!ok) {
    preview.replaceChildren(el("div", undefined, "Access declined, so this feed cannot be read."));
    return;
  }

  const res = await ext.runtime
    .sendMessage({ type: "discover", url: raw })
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : "The worker did not answer." }));
  if (!res || res.error || !res.candidates?.length) {
    preview.replaceChildren(el("div", undefined, res?.error ?? "No feed found there."));
    return;
  }

  // Several candidates is the normal case — TechCrunch advertises a site
  // feed and a per-section one. The best is preselected; the rest are
  // offered rather than hidden, because only the reader knows which they
  // meant.
  const best = res.candidates[0];
  preview.replaceChildren();
  preview.append(el("b", undefined, `Found: ${best.url}`));
  for (const item of res.preview ?? []) preview.append(el("div", undefined, item.title));

  const add = (url: string) => {
    bindings.push({ kind: "feed", url, weight: 1.5 });
    inst.opts.sources = bindings;
    input.value = "";
    void save(true);
    drawTopics();
    toast("Feed added");
  };

  const confirm = el("button", "btn primary", "Add this feed");
  confirm.addEventListener("click", () => add(best.url));
  preview.append(confirm);

  for (const other of res.candidates.slice(1, 4)) {
    const alt = el("button", "btn", `Use ${other.title || other.url} instead`);
    alt.addEventListener("click", () => add(other.url));
    preview.append(alt);
  }
}

/**
 * Origins one instance needs — computed here, synchronously.
 *
 * It duplicates `tabs_core::config::fixed_origins`, which is a real cost. The
 * alternative is a message round-trip before `permissions.request()`, and
 * that await spends the user gesture the API requires. A small duplicated
 * table beats a permission prompt that silently never appears.
 */
const FIXED_ORIGINS: Record<string, string[]> = {
  crypto: ["https://api.binance.com/*"],
  equities: ["https://query1.finance.yahoo.com/*"],
  status: [
    "https://www.githubstatus.com/*",
    "https://www.cloudflarestatus.com/*",
    "https://status.openai.com/*",
    "https://status.anthropic.com/*",
  ],
  weather: ["https://api.open-meteo.com/*", "https://geocoding-api.open-meteo.com/*"],
  apps: [SITE_MATCH],
  trending: [SITE_MATCH, "https://github.com/*"],
};

const QUERY_HOSTS: Record<string, string> = {
  googlenews: "https://news.google.com/*",
  bingnews: "https://www.bing.com/*",
  reddit: "https://www.reddit.com/*",
  subreddit: "https://www.reddit.com/*",
  arxiv: "https://export.arxiv.org/*",
  arxiv_all: "https://export.arxiv.org/*",
  hn: "https://hn.algolia.com/*",
  bluesky: "https://public.api.bsky.app/*",
  mastodon: "https://mastodon.social/*",
};

function originsFor(inst: Instance): string[] {
  const out = new Set(FIXED_ORIGINS[inst.def] ?? []);
  for (const b of ((inst.opts.sources as Binding[] | undefined) ?? [])) {
    if (b.kind === "query" && b.tmpl && QUERY_HOSTS[b.tmpl]) out.add(QUERY_HOSTS[b.tmpl]!);
    if (b.kind === "feed" && b.url) {
      try {
        const u = new URL(b.url);
        out.add(`${u.protocol}//${u.hostname}/*`);
      } catch {
        /* skip a malformed feed URL */
      }
    }
  }
  return [...out];
}

async function requestFor(inst: Instance): Promise<boolean> {
  const list = originsFor(inst);
  if (list.length === 0) return true;
  return await ext.permissions.request({ origins: list }).catch(() => false);
}

// ---------- calendar pane ----------

function drawCalendars() {
  const list = $("callist");
  list.replaceChildren();
  const subs = (local.calendarUrls ??= []);
  subs.forEach((sub, i) => {
    const url = typeof sub === "string" ? sub : sub.url;
    const label = typeof sub === "string" ? "" : (sub.label ?? "");

    const row = el("div", "citem");
    const head = el("div", "gitem-head");

    const name = document.createElement("input");
    name.value = label;
    name.placeholder = "Label — e.g. Work";
    name.addEventListener("change", () => {
      subs[i] = { label: name.value.trim(), url };
      void saveLocal();
      void ext.runtime.sendMessage({ type: "refresh" }).catch(() => {});
    });
    head.append(name);

    const rm = el("button", "move", "remove");
    rm.addEventListener("click", () => {
      subs.splice(i, 1);
      void saveLocal();
      drawCalendars();
      void ext.runtime.sendMessage({ type: "refresh" }).catch(() => {});
    });
    head.append(rm);
    row.append(head);

    // Never render the secret in full: a screenshot of this page would
    // otherwise hand over read access to the calendar.
    row.append(el("div", "hint", `${url.slice(0, 42)}…`));
    list.append(row);
  });
  if (subs.length === 0) list.append(el("div", "hint", "No calendars yet."));
}


// ---------- data pane ----------

function exportable(withSecrets: boolean) {
  return {
    ...cfg,
    ...(withSecrets ? { _calendars: local.calendarUrls ?? [] } : {}),
  };
}

function toConfigString(withSecrets: boolean): string {
  const json = JSON.stringify(exportable(withSecrets));
  // Deflate then base64url. Small enough to paste between browsers, and no
  // server is involved at any point.
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `opentabs1:${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function fromConfigString(s: string): unknown {
  const body = s.trim().replace(/^opentabs1:/, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(body + "===".slice((body.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function drawData() {
  ($("raw") as HTMLTextAreaElement).value = JSON.stringify(cfg, null, 2);
  ($("configstr") as HTMLTextAreaElement).value = toConfigString(
    ($("withsecrets") as HTMLInputElement).checked,
  );
}

// ---------- wiring ----------

/** What the marketplace pane needs from this module, passed rather than imported
 *  back — a cycle between the two files would be the easy way and the wrong one. */
function marketDeps() {
  return {
    el,
    $,
    toast,
    cfg: () => cfg,
    afterInstall: () => {
      // The worker rewrote the config, so this page's copy is stale.
      void ext.runtime
        .sendMessage({ type: "config" })
        .then((r: { config?: Config }) => {
          if (r?.config) cfg = r.config;
          drawGroups();
          drawTopics();
        })
        .catch(() => {});
    },
  };
}

/** Switch panes, from the nav or from a deep link. */
function showPane(pane: string) {
  document.querySelectorAll(".pane").forEach((p) => p.classList.remove("on"));
  document.querySelectorAll("#nav button").forEach((b) => b.classList.remove("on"));
  document.querySelector(`#nav button[data-pane="${pane}"]`)?.classList.add("on");
  $(`pane-${pane}`).classList.add("on");
  if (pane === "data") drawData();
  if (pane === "general") void showPerms();
  if (pane === "market") {
    drawShareRow();
    void showMarketPane(marketDeps());
  }
}

/**
 * A Share button for every group that can be published.
 *
 * "How do I add something to the marketplace" had, until now, one answer:
 * go to Groups and find the small lowercase `share` control sitting among
 * the move and remove buttons. That is a true answer and a bad one. The
 * question is asked *on this pane*, so it is answered here.
 *
 * Rebuilt each time the pane opens rather than once at load: groups are
 * added and renamed on the pane next door.
 */
function drawShareRow() {
  const row = document.getElementById("sharerow");
  if (!row) return;
  row.replaceChildren();

  const shareable = cfg.instances.filter((i) => SHAREABLE.has(i.def));
  if (shareable.length === 0) {
    row.append(
      el(
        "div",
        "hint",
        "Nothing to publish yet — add a topic or a search under Groups, then come back.",
      ),
    );
    return;
  }
  // Two groups can carry the same name — the crypto tickers and a crypto
  // news topic both arrive called "Crypto" — and two identical buttons is a
  // coin toss, not a choice. Only the ambiguous ones get qualified; adding
  // the type to every button would be noise on the thirteen that are clear.
  const seen = new Map<string, number>();
  for (const inst of shareable) {
    seen.set(inst.name, (seen.get(inst.name) ?? 0) + 1);
  }
  for (const inst of shareable) {
    const label =
      (seen.get(inst.name) ?? 0) > 1 ? `Share “${inst.name}” (${inst.def})` : `Share “${inst.name}”`;
    const b = el("button", "btn", label);
    b.addEventListener("click", () => openShareDialog(marketDeps(), inst.id));
    row.append(b);
  }
}

/**
 * Open straight at one group, from the gear on its card.
 *
 * The card knows which group it is; making the reader arrive at a settings
 * page and find it again is work the link can do. The row is opened and
 * briefly highlighted, because a page that silently scrolled somewhere is
 * indistinguishable from one that ignored you.
 */
function focusInstance(id: string) {
  const inst = cfg.instances.find((i) => i.id === id);
  if (!inst) return;
  const pane =
    inst.def === "topic" || inst.def === "xsearch"
      ? "topics"
      : inst.def === "calendar"
        ? "calendar"
        : "groups";
  showPane(pane);
  // Scoped to the pane just shown. A group appears in the Groups list *and*
  // in its own pane, so an unscoped lookup finds the first copy and opens a
  // row on a pane the reader is not looking at.
  const row = $(`pane-${pane}`).querySelector<HTMLElement>(
    `[data-instance="${CSS.escape(id)}"]`,
  );
  if (!row) return;
  row.classList.add("open", "flash");
  row.scrollIntoView({ block: "center" });
  setTimeout(() => row.classList.remove("flash"), 1600);
}

async function main() {
  const storedCfg = await getSync<Config | null>(KEY.config, null);
  local = await getLocal<LocalState>(KEY.local, {});
  // The worker owns migration, so a page and a worker can never disagree
  // about what a stored document means.
  cfg = (await ext.runtime.sendMessage({ type: "config" }).catch(() => null))?.config ?? storedCfg;
  if (!cfg) {
    cfg = { version: 1, instances: [], theme: "auto", assistant: "claude" };
  }

  for (const btn of document.querySelectorAll<HTMLButtonElement>("#nav button")) {
    btn.addEventListener("click", () => showPane(btn.dataset.pane!));
  }

  initMarketPane(marketDeps());
  drawGroups();
  drawBookmarkAdder();
  drawTopics();
  drawCalendars();

  // `#i=<instance>` — where the per-card gear lands.
  // `#pane=market` from the new tab's Packs button. Checked before `#i=`
  // because a pane is the coarser target and the two never both appear.
  const wantPane = /^#pane=([a-z]+)$/.exec(location.hash);
  if (wantPane && document.getElementById(`pane-${wantPane[1]}`)) showPane(wantPane[1]!);

  const target = /^#i=(.+)$/.exec(location.hash);
  if (target) focusInstance(decodeURIComponent(target[1]!));
  window.addEventListener("hashchange", () => {
    // Both forms, because this page can already be open when the link is
    // followed. A same-document hash change does not re-run the code above,
    // so without this the deep link works on a cold load and silently does
    // nothing on a warm one.
    const p = /^#pane=([a-z]+)$/.exec(location.hash);
    if (p && document.getElementById(`pane-${p[1]}`)) showPane(p[1]!);
    const t = /^#i=(.+)$/.exec(location.hash);
    if (t) focusInstance(decodeURIComponent(t[1]!));
  });

  ($("assistant") as HTMLSelectElement).value = cfg.assistant || "claude";
  $("assistant").addEventListener("change", (e) => {
    cfg.assistant = (e.target as HTMLSelectElement).value;
    void save();
  });
  ($("theme") as HTMLSelectElement).value = cfg.theme || "auto";
  $("theme").addEventListener("change", (e) => {
    cfg.theme = (e.target as HTMLSelectElement).value;
    void save();
  });

  $("addtopic").addEventListener("click", () => {
    const input = $("newtopic") as HTMLInputElement;
    const name = input.value.trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `t${Date.now()}`;
    const inst: Instance = {
      def: "topic",
      id,
      name,
      enabled: true,
      // One binding by default: a Google News query alone returns ~100 items,
      // and every extra binding is another ~130 KB per refresh.
      opts: { query: name, sources: [{ kind: "query", tmpl: "googlenews", weight: 1 }], limit: 8, exclude: [], include: [] },
    };
    cfg.instances.push(inst);
    input.value = "";
    void save(true);
    void requestFor(inst);
    drawTopics();
    drawGroups();
  });

  $("addx").addEventListener("click", () => {
    const input = $("newx") as HTMLInputElement;
    const name = input.value.trim();
    if (!name) return;
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    let id = `x_${base || Date.now()}`;
    // Ids must be unique: two cards sharing one would edit each other.
    for (let n = 2; cfg.instances.some((i) => i.id === id); n++) id = `x_${base}_${n}`;

    // A name beginning with @ is almost certainly an account to follow.
    const handle = name.startsWith("@") ? name.slice(1) : "";
    cfg.instances.push({
      def: "xsearch",
      id,
      name,
      enabled: true,
      opts: {
        query_fields: {
          all: handle ? "" : name,
          from: handle,
          exclude_retweets: true,
          replies: "none",
          window_days: 1,
        },
        mode: "launcher",
        interval_min: 240,
        limit: 10,
      },
    });
    input.value = "";
    void save(true);
    drawXSearches();
    drawGroups();
    toast(`Added “${name}”`);
  });

  $("addcal").addEventListener("click", async () => {
    const input = $("newcal") as HTMLInputElement;
    const raw = input.value.trim();
    if (!raw) return;
    const https = raw.replace(/^webcals?:\/\//i, "https://");
    let origin = "";
    try {
      origin = `${new URL(https).protocol}//${new URL(https).hostname}/*`;
    } catch {
      toast("That does not look like a web address.");
      return;
    }
    // Store first, ask second. Gating the save on the prompt meant a declined
    // or dismissed dialog silently discarded the address the user had just
    // pasted — and a secret iCal URL is not something anyone wants to dig out
    // of Google twice.
    const label = ($("newcallabel") as HTMLInputElement).value.trim();
    (local.calendarUrls ??= []).push(label ? { label, url: https } : { url: https });
    ($("newcallabel") as HTMLInputElement).value = "";
    input.value = "";
    await saveLocal();

    // Adding a calendar means wanting to see it. Leaving the group switched
    // off was the whole bug: the address saved correctly, the fetch worked,
    // and no card ever appeared because nothing had enabled it.
    const cal = cfg.instances.find((i) => i.def === "calendar");
    if (cal && !cal.enabled) {
      cal.enabled = true;
      await save(false);
      drawGroups();
      toast("Calendar added and switched on");
    } else {
      toast("Calendar added");
    }

    drawCalendars();

    // Requested after saving; the card names the missing access if declined.
    const granted = await ext.permissions.request({ origins: [origin] }).catch(() => false);
    if (!granted) toast("Saved, but access was declined — the card will say so.");
    void ext.runtime.sendMessage({ type: "refresh" }).catch(() => {});
  });

  $("calprobe").addEventListener("click", () => {
    const out = $("calprobeout");
    out.textContent = "Fetching…";
    void ext.runtime
      .sendMessage({ type: "calendarProbe" })
      .then((r: Record<string, unknown>) => {
        if (!r || r.error) {
          out.textContent = String(r?.error ?? "No answer from the worker.");
          return;
        }
        const lines: string[] = [
          `host            ${r.host}`,
          `browser now     ${r.browserNow}`,
          `browser offset  UTC${(r.tzOffsetMinutes as number) <= 0 ? "+" : "-"}${
            Math.abs((r.tzOffsetMinutes as number) / 60)
          }`,
          "",
          "--- events as written in the calendar ---",
          ...(r.raw as string[]),
          "",
          "--- how they were read ---",
          ...(r.parsed as Record<string, unknown>[]).map(
            (e) =>
              `${String(e.summary).slice(0, 26).padEnd(28)} ${e.iso_utc}  ` +
              `floating=${e.floating}  all_day=${e.all_day}` +
              `${e.tzid ? `  tz=${e.tzid}` : ""}`,
          ),
        ];
        out.textContent = lines.join("\n");
      })
      .catch(() => {
        out.textContent = "The worker did not answer. Reload the extension.";
      });
  });

  $("runprune").addEventListener("click", () => {
    const out = $("pruneout");
    out.textContent = "Asking the worker…";
    void ext.runtime
      .sendMessage({ type: "pruneProbe" })
      .then((r: Record<string, unknown>) => {
        if (!r) {
          out.textContent = "The worker did not answer. Reload the extension.";
          return;
        }
        const o = r.opts as { closeDuplicates: boolean; closeAfterMin: number };
        const alarm = r.alarm as { periodInMinutes?: number; inSecs?: number } | null;
        const verdicts = r.verdicts as {
          id: number; windowId: number; idleMs: number; ours: boolean; close: boolean; why: string;
        }[];
        const ours = verdicts.filter((v) => v.ours);
        const lines = [
          `close after      ${o.closeAfterMin > 0 ? `${o.closeAfterMin} min` : "off"}`,
          `close duplicates ${o.closeDuplicates ? "on" : "off"}`,
          `checks every     ${r.everyMin === null ? "never — nothing is switched on" : `${r.everyMin} min`}`,
          `next check       ${alarm ? `in ${alarm.inSecs}s` : "no alarm scheduled"}`,
          "",
          `New Tab pages open: ${ours.length}`,
          "",
          ...ours.map(
            (v) =>
              `${v.close ? "CLOSING" : "keeping"}  win ${String(v.windowId).padEnd(4)} ` +
              `idle ${`${Math.floor(v.idleMs / 60000)}m${String(
                Math.round((v.idleMs % 60000) / 1000),
              ).padStart(2, "0")}s`.padEnd(8)} ${v.why}`,
          ),
          ours.length === 0 ? "(none — nothing for auto-close to do)" : "",
          "",
          `other tabs open: ${verdicts.length - ours.length}`,
        ];
        out.textContent = lines.filter((l) => l !== "").join("\n");
      })
      .catch(() => {
        out.textContent = "The worker did not answer. Reload the extension.";
      });
  });

  $("grantall").addEventListener("click", () => {
    // Computed synchronously, for the same user-gesture reason as the
    // per-group toggles: an await here spends the activation and the prompt
    // never appears.
    const on = cfg.instances.filter((i) => i.enabled);
    const origins = [...new Set(on.flatMap(originsFor))];
    const permissions = [...new Set(on.flatMap((i) => PERMS_FOR[i.def] ?? []))];
    if (origins.length === 0 && permissions.length === 0) return toast("Nothing needs access.");
    void ext.permissions
      .request({
        ...(origins.length ? { origins } : {}),
        ...(permissions.length ? { permissions } : {}),
      })
      .then((ok) => {
        toast(ok ? "Access granted." : "Access declined.");
        void showPerms();
      })
      .catch(() => toast("Access declined."));
  });

  $("copystr").addEventListener("click", async () => {
    await navigator.clipboard.writeText(($("configstr") as HTMLTextAreaElement).value);
    toast("Copied");
  });
  $("withsecrets").addEventListener("change", drawData);
  $("applystr").addEventListener("click", async () => {
    try {
      const parsed = fromConfigString(($("configstr") as HTMLTextAreaElement).value) as Config & {
        _calendars?: string[];
      };
      if (parsed._calendars) {
        local.calendarUrls = parsed._calendars;
        delete parsed._calendars;
        await setLocal(KEY.local, local);
      }
      cfg = parsed;
      await save(true);
      drawGroups();
      drawTopics();
      drawCalendars();
    } catch {
      toast("That string could not be read.");
    }
  });

  $("validate").addEventListener("click", () => {
    try {
      const v = JSON.parse(($("raw") as HTMLTextAreaElement).value);
      const n = Array.isArray(v.instances) ? v.instances.length : 0;
      $("rawstatus").textContent = `Valid — ${n} groups.`;
    } catch (e) {
      $("rawstatus").textContent = e instanceof Error ? e.message : "Invalid JSON";
    }
  });
  $("saveraw").addEventListener("click", async () => {
    try {
      cfg = JSON.parse(($("raw") as HTMLTextAreaElement).value);
      await save(true);
      drawGroups();
      drawTopics();
      $("rawstatus").textContent = "Saved.";
    } catch (e) {
      $("rawstatus").textContent = e instanceof Error ? e.message : "Invalid JSON";
    }
  });

  $("reset").addEventListener("click", async () => {
    const res = await ext.runtime.sendMessage({ type: "defaults" }).catch(() => null);
    if (!res?.config) return;
    cfg = res.config;
    await save(true);
    drawGroups();
    drawTopics();
    toast("Reset");
  });

  $("rundiag").addEventListener("click", () => void runDiagnostics());
  void showPerms();
}

/**
 * Name the groups that are switched on but cannot fetch.
 *
 * Without this, a missing permission is indistinguishable from a dead source:
 * the card just says "No prices" forever. Surfacing it is what turns an
 * unexplained empty group into a one-click fix.
 */
interface DiagRow {
  id: string;
  def: string;
  /** For groups that have one — e.g. an X search's launcher/scrape/api. */
  mode?: string;
  name: string;
  enabled: boolean;
  optsIsObject: boolean;
  sources: number;
  resolved: number;
  origins: string[];
  granted: boolean;
  items: number;
  age: number | null;
  error: string | null;
}

/**
 * Ask the worker what it actually sees.
 *
 * Three different faults have now presented identically as an empty card, and
 * the only way to tell them apart was guesswork. What the settings page shows
 * and what the worker resolves can disagree — this reports the worker's view.
 */
async function runDiagnostics() {
  const out = $("diag");
  out.replaceChildren(el("div", "hint", "Asking the worker\u2026"));
  const res = await ext.runtime
    .sendMessage({ type: "diagnostics" })
    .catch(() => ({ error: "The worker did not answer. Reload the extension." }));
  if (!res || res.error) {
    out.replaceChildren(el("div", "warn", res?.error ?? "No answer."));
    return;
  }

  const rows = (res.rows as DiagRow[]).filter((r) => r.enabled);
  const table = document.createElement("table");
  table.className = "diag";
  const head = document.createElement("tr");
  for (const h of ["Group", "Sources", "Resolved", "Access", "Items", "Age", "Problem"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.append(th);
  }
  table.append(head);

  for (const r of rows) {
    const tr = document.createElement("tr");
    const isTopic = r.def === "topic";
    const cells: string[] = [
      r.name,
      isTopic ? String(r.sources) : (r.mode || "\u2014"),
      isTopic ? String(r.resolved) : "\u2014",
      r.origins.length === 0 ? "n/a" : r.granted ? "granted" : "MISSING",
      String(r.items),
      r.age === null ? "never" : r.age < 90 ? "just now" : `${Math.round(r.age / 60)}m`,
      r.error ?? (r.optsIsObject ? "" : "options are not a plain object"),
    ];
    for (const [i, c] of cells.entries()) {
      const td = document.createElement("td");
      td.textContent = c;
      if (i === 3 && c === "MISSING") td.style.color = "var(--danger-fg, #c0392b)";
      if (i === 2 && isTopic && r.resolved === 0) td.style.color = "var(--danger-fg, #c0392b)";
      if (i === 6 && c) td.style.color = "var(--warning-fg, #c2661f)";
      tr.append(td);
    }
    table.append(tr);
  }
  out.replaceChildren(table);

  // A throttled host belongs to no single group, so it cannot be a column.
  const cooling = (res.cooling ?? []) as { host: string; until: number; strikes: number }[];
  if (cooling.length > 0) {
    const box = el("div", "warn");
    box.textContent =
      "Waiting out a rate limit — these hosts asked for room and are not being " +
      "asked again until: " +
      cooling
        .map(
          (c) =>
            `${c.host} ${new Date(c.until * 1000).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}`,
        )
        .join(", ");
    out.append(box);
  }

  const missing = rows.filter((r) => !r.granted && r.origins.length > 0);
  if (missing.length > 0) {
    const origins = [...new Set(missing.flatMap((m) => m.origins))];
    const fix = el("button", "btn primary", `Grant access for ${missing.length} group(s)`);
    fix.addEventListener("click", () => {
      void ext.permissions.request({ origins }).then((ok) => {
        toast(ok ? "Granted." : "Declined.");
        void runDiagnostics();
      });
    });
    out.append(fix);
  }
}

async function showPerms() {
  const box = $("perms");
  box.replaceChildren();

  const blocked: string[] = [];
  for (const inst of cfg.instances.filter((i) => i.enabled)) {
    const origins = originsFor(inst);
    const permissions = PERMS_FOR[inst.def] ?? [];
    if (origins.length === 0 && permissions.length === 0) continue;
    const ok = await ext.permissions
      .contains({
        ...(origins.length ? { origins } : {}),
        ...(permissions.length ? { permissions } : {}),
      })
      .catch(() => false);
    if (!ok) blocked.push(inst.name);
  }

  const all = await ext.permissions.getAll().catch(() => ({ origins: [] as string[] }));
  const n = (all.origins ?? []).length;

  if (blocked.length > 0) {
    const warn = el("div", "warn");
    warn.textContent =
      `${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} switched on but ` +
      `cannot reach ${blocked.length === 1 ? "its source" : "their sources"} yet. ` +
      `Use the button below — that is why ${blocked.length === 1 ? "it looks" : "they look"} empty.`;
    box.append(warn);
  }
  box.append(
    el(
      "div",
      undefined,
      n === 0
        ? "No sites granted yet. OpenTabs asks for one site at a time, when you add it."
        : `${n} site${n > 1 ? "s" : ""} granted. OpenTabs never asks for more than the groups you enabled.`,
    ),
  );
}

void main();
