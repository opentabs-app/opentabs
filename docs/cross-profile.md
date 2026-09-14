# Seeing across Chrome profiles

**Status: spec, not built.** Tier 1 shipped; tiers 2 and 3 are described here
so the decision about tier 2 can be made on what it actually costs.

## The request

> 就是跨profile的切换。我感觉我现在就是在不同chrome profile切换，都要花掉我好多时间
> — switching between Chrome profiles takes a lot of my time

Two different problems wear one sentence, and only one of them is about
switching:

1. **"Which profile has the thing I want?"** — you know the tab exists, not
   where. Answering this means looking somewhere, which is the slow part.
2. **"Take me there."** — the click itself.

## What Chrome permits, measured

From OpenTabs' own service worker, not from documentation:

```
chrome.profiles                     undefined
chrome.users                        undefined
windows.create({profileName: …})    REFUSED: Unexpected property: 'profileName'
```

Google [proposed](https://chromium.googlesource.com/playground/chromium-org-site/+/refs/heads/main/developers/design-documents/extensions/proposed-changes/apis-under-development/profile-extension-api.md)
exactly this API — `chrome.users.getProfileList`, a `profileName` on
`windows.create` — and it has sat unshipped for years. Every profile switcher
that exists works around it with a **native messaging host**: a helper
installed outside the browser that reads Chrome's `Local State` and launches
`chrome --profile-directory=…`.

One thing *is* permitted, and tier 1 ships it: an extension may open
`chrome://profile-picker`. Measured working in Chromium and Edge, which
aliases the `chrome:` form to its own. Real Chrome is unverified — Playwright
cannot load an extension into it here.

## The three tiers

| | What it does | Cost |
|---|---|---|
| **1 — shipped** | One click to the browser's own picker | ~10 lines |
| **2 — this spec** | See what is open in your other profiles | a feature, no new infrastructure |
| **3 — not proposed** | Jump straight to a named profile | a native host, per-OS paths, installed outside the store |

**Tier 2 is the one that answers the request.** What costs time is not the
click; it is not knowing which profile holds the thing, and re-finding it
after arriving. Tier 1 fixes the click. Tier 3 saves one more click after
tier 2 has already told you where to go — which is why it is not proposed
here despite being the literal reading of "switching".

## How tier 2 would work

Profiles share no local storage: `chrome.storage` is per profile and there is
no channel between them. The sync engine is therefore not merely *a* way to do
this, it is **the only one that needs no native host** — and it makes "my other
laptop's tabs" the same feature for free.

Each profile publishes its own grouping into the `tabs:main` namespace as its
own file, keyed by a stable per-profile id:

```
tabs:main/
  settings.json          the existing synced config
  tabs/<profile-id>.json one per profile, written only by that profile
```

### Why one file per profile, and what that does not buy

It removes *content* conflicts: no two writers ever author the same bytes, so
there is nothing to merge and no need for the union fold an append-only log
would require.

It does **not** make the writers independent. `Payload.pushAll` rebuilds the
whole manifest from what is staged and publishes one pointer, so two profiles
publishing at the same moment still race: the later pointer wins, and if it
was built from a pull that predates the other's write, that write is reverted.

The property that makes this acceptable is not that the race cannot happen,
but that **a lost update here is temporary**. Every profile re-asserts its own
file on its next tick and never authors anyone else's, so the loser's next
publish restores it. Compare the settings document, where a lost update is
permanent because the loser has no reason to write again.

So: pull, replace only my own file, push the union. Never write another
profile's file, not even to tidy it.

### Sizing

A realistic profile — 26 tabs across 9 sites, three titles kept per group:

```
one profile     3.3 KB
four profiles  13.3 KB      0.026% of the 50 MB per-product ceiling
```

Well inside anything. Tabs change constantly, so the rate matters more than
the size: publish on a debounce measured in minutes, not on every tab event,
and treat this as a *view* that is allowed to be a few minutes stale.

### Staleness is part of the display, not an error

A profile that has not published for a day is a profile that is closed. Show
when it was last seen rather than hiding it — "Work · 14 tabs · 3h ago" is
useful; silently dropping it looks like data loss.

### What a click does

Opening another profile's URL *in this profile* is a trap: different cookies,
so for work-versus-personal it usually lands on a login page. The honest
actions are **copy the link** and **open the picker** (tier 1). Tier 3 is what
would make the tab itself reachable, and it needs the native host.

## What it costs, and this is the real decision

The privacy page says, under **The extension**:

> Your open tabs are read by the extension and never leave the browser. They
> are the page's content, not data collected about you.

Tier 2 makes that **false as written**. The tabs would leave the browser —
sealed, to a relay that holds ciphertext and no key, only for someone who
switched sync on — but they would leave it.

That sentence is load-bearing for the product's pitch, so it is not an edit to
make in passing. Three options, in the order I would consider them:

1. **Scope the promise to the default.** "…never leave the browser unless you
   turn on cross-profile view, and then only sealed, to a relay that cannot
   read them." Honest, and it keeps the strong claim for everyone who does
   nothing.
2. **Make it a separate switch from settings sync.** Someone who wants their
   theme on two machines has not agreed to publish their tab list. Two
   toggles, two sentences.
3. **Do not build it.** Tier 1 plus the picker may be enough, and the cheapest
   way to find out is to ask the person who raised it whether *seeing where
   things are* would have saved them the time.

Option 3 is not a placeholder. The request has not been tested against tier 1
yet, and tier 1 shipped today.

## Open questions

- **A stable profile id.** There is no API for one. A random id minted on
  first run and kept in `storage.local` is stable per profile and survives
  nothing else — good enough, and it is the same shape as the device name.
- **Naming a profile.** The extension cannot read Chrome's profile name.
  Someone has to type it, or every card reads "Chrome on Mac".
- **Incognito** publishes nothing, ever.
- **Does it need the settings document at all?** A profile that wants only the
  tab view still has to pair. Sharing one account is right; whether the two
  are one switch or two is question 2 above.
