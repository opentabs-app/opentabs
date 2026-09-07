# Why OpenTabs

## The problem

A browser tab is the cheapest thing in computing to create and the most
expensive to find. People run twenty, forty, a hundred at once; the strip at
the top of the window degrades to a row of favicons at about fifteen, and
past that a tab is only findable by clicking through them one at a time.

Meanwhile the page you see most often in a day — the new tab, thirty to a
hundred times — shows a grid of links you already bookmarked, or an
advertising surface, or nothing.

Those two facts sit next to each other and almost nobody puts them together.
The surface you open constantly is blank, and the thing you most need help
with is one keystroke away in the same window.

## What exists today

**Tab managers** (OneTab, Toby, Workona) treat tabs as a library to curate:
save a session, name it, restore it later. That is a filing system, and it
asks for the one thing people running ninety tabs demonstrably will not do —
tidying up. They also live behind a toolbar button, so using one is a
deliberate act.

**New tab replacements** (Momentum and its many imitators) treat the page as
a dashboard: a photograph, a greeting, a to-do list, a weather widget. None
of them show your tabs, because none of them ask for the `tabs` permission —
the moment you do, you are an extension that can see every page a person has
open, and most dashboards would rather not have that conversation.

**The browser's own attempts** — vertical tabs, tab groups, tab search —
are real improvements, and all of them are still inside the chrome. They
help you navigate a list you already have. They do not put it in front of
you at the moment you are already looking.

So the gap is structural rather than a missing feature: the tab managers do
not own the new tab, and the new tab pages do not read your tabs.

## What this is

The new tab page shows the tabs you already have open — grouped by site,
sorted by what you touched last, closable from the page — and above them, a
briefing you assemble: topics from feeds you name, markets, weather, a
calendar, a to-do list.

Two claims, and they are the whole product:

**It is instant.** The page ships about 19 KB gzipped — markup, styles and
script together — loads no WebAssembly
and makes no network request when it opens. Everything — fetching, parsing,
ranking, grouping — happens beforehand in the service worker, so opening a
tab is one read from local storage and a paint. That is not an optimisation,
it is the constraint the architecture is built around, and a test enforces
the budget so it stays true.

**It is yours.** No account, no server holding your configuration, no
telemetry. A group you do not turn on makes no request at all, and the
extension asks for a site's permission the first time it needs it rather
than at install.

## What a local Rust core buys that a SaaS cannot

The interesting work — cross-source deduplication, ranking, real calendar
recurrence, domain grouping — is a Rust library compiled to WebAssembly and
run inside the browser. A hosted service could do the same work on a server,
and would then need your feed list, your calendar, and a record of what you
read. That is the product most of this category actually is.

Doing it locally means there is nothing to breach, nothing to subpoena and
nothing to shut down, and it means the same core is testable natively: 292
tests run in milliseconds against the same code the browser executes.

The one thing that genuinely benefits from being shared — packs of sources
other people assembled — is shared as *documents*, not as an account. A pack
is stripped of API keys, calendar addresses and coordinates before it leaves
the browser, and you can hand one to a colleague without either of you
signing in to anything.
