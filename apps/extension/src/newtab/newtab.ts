/**
 * The new tab page. Dumb by contract.
 *
 * One storage read, then paint. No fetch, no wasm, no parsing — every one of
 * those already happened in the service worker on an alarm. This file must
 * stay boring; if it ever needs to compute something, that belongs in
 * `src/background`.
 *
 * The one exception is the to-do date parser, which is asked of the worker
 * over a message rather than done here.
 */
import { ext, KEY, getLocal, getSync, setLocal } from "../lib/ext";
import { OPENAPPS_MATCH } from "../lib/openapps";
import { applyTheme } from "../lib/theme";
import type { Config, LocalState, Payloads } from "../lib/types";
import { makeArrangeable, packGrid, watchGrid, type Span } from "./layout";
import {
  markBookmarked, renderApps, renderBookmarks, renderCalendar, renderFocus, renderScratch,
  renderFailed, renderStatus, renderTabs, renderTickers, renderTodos, renderTopic,
  renderTrending,
  renderWeather, renderXSearch,
} from "./render";

const ASSISTANTS: Record<string, { label: string; url: (q: string) => string }> = {
  claude: { label: "Claude", url: (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}` },
  chatgpt: { label: "ChatGPT", url: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}` },
  perplexity: { label: "Perplexity", url: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}` },
  google: { label: "Google", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
};

/** Bang prefixes override the default assistant for one query. */
const BANGS: Record<string, string> = {
  "!c": "claude", "!claude": "claude",
  "!p": "perplexity", "!perp": "perplexity",
  "!g": "google", "!gpt": "chatgpt", "!o": "chatgpt",
};

function greeting(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function fresh(p: { generated_at: number; stale_after: number } | undefined): boolean {
  if (!p || !p.generated_at) return false;
  // Grace beyond the budget: better a slightly old briefing than a hole in
  // the page while the worker is waking up.
  return p.stale_after + 1800 > Date.now() / 1000;
}

async function main() {
  const now = new Date();
  document.getElementById("greeting")!.textContent = greeting(now);
  document.getElementById("date")!.textContent = now.toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const [stored, payloads, local] = await Promise.all([
    getSync<Config | null>(KEY.config, null),
    getLocal<Payloads>(KEY.payloads, {}),
    getLocal<LocalState>(KEY.local, {}),
  ]);

  // Fast path: config comes straight from storage, no message, no await
  // beyond the read above.
  //
  // On the very first new tab of a fresh install, though, the worker may not
  // have seeded it yet — and an empty config renders an empty page, which is
  // a terrible first impression and was an intermittent test failure. So fall
  // back to asking the worker, but *only* when there is nothing to draw.
  // Still no network and no wasm on this path.
  let cfg: Config | null = stored;
  if (!cfg?.instances?.length) {
    cfg = await ext.runtime
      .sendMessage({ type: "config" })
      .then((r: { config?: Config } | undefined) => r?.config ?? null)
      .catch(() => null);
  }
  const instances = cfg?.instances ?? [];

  if (cfg?.theme === "dark") document.documentElement.className = "oa-dark";
  else if (cfg?.theme === "light") document.documentElement.className = "";
  // Synchronously, before the first paint: applying a theme afterwards means
  // painting the default palette and then repainting, which is a flash of the
  // wrong colours on the page someone opens fifty times a day.
  applyTheme(cfg?.custom_theme);

  setupPrompt(cfg?.assistant ?? "claude");
  document.getElementById("settings")!.addEventListener("click", () => {
    void ext.runtime.openOptionsPage();
  });
  setupAccount();
  // Straight to the Marketplace pane, not the front of Settings. Landing on
  // Groups and being expected to find the tab is how a link gets a
  // reputation for not working.
  document.getElementById("packs")?.addEventListener("click", () => {
    void ext.tabs.create({ url: ext.runtime.getURL("settings.html#pane=market") });
  });

  const saveLocal = (s: LocalState) => {
    void setLocal(KEY.local, s);
    void ext.runtime.sendMessage({ type: "rescheduleReminder" }).catch(() => {});
  };
  const parseDue = async (text: string) => {
    try {
      return await ext.runtime.sendMessage({ type: "parseDue", text });
    } catch {
      return null;
    }
  };

  const grid = document.getElementById("grid")!;
  const frag = document.createDocumentFragment();

  for (const inst of instances) {
    if (!inst.enabled) continue;
    const p = payloads[inst.id];
    const data = p?.data as never;
    let node: HTMLElement | null = null;

    // Wrapped, because a renderer that throws used to abort the whole loop:
    // one malformed payload produced a *completely blank page*, every other
    // group gone, with nothing on screen to say why. Found while seeding
    // screenshot fixtures with the wrong shape — which is what a half-written
    // storage value, or data from a version one schema ahead, looks like.
    //
    // A group that cannot render is one group's problem. The page is not
    // allowed to make it everybody's.
    try {
    switch (inst.def) {
      // Local groups always render — they have no freshness to lose.
      case "focus": node = renderFocus(inst, local, saveLocal); break;
      case "scratch": node = renderScratch(inst, local, saveLocal); break;
      case "todos": node = renderTodos(inst, local, saveLocal, parseDue); break;
      case "tabs":
        if (data) {
          node = renderTabs(inst, data);
          // A sensible starting width, not a fixed one — the user can resize
          // it like any other card.
          if (inst.opts.span === undefined) inst.opts.span = 2;
        }
        break;
      // Fetched groups hide themselves when their data is past budget.
      // A topic renders even when stale, because its note explains itself.
      case "topic": node = renderTopic(inst, fresh(p) ? (data ?? []) : [], p?.error); break;
      case "apps": if (fresh(p)) node = renderApps(inst, data ?? []); break;
      case "weather": if (fresh(p)) node = renderWeather(inst, data); break;
      case "crypto": if (fresh(p)) node = renderTickers(inst, data ?? []); break;
      case "equities": if (fresh(p)) node = renderTickers(inst, data ?? [], true); break;
      case "status": if (fresh(p)) node = renderStatus(inst, data ?? []); break;
      case "xsearch":
        node = renderXSearch(inst, fresh(p) ? (data ?? []) : [], p?.error, () => {
          void ext.runtime
            .sendMessage({ type: "xWebUrl", instance: inst })
            .then((r: { url?: string }) => {
              if (r?.url) window.open(r.url, "_blank", "noopener");
            })
            .catch(() => {});
        }, p?.retry_at);
        break;
      case "trending": node = renderTrending(inst, fresh(p) ? (data ?? []) : []); break;
      // Renders even when empty: "I have not been given permission" is the
      // usual state before the reader grants it, and a card that vanishes
      // instead of saying so is the bug this avoids.
      case "bookmarks":
        node = renderBookmarks(inst, fresh(p) ? (data ?? []) : [], p?.error);
        break;
      // Renders even when empty or stale: its note explains itself, and a
      // calendar card that silently vanishes is the bug this replaces.
      case "calendar":
        node = renderCalendar(inst, fresh(p) ? (data ?? []) : [], p?.error);
        break;
      default: node = null;
    }
    } catch (e) {
      console.error(`OpenTabs: the ${inst.def} group failed to render`, e);
      node = renderFailed(inst);
    }
    if (node) {
      makeArrangeable(node, inst.id, {
        span: inst.opts.span as Span | undefined,
        collapsed: inst.opts.collapsed as boolean | undefined,
        rows: Number(inst.opts.rows) || undefined,
      }, grid);
      frag.append(node);
    }
  }

  grid.replaceChildren(frag);
  // Measured synchronously, in the same task as the insert: doing it in a
  // later frame would paint once at the wrong height and again at the right
  // one, which is exactly the layout shift the budget forbids.
  packGrid(grid);
  watchGrid(grid);

  const tabsPayload = payloads["tabs"]?.data as { total?: number } | undefined;
  if (tabsPayload?.total !== undefined) {
    // "1 tabs" on a page somebody opens fifty times a day.
    const n = tabsPayload.total;
    document.getElementById("tabcount")!.textContent = `${n} ${n === 1 ? "tab" : "tabs"}`;
  }

  // Tab state changes constantly; ask for a re-group after paint so the
  // count is right without ever blocking the first frame.
  void ext.runtime.sendMessage({ type: "refreshTabs" }).catch(() => {});
  // Same reasoning for the bookmark marks: a decoration on rows that are
  // already on screen, never a condition of them getting there.
  void ext.runtime
    .sendMessage({ type: "bookmarkedUrls" })
    .then((r: { urls?: string[] | null }) => markBookmarked(grid, r?.urls ?? null))
    .catch(() => {});
}

function setupPrompt(defaultAssistant: string) {
  const form = document.getElementById("promptbar") as HTMLFormElement;
  const input = document.getElementById("prompt") as HTMLInputElement;
  const button = document.getElementById("assistant") as HTMLButtonElement;

  let current = ASSISTANTS[defaultAssistant] ? defaultAssistant : "claude";
  const paint = () => {
    button.textContent = ASSISTANTS[current]!.label;
  };
  paint();

  button.addEventListener("click", () => {
    const keys = Object.keys(ASSISTANTS);
    current = keys[(keys.indexOf(current) + 1) % keys.length]!;
    paint();
    input.focus();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let q = input.value.trim();
    if (!q) return;
    let target = current;
    const firstSpace = q.indexOf(" ");
    const head = (firstSpace === -1 ? q : q.slice(0, firstSpace)).toLowerCase();
    if (BANGS[head]) {
      target = BANGS[head]!;
      q = firstSpace === -1 ? "" : q.slice(firstSpace + 1).trim();
    }
    if (!q) return;
    window.location.href = ASSISTANTS[target]!.url(q);
  });

  // The prompt bar is the primary input on this page (A1), so it gets focus.
  input.focus();
}

// storage.local is fast, but not synchronous — start immediately rather than
// waiting for DOMContentLoaded, since the script is a module and defers already.
void main();


/**
 * The account button.
 *
 * Signing in cannot happen on this page, and the reason is structural rather
 * than a shortcut: Chrome injects `window.ethereum` and `window.nostr` from
 * content scripts, and content scripts never run on `chrome-extension://`
 * URLs. Wallet and Nostr sign-in are therefore impossible here however long
 * you wait for the globals — a form on this page could only ever offer
 * Google, with two buttons that error. So the button opens the platform's
 * own https sign-in page in a tab, and a relay registered on that origin
 * hands the session back to the worker.
 *
 * Nothing here is on the paint path. The button renders signed-out from
 * markup; the worker is asked afterwards and the dot appears if it differs.
 */
function setupAccount() {
  const btn = document.getElementById("account");
  const dot = document.getElementById("accountdot");
  if (!btn || !dot) return;

  let signedIn = false;

  const draw = (yes: boolean) => {
    signedIn = yes;
    dot.hidden = !yes;
    btn.classList.toggle("on", yes);
    btn.title = yes ? "Signed in — click to sign out" : "Sign in";
    btn.setAttribute("aria-label", btn.title);
  };

  const ask = () =>
    ext.runtime
      .sendMessage({ type: "authState" })
      .then((r: { signedIn?: boolean } | undefined) => draw(!!r?.signedIn))
      .catch(() => {});

  void ask();

  btn.addEventListener("click", () => {
    if (signedIn) {
      // Immediate rather than behind a confirm dialog: signing back in is
      // two clicks, and a menu on this page is a menu on the page that has
      // to open in under a frame.
      void ext.runtime.sendMessage({ type: "authSignOut" }).then(() => draw(false)).catch(() => {});
      return;
    }
    // Permission first, and nothing awaited before it: one `await` spends
    // the user activation and the prompt then never appears — no error, no
    // dialog, just a button that does nothing. Already granted resolves
    // immediately without prompting, so calling it every time is safe and is
    // what keeps it first.
    //
    // Without it the worker registers no relay on the sign-in origin, the
    // session is never handed back, and the tab sits there looking finished.
    void ext.permissions
      .request({ origins: [OPENAPPS_MATCH] })
      .then((ok) => {
        if (!ok) return false;
        // The worker opens the tab and resolves when the session arrives, so
        // there is nothing to poll and no window to keep a handle on.
        return ext.runtime
          .sendMessage({ type: "authSignIn" })
          .then((r: { ok?: boolean } | undefined) => !!r?.ok);
      })
      .then((ok) => draw(!!ok))
      .catch(() => {});
  });

  // Signing in happens in another tab, and this one may have been sitting
  // open the whole time. Re-check when it comes back into view.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void ask();
  });
}
