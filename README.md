# OpenTabs

A new tab page that shows your **actual open tabs** — grouped by site and
closable — above a calm briefing you choose: web apps, markets, weather,
news topics, repos, calendar, to-dos.

Built on the OpenApps design system.

```
crates/tabs-core      pure Rust — parsing, ranking, grouping, dates. native + wasm
crates/tabs-feedgen   the daily feeds: two static files, no database
crates/tabs-market    the marketplace's ranking, moderation and privacy core
apps/extension        MV3 extension (Chrome + Firefox), vanilla TS
apps/marketplace      the pack marketplace, a static site
apps/market-api       the marketplace API: axum + SQLite, one binary
apps/site             opentabs.app itself
deploy/               nginx, Docker and the runbook — see deploy/DEPLOY.md
docs/config.schema.json  the published config schema
```

## Where it runs

| | |
|---|---|
| `opentabs.app` | the site, and the two daily feed files the extension reads |
| `market.opentabs.app` | the pack marketplace — site and API on one origin |
| `auth.opentabs.app` | OpenApps accounts, for the two things that need one |

Signing in is optional and buys exactly two things: publishing a pack, and
liking one. It is never used to store your configuration, which lives in your
own browser profile and nowhere else.

`deploy/DEPLOY.md` is the runbook.

## Three properties, in priority order

1. **Light.** The new tab opens 30–100× a day, so it must paint before you
   perceive it. Everything else is subordinate — including the interesting
   parts.
2. **Highly customisable.** Every group optional and reorderable, any topic
   you can name, and the whole configuration is one text document.
3. **Powerful.** Real cross-source dedupe and ranking, real calendar
   recurrence, real domain grouping. Not a link grid with a weather icon.

## The architecture in one picture

```
chrome.alarms ─► service worker ─► fetch → tabs-core.wasm → rank
                                            │
                                   render-ready JSON
                                            │
                                            ▼
                                    chrome.storage.local
                                            │
              new tab opens ─────────────►  read once, paint. done.
```

All the work happens where nobody is waiting. The new tab page ships **no
wasm, makes no network request, and is 4 KB gzipped** — asserted in
`apps/extension/test/budget.test.ts`, so it stays that way.

## Quick start

```sh
# Rust side
cargo test --workspace

# Extension
cd apps/extension
npm ci
npm run build            # → dist/  (load unpacked at chrome://extensions)
npm test                 # budget + manifest assertions against dist/
npm run e2e              # real Chrome
npm run build:firefox    # → dist-firefox/
```

`npm run build` needs the wasm-bindgen CLI pinned to the version in the root
`Cargo.toml`:

```sh
cargo install wasm-bindgen-cli --version 0.2.126 --locked
```

## Topics

There is no "AI news" feature and no "Finance news" feature. There is **one
topic engine**, instantiated. A topic is a name plus source *bindings*, and a
binding is either a fixed feed URL or a **query** against a searchable
source:

| Template | Yield |
|---|---|
| `googlenews` | ~100 items for any topic, any locale |
| `arxiv` | papers — `q-fin.TR` is the HFT category |
| `reddit` / `subreddit` | no key, no OAuth — it is just Atom |
| `bingnews` | a second opinion |
| `hn` | practitioner signal |

Seven topics ship as seeds (AI, Finance, Robotics, Crypto, Real Estate, Data
Centre, Quantitative Finance). They are **rows in a config file, not
features** — type "Semiconductor Supply Chain" into settings and you get
exactly what they have.

Ranking is a scoring function, not a model: recency decay × source weight ×
**cross-source corroboration**. A story four outlets carry outranks one only
a single blog ran, which is what turns a wide query source from noise into an
asset.

## Privacy

- **Your tabs never leave the browser.** No telemetry on tab data, ever.
- **No account required**, and nothing about you is stored on any server.
  Preferences live in `chrome.storage.sync`; calendar addresses and API keys
  never leave `storage.local`.
- **Site access is asked for one site at a time**, when you add it — the
  manifest requests no `<all_urls>`.
- Honest trade: because the extension fetches its own data, the sources you
  enable see your IP, the same way visiting them would. Nothing is proxied
  through us, and no central server learns what you read.

## The backend

Two static files, written by a cron job:

```sh
cargo run -p tabs-feedgen -- --out /var/www/openapps/tabs/v1
```

`apps.json` (hand-edited — the release valve for new OpenApps products) and
`github-trending.json` (one fetch of `github.com/trending`, 682 KB in, ~7 KB
out). No database, no API key, no model, no auth. Sign-in, if ever added,
needs one line: the extension origin in `allowed_origins`.

## Licence

MIT.
