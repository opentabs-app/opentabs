//! Tab grouping — the anchor feature.
//!
//! Grouping is by registrable domain (eTLD+1), which is why this needs a
//! public suffix list: `a.github.io` and `b.github.io` are different sites,
//! while `news.bbc.co.uk` and `www.bbc.co.uk` are one. Getting that wrong is
//! immediately visible — every GitHub Pages site collapsing into one card, or
//! `bbc.co.uk` splitting from `www.bbc.co.uk`.
//!
//! The embedded list is the ICANN multi-part suffixes that actually occur in
//! browsing, not the full PSL. The full list is ~80 KB compressed and this
//! covers the same cases for a tab bar; `SUFFIXES` is a plain table so
//! swapping in the real thing later is a data change, not a code change.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Multi-part public suffixes. Single-label TLDs (`com`, `dev`, `app`) need
/// no entry — the algorithm falls back to "last two labels" for those.
/// The Public Suffix List, generated — see `psl.rs` and
/// `scripts/update-psl.sh`.
///
/// This used to be 145 entries kept by hand. It was correct for the
/// countries somebody had thought of and silently wrong everywhere else,
/// which for a product whose whole job is "put these tabs in rows I
/// recognise" is the failure that matters most and shows least.
mod psl;

/// Domains whose *homepage* is a destination in its own right. These get
/// their own group so "Gmail" doesn't sit inside a pile of other google.com
/// tabs.
const HOMEPAGES: &[&str] = &[
    "mail.google.com",
    "calendar.google.com",
    "drive.google.com",
    "docs.google.com",
    "x.com",
    "twitter.com",
    "linkedin.com",
    "facebook.com",
    "instagram.com",
    "youtube.com",
    "reddit.com",
    "news.ycombinator.com",
    "github.com",
    "claude.ai",
    "chatgpt.com",
    "gemini.google.com",
    "perplexity.ai",
    "notion.so",
    "slack.com",
    "discord.com",
    "figma.com",
    "linear.app",
];

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Tab {
    pub id: i64,
    #[serde(default)]
    pub window_id: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub fav_icon_url: Option<String>,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupedTab {
    pub id: i64,
    pub window_id: i64,
    pub title: String,
    pub url: String,
    pub fav_icon_url: Option<String>,
    pub active: bool,
    pub pinned: bool,
    /// Other tab ids showing the same canonical URL.
    pub duplicate_of: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TabGroup {
    /// Stable key: the registrable domain, or `localhost:PORT`.
    pub key: String,
    pub label: String,
    pub is_homepage: bool,
    pub tabs: Vec<GroupedTab>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Grouping {
    pub groups: Vec<TabGroup>,
    pub total: usize,
    pub duplicates: usize,
    /// Tabs that are internal browser pages — counted, never grouped.
    pub skipped: usize,
}

/// The key the browser-pages group is bucketed under.
///
/// Leading control character so it can never collide with a real registrable
/// domain, and so the sort can recognise it without matching on a label
/// somebody's site might legitimately have.
pub const INTERNAL_KEY: &str = "\u{1}internal";

/// Browser-internal schemes.
///
/// These used to be dropped entirely, on the grounds that a page listing
/// `chrome://` URLs is noise. That was half right: what is noise is *thirty*
/// of them scattered through the domain groups. What is not noise is the
/// extension editor and the settings page someone left open two days ago and
/// cannot find — they are real tabs taking real space, and a tab manager that
/// pretends they do not exist is lying about the count in its own header.
///
/// So they are grouped, into one bucket, pinned to the bottom.
pub fn is_internal(url: &str) -> bool {
    const INTERNAL: &[&str] = &[
        "chrome://",
        "chrome-extension://",
        "extension://",
        "about:",
        "edge://",
        "brave://",
        "moz-extension://",
        "vivaldi://",
        "opera://",
        "devtools://",
        "view-source:",
        "file://",
    ];
    INTERNAL.iter().any(|p| url.starts_with(p))
}

/// A new tab page, which stays out of the list.
///
/// The one internal page that really is noise: it *is* the page doing the
/// listing. Six rows saying "New Tab" tell the reader nothing they cannot
/// see, and closing them is what the duplicate control and auto-close are
/// for. Kept in step with `BROWSER_NEW_TAB` in the extension's prune.
pub fn is_new_tab(url: &str) -> bool {
    let u = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .trim_end_matches('/');
    const NEW_TAB: &[&str] = &[
        "chrome://newtab",
        "chrome://new-tab-page",
        "chrome://new-tab-page-third-party",
        "edge://newtab",
        "brave://newtab",
        "vivaldi://newtab",
        "opera://newtab",
        "browser://newtab",
        "about:newtab",
        "about:home",
        "about:blank",
    ];
    NEW_TAB.iter().any(|p| u.eq_ignore_ascii_case(p))
}

/// Canonical form of an internal page, for duplicate detection.
///
/// `crate::url::canonicalize` is built for web URLs — stripping `www.`,
/// dropping tracking parameters — and none of that is meaningful here. Two
/// internal pages are the same page when their address is the same modulo a
/// trailing slash, a fragment and case.
fn internal_canonical(url: &str) -> String {
    url.split('#')
        .next()
        .unwrap_or(url)
        .trim_end_matches('/')
        .to_lowercase()
}

/// A readable name for an internal page, when it has no title.
///
/// `chrome-extension://ijlf…/editor.html` is not something anyone recognises;
/// `editor.html` at least says what it is.
fn internal_label(url: &str) -> String {
    let no_scheme = url.split("://").nth(1).unwrap_or(url);
    let path = no_scheme.split(['?', '#']).next().unwrap_or(no_scheme);
    let last = path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path);
    if last.is_empty() {
        url.to_string()
    } else {
        last.to_string()
    }
}

/// The registrable domain (eTLD+1) for a host.
///
/// `None` for IP literals and single-label hosts, which have no registrable
/// domain and are grouped by the host itself.
pub fn registrable_domain(host: &str) -> Option<String> {
    if host.starts_with('[') || host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() < 2 {
        return None;
    }

    // The list's own algorithm, and the two rule kinds a hand-written table
    // never had:
    //
    //   *.ck     a wildcard — any single label under `ck` is itself a suffix
    //   !www.ck  an exception — except this one, which is registrable
    //
    // Without them `foo.ck` groups as `foo.ck` when it is a registry, and
    // `www.ck` fails to group at all. Both are rare; being wrong about them
    // silently is not better for being rare.
    let mut best = 0usize; // labels in the matched suffix
    for i in 0..labels.len() {
        let candidate = labels[i..].join(".");
        let n = labels.len() - i;

        if has_rule(&format!("!{candidate}")) {
            // An exception names a registrable domain outright: the suffix
            // is everything after its first label.
            best = n - 1;
            break;
        }
        if has_rule(&candidate) {
            best = best.max(n);
        }
        if i > 0 {
            let wild = format!("*.{}", labels[i..].join("."));
            if has_rule(&wild) {
                best = best.max(n + 1);
            }
        }
    }

    // No rule matched: the implicit rule is `*`, one label, so the
    // registrable domain is the last two labels — `example.com`.
    let suffix_labels = best.max(1);
    if labels.len() <= suffix_labels {
        // The host *is* a public suffix. `co.uk` alone is not a site, and
        // filing a tab under a registry is the bug this table exists to
        // prevent — so say there is no domain rather than invent one.
        return None;
    }
    Some(labels[labels.len() - (suffix_labels + 1)..].join("."))
}

/// Which Public Suffix List this build carries: its digest and rule count.
///
/// Exposed rather than left as a comment in the generated file so that
/// "which list is in this build" is answerable from the outside — by a
/// diagnostic, by a test, by anyone wondering whether a grouping oddity is
/// a stale table.
pub fn suffix_list_version() -> (&'static str, usize) {
    (psl::DIGEST, psl::COUNT)
}

/// Whether a host is itself a public suffix — a registry, not a site.
///
/// Exposed because "did this group under a registry" is the check worth
/// making against a corpus of real hosts, and asking the list is the only
/// way to make it without a second, hand-written opinion about which names
/// are registries.
pub fn is_public_suffix(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    // Every top-level name is a suffix. The list says so with its implicit
    // `*` rule, and the generated blob leaves single-label rules out
    // precisely because they need no table.
    if !h.contains('.') {
        return !h.is_empty();
    }
    if has_rule(&h) {
        return true;
    }
    // A wildcard makes every child of its parent a suffix too.
    match h.split_once('.') {
        Some((_, parent)) => has_rule(&format!("*.{parent}")) && !has_rule(&format!("!{h}")),
        None => false,
    }
}

/// Is `rule` in the list? Binary search over the sorted blob.
///
/// The blob is one string with `\n` between rules, so a search means
/// bisecting on line boundaries rather than indexing a slice. It costs a
/// handful of comparisons per lookup and no allocation.
fn has_rule(rule: &str) -> bool {
    let blob = psl::RULES.as_bytes();
    let (mut lo, mut hi) = (0usize, blob.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        // Walk back to the start of the line `mid` fell into.
        let start = blob[..mid]
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |i| i + 1);
        let end = blob[start..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(blob.len(), |i| start + i);
        let line = &psl::RULES[start..end];
        match line.cmp(rule) {
            std::cmp::Ordering::Equal => return true,
            std::cmp::Ordering::Less => lo = end + 1,
            std::cmp::Ordering::Greater => {
                if start == 0 {
                    return false;
                }
                hi = start - 1;
            }
        }
    }
    false
}

/// Group a tab list. Order is stable: largest group first, ties broken by
/// key, so the page does not reshuffle between opens.
pub fn group(tabs: &[Tab]) -> Grouping {
    let mut buckets: HashMap<String, TabGroup> = HashMap::new();
    let mut seen_urls: HashMap<String, Vec<i64>> = HashMap::new();
    let (mut total, mut skipped) = (0usize, 0usize);

    for t in tabs {
        if t.url.is_empty() || is_new_tab(&t.url) {
            skipped += 1;
            continue;
        }
        if is_internal(&t.url) {
            // Counted like any other tab: they occupy the same space, and a
            // header saying "18 tabs" while the browser says 24 is a header
            // nobody trusts again.
            total += 1;
            // Two copies of the same settings page are as much a duplicate as
            // two copies of an article, and the close-duplicates control has
            // to be able to see them.
            seen_urls
                .entry(internal_canonical(&t.url))
                .or_default()
                .push(t.id);
            buckets
                .entry(INTERNAL_KEY.to_string())
                .or_insert_with(|| TabGroup {
                    key: INTERNAL_KEY.to_string(),
                    label: "Browser pages".into(),
                    is_homepage: false,
                    tabs: Vec::new(),
                })
                .tabs
                .push(GroupedTab {
                    id: t.id,
                    window_id: t.window_id,
                    title: if t.title.is_empty() {
                        internal_label(&t.url)
                    } else {
                        t.title.clone()
                    },
                    url: t.url.clone(),
                    fav_icon_url: t.fav_icon_url.clone(),
                    active: t.active,
                    pinned: t.pinned,
                    duplicate_of: Vec::new(),
                });
            continue;
        }
        let Some(parts) = crate::url::parse(&t.url) else {
            skipped += 1;
            continue;
        };
        total += 1;
        seen_urls
            .entry(crate::url::canonicalize(&t.url))
            .or_default()
            .push(t.id);

        // localhost:3000 and localhost:8080 are different projects, and
        // collapsing them is the single most annoying thing a dev-facing
        // grouper can do.
        let is_local = parts.host == "localhost" || parts.host.starts_with("127.");
        let (key, label) = if is_local {
            let k = match parts.port {
                Some(p) => format!("{}:{}", parts.host, p),
                None => parts.host.clone(),
            };
            (k.clone(), k)
        } else if HOMEPAGES.contains(&parts.host.as_str()) {
            (parts.host.clone(), parts.host.clone())
        } else {
            let d = registrable_domain(&parts.host).unwrap_or_else(|| parts.host.clone());
            (d.clone(), d)
        };
        // From the key, not the raw host.
        //
        // HOMEPAGES is an exact-host list, and almost nobody arrives at these
        // sites on the bare host: it is `www.youtube.com`, `app.slack.com`,
        // `old.reddit.com`, `m.facebook.com`. Testing the raw host marked
        // eight of sixteen and missed the rest, so "the sites you live in
        // float to the top" worked for half the list and which half was luck.
        //
        // The key has already been reduced to the registrable domain by this
        // point, which is the form HOMEPAGES is written in.
        let is_homepage = HOMEPAGES.contains(&key.as_str());

        buckets
            .entry(key.clone())
            .or_insert_with(|| TabGroup {
                key,
                label,
                is_homepage,
                tabs: Vec::new(),
            })
            .tabs
            .push(GroupedTab {
                id: t.id,
                window_id: t.window_id,
                title: if t.title.is_empty() {
                    parts.host.clone()
                } else {
                    t.title.clone()
                },
                url: t.url.clone(),
                fav_icon_url: t.fav_icon_url.clone(),
                active: t.active,
                pinned: t.pinned,
                duplicate_of: Vec::new(),
            });
    }

    // Attribute duplicates after bucketing, so every copy learns about the
    // others regardless of which group each landed in.
    let dup_ids: HashMap<i64, Vec<i64>> = seen_urls
        .values()
        .filter(|ids| ids.len() > 1)
        .flat_map(|ids| {
            ids.iter()
                .map(|id| (*id, ids.iter().copied().filter(|o| o != id).collect()))
        })
        .collect();
    let duplicates = dup_ids.len();

    let mut groups: Vec<TabGroup> = buckets.into_values().collect();
    for g in &mut groups {
        for t in &mut g.tabs {
            if let Some(others) = dup_ids.get(&t.id) {
                t.duplicate_of = others.clone();
            }
        }
        g.tabs.sort_by_key(|t| t.id);
    }
    groups.sort_by(|a, b| {
        // Browser pages last whatever their size. They are the group someone
        // scrolls past, and letting a pile of extension pages take the top of
        // the card because there happen to be nine of them would bury the
        // work the card exists to show.
        let internal = |g: &TabGroup| g.key == INTERNAL_KEY;
        internal(a)
            .cmp(&internal(b))
            .then(b.is_homepage.cmp(&a.is_homepage))
            .then(b.tabs.len().cmp(&a.tabs.len()))
            .then(a.key.cmp(&b.key))
    });

    Grouping {
        groups,
        total,
        duplicates,
        skipped,
    }
}

/// Substring match over title and URL, case-insensitive. Deliberately not
/// fuzzy: a tab search that returns near-misses above exact ones reads as
/// broken, and with 40 tabs there is nothing to be clever about.
pub fn search<'a>(g: &'a Grouping, needle: &str) -> Vec<&'a GroupedTab> {
    let n = needle.trim().to_lowercase();
    if n.is_empty() {
        return Vec::new();
    }
    g.groups
        .iter()
        .flat_map(|grp| grp.tabs.iter())
        .filter(|t| t.title.to_lowercase().contains(&n) || t.url.to_lowercase().contains(&n))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: i64, url: &str) -> Tab {
        Tab {
            id,
            window_id: 1,
            title: format!("tab {id}"),
            url: url.into(),
            fav_icon_url: None,
            active: false,
            pinned: false,
        }
    }

    #[test]
    fn registrable_domain_handles_multipart_suffixes() {
        assert_eq!(
            registrable_domain("news.bbc.co.uk").as_deref(),
            Some("bbc.co.uk")
        );
        assert_eq!(
            registrable_domain("www.bbc.co.uk").as_deref(),
            Some("bbc.co.uk")
        );
        assert_eq!(
            registrable_domain("a.example.com").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            registrable_domain("example.com").as_deref(),
            Some("example.com")
        );
    }

    #[test]
    fn hosting_suffixes_keep_sites_apart() {
        // The case a naive last-two-labels rule gets wrong.
        assert_eq!(
            registrable_domain("alice.github.io").as_deref(),
            Some("alice.github.io")
        );
        assert_eq!(
            registrable_domain("bob.github.io").as_deref(),
            Some("bob.github.io")
        );
        assert_ne!(
            registrable_domain("alice.github.io"),
            registrable_domain("bob.github.io")
        );
    }

    #[test]
    fn ip_and_single_label_hosts_have_no_registrable_domain() {
        assert_eq!(registrable_domain("127.0.0.1"), None);
        assert_eq!(registrable_domain("localhost"), None);
        assert_eq!(registrable_domain("[::1]"), None);
    }

    #[test]
    fn localhost_ports_are_separate_projects() {
        let g = group(&[
            tab(1, "http://localhost:3000/a"),
            tab(2, "http://localhost:8080/b"),
            tab(3, "http://localhost:3000/c"),
        ]);
        assert_eq!(g.groups.len(), 2);
        let keys: Vec<&str> = g.groups.iter().map(|x| x.key.as_str()).collect();
        assert!(keys.contains(&"localhost:3000") && keys.contains(&"localhost:8080"));
    }

    #[test]
    fn grouping_never_loses_a_tab() {
        let tabs: Vec<Tab> = [
            "https://a.example.com/1",
            "https://b.example.com/2",
            "https://news.bbc.co.uk/x",
            "http://localhost:3000/",
            "https://alice.github.io/p",
            "https://bob.github.io/q",
        ]
        .iter()
        .enumerate()
        .map(|(i, u)| tab(i as i64, u))
        .collect();
        let g = group(&tabs);
        let counted: usize = g.groups.iter().map(|x| x.tabs.len()).sum();
        assert_eq!(counted, tabs.len());
        assert_eq!(g.total, tabs.len());
    }

    #[test]
    fn internal_pages_are_gathered_into_one_group() {
        // They are real tabs taking real space. Dropping them made the card's
        // own header disagree with the browser's tab count.
        let g = group(&[
            tab(1, "chrome://extensions"),
            tab(2, "edge://settings/privacy"),
            tab(
                3,
                "chrome-extension://ijlfnijggnacdaacbabblhdjmccmfdbg/editor.html",
            ),
            tab(4, "https://real.test/x"),
        ]);
        assert_eq!(g.total, 4);
        assert_eq!(g.groups.len(), 2);
        let internal = g.groups.iter().find(|x| x.key == INTERNAL_KEY).unwrap();
        assert_eq!(internal.label, "Browser pages");
        assert_eq!(internal.tabs.len(), 3);
    }

    #[test]
    fn a_new_tab_page_stays_out_of_the_list() {
        // The one internal page that really is noise: it is the page doing
        // the listing, and six rows saying "New Tab" say nothing.
        let g = group(&[
            tab(1, "chrome://newtab/"),
            tab(2, "edge://newtab"),
            tab(3, "about:blank"),
            tab(4, "about:newtab"),
            tab(5, "https://real.test/x"),
        ]);
        assert_eq!(g.skipped, 4);
        assert_eq!(g.total, 1);
        assert_eq!(g.groups.len(), 1);
        assert_ne!(g.groups[0].key, INTERNAL_KEY);
    }

    #[test]
    fn browser_pages_sort_last_however_many_there_are() {
        // Nine extension pages must not take the top of the card from the
        // work it exists to show.
        let mut tabs: Vec<Tab> = (1..=9)
            .map(|i| tab(i, &format!("chrome-extension://abc/page{i}.html")))
            .collect();
        tabs.push(tab(20, "https://real.test/a"));
        let g = group(&tabs);
        assert_eq!(g.groups.last().unwrap().key, INTERNAL_KEY);
        assert_eq!(g.groups[0].label, "real.test");
    }

    #[test]
    fn an_untitled_internal_page_is_named_by_its_last_path_segment() {
        // `chrome-extension://ijlf…/editor.html` is not a thing anyone
        // recognises; `editor.html` at least says what it is.
        let mut t = tab(
            1,
            "chrome-extension://ijlfnijggnacdaacbabblhdjmccmfdbg/editor.html",
        );
        t.title = String::new();
        let g = group(&[t]);
        assert_eq!(g.groups[0].tabs[0].title, "editor.html");
    }

    #[test]
    fn a_titled_internal_page_keeps_its_title() {
        let mut t = tab(1, "edge://extensions/");
        t.title = "Extensions".into();
        let g = group(&[t]);
        assert_eq!(g.groups[0].tabs[0].title, "Extensions");
    }

    #[test]
    fn duplicate_internal_pages_are_still_found() {
        // Two copies of the same settings page are as much a duplicate as two
        // copies of an article. A trailing slash does not make them different.
        let g = group(&[
            tab(1, "chrome://extensions"),
            tab(2, "chrome://extensions/"),
            tab(3, "chrome://settings"),
        ]);
        assert_eq!(g.duplicates, 2);
        let internal = &g.groups[0];
        assert_eq!(
            internal
                .tabs
                .iter()
                .filter(|t| !t.duplicate_of.is_empty())
                .count(),
            2
        );
    }

    #[test]
    fn duplicates_are_found_across_tracking_differences() {
        let g = group(&[
            tab(1, "https://site.test/story"),
            tab(2, "https://www.site.test/story/?utm_source=x"),
        ]);
        assert_eq!(g.duplicates, 2);
        let t = &g.groups[0].tabs[0];
        assert_eq!(t.duplicate_of, vec![2]);
    }

    #[test]
    fn homepages_sort_first_and_group_alone() {
        let g = group(&[
            tab(1, "https://docs.google.com/document/x"),
            tab(2, "https://mail.google.com/"),
            tab(3, "https://random.google.com/a"),
        ]);
        assert!(g.groups[0].is_homepage);
        // random.google.com is not a homepage, so it groups by google.com.
        assert!(g
            .groups
            .iter()
            .any(|x| x.key == "google.com" && !x.is_homepage));
    }

    #[test]
    fn ordering_is_stable_across_calls() {
        let tabs: Vec<Tab> = (0..12)
            .map(|i| tab(i, &format!("https://s{}.test/p{i}", i % 4)))
            .collect();
        let a = group(&tabs);
        let b = group(&tabs);
        let ka: Vec<&str> = a.groups.iter().map(|g| g.key.as_str()).collect();
        let kb: Vec<&str> = b.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(ka, kb);
    }

    #[test]
    fn search_matches_title_and_url() {
        let g = group(&[
            tab(1, "https://rust-lang.org/learn"),
            tab(2, "https://other.test/x"),
        ]);
        assert_eq!(search(&g, "rust-lang").len(), 1);
        assert_eq!(search(&g, "tab 2").len(), 1);
        assert_eq!(search(&g, "   ").len(), 0);
    }

    /// The sites in HOMEPAGES float to the top of the card. They have to do
    /// that on the hosts people actually arrive on, which are almost never
    /// the bare domain: `www.youtube.com`, `app.slack.com`, `old.reddit.com`,
    /// `m.facebook.com`. Matching the raw host marked eight of these sixteen
    /// and silently missed the other eight.
    #[test]
    fn a_homepage_is_recognised_however_the_reader_reached_it() {
        let hosts = [
            "https://www.youtube.com/watch?v=1",
            "https://m.youtube.com/feed",
            "https://www.facebook.com/",
            "https://m.facebook.com/",
            "https://old.reddit.com/r/rust/",
            "https://www.reddit.com/r/rust/",
            "https://app.slack.com/client/T1/C1",
            "https://www.linkedin.com/feed/",
            "https://www.instagram.com/",
            "https://www.figma.com/file/a/b",
            "https://www.notion.so/page",
            "https://www.github.com/rust-lang/rust",
        ];
        let tabs: Vec<Tab> = hosts
            .iter()
            .enumerate()
            .map(|(i, u)| Tab {
                id: i as i64 + 1,
                url: (*u).to_string(),
                ..Default::default()
            })
            .collect();
        let g = group(&tabs);
        for grp in &g.groups {
            assert!(
                grp.is_homepage,
                "{} was not marked a homepage — it will not sort to the top",
                grp.label
            );
        }
        // And a site that is not on the list stays off it.
        let other = group(&[Tab {
            id: 1,
            url: "https://www.bbc.co.uk/news".into(),
            ..Default::default()
        }]);
        assert!(!other.groups[0].is_homepage);
    }

    /// The suffix table is what stops a row being named after a registry.
    /// `bbc.co.uk` under "co.uk" is the shape of the failure.
    #[test]
    fn no_top_site_groups_under_a_public_suffix() {
        for host in [
            "www.bbc.co.uk",
            "www.amazon.co.uk",
            "www.ox.ac.uk",
            "www.abc.net.au",
            "www.dbs.com.sg",
            "www.yahoo.co.jp",
            "www.uol.com.br",
            "www.news24.co.za",
            "www.hurriyet.com.tr",
            "www.mercadolibre.com.ar",
            "someone.github.io",
            "acme.vercel.app",
            "acme.myshopify.com",
            "writer.substack.com",
            "bucket.s3.amazonaws.com",
        ] {
            let d = registrable_domain(host).unwrap_or_default();
            assert!(
                !has_rule(&d),
                "{host} grouped under {d}, which is a registry and not a site"
            );
            assert!(d.matches('.').count() >= 1, "{host} → {d}");
        }
    }

    /// Rules the hand-written table could not express at all, and got
    /// silently wrong: wildcards, exceptions, and suffixes four labels deep.
    #[test]
    fn the_public_suffix_list_rules_the_old_table_could_not_express() {
        // `*.ck` — every single label under `ck` is a registry…
        assert_eq!(registrable_domain("foo.ck"), None);
        // …except the one the list carves out with `!www.ck`.
        assert_eq!(registrable_domain("www.ck").as_deref(), Some("www.ck"));
        // Four labels deep. Japan's municipal namespace is the reason the
        // list is 8,000 rules and not 200.
        assert_eq!(
            registrable_domain("www.city.chiyoda.tokyo.jp").as_deref(),
            Some("city.chiyoda.tokyo.jp")
        );
        // A registry is not a site, however plausible it looks as one.
        for registry in ["co.uk", "com", "org.au", "ac.uk"] {
            assert_eq!(registrable_domain(registry), None, "{registry}");
        }
        // But `kobe.jp` is one: the list carries `*.kobe.jp`, not `kobe.jp`,
        // so the bare name falls to the implicit rule and is registrable.
        // Reading the list rather than guessing at it is the whole point.
        assert_eq!(registrable_domain("kobe.jp").as_deref(), Some("kobe.jp"));
        // Hosting suffixes keep unrelated sites apart, which is the whole
        // point of the list's private section.
        assert_eq!(
            registrable_domain("someone.github.io").as_deref(),
            Some("someone.github.io")
        );
        assert_eq!(
            registrable_domain("other.github.io").as_deref(),
            Some("other.github.io")
        );
        // And a plain subdomain still collapses to its site.
        assert_eq!(
            registrable_domain("team.slack.com").as_deref(),
            Some("slack.com")
        );
    }

    #[test]
    fn is_public_suffix_agrees_with_the_list() {
        for yes in ["co.uk", "com", "github.io", "s3.amazonaws.com", "foo.ck"] {
            assert!(is_public_suffix(yes), "{yes} should be a suffix");
        }
        for no in ["bbc.co.uk", "example.com", "someone.github.io", "www.ck"] {
            assert!(!is_public_suffix(no), "{no} should not be a suffix");
        }
    }

    /// The generated table has to *be* generated, and be plausible.
    ///
    /// A table this large is exactly the kind of thing that gets truncated
    /// by a bad regenerate and nobody notices, because the common cases keep
    /// working — `.com` needs no table at all. These assertions are cheap
    /// and would catch a blob that lost its tail.
    #[test]
    fn the_generated_suffix_table_is_whole() {
        let (digest, count) = suffix_list_version();
        // Counted from the blob, not read from the constant: the point is to
        // catch a blob that lost its tail, and a stale constant would agree
        // with itself all the way down.
        let actual = psl::RULES.lines().count();
        assert_eq!(actual, count, "COUNT says {count}, the blob has {actual}");
        assert!(
            actual > 8_000,
            "only {actual} rules — a regenerate truncated"
        );
        assert_eq!(digest.len(), 16, "the digest did not survive the generate");
        // Sorted, because the lookup binary-searches it.
        let mut prev = "";
        for line in psl::RULES.lines() {
            assert!(line > prev, "not sorted at {line:?}");
            prev = line;
        }
        // A rule from each end and from the middle of the alphabet, so a
        // truncation anywhere shows.
        for rule in [
            "ac.uk",
            "github.io",
            "*.kobe.jp",
            "s3.amazonaws.com",
            "zone.id",
        ] {
            assert!(has_rule(rule), "missing {rule}");
        }
        // The sections the list keeps apart both survived the generate.
        assert!(has_rule("co.uk"), "ICANN section missing");
        assert!(has_rule("vercel.app"), "private section missing");
        assert!(
            psl::RULES.lines().any(|r| r.starts_with('*')),
            "wildcards missing"
        );
        assert!(
            psl::RULES.lines().any(|r| r.starts_with('!')),
            "exceptions missing"
        );
    }
}
