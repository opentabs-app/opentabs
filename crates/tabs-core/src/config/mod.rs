//! The config document (milestone M2) — one versioned JSON object holding
//! everything the user has configured.
//!
//! Two things depend on this being *one document with a published schema*:
//! cross-browser sync by config string (D4), and letting an agent write your
//! new tab page (A3). Both fall apart if configuration is scattered across
//! storage keys.
//!
//! The def/instance split is decision D12. A `def` is code ("topic"); an
//! instance is config. There is one `tabs` instance and as many `topic`
//! instances as the user wants — which is what makes "add Data Centre" a row
//! rather than a release.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Bumped to 2 to force a repair pass over stored documents.
///
/// Version 1 shipped with a serialisation fault: `opts` crossed into JS as an
/// ES `Map`, so writing a topic's sources produced a property that
/// `JSON.stringify` discarded — and the config was then *saved* that way.
/// Fixing the serialiser stops new damage; it cannot undo what was already
/// written, so `migrate` repairs it and the version bump makes that run once
/// for everyone.
pub const CURRENT_VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Binding {
    /// "query" — a template with the topic's query substituted — or "feed",
    /// a fixed URL.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmpl: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arg: Option<String>,
    #[serde(default = "one")]
    pub weight: f64,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Instance {
    /// Which def this instantiates: "tabs", "topic", "weather", …
    pub def: String,
    /// Unique per user.
    pub id: String,
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub opts: Value,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub version: u32,
    pub instances: Vec<Instance>,
    #[serde(default)]
    pub theme: String,
    #[serde(default)]
    pub assistant: String,
    /// A theme installed from a pack, or built here.
    ///
    /// Part of the config document rather than local storage because it is a
    /// preference, and the whole point of the document is that copying one
    /// string moves your setup to another browser (D4). A theme that did not
    /// travel with it would be the one thing that did not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_theme: Option<crate::pack::Theme>,
}

/// The five query templates, verified live against each endpoint. `{q}` is
/// the topic's query, URL-encoded.
pub fn query_template(name: &str) -> Option<&'static str> {
    Some(match name {
        "googlenews" => "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en",
        "bingnews" => "https://www.bing.com/news/search?q={q}&format=RSS",
        "reddit" => "https://www.reddit.com/search.rss?q={q}&sort=top&t=week",
        "subreddit" => "https://www.reddit.com/r/{q}/top/.rss?t=day",
        "arxiv" => "https://export.arxiv.org/api/query?search_query=cat:{q}&sortBy=submittedDate&sortOrder=descending&max_results=25",
        "arxiv_all" => "https://export.arxiv.org/api/query?search_query=all:{q}&sortBy=submittedDate&sortOrder=descending&max_results=25",
        "hn" => "https://hn.algolia.com/api/v1/search?query={q}&tags=story&hitsPerPage=25",
        // Keyless social search. These exist because X's does not: its search
        // page serves no results without an authenticated session, and its
        // API charges per post read.
        "bluesky" => "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q={q}&limit=25&sort=latest",
        // The hashtag timeline, not `/api/v2/search`. Unauthenticated
        // full-text search on mastodon.social returns nothing at all — it is
        // opt-in per user — while the public tag timeline answers 20 posts for
        // any tag. Takes a hashtag, so use `arg`, not the topic query.
        "mastodon" => "https://mastodon.social/api/v1/timelines/tag/{q}?limit=25",
        _ => return None,
    })
}

/// Percent-encode for a query-string value. Hand-rolled to keep the wasm
/// bundle free of a URL crate for one function.
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Resolve a binding to a fetchable URL.
pub fn binding_url(b: &Binding, query: &str) -> Option<String> {
    match b.kind.as_str() {
        "feed" => b.url.clone(),
        "query" => {
            let tmpl = query_template(b.tmpl.as_deref()?)?;
            let arg = b.arg.as_deref().unwrap_or(query).trim();
            // An empty query is a legitimate configuration — it means "just
            // the feeds I listed". It is not, however, a search: Google News
            // with `q=` returns nothing useful, so the binding is skipped
            // rather than fetched and silently wasted.
            if arg.is_empty() {
                return None;
            }
            Some(tmpl.replace("{q}", &encode(arg)))
        }
        _ => None,
    }
}

/// Origins a def always needs, regardless of its options.
///
/// Topics derive their origins from their bindings, but every other fetching
/// group talks to a fixed set of hosts. Forgetting them is invisible in the
/// worst way: the group renders "No prices" forever because the fetch was
/// never permitted, not because the source was down. That shipped once.
pub fn fixed_origins(def: &str) -> &'static [&'static str] {
    match def {
        "crypto" => &["https://api.binance.com/*"],
        // Deliberately no origin for `xsearch`. Without an API key the group
        // is a launcher — it opens searches in a tab and fetches nothing — so
        // asking for api.x.com at enable time would be requesting access the
        // group does not use. It is requested when a key is entered instead.
        "equities" => &["https://query1.finance.yahoo.com/*"],
        "status" => &[
            "https://www.githubstatus.com/*",
            "https://www.cloudflarestatus.com/*",
            "https://status.openai.com/*",
            "https://status.anthropic.com/*",
        ],
        // The geocoding host is separate from the forecast host, and the
        // city picker is unusable without it.
        "weather" => &[
            "https://api.open-meteo.com/*",
            "https://geocoding-api.open-meteo.com/*",
        ],
        "apps" => &["https://opentabs.app/*"],
        // Trending prefers the served 8 KB file but falls back to parsing
        // github.com/trending in the browser, so it works with no server at
        // all. Both origins are needed for that.
        "trending" => &["https://opentabs.app/*", "https://github.com/*"],
        // Calendar origins are not here: an ICS address is a secret held in
        // storage.local, so its permission is requested when the user pastes
        // it rather than derived from the synced config.
        _ => &[],
    }
}

/// Origins a config needs permission for, deduped — what the permission
/// broker asks Chrome for.
pub fn required_origins(cfg: &Config) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for inst in cfg.instances.iter().filter(|i| i.enabled) {
        for o in fixed_origins(&inst.def) {
            if !out.iter().any(|x| x == o) {
                out.push((*o).to_string());
            }
        }
        let query = inst.opts.get("query").and_then(Value::as_str).unwrap_or("");
        let bindings: Vec<Binding> = inst
            .opts
            .get("sources")
            .and_then(|s| serde_json::from_value(s.clone()).ok())
            .unwrap_or_default();
        for b in &bindings {
            if let Some(u) = binding_url(b, query) {
                if let Some(p) = crate::url::parse(&u) {
                    let origin = format!("{}://{}/*", p.scheme, p.host);
                    if !out.contains(&origin) {
                        out.push(origin);
                    }
                }
            }
        }
    }
    out.sort();
    out
}

fn topic(id: &str, name: &str, query: &str, extra: Value) -> Instance {
    let mut sources = vec![json!({ "kind": "query", "tmpl": "googlenews", "weight": 1.0 })];
    if let Value::Array(more) = extra {
        sources.extend(more);
    }
    Instance {
        def: "topic".into(),
        id: id.into(),
        name: name.into(),
        enabled: false,
        opts: json!({
            "query": query,
            "sources": sources,
            "limit": 8,
            // News, by default. A topic that shows last month's headlines
            // beside today's is not a briefing.
            "max_age_hours": 24,
            "exclude": [],
            "include": []
        }),
    }
}

/// The shipped configuration.
///
/// Only four instances are enabled — decision D8. Everything else is one
/// toggle away, which keeps the page calm *and* the install-time permission
/// list short. The seed topics are rows here, not features: a user adding
/// "Semiconductor Supply Chain" gets exactly what these have.
pub fn default_config() -> Config {
    Config {
        version: CURRENT_VERSION,
        theme: "auto".into(),
        assistant: "claude".into(),
        custom_theme: None,
        instances: vec![
            Instance {
                def: "tabs".into(),
                id: "tabs".into(),
                name: "Tabs Management".into(),
                enabled: true,
                opts: json!({ "collapse_after": 8, "show_dupes": true }),
            },
            Instance {
                def: "apps".into(),
                id: "apps".into(),
                name: "Web Apps".into(),
                enabled: true,
                opts: json!({}),
            },
            Instance {
                def: "focus".into(),
                id: "focus".into(),
                name: "Focus".into(),
                enabled: true,
                opts: json!({ "prompt": "What's today about?" }),
            },
            Instance {
                def: "weather".into(),
                id: "weather".into(),
                name: "Weather".into(),
                enabled: true,
                opts: json!({ "lat": 1.3521, "lon": 103.8198, "place": "Singapore", "unit": "c" }),
            },
            Instance {
                def: "crypto".into(),
                id: "crypto".into(),
                name: "Crypto".into(),
                enabled: false,
                opts: json!({ "symbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }),
            },
            Instance {
                def: "equities".into(),
                id: "equities".into(),
                name: "Stocks".into(),
                enabled: false,
                opts: json!({ "symbols": ["000660.KS", "NVDA", "TSM"] }),
            },
            Instance {
                def: "status".into(),
                id: "status".into(),
                name: "Status".into(),
                enabled: false,
                opts: json!({}),
            },
            Instance {
                def: "trending".into(),
                id: "trending".into(),
                name: "GitHub trending".into(),
                enabled: false,
                opts: json!({ "limit": 8 }),
            },
            // Reads the browser's own bookmark store — no origin, no network,
            // and no server could serve it. The `bookmarks` API permission is
            // optional and requested when the group is switched on.
            Instance {
                def: "bookmarks".into(),
                id: "bookmarks".into(),
                name: "Recent bookmarks".into(),
                enabled: false,
                opts: json!({ "limit": 10, "show_folder": true }),
            },
            Instance {
                def: "xsearch".into(),
                id: "xsearch".into(),
                name: "X search".into(),
                enabled: false,
                opts: json!({
                    "query_fields": {
                        "all": "",
                        "none": "",
                        "exclude_retweets": true,
                        "replies": "none",
                        // Yesterday to today, recomputed every time.
                        "window_days": 1
                    },
                    // launcher | scrape | api. Defaults to opening the search
                    // in X: it costs nothing, breaks nothing, and asks for no
                    // site access.
                    "mode": "launcher",
                    "interval_min": 240,
                    "limit": 10
                }),
            },
            Instance {
                def: "scratch".into(),
                id: "scratch".into(),
                name: "Scratchpad".into(),
                enabled: false,
                opts: json!({}),
            },
            Instance {
                def: "todos".into(),
                id: "todos".into(),
                name: "To-dos".into(),
                enabled: false,
                opts: json!({ "remind": true }),
            },
            Instance {
                def: "calendar".into(),
                id: "calendar".into(),
                name: "Calendar".into(),
                enabled: false,
                opts: json!({ "urls": [], "days": 7 }),
            },
            // --- seed topics: config, not code (D12) ---
            topic(
                "ai",
                "AI",
                "artificial intelligence OR LLM OR \"machine learning\"",
                json!([
                    { "kind": "feed", "url": "https://tldr.tech/api/rss/ai", "weight": 2.5 },
                    { "kind": "feed", "url": "https://www.therundown.ai/feed", "weight": 2.0 },
                    { "kind": "query", "tmpl": "hn", "weight": 1.5 },
                    { "kind": "query", "tmpl": "subreddit", "arg": "LocalLLaMA", "weight": 1.2 }
                ]),
            ),
            topic(
                "finance",
                "Finance",
                "markets OR \"federal reserve\" OR earnings",
                json!([]),
            ),
            topic(
                "robotics",
                "Robotics",
                "robotics OR humanoid robot",
                json!([{ "kind": "feed", "url": "https://spectrum.ieee.org/feeds/topic/robotics.rss", "weight": 2.0 }]),
            ),
            topic(
                "crypto_news",
                "Crypto",
                "crypto OR bitcoin OR ethereum",
                json!([{ "kind": "feed", "url": "https://www.coindesk.com/arc/outboundfeeds/rss/", "weight": 1.5 }]),
            ),
            topic(
                "realestate",
                "Real Estate",
                "\"commercial real estate\" OR property market",
                json!([{ "kind": "feed", "url": "https://www.mingtiandi.com/feed/", "weight": 2.0 }]),
            ),
            topic(
                "datacentre",
                "Data Centre",
                "\"data center\" OR \"data centre\" capacity",
                json!([]),
            ),
            topic(
                "quant",
                "Quantitative Finance",
                "\"quantitative finance\" OR \"algorithmic trading\"",
                json!([{ "kind": "query", "tmpl": "arxiv", "arg": "q-fin.TR", "weight": 1.8 }]),
            ),
        ],
    }
}

/// Repair a topic whose options were emptied by the v1 serialisation fault.
///
/// A topic with no sources can never produce anything, and the user has no
/// way to tell that from a quiet news day. Rather than dropping it, give it
/// back a working shape: the shipped configuration if it is a seed topic, and
/// otherwise a single Google News binding keyed on its own name — which is
/// exactly what a newly created topic gets.
fn repair_topic(inst: &mut Instance, seeds: &[Instance]) {
    let has_sources = inst
        .opts
        .get("sources")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty());
    if has_sources {
        return;
    }
    if let Some(seed) = seeds.iter().find(|s| s.id == inst.id) {
        inst.opts = seed.opts.clone();
        return;
    }
    let query = inst
        .opts
        .get("query")
        .and_then(Value::as_str)
        .filter(|q| !q.trim().is_empty())
        .unwrap_or(&inst.name)
        .to_string();
    inst.opts = json!({
        "query": query,
        "max_age_hours": inst.opts.get("max_age_hours").cloned().unwrap_or(json!(24)),
        "sources": [{ "kind": "query", "tmpl": "googlenews", "weight": 1.0 }],
        "limit": inst.opts.get("limit").and_then(Value::as_u64).unwrap_or(8),
        "exclude": inst.opts.get("exclude").cloned().unwrap_or(json!([])),
        "include": inst.opts.get("include").cloned().unwrap_or(json!([])),
    });
}

/// Bring a stored document to the current version.
///
/// Unknown/absent version means a pre-1 document: fill in what is missing
/// rather than discarding, because throwing away a user's configuration on
/// upgrade is the one unrecoverable failure here.
pub fn migrate(stored: &Value) -> Config {
    let version = stored.get("version").and_then(Value::as_u64).unwrap_or(0) as u32;
    let mut cfg: Config = match serde_json::from_value(stored.clone()) {
        Ok(c) if version >= 1 => c,
        _ => {
            let defaults = default_config();
            let instances = stored
                .get("instances")
                .and_then(|v| serde_json::from_value::<Vec<Instance>>(v.clone()).ok())
                .unwrap_or(defaults.instances);
            Config {
                version: CURRENT_VERSION,
                instances,
                theme: stored
                    .get("theme")
                    .and_then(Value::as_str)
                    .unwrap_or("auto")
                    .to_string(),
                assistant: stored
                    .get("assistant")
                    .and_then(Value::as_str)
                    .unwrap_or("claude")
                    .to_string(),
                // Read back through serde rather than reconstructed: an
                // unreadable theme is dropped, never half-applied.
                custom_theme: stored
                    .get("custom_theme")
                    .and_then(|v| serde_json::from_value(v.clone()).ok()),
            }
        }
    };
    cfg.version = CURRENT_VERSION;
    if cfg.theme.is_empty() {
        cfg.theme = "auto".into();
    }
    if cfg.assistant.is_empty() {
        cfg.assistant = "claude".into();
    }
    // Heal anything the v1 fault emptied, and make sure `opts` is at least
    // an object — a non-object here would fail every later `.get`.
    let seeds = default_config().instances;
    for inst in cfg.instances.iter_mut() {
        if !inst.opts.is_object() {
            inst.opts = json!({});
        }
        if inst.def == "topic" {
            repair_topic(inst, &seeds);
        }
    }

    // Duplicate ids would make settings edit the wrong card.
    let mut seen = Vec::new();
    cfg.instances.retain(|i| {
        let dup = seen.contains(&i.id);
        if !dup {
            seen.push(i.id.clone());
        }
        !dup
    });

    // Rename the tabs card, but only where the reader never renamed it
    // themselves. Overwriting a name someone chose would be worse than
    // leaving the old default in place.
    for inst in cfg.instances.iter_mut() {
        if inst.def == "tabs" && inst.name == "Right now" {
            inst.name = "Tabs Management".into();
        }
    }

    // Offer groups shipped since this config was written.
    //
    // Without this a new group type is invisible forever to anyone who
    // already has a config — which is everyone after the first run. They
    // arrive **disabled**, so a release never changes a page the user
    // arranged; it only puts the new group on the menu.
    let existing: Vec<String> = cfg.instances.iter().map(|i| i.id.clone()).collect();
    for seed in seeds {
        if !existing.contains(&seed.id) {
            cfg.instances.push(Instance {
                enabled: false,
                ..seed
            });
        }
    }
    cfg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_calm() {
        let c = default_config();
        let on: Vec<&str> = c
            .instances
            .iter()
            .filter(|i| i.enabled)
            .map(|i| i.id.as_str())
            .collect();
        assert_eq!(
            on,
            vec!["tabs", "apps", "focus", "weather"],
            "D8: four on by default"
        );
    }

    #[test]
    fn every_users_topic_is_the_same_shape_as_a_shipped_one() {
        let c = default_config();
        let shipped = c.instances.iter().find(|i| i.id == "quant").unwrap();
        let invented = topic(
            "semis",
            "Semiconductor Supply Chain",
            "tsmc OR asml",
            json!([]),
        );
        assert_eq!(shipped.def, invented.def);
        assert!(shipped.opts.get("sources").is_some() && invented.opts.get("sources").is_some());
    }

    #[test]
    fn seven_seed_topics_ship() {
        let n = default_config()
            .instances
            .iter()
            .filter(|i| i.def == "topic")
            .count();
        assert_eq!(n, 7);
    }

    #[test]
    fn query_bindings_resolve_and_encode() {
        let b = Binding {
            kind: "query".into(),
            tmpl: Some("googlenews".into()),
            url: None,
            arg: None,
            weight: 1.0,
        };
        let u = binding_url(&b, "\"high frequency trading\"").unwrap();
        assert!(u.starts_with("https://news.google.com/rss/search?q="));
        assert!(u.contains("%22high%20frequency%20trading%22"), "got {u}");
    }

    #[test]
    fn an_arg_overrides_the_topic_query() {
        let b = Binding {
            kind: "query".into(),
            tmpl: Some("arxiv".into()),
            url: None,
            arg: Some("q-fin.TR".into()),
            weight: 1.0,
        };
        assert!(binding_url(&b, "ignored").unwrap().contains("cat:q-fin.TR"));
    }

    #[test]
    fn feed_bindings_pass_through() {
        let b = Binding {
            kind: "feed".into(),
            tmpl: None,
            url: Some("https://a.test/feed".into()),
            arg: None,
            weight: 1.0,
        };
        assert_eq!(binding_url(&b, "x").unwrap(), "https://a.test/feed");
    }

    #[test]
    fn an_empty_query_means_feeds_only_not_everything() {
        let q = Binding {
            kind: "query".into(),
            tmpl: Some("googlenews".into()),
            url: None,
            arg: None,
            weight: 1.0,
        };
        // A search with no terms is not "everything", it is nothing useful.
        assert!(binding_url(&q, "").is_none());
        assert!(binding_url(&q, "   ").is_none());

        // A feed binding is unaffected: this is how a topic becomes a plain
        // reader for the sources the user picked.
        let f = Binding {
            kind: "feed".into(),
            tmpl: None,
            url: Some("https://techcrunch.com/category/artificial-intelligence/feed/".into()),
            arg: None,
            weight: 1.0,
        };
        assert!(binding_url(&f, "").is_some());

        // An explicit arg still works with no topic query.
        let a = Binding {
            kind: "query".into(),
            tmpl: Some("arxiv".into()),
            url: None,
            arg: Some("q-fin.TR".into()),
            weight: 1.0,
        };
        assert!(binding_url(&a, "").is_some());
    }

    #[test]
    fn unknown_templates_do_not_panic() {
        let b = Binding {
            kind: "query".into(),
            tmpl: Some("nope".into()),
            url: None,
            arg: None,
            weight: 1.0,
        };
        assert!(binding_url(&b, "x").is_none());
    }

    #[test]
    fn fetching_groups_ask_for_the_hosts_they_actually_call() {
        // The regression that shipped: crypto/equities/status were never
        // granted anything, so they rendered an empty state forever.
        let mut c = default_config();
        for i in c.instances.iter_mut() {
            if ["crypto", "equities", "status"].contains(&i.def.as_str()) {
                i.enabled = true;
            }
        }
        let o = required_origins(&c);
        assert!(o.iter().any(|x| x.contains("api.binance.com")));
        assert!(o.iter().any(|x| x.contains("query1.finance.yahoo.com")));
        assert!(o.iter().any(|x| x.contains("githubstatus.com")));
    }

    #[test]
    fn a_disabled_fetching_group_asks_for_nothing() {
        let c = default_config(); // crypto/equities/status all off by default
        let o = required_origins(&c);
        assert!(!o.iter().any(|x| x.contains("binance")));
        assert!(!o.iter().any(|x| x.contains("yahoo")));
    }

    #[test]
    fn required_origins_covers_enabled_instances_only() {
        let mut c = default_config();
        for i in c.instances.iter_mut() {
            if i.id == "ai" {
                i.enabled = true;
            }
        }
        let o = required_origins(&c);
        assert!(o.iter().any(|x| x.contains("news.google.com")));
        assert!(o.iter().any(|x| x.contains("tldr.tech")));
        // A disabled topic must not widen the permission request.
        assert!(!o.iter().any(|x| x.contains("mingtiandi")));
    }

    #[test]
    fn the_tabs_card_is_renamed_only_when_it_was_never_customised() {
        let untouched = json!({ "version": 3, "instances": [
            { "def": "tabs", "id": "tabs", "name": "Right now", "enabled": true, "opts": {} }
        ]});
        assert_eq!(migrate(&untouched).instances[0].name, "Tabs Management");

        // A name the reader chose is theirs, and a release must not take it.
        let renamed = json!({ "version": 3, "instances": [
            { "def": "tabs", "id": "tabs", "name": "My Tabs", "enabled": true, "opts": {} }
        ]});
        assert_eq!(migrate(&renamed).instances[0].name, "My Tabs");
    }

    #[test]
    fn groups_shipped_after_a_config_was_written_become_available() {
        // The bug this fixes: a config written before a group existed never
        // gained it, so the group was invisible to every existing user.
        let stored = json!({ "version": 2, "instances": [
            { "def": "tabs", "id": "tabs", "name": "Right now", "enabled": true, "opts": {} }
        ]});
        let c = migrate(&stored);
        let x = c.instances.iter().find(|i| i.id == "xsearch");
        assert!(x.is_some(), "a newly shipped group must appear");
        assert!(
            !x.unwrap().enabled,
            "but never switched on behind the user's back"
        );
        assert_eq!(c.version, CURRENT_VERSION);
    }

    #[test]
    fn adding_new_groups_never_disturbs_what_the_user_arranged() {
        let stored = json!({ "version": 2, "instances": [
            { "def": "weather", "id": "weather", "name": "My Weather", "enabled": true,
              "opts": { "place": "Seoul", "lat": 37.5, "lon": 127.0 } },
            { "def": "tabs", "id": "tabs", "name": "Right now", "enabled": true, "opts": {} }
        ]});
        let c = migrate(&stored);
        // Their instances keep their order, names, options and enabled state.
        assert_eq!(c.instances[0].id, "weather");
        assert_eq!(c.instances[0].name, "My Weather");
        assert_eq!(
            c.instances[0].opts.get("place").and_then(|p| p.as_str()),
            Some("Seoul")
        );
        assert_eq!(c.instances[1].id, "tabs");
        // New ones are appended after, all disabled.
        assert!(c.instances[2..].iter().all(|i| !i.enabled));
    }

    #[test]
    fn a_topic_emptied_by_the_v1_fault_is_repaired() {
        // Exactly what the Map bug wrote to storage: opts stringified to {}.
        let stored = json!({ "version": 1, "instances": [
            { "def": "topic", "id": "ai", "name": "AI", "enabled": true, "opts": {} }
        ]});
        let c = migrate(&stored);
        let ai = &c.instances[0];
        let sources = ai.opts.get("sources").and_then(|s| s.as_array()).unwrap();
        assert!(
            !sources.is_empty(),
            "a repaired seed topic gets its sources back"
        );
        assert!(ai.opts.get("query").and_then(|q| q.as_str()).is_some());
    }

    #[test]
    fn a_users_own_topic_is_repaired_from_its_name_not_discarded() {
        let stored = json!({ "version": 1, "instances": [
            { "def": "topic", "id": "hft", "name": "High Frequency Trading",
              "enabled": true, "opts": {} }
        ]});
        let c = migrate(&stored);
        let t = &c.instances[0];
        assert_eq!(
            t.name, "High Frequency Trading",
            "never lose what the user named"
        );
        assert_eq!(
            t.opts.get("query").and_then(|q| q.as_str()),
            Some("High Frequency Trading")
        );
        assert_eq!(
            t.opts
                .get("sources")
                .and_then(|s| s.as_array())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_healthy_topic_is_left_exactly_as_it_is() {
        // Repair must never overwrite a working configuration.
        let stored = json!({ "version": 1, "instances": [
            { "def": "topic", "id": "ai", "name": "AI", "enabled": true, "opts": {
                "query": "my own query",
                "sources": [{ "kind": "feed", "url": "https://techcrunch.com/feed/", "weight": 1.5 }],
                "limit": 4
            }}
        ]});
        let c = migrate(&stored);
        let ai = &c.instances[0];
        assert_eq!(
            ai.opts.get("query").and_then(|q| q.as_str()),
            Some("my own query")
        );
        assert_eq!(
            ai.opts
                .get("sources")
                .and_then(|s| s.as_array())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(ai.opts.get("limit").and_then(|l| l.as_u64()), Some(4));
    }

    #[test]
    fn an_empty_query_with_real_feeds_survives_repair() {
        // "Feeds only" is a legitimate configuration and must not be treated
        // as damage.
        let stored = json!({ "version": 1, "instances": [
            { "def": "topic", "id": "mine", "name": "Mine", "enabled": true, "opts": {
                "query": "",
                "sources": [{ "kind": "feed", "url": "https://a.test/feed/", "weight": 1.0 }]
            }}
        ]});
        let c = migrate(&stored);
        assert_eq!(
            c.instances[0].opts.get("query").and_then(|q| q.as_str()),
            Some("")
        );
    }

    #[test]
    fn a_non_object_opts_does_not_break_migration() {
        let stored = json!({ "version": 1, "instances": [
            { "def": "weather", "id": "weather", "name": "Weather", "opts": "corrupt" }
        ]});
        let c = migrate(&stored);
        assert!(c.instances[0].opts.is_object());
    }

    #[test]
    fn migration_preserves_a_users_instances() {
        let stored = json!({
            "instances": [{ "def": "topic", "id": "mine", "name": "Mine", "opts": {} }]
        });
        let c = migrate(&stored);
        assert_eq!(c.version, CURRENT_VERSION);
        // Newly shipped groups are appended, so assert on the user's own
        // instance rather than the total.
        assert_eq!(c.instances[0].id, "mine");
        assert!(c.instances[0].enabled, "absent `enabled` defaults to on");
        assert!(c.instances.iter().filter(|i| i.id == "mine").count() == 1);
    }

    #[test]
    fn migration_of_junk_falls_back_to_defaults_rather_than_erroring() {
        let c = migrate(&json!({ "version": 0, "garbage": true }));
        assert_eq!(c.version, CURRENT_VERSION);
        assert!(!c.instances.is_empty());
    }

    #[test]
    fn duplicate_ids_are_dropped() {
        let stored = json!({ "version": 1, "instances": [
            { "def": "topic", "id": "x", "name": "A", "opts": {} },
            { "def": "topic", "id": "x", "name": "B", "opts": {} }
        ]});
        let c = migrate(&stored);
        assert_eq!(
            c.instances.iter().filter(|i| i.id == "x").count(),
            1,
            "a duplicate id must be dropped, whatever else is appended"
        );
        assert_eq!(c.instances[0].name, "A", "the first wins");
    }

    #[test]
    fn a_round_trip_through_json_is_lossless() {
        let c = default_config();
        let s = serde_json::to_value(&c).unwrap();
        let back = migrate(&s);
        assert_eq!(back.instances.len(), c.instances.len());
        assert_eq!(back.assistant, c.assistant);
    }
}
