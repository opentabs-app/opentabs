# opentabs (OpenTabs) — Implementation Plan

**Status (2026-08-30): M0–M11 implemented. 112 Rust tests, 19 TypeScript tests and 6
Playwright e2e tests pass against real Chrome; `cargo clippy -D warnings` and
`cargo fmt --check` are clean; Chrome and Firefox both build. `tabs-feedgen` was run
against the live GitHub trending page and produced a 6.7 KB file from 20 repos.**

**The budgets hold, measured on the built bundle: the new tab page ships zero wasm
references, makes zero network calls, and is 4.0 KB gzipped — 13% of its 30 KB budget.**

Not done: store submission (needs real credentials), Firefox on-device verification, and
the A1–A7 AI-native layer beyond the prompt bar and bang routing. See "What is not built"
at the end.

Product: a new tab page that replaces Chrome's with your own mission control — your
actual open tabs, grouped and closable, above a calm, fully customisable briefing:
web apps, markets, weather, news, repos, calendar, to-dos. Extends
an original implementation throughout.

Three properties drive every decision here, in this order:

1. **Light** — the new tab page opens 30–100× a day. It must paint before the user
   perceives it. Everything else is subordinate to that.
2. **Highly customisable** — every group optional, reorderable, configurable; users can
   add their own sources; the whole configuration is one text document.
3. **Powerful** — real trending, real recurrence expansion, real dedupe. Not a
   link grid with a weather icon.

---

## Decision log

Decisions taken in discussion, with the reasoning that produced them. Recorded because
the *why* is what a future change needs to argue against.

| # | Decision | Why |
|---|---|---|
| D1 | **Hybrid sourcing, client-direct by default.** The extension fetches its own data. A small static server handles only what the client provably cannot. | MV3 extensions bypass CORS with host permissions, so client-direct is far more viable than on the web. Keeps the product alive if the server dies. |
| D2 | **The server handles exactly two things:** the OpenApps app catalogue and GitHub trending. | The catalogue is the release valve — a new product appears the day you ship it, not after a store review. Trending is a 682 KB page republished as 8 KB, which is politer to GitHub and lets a markup change be a server-side fix. Nothing else needs a server. |
| D3 | **Rust core (`tabs-core`) compiled to wasm — in the service worker only, never the new tab page.** | D1 moved feed parsing, dedupe, ranking, ICS recurrence and PSL grouping into the client. That is a large body of pure logic. Putting it in a background alarm keeps it off the paint path entirely; the new tab page becomes a dumb renderer and is *faster* than an inline-fetch design. |
| D4 | **Local-first. Zero OpenTabs user data on the backend.** Preferences in `chrome.storage.sync`; secrets in `storage.local`; cross-browser sync via a config string, not an account. | User constraint. Also means the server's two files are unauthenticated static files with no identity in the request path and nothing to log. |
| D5 | **Login is optional and additive**, for the Web Apps launcher (signed-in state, balance, SSO) and, if ever wanted, the Supporter entitlement — which reuses the existing row in `openapps-server` and adds no new user data. | OpenTabs must work fully signed-out. This audience is hostile to account walls. |
| D6 | **On-demand host permissions** (`optional_host_permissions` + `chrome.permissions.request()` on the user's click) for user-added feeds. Only default-on groups' origins ship in fixed `host_permissions`. | `<all_urls>` on a new-tab override reads as "read all your data on all websites" and invites a hard store review. Asking per-site at the moment of adding is better UX *and* a better review story. |
| D7 | **Calendars via ICS subscription, not OAuth.** | One parser covers Google, Outlook, iCloud, Fastmail, Proton, Notion, Linear, Cal.com. No OAuth, no Google verification, no backend. `calendar.readonly` is a *sensitive* scope — verification with justification and demo video, though not the CASA audit that restricted scopes trigger — which is a v2 cost, not a v1 one. |
| D8 | **Default to calm.** A small default-on group set; density is opt-in. | 90% of new-tab opens are "I want to go somewhere", not "let me read". Also the cheapest way to keep the install-time permission list short (D6). |
| D12 | **There are no news groups — there is one topic engine, instantiated.** A topic is a user-chosen name plus a set of *source bindings*, and a binding is either a fixed feed URL or a **query** against a searchable source. | "AI news" and "Finance news" as separate code would have been two hardcoded lists that no user could extend to Robotics, Data Centre or HFT. Making them seed configuration instead means any topic works on day one — verified against Google News, arXiv, Reddit search, Bing News and HN Algolia, all of which accept an arbitrary query and return real results. It also deletes the separate "custom feeds" group: adding a feed is adding a source to a topic. |
| D10 | **No model calls in the product.** "Top 5 headlines with links" is a ranking problem, not a summarisation one: recency decay × source weight × cross-source corroboration, computed in `tabs-core`. | Deterministic, instant, free, property-testable, and it needs no AI-generated-content labelling and carries no editorial liability. A model would only earn its place clustering near-duplicate headlines that share no URL — deferred until ranking demonstrably fails. |
| D11 | **Prefer the source that blocks servers.** Where a free endpoint is browser-shaped and datacenter-hostile, fetch it from the user's browser, never from our server. | Measured, not assumed — see the table below. These endpoints are built for people reading their own data; a server proxying them gets blocked *and* is the party redistributing someone else's content. |
| D13 | **Anything time-based gets an alarm, never an event.** Tab pruning rides on `chrome.alarms` sized to the user's cutoff, not on `chrome.tabs` events. | An MV3 worker has no timers of its own — it is dead between wakeups. Hanging "close a New Tab untouched for N minutes" off tab events meant the one case the feature is named after, a tab nobody touches, produced no event and never fired. Being idle is not observable as an event; it can only be noticed by looking. The same feature had a second silent failure worth recording: overriding the new tab page does **not** change the URL the browser reports for it — a real Ctrl+T tab is `chrome://newtab/`, never the extension URL — so matching the extension URL matched nothing anyone ever opens. Both bugs passed tests, because the tests navigated to the page by hand instead of opening a new tab. |
| D14 | **A marketplace that stores content, never preferences.** Publishing is an explicit act and a listing is hosted content. A **like** is stored as `HMAC(server_secret, account_id ‖ pack_id)` — an opaque token and nothing else. | The stated constraint is that no user information or preference is held on the backend, and a naive `likes(user_id, pack_id)` table is exactly a preference. The token answers the only question the feature asks — *has this account already liked this* — and cannot be reversed: the account id is not stored, and the HMAC key is never written beside the tokens, so a stolen database plus the whole account list still yields nothing. "What has this person liked" has **no query that answers it**, and a test asserts that against the schema rather than against this paragraph. |
| D15 | **A pack is hostile until proved otherwise.** Allow-lists for colours, font stacks, media schemes, defs and option keys; never a deny-list. Validated in the extension *and* again on the server. | A pack is JSON from a stranger that is applied to a reader's configuration and their stylesheet. A colour that may be any string is a stylesheet injection — `url(…)` alone is a request reporting who is reading. `calendar` is unshareable because its address is a bearer secret. Keys and coordinates are stripped on the way out, so publishing cannot leak them even by accident. The extension's cleaning is a convenience for the publisher; the server's is the boundary, and a boundary that trusts its client is not one. |
| D9 | **Everything is written from scratch.** No third-party source is copied; grouping, ranking, parsing and UI are original. | Nothing carries another project's licence obligations, so the product is MIT end to end with no attribution to track. |

### What the probes changed

Three claims in the first draft did not survive contact with the actual endpoints.

**CORS is not an obstacle.** The first architecture routed all content through a
server-built bundle, partly because CORS would block client-side fetching. That is wrong
for extensions: Chrome's docs are explicit that same-origin policy binds content scripts,
not the extension itself. Verified — `openai.com/news/rss.xml` sends no CORS header at all
and is fetchable anyway. Removing that objection is what made D1 viable.

**GitHub trending needed no invention.** The plan originally built daily star snapshots in
a database to compute trending, on the belief that scraping `github.com/trending` was off
the table. It is not: `robots.txt` contains no mention of `/trending`, the page returns 200,
and it parses cleanly — repo, stars-today and language for twenty rows. That deleted a
database, a schema, and the multi-day cold start before the group would work at all.

**Free financial and social endpoints are browser-shaped.** Measured from a datacenter IP:

| Source | From a datacenter IP |
|---|---|
| Yahoo Finance (`query1`) | `429` on the first request |
| Reddit `.json` | `403` |
| Reddit `.rss` | `200`, then `429` on the second |
| MarkTechPost RSS | `403` (Cloudflare) |
| The Robot Report RSS | `403` |
| Bluesky public API | `403` |
| GitHub `/trending` | `200` — the exception, which is why it stays served |

Five independent sources behave the same way. They are built for a person reading their own
data at human cadence, and hostile to a server pulling on everyone's behalf. This is D11, and
it is the strongest empirical argument in the design: for these sources client-direct is not
merely acceptable, it is *more reliable* than a proxy — and it is also the party-of-record
question, since a server redistributing Yahoo's quotes is doing something a browser reading
them is not.

### One trade accepted knowingly

Client-direct means each user's IP reaches TechCrunch, CNBC, Reddit and Yahoo on a schedule;
a bundle would have had zero vendors seeing users. It is *no central observer* versus *no
vendor observers* — a real trade, not a free win. It gets an honest line in the privacy
disclosure.

---

## Non-negotiables

These are budgets, not aspirations. CI enforces the ones marked ✓.

| | Budget | |
|---|---|---|
| New tab first paint | < 50 ms from navigation | ✓ measured in e2e |
| New tab JS bundle | < 30 KB gzipped | ✓ size check |
| Network requests on the paint path | **zero** | ✓ e2e asserts no fetch |
| wasm on the paint path | **zero** | ✓ bundle graph check |
| Layout shift after paint | **zero** — cached content occupies the size fresh content will | e2e CLS assert |
| Tab data leaving the browser | **never**, under any setting | code review + listing claim |
| Install-time host permissions | only default-on groups' origins | manifest review |

The zero-network rule is what the whole service-worker architecture buys. If a change
needs a fetch during render, the change is wrong.

---

## Architecture

```
                    chrome.alarms  (staggered, per-group TTL)
                            │
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │ service worker  —  the only place work happens            │
   │                                                           │
   │  scheduler ──► fetch (conditional GET, backoff)           │
   │                   │                                       │
   │                   ▼                                       │
   │            tabs-core.wasm                                 │
   │              feed parse (RSS/Atom/RDF) · dedupe · rank     │
   │              ICS parse · RRULE expansion · timezones       │
   │              URL canonicalise · PSL eTLD+1 · NL dates      │
   │                   │                                       │
   │                   ▼                                       │
   │            render-ready JSON ──► chrome.storage.local      │
   └──────────────────────────────────────────────────────────┘
                            │
        new tab opens       ▼
   ┌──────────────────────────────────────────────────────────┐
   │ newtab page  —  vanilla TS, ~15 KB, no wasm, no network   │
   │   one storage read → paint → done                         │
   └──────────────────────────────────────────────────────────┘
```

The asymmetry is the design. All latency lives in a background alarm where it costs
nothing; the surface the user actually waits on does one synchronous-feeling read.

### Repo layout

```
opentabs/
  Cargo.toml                    workspace: tabs-core, tabs-feedgen
  rust-toolchain.toml
  crates/
    tabs-core/                  pure · no I/O · → wasm32 + native
      src/feed/                 rss/atom/rdf, autodiscovery, dedupe, rank
      src/ical/                 ICS parse, RRULE/EXDATE/RDATE, VTIMEZONE
      src/tabs/                 PSL eTLD+1 grouping, dedupe, fuzzy search
      src/nldate/               "fri 3pm", "next tue", "eom"
      src/url/                  canonicalise, strip utm_*, webcal:// rewrite
      src/config/               config document schema + versioned migration
      src/wasm.rs               #[cfg(target_arch="wasm32")] the whole JS surface
    tabs-feedgen/               native binary — two files, no database
  apps/
    extension/
      public/manifest.json      + manifest.firefox.json
      src/background/           scheduler, wasm host, permission broker
      src/newtab/               the page. dumb by contract
      src/settings/             registry-driven
      src/groups/               one module per group, registered not hardcoded
      scripts/build-wasm.sh
  docs/
```

`tabs-core` compiles native so every rule is `cargo test`-and-`proptest`-covered, and
to wasm so the extension runs the *same* rules — the `shot-core` pattern OpenCapture
already proves in this codebase.

### The group registry

Every group is a registry entry, never hardcoded UI. This is what makes "add a group"
a config change instead of a refactor, and it is the mechanism behind both
customisability and extensibility.

```ts
interface GroupDef {                 // the *type* — one per kind of group
  id: string;
  kind: "local" | "feed" | "api" | "credentialed" | "served";
  name: string; icon: string;
  refresh: number | null;            // seconds; null = local, no fetch
  origins: string[];                 // for the permission broker
  options: OptionSchema;             // renders its own settings form
  render(payload, opts): Node;       // pure; payload came from storage
}

interface GroupInstance {            // what the user actually has on the page
  def: string;                       // "topic", "tabs", "weather", …
  id: string;                        // "hft", "robotics" — unique per user
  name: string;                      // "High Frequency Trading"
  opts: Record<string, unknown>;
}
```

**Defs are the code; instances are the config.** The user has one `tabs`, one
`weather`, and *however many* `topic` instances they want. This distinction is what
D12 needs, and getting it wrong — one def per news category — is what would have
made "add Data Centre" a code change.

### A topic, concretely

```ts
{ def: "topic", id: "hft", name: "High Frequency Trading",
  opts: {
    query: '"high frequency trading" OR "market microstructure" -crypto',
    sources: [
      { kind: "query", tmpl: "googlenews" },            // 100 items, any topic
      { kind: "query", tmpl: "arxiv", cat: "q-fin.TR" },
      { kind: "query", tmpl: "reddit", sub: "quant" },
      { kind: "feed",  url: "https://…/feed/" },        // one the user knows
    ],
    exclude: ["sponsored"], limit: 10,
  }}
```

A **query binding** is a URL template with the topic's query substituted; a **feed
binding** is a fixed URL. One parser, one ranker, one settings form, every topic.
Verified templates:

| Template | Shape | Yield |
|---|---|---|
| `googlenews` | `news.google.com/rss/search?q={q}&hl=&gl=&ceid=` | 100 items, any topic, any locale |
| `arxiv` | `export.arxiv.org/api/query?search_query=cat:{c}` or `all:{q}` | papers; `q-fin.TR` *is* the HFT category |
| `reddit` | `reddit.com/search.rss?q={q}&sort=top&t=week` | 25 items, no key |
| `bingnews` | `bing.com/news/search?q={q}&format=RSS` | second opinion on news |
| `hn` | `hn.algolia.com/api/v1/search?query={q}` | practitioner signal |

Five kinds, because the three later features proved groups are not alike:

| kind | example | needs |
|---|---|---|
| `local` | Tabs, To-dos, Focus, Scratchpad | nothing |
| `feed` | **Topics** — any number, user-named | on-demand origin permission |
| `api` | Weather, crypto, status | fixed origin |
| `credentialed` | **Calendars** | a secret; `storage.local` only; never exported |
| `served` | App catalogue, GitHub trending | two static files |

`kind` is what lets one settings page handle a user-added feed, a secret ICS URL and a
local to-do list without three bespoke code paths.

---

## The customisation model

- **One config document.** The entire configuration — group *instances*, order, layout,
  per-instance options, topic queries, source bindings, watchlists — is a single versioned
  JSON document in `storage.sync`, with a published JSON Schema in `docs/`. Not a scatter
  of keys.
- **Topics are the main thing users configure.** Name it, give it a query, add or remove
  bindings, filter it, set how many items show. Seven ship as seeds; there is no ceiling
  and no difference between a shipped topic and one the user invents (D12).
- **Layout is a grid the user arranges.** Drag to reorder, toggle on/off, resize
  between one and three columns, set item counts per group.
- **Import / export.** A JSON file, and a compressed `deflate`+base64url **config
  string** the user copies from Chrome and pastes into Firefox. Cross-browser sync
  with no server (D4). Secrets are excluded unless explicitly opted in with a warning.
- **A raw config editor** in settings, validated against the schema, with a diff before
  apply. Power users edit text; everyone else uses the forms. Both write the same doc.
- **OPML in and out** for feeds — migration from Feedly/Inoreader/NetNewsWire, and the
  ability to leave.
- **Themes** from `@openapps/tokens` semantic aliases only. `oa-auto` on `<html>`;
  never a `prefers-color-scheme` query of our own.

---

## The AI-native layer

The people most likely to keep 43 tabs open are the people who start most tasks by
opening a new tab and typing at a model. The new tab page is the single highest-value
place to serve them, and almost nobody has noticed.

**A1 — The prompt bar is the primary input.** Not a search box. Type, press Enter,
land in your chosen assistant with the text already there. Assistant is configurable
(Claude, ChatGPT, Perplexity, Gemini, or a custom URL template), with bang prefixes to
override per-query (`!c` Claude, `!p` Perplexity, `!g` Google). *Verify each provider's
query-param contract during M10 rather than assuming it.*

**A2 — Your tabs as context. This is the feature only a tab-aware new tab can have.**
One click turns the open-tab list into a prompt: *summarise these*, *what am I working
on*, *group these into projects*, *draft a status update*. Two paths, because URL
length caps out around 2 KB: short contexts prefill the assistant URL; long ones copy
to the clipboard and open a blank chat with a "context copied — paste it" toast. No key
required for either.

**A3 — Config as an agent-editable document.** Because the config is one schema'd JSON
document (above), an agent can write it. "Add a group of Korean semiconductor news" →
Claude Code produces valid config → paste, or open a `#import=` deep link. Shipping the
JSON Schema in `docs/` is what makes this reliable instead of guesswork. This costs
almost nothing to build — the document has to exist anyway — and it is the most direct
expression of "highly customisable" this product can offer.

**A4 — Ranking, not summarising.** *Cut.* The brief is "the top 5–10 stories with
headlines and links", and that is a ranking problem a scoring function solves better than a
model does: recency decay × source weight × cross-source corroboration, in `tabs-core`.
Free, instant, deterministic, testable — and no AI-generated content means no labelling
obligation and no editorial liability. Human-curated newsletters (TLDR AI, The Rundown,
Import AI) blend into the same ranked pool and are already "top N" by construction. See D10.

**A5 — Bring your own key.** An Anthropic or OpenAI key in `storage.local` — never
synced, never sent to our backend — unlocks per-user summarisation: summarise *this*
feed, *my* tabs, *my* day. Zero marginal cost to us. Disclose plainly that a key in
extension storage is readable by anyone with access to the machine.

**A6 — AI-native groups.** *Model radar* (release posts from Anthropic, OpenAI, Google,
Meta, Mistral, Qwen, DeepSeek — deduped; nobody aggregates this well). *arXiv daily*
(cs.AI/cs.LG/cs.CL). *AI provider status*. *GitHub AI trending*, topic-filtered.

**A7 — Agent-readable state, honestly scoped.** An MV3 extension cannot host an MCP
server: no listening socket, no local process. What it *can* do cheaply is write a
state snapshot — tabs, groups, to-dos, today's calendar — to a user-chosen location via
the File System Access API, the same mechanism OpenCapture already uses for save
locations. Claude Code then reads `~/opentabs/state.json`. A native-messaging host
exposing live state to a local MCP server is the real answer and is a separate project;
it is named here so it isn't rediscovered later, not scheduled.

---

## Group catalogue

| Group | Kind | Source | Refresh | Ships |
|---|---|---|---|---|
| **Open tabs** | local | `chrome.tabs` | live | M1 |
| **Focus line** | local | — | — | M4 |
| **Web Apps** | served | catalogue JSON | 24 h | M4 |
| **Tickers — crypto** | api | Binance / Coinbase | 60 s | M4 |
| **Weather** | api | Open-Meteo | 30 m | M4 |
| **Status board** | api | GitHub/CF/AWS/OpenAI/Anthropic status | 5 m | M4 |
| **Scratchpad** | local | — | — | M4 |
| **Topics** ×N | feed | query bindings + fixed feeds | 45 m | M5 |
| **GitHub — lite** | api | `created:>date sort:stars` | 12 h | M5 |
| *(seeds: AI · Finance · Robotics · Crypto · Real Estate · Data Centre · Quant Finance)* | | shipped as config, not code | | M5 |
| **Calendars** | credentialed | ICS subscription | 20 m | M7 |
| **To-dos** | local | — | — | M8 |
| **Today** | local | calendar ∪ to-dos, one timeline | — | M8 |
| **Tickers — equities** | api | Yahoo `query1`, client-direct | 15 m *delayed* | M5 |
| **Social** | feed | Reddit `.rss`, HN | 45 m | M5 |
| **GitHub — trending** | served | scraped `github.com/trending` | 12 h | M9 |
| **Model radar** | feed | vendor release feeds | 3 h | M10 |
| Recently closed | local | `chrome.sessions` | live | post-v1 |
| Top sites | local | `chrome.topSites` | live | post-v1 |
| World clocks | local | — | — | post-v1 |
| Release radar | feed | GitHub release atom feeds | 12 h | post-v1 |

Default-on at install: **Open tabs, Web Apps, Focus, Weather** (D8). Everything else is
one toggle away in settings.

---

## Milestones

**M0 — Skeleton.** Cargo workspace, `tabs-core` building for native + wasm32, Vite
multi-entry extension, `@openapps/tokens` wired, CI (fmt, clippy -D warnings, cargo
test, wasm build, typecheck, vitest, Playwright). Deliverable: a styled empty shell
that loads as an unpacked extension.

**M1 — Tab mission control.** The anchor feature, and shippable on its own. eTLD+1
grouping in `tabs-core` (PSL, IDN, localhost ports, bare IPs) — proptested; homepage
group; duplicate detection; save-for-later; cross-window jump; badge count in the
service worker; the close interaction with its sound and confetti, respecting
`prefers-reduced-motion` and the once-per-session animation rule.

**M2 — Config document, registry, settings.** Schema + versioned migration in Rust;
`storage.sync` persistence; the registry; the settings page rendering itself from
`options` schemas; the drag-to-arrange grid; import/export + config string; the raw
editor with schema validation and a pre-apply diff.

**M3 — The pipeline.** Alarm scheduler with staggered per-group TTLs; conditional GET
with ETag/`If-Modified-Since`; exponential backoff; staleness budgets that hide a group
rather than show stale data; the wasm host in the service worker; render-ready payloads
into `storage.local`. Plus the permission broker for D6. **The e2e assertions for the
zero-network and zero-wasm paint budgets land here** — they must exist before the
groups that would violate them.

**M4 — Wave 1: the keyless groups.** Web Apps launcher, crypto tickers, weather,
status board, focus line, scratchpad. First genuinely useful release.

**M5 — The topic engine.** The centrepiece, and the thing most of the product turns out
to be. RSS/Atom/RDF parsing in `tabs-core` (three dialects, entity mangling, the
date-format swamp), the query-binding templates above, cross-source dedupe, and the ranking
function of D10. Ships with seed topics — AI, Finance, Robotics, Crypto, Real Estate, Data
Centre, Quantitative Finance — that are **rows in a config file, not features**, so a user
adding "Semiconductor Supply Chain" gets exactly what the shipped ones have.

Two implementation notes that bite here:

- **Google News URLs are redirect wrappers** (`news.google.com/rss/articles/CBM…`), so
  dedupe fails unless URL canonicalisation resolves or normalises them. Cross-source
  corroboration is the main ranking signal (D10), and it is worthless if the same story
  under two wrappers reads as two stories.
- **Query sources are large.** One Google News query returns ~130 KB. Five topics × four
  bindings is ~2.6 MB per refresh cycle — real bandwidth on someone's laptop. Mitigations:
  default a new topic to **one** query binding (Google News alone yields 100 items),
  cap bindings per topic, 45–60 min TTLs, and jittered schedules. Measure this before
  raising any default.

Reddit lands here free — `/r/<sub>/top/.rss` and `search.rss` are both Atom with no key and
no OAuth, so they are just two more bindings. Equities land here too, client-direct via
Yahoo per D11 — labelled delayed and unofficial, default off, failing silently.

**M6 — Discovery.** M5 makes any topic *work*; M6 makes it *findable*. Three routes, in
the order a user reaches for them:

1. **Type a topic name.** Query bindings cover it instantly with no curation — this is
   why D12 matters and why "High Frequency Trading Strategies" is not a special case.
2. **Paste any URL.** Is-it-a-feed → `<link rel="alternate">` autodiscovery → well-known
   paths (`/feed/`, `/rss`, `/feed.xml`, `/atom.xml`, `/index.xml`, `/?feed=rss2`).
   Candidate ranking that demotes comment feeds — verified necessary: `mingtiandi.com`
   advertises both a main and a comments feed. Live 3-headline preview before saving,
   then the batched `chrome.permissions.request()` flow.
3. **The directory.** A curated, topic-tagged source list served as a static file, so a
   new suggestion ships without an extension release. Where "Real Estate APAC →
   Mingtiandi" lives.

Plus per-topic include/exclude keyword filters — "data centre" pulls real-estate noise
and vice versa — and OPML import/export, so a Feedly subscription list arrives whole and
can leave the same way.

**M7 — Calendars.** ICS parsing and RRULE/EXDATE/RDATE expansion with VTIMEZONE in
`tabs-core` — the hardest correctness work in the project and the clearest payoff of
the Rust decision. `webcal://` rewrite. Per-provider illustrated instructions. Secret
URLs in `storage.local`, excluded from export. "Next up" display: next three events,
time-until, meeting hours today, and a Join button parsed out of Meet/Zoom/Teams links
in the location or description. **Empirically measure Google's export-endpoint cache
behaviour with a real calendar before promising any freshness in the UI.**

**M8 — To-dos and Today.** Local store in `storage.sync`; natural-language date entry
via `tabs-core`; a *single rolling alarm* for the next due item, recomputed on change,
never one alarm per to-do; `chrome.notifications` as an optional permission requested at
first use; a startup sweep that shows a digest of anything missed while Chrome was
closed. Turn a tab into a to-do with a deadline — *close the tab, keep the task* — which
is what turns "saved for later" from a bookmark into a real feature. Then the
merged **Today** timeline of events and deadlines together.

**M9 — `tabs-feedgen`.** Now an afternoon, not a milestone. A Rust binary on a timer
producing two unauthenticated static files: the hand-maintained app catalogue, and
`github-trending.json` — one fetch of the 682 KB trending page, parsed to ~8 KB. **No
database, no API key, no model, no auth.** It writes into a directory the existing site
deploy already serves, so `openapps.network/tabs/v1/*.json` needs no new DNS, certificate
or vhost. The HTML parser ships with a checked-in fixture so a GitHub markup change fails
a test rather than a user's new tab.

**M10 — The AI-native layer.** A1 prompt bar, A2 tab-context actions, A3 published JSON
Schema + `#import=` deep link, A5 BYO key, A6 model radar, A7 state snapshot via File
System Access. A4 is cut (D10) — nothing in OpenTabs calls a model by default, and any
user who wants summarising brings their own key.

**M11 — Ship.** Firefox build target (`chrome_url_overrides.newtab` is supported in
Firefox MV3; reuse OpenCapture's `TARGET_BROWSER` split), the privacy disclosure
including the honest client-direct vendor-exposure line, store listing and screenshots,
store listing copy.

---

## Testing

- **`tabs-core`**: unit + `proptest`. The properties that matter — grouping never loses
  a tab, dedupe is idempotent, RRULE expansion round-trips against known fixtures,
  NL-date parsing never produces a past date for a future phrase, URL canonicalisation
  is stable under repetition.
- **Fixtures over network** for every parser: real captured RSS/Atom/RDF and ICS files
  checked in, including the ugly ones. No test may hit the network.
- **Playwright e2e** against real Chrome: paint budget, zero-network-on-paint,
  zero-CLS, permission-request flow, feed-add flow end to end.
- **CI** mirrors OpenCapture's workflow, in `opentabs/.github/workflows/`.

---

## Permissions

| Permission | Why | When |
|---|---|---|
| `tabs` | the anchor feature | install |
| `storage` | config + payloads | install |
| `alarms` | the scheduler | install |
| default-on group origins | weather, catalogue | install |
| `optional_host_permissions: https://*/*` | user-added feeds, calendars | on the user's click |
| `notifications` | to-do reminders | at first reminder |
| `topSites`, `sessions` | post-v1 groups | when enabled |

`tabs` alone surfaces as "read your browsing history", which on a new-tab override
invites scrutiny. The listing must state plainly and verifiably: **tab data never
leaves the browser.**

---

## Risks

1. **Store review.** New-tab overrides are reviewed hard under the single-purpose
   policy, and `tabs` reads as browsing history. Mitigated by D6/D8 and an explicit
   disclosure; not eliminated. Budget for a rejection round.
2. **Scope.** This is eleven milestones. M1 alone is a shippable product and M4 is a
   good public v1 — release early rather than holding for M11.
3. **Vendor terms, and the Yahoo dependency.** Open-Meteo is free non-commercially and
   CoinGecko now generally wants a key. The equities source is Yahoo's undocumented
   `query1` endpoint: no SLA, no contract, and it can change shape without notice. That is
   survivable precisely because it is client-direct — the user's browser fetching the
   user's own watchlist — and because the group fails silently and is off by default. A
   keyed vendor (Twelve Data, Finnhub) stays the opt-in upgrade for anyone who wants a
   contract behind the numbers; confirm KRX coverage before recommending one.
4. **Silent staleness.** A dead scheduler looks identical to quiet news. Every payload
   carries `generated_at`; past its staleness budget a group hides itself.
5. **Reminder reliability.** `chrome.alarms` has a 30-second floor and does not fire
   while Chrome is closed. Say so in the UI; the startup digest turns the limitation
   into a feature.
6. **Rate limits under shared NAT.** GitHub Search is 10 req/min *per IP* — verified by
   exhausting it during design — and Reddit 429s quickly under load. Behind office or
   carrier-grade NAT users can break each other. Mitigated by long TTLs (45 m for feeds,
   12 h for trending), jittered schedules so installs don't synchronise, and honest
   silent failure. The served trending file removes the worst case entirely.

7. **Query sources are wide, and wide means noisy and heavy.** One Google News query is
   ~130 KB and 100 items, most of them the same story from different outlets. Dedupe and
   corroboration turn that from a liability into the main ranking signal — but only if
   Google's redirect-wrapper URLs canonicalise correctly. Budget for tuning: default one
   binding per new topic, cap the total, and measure bandwidth before raising either.

8. **A scraped page is a page that changes.** `github.com/trending` is HTML, not an API.
   The parser ships with a checked-in fixture, CI fails on a parse regression, and the
   group hides itself rather than showing nothing — but expect to fix it once a year.
7. **The secret ICS URL is a bearer credential.** Local-only storage, excluded from
   export, with a "reset your secret address" pointer for leaks.

---

## What is not built

Honest gaps, so nobody rediscovers them as surprises:

- **A2 tab-context actions, A3 `#import=` deep link, A5 BYO key, A7 state snapshot.** The
  prompt bar and bang routing (A1) ship; the rest of the AI-native layer does not. A6
  model radar works today as an ordinary topic — it needs no code, only a config row.
- **Store submission.** Needs real credentials this environment does not have. The
  listing copy and privacy disclosure are not written.
- **Firefox on device.** `dist-firefox/` builds and the manifest is right, but nothing
  has been loaded into a real Firefox.
- **Drag-to-reorder.** Settings reorders groups with up/down buttons; the plan called for
  drag. Buttons are keyboard-accessible, which drag is not, so this may stay.
- **OPML import/export.** Specified in M6, not implemented — the paste-a-URL path and the
  seven seed topics cover the same need for now.
- **The starter directory** is the seed topics rather than a served, updatable file.
- **PSL coverage.** `tabs::SUFFIXES` is a curated ~120-entry table, not the full Public
  Suffix List. It is a plain data table precisely so swapping in the real list later is a
  data change, not a code change.
- **ICS timezones.** UTC and date-only values are exact; a `TZID=` local time is read as
  wall-clock and flagged `floating` for the UI. Full VTIMEZONE would mean shipping a zone
  database in the wasm bundle.

## Open questions

1. **Default assistant** for the prompt bar — Claude, or ask on first run?
2. **X/Twitter.** X removed its free read tier in February 2026; reads are $0.005/post,
   so a server-funded Social group would run ~$45/month at a modest cadence. Read as
   settled in favour of free sources (Reddit, HN) with X available as a bring-your-own-key
   source, per A5 — say so if that reading is wrong.
3. **Does OpenTabs ever charge?** The Supporter-entitlement pattern fits (D5), but nothing
   here costs enough per user to need it. Recommend shipping entirely free and revisiting.
4. **Repo split**: stay under `openapps/` like `opencapture`, or its own repository?
