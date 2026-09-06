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
const SUFFIXES: &[&str] = &[
    "co.uk",
    "org.uk",
    "me.uk",
    "ac.uk",
    "gov.uk",
    "net.uk",
    "sch.uk",
    "com.au",
    "net.au",
    "org.au",
    "edu.au",
    "gov.au",
    "id.au",
    "co.nz",
    "net.nz",
    "org.nz",
    "govt.nz",
    "ac.nz",
    "co.jp",
    "or.jp",
    "ne.jp",
    "ac.jp",
    "go.jp",
    "lg.jp",
    "com.cn",
    "net.cn",
    "org.cn",
    "gov.cn",
    "edu.cn",
    "ac.cn",
    "com.sg",
    "net.sg",
    "org.sg",
    "edu.sg",
    "gov.sg",
    "com.hk",
    "org.hk",
    "net.hk",
    "edu.hk",
    "gov.hk",
    "com.tw",
    "net.tw",
    "org.tw",
    "edu.tw",
    "gov.tw",
    "co.kr",
    "or.kr",
    "ne.kr",
    "go.kr",
    "re.kr",
    "ac.kr",
    "com.br",
    "net.br",
    "org.br",
    "gov.br",
    "edu.br",
    "com.mx",
    "com.ar",
    "com.co",
    "com.pe",
    "com.ve",
    "com.ec",
    "co.in",
    "net.in",
    "org.in",
    "gov.in",
    "ac.in",
    "edu.in",
    "com.my",
    "net.my",
    "org.my",
    "gov.my",
    "edu.my",
    "co.id",
    "or.id",
    "ac.id",
    "go.id",
    "web.id",
    "co.th",
    "in.th",
    "ac.th",
    "go.th",
    "com.ph",
    "com.vn",
    "com.pk",
    "com.bd",
    "com.sa",
    "com.eg",
    "co.za",
    "org.za",
    "net.za",
    "gov.za",
    "ac.za",
    "com.tr",
    "net.tr",
    "org.tr",
    "gov.tr",
    "edu.tr",
    "com.ua",
    "com.ru",
    "org.ru",
    "net.ru",
    "edu.ru",
    "gov.ru",
    "co.il",
    "org.il",
    "net.il",
    "ac.il",
    "gov.il",
    "com.es",
    "com.pl",
    "com.pt",
    "com.gr",
    "com.ro",
    "com.hr",
    // Hosting suffixes: each subdomain is a separate site, which is the
    // whole reason a naive last-two-labels rule is wrong.
    "github.io",
    "gitlab.io",
    "pages.dev",
    "workers.dev",
    "vercel.app",
    "netlify.app",
    "herokuapp.com",
    "web.app",
    "firebaseapp.com",
    "azurewebsites.net",
    "cloudfront.net",
    "s3.amazonaws.com",
    "blogspot.com",
    "wordpress.com",
    "substack.com",
    "medium.com",
    "notion.site",
    "webflow.io",
    "myshopify.com",
    "squarespace.com",
    "ngrok.io",
    "ngrok-free.app",
    "trycloudflare.com",
    "repl.co",
    "replit.dev",
    "fly.dev",
    "onrender.com",
    "railway.app",
    "surge.sh",
    "glitch.me",
];

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

#[derive(Debug, Clone, Deserialize)]
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
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() < 2 {
        return None;
    }
    // Longest matching suffix wins: `s3.amazonaws.com` must beat `com`.
    let mut best = 1usize;
    for suffix in SUFFIXES {
        let n = suffix.split('.').count();
        if labels.len() > n {
            let tail = labels[labels.len() - n..].join(".");
            if tail.eq_ignore_ascii_case(suffix) && n > best {
                best = n;
            }
        }
    }
    Some(labels[labels.len() - (best + 1)..].join("."))
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
        let is_homepage = HOMEPAGES.contains(&parts.host.as_str());

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
}
