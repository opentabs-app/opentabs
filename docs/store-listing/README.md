# Store listing copy

One file per locale, the text that goes into the store forms by hand. Each
file holds the Edge search terms, the Chrome overview and the Edge/Firefox
overview, in that order, under `=====` headings.

The 18 locales here are the ones the extension itself is translated into —
`apps/extension/public/_locales`. The store name and description live there,
not in these files, so that the installed extension and its listing say the
same thing. `test/locales.test.ts` checks the two sets stay in step.

Not generated: written by the listing team and dropped in (2026-09-24), then
copied here unchanged. Edit the file for the locale, don't machine-translate
one from another.

The two overviews differ in their last line — Chrome's mentions Firefox,
Edge/Firefox's does not — because the stores are separate listings.
