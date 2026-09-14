//! Grouping, run over the sites people actually have open.
//!
//!     cargo run --release -p tabs-core --example topsites
//!
//! The tab card is the product, and its whole job is to put twenty tabs into
//! five rows somebody recognises. That depends on `registrable_domain`, which
//! depends on a hand-maintained suffix table — and a table is exactly the
//! kind of thing that is correct for the cases somebody thought of and wrong
//! for the ones they did not.
//!
//! So this runs the real grouping over a corpus of the world's most-visited
//! sites, the regional TLDs that stress the table, and the multi-tab shapes
//! people actually generate (eight Google Docs, six Jira tickets, a dozen
//! GitHub pull requests). It prints every case where the answer is
//! suspicious, with the reason.
//!
//! A failure here is not cosmetic. Grouping `bbc.co.uk` under `co.uk` puts
//! the BBC in a row named after a registry.

use std::collections::BTreeMap;
use tabs_core::tabs::{group, registrable_domain, Tab};

/// Hosts, grouped by what a reader would call them. The key is the label a
/// human would expect the row to carry.
fn corpus() -> Vec<(&'static str, Vec<&'static str>)> {
    vec![
        // ---- the global top of the list ----
        (
            "google.com",
            vec![
                "https://www.google.com/search?q=rust",
                "https://mail.google.com/mail/u/0/#inbox",
                "https://docs.google.com/document/d/abc/edit",
                "https://drive.google.com/drive/my-drive",
                "https://calendar.google.com/calendar/u/0/r",
                "https://meet.google.com/abc-defg-hij",
            ],
        ),
        (
            "youtube.com",
            vec![
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "https://m.youtube.com/feed/subscriptions",
                "https://studio.youtube.com/channel/UC123/videos",
            ],
        ),
        (
            "facebook.com",
            vec![
                "https://www.facebook.com/",
                "https://business.facebook.com/",
            ],
        ),
        (
            "x.com",
            vec!["https://x.com/home", "https://x.com/search?q=rust"],
        ),
        ("instagram.com", vec!["https://www.instagram.com/"]),
        (
            "wikipedia.org",
            vec![
                "https://en.wikipedia.org/wiki/Rust_(programming_language)",
                "https://de.wikipedia.org/wiki/Rust",
            ],
        ),
        (
            "reddit.com",
            vec![
                "https://www.reddit.com/r/rust/",
                "https://old.reddit.com/r/rust/",
            ],
        ),
        ("amazon.com", vec!["https://www.amazon.com/dp/B08N5WRWNW"]),
        ("chatgpt.com", vec!["https://chatgpt.com/c/abc"]),
        ("claude.ai", vec!["https://claude.ai/chat/abc"]),
        ("linkedin.com", vec!["https://www.linkedin.com/feed/"]),
        ("netflix.com", vec!["https://www.netflix.com/browse"]),
        ("microsoft.com", vec!["https://www.microsoft.com/en-us/"]),
        (
            "office.com",
            vec![
                "https://www.office.com/",
                "https://outlook.office.com/mail/",
            ],
        ),
        ("live.com", vec!["https://outlook.live.com/mail/0/"]),
        ("bing.com", vec!["https://www.bing.com/search?q=rust"]),
        (
            "apple.com",
            vec![
                "https://www.apple.com/uk/",
                "https://developer.apple.com/documentation/",
            ],
        ),
        ("whatsapp.com", vec!["https://web.whatsapp.com/"]),
        ("tiktok.com", vec!["https://www.tiktok.com/foryou"]),
        (
            "yahoo.com",
            vec![
                "https://www.yahoo.com/",
                "https://finance.yahoo.com/quote/AAPL",
            ],
        ),
        ("zoom.us", vec!["https://us02web.zoom.us/j/123456"]),
        ("twitch.tv", vec!["https://www.twitch.tv/directory"]),
        ("spotify.com", vec!["https://open.spotify.com/playlist/abc"]),
        (
            "paypal.com",
            vec!["https://www.paypal.com/myaccount/summary"],
        ),
        ("pinterest.com", vec!["https://www.pinterest.com/"]),
        ("ebay.com", vec!["https://www.ebay.com/itm/123"]),
        ("cloudflare.com", vec!["https://dash.cloudflare.com/"]),
        // ---- work: the shapes that generate many tabs at once ----
        (
            "github.com",
            vec![
                "https://github.com/rust-lang/rust/pull/1",
                "https://github.com/rust-lang/rust/pull/2",
                "https://github.com/rust-lang/rust/issues/3",
                "https://gist.github.com/someone/abc",
            ],
        ),
        (
            "atlassian.net",
            vec![
                "https://acme.atlassian.net/browse/ENG-1",
                "https://acme.atlassian.net/browse/ENG-2",
                "https://acme.atlassian.net/wiki/spaces/ENG/pages/1",
            ],
        ),
        ("notion.so", vec!["https://www.notion.so/acme/Page-abc"]),
        ("slack.com", vec!["https://app.slack.com/client/T1/C1"]),
        ("figma.com", vec!["https://www.figma.com/file/abc/Design"]),
        (
            "stackoverflow.com",
            vec!["https://stackoverflow.com/questions/123"],
        ),
        (
            "gitlab.com",
            vec!["https://gitlab.com/group/project/-/merge_requests/1"],
        ),
        (
            "salesforce.com",
            vec!["https://acme.lightning.force.com/lightning/o/Account/home"],
        ),
        // ---- regional: what the suffix table is actually for ----
        (
            "bbc.co.uk",
            vec![
                "https://www.bbc.co.uk/news",
                "https://www.bbc.co.uk/iplayer",
            ],
        ),
        ("gov.uk", vec!["https://www.gov.uk/vat-rates"]),
        (
            "amazon.co.uk",
            vec!["https://www.amazon.co.uk/dp/B08N5WRWNW"],
        ),
        ("ox.ac.uk", vec!["https://www.ox.ac.uk/admissions"]),
        ("abc.net.au", vec!["https://www.abc.net.au/news"]),
        (
            "straitstimes.com",
            vec!["https://www.straitstimes.com/singapore"],
        ),
        (
            "gov.sg",
            vec!["https://www.gov.sg/", "https://www.iras.gov.sg/"],
        ),
        (
            "dbs.com.sg",
            vec!["https://www.dbs.com.sg/personal/default.page"],
        ),
        ("asahi.co.jp", vec!["https://www.asahi.co.jp/"]),
        ("yahoo.co.jp", vec!["https://www.yahoo.co.jp/"]),
        ("naver.com", vec!["https://www.naver.com/"]),
        ("baidu.com", vec!["https://www.baidu.com/s?wd=rust"]),
        ("qq.com", vec!["https://www.qq.com/"]),
        ("weibo.com.cn", vec!["https://www.weibo.com.cn/"]),
        ("globo.com", vec!["https://www.globo.com/"]),
        ("uol.com.br", vec!["https://www.uol.com.br/"]),
        ("rediff.co.in", vec!["https://www.rediff.co.in/"]),
        (
            "timesofindia.indiatimes.com",
            vec!["https://timesofindia.indiatimes.com/"],
        ),
        ("news24.co.za", vec!["https://www.news24.co.za/"]),
        ("hurriyet.com.tr", vec!["https://www.hurriyet.com.tr/"]),
        (
            "mercadolibre.com.ar",
            vec!["https://www.mercadolibre.com.ar/"],
        ),
        ("allegro.pl", vec!["https://allegro.pl/"]),
        // ---- hosting suffixes: many unrelated sites share the parent ----
        (
            "someone.github.io",
            vec!["https://someone.github.io/blog/post"],
        ),
        ("acme.vercel.app", vec!["https://acme.vercel.app/"]),
        ("acme.pages.dev", vec!["https://acme.pages.dev/"]),
        (
            "acme.myshopify.com",
            vec!["https://acme.myshopify.com/admin"],
        ),
        (
            "writer.substack.com",
            vec!["https://writer.substack.com/p/post"],
        ),
        (
            "blog.blogspot.com",
            vec!["https://blog.blogspot.com/2026/01/post.html"],
        ),
        ("acme.herokuapp.com", vec!["https://acme.herokuapp.com/"]),
        (
            "bucket.s3.amazonaws.com",
            vec!["https://bucket.s3.amazonaws.com/key"],
        ),
        ("acme.notion.site", vec!["https://acme.notion.site/Page"]),
        // ---- awkward but real ----
        (
            "localhost",
            vec!["http://localhost:5173/", "http://localhost:3000/api"],
        ),
        ("127.0.0.1", vec!["http://127.0.0.1:8080/"]),
        ("[::1]", vec!["http://[::1]:8080/"]),
        ("t.co", vec!["https://t.co/abc"]),
        ("goo.gl", vec!["https://goo.gl/maps/abc"]),
        (
            "archive.org",
            vec!["https://web.archive.org/web/2026/https://example.com"],
        ),
    ]
}

fn tab(id: i64, url: &str) -> Tab {
    Tab {
        id,
        window_id: 1,
        title: url.to_string(),
        url: url.to_string(),
        fav_icon_url: None,
        active: false,
        pinned: false,
    }
}

fn main() {
    let corpus = corpus();
    let mut problems: Vec<String> = Vec::new();
    let mut tabs = Vec::new();
    let mut id = 1i64;

    println!("== registrable domain, per host ==\n");
    for (expected, urls) in &corpus {
        for url in urls {
            let host = url
                .split("://")
                .nth(1)
                .and_then(|r| r.split('/').next())
                .unwrap_or("")
                .split(':')
                .next()
                .unwrap_or("")
                .to_string();
            // An IPv6 literal keeps its brackets.
            let host = if url.contains("//[") {
                url.split("//")
                    .nth(1)
                    .and_then(|r| r.split(']').next())
                    .map(|h| format!("{h}]"))
                    .unwrap_or(host)
            } else {
                host
            };
            let got = registrable_domain(&host);
            let shown = got.clone().unwrap_or_else(|| "(none)".into());

            let mut note = "";
            if let Some(d) = &got {
                // Asked of the list itself rather than a second hand-written
                // opinion about which names are registries — the first
                // version of this check called `substack.com` a registry
                // because *I* thought it was one, and the list does not.
                if tabs_core::tabs::is_public_suffix(d) {
                    note = "  ← GROUPED UNDER A REGISTRY, not a site";
                    problems.push(format!("{host} → {d} (a public suffix, not a domain)"));
                }
            } else if !host.is_empty()
                && !host.starts_with('[')
                && host.parse::<std::net::IpAddr>().is_err()
                && host != "localhost"
            {
                note = "  ← NO DOMAIN";
                problems.push(format!("{host} → none"));
            }
            if !note.is_empty() || std::env::args().any(|a| a == "-v") {
                println!("  {host:<42} → {shown}{note}");
            }
            tabs.push(tab(id, url));
            id += 1;
        }
        let _ = expected;
    }

    // ---- the grouping itself ----
    let g = group(&tabs);
    println!("\n== grouping ==\n");
    println!(
        "  {} tabs → {} groups, {} duplicates\n",
        g.total,
        g.groups.len(),
        g.duplicates
    );

    let mut sizes: BTreeMap<usize, usize> = BTreeMap::new();
    for grp in &g.groups {
        *sizes.entry(grp.tabs.len()).or_insert(0) += 1;
    }
    println!("  group sizes: {sizes:?}");

    let singletons = g.groups.iter().filter(|x| x.tabs.len() == 1).count();
    println!(
        "  singletons:  {singletons}/{} ({:.0}%)",
        g.groups.len(),
        100.0 * singletons as f64 / g.groups.len().max(1) as f64
    );

    println!("\n  largest groups:");
    let mut by_size: Vec<_> = g.groups.iter().collect();
    by_size.sort_by_key(|x| std::cmp::Reverse(x.tabs.len()));
    for grp in by_size.iter().take(8) {
        println!("    {:<32} {}", grp.label, grp.tabs.len());
    }

    // A label a reader would not recognise is the failure this exists to
    // catch, so name every one rather than counting them.
    // `is_homepage` lifts a group to the top of the card. It is set from an
    // exact host match, and almost every real URL carries `www.`
    println!("\n  homepage flag (these sort first):");
    let hp: Vec<&str> = g
        .groups
        .iter()
        .filter(|x| x.is_homepage)
        .map(|x| x.label.as_str())
        .collect();
    println!(
        "    marked:     {}",
        if hp.is_empty() {
            "(none)".into()
        } else {
            hp.join(", ")
        }
    );
    let expected_hp = [
        "mail.google.com",
        "calendar.google.com",
        "drive.google.com",
        "docs.google.com",
        "x.com",
        "linkedin.com",
        "facebook.com",
        "instagram.com",
        "youtube.com",
        "reddit.com",
        "github.com",
        "claude.ai",
        "chatgpt.com",
        "notion.so",
        "slack.com",
        "figma.com",
    ];
    let missed: Vec<&str> = g
        .groups
        .iter()
        .filter(|x| !x.is_homepage && expected_hp.contains(&x.label.as_str()))
        .map(|x| x.label.as_str())
        .collect();
    if !missed.is_empty() {
        println!("    MISSED:     {}", missed.join(", "));
        println!("                ^ in HOMEPAGES, but the group was created from a");
        println!("                  www./m./old. host, so the exact match failed");
    }

    println!("\n  every label:");
    let mut labels: Vec<&str> = g.groups.iter().map(|x| x.label.as_str()).collect();
    labels.sort();
    for chunk in labels.chunks(4) {
        println!("    {}", chunk.join("   "));
    }

    println!("\n== summary ==");
    println!("  hosts checked   {}", tabs.len());
    println!("  suspicious      {}", problems.len());
    for p in &problems {
        println!("    {p}");
    }
    if problems.is_empty() {
        println!("  Nothing grouped under a registry, and every host resolved.");
    } else {
        // Non-zero, so CI fails rather than printing a warning nobody reads.
        std::process::exit(1);
    }
}
