//! Normalising posts read from a rendered X search page.
//!
//! The reading itself happens in the page, because that is the only place the
//! posts exist — `x.com/search` serves a JavaScript shell and renders results
//! client-side from the reader's own authenticated session. What arrives here
//! is whatever the extractor scraped, in whatever shape the DOM was in.
//!
//! So this module's job is defensive: X's markup is not an API, fields go
//! missing without warning, and the failure that matters is a *wrong* post
//! rather than a missing one. Anything that cannot be identified confidently
//! is dropped.
//!
//! The extension puts this behind an explicit, off-by-default setting with the
//! terms-of-service risk stated in the UI — see `background/xscrape.ts`.

use super::feed::Item;
use serde::Deserialize;
use serde_json::Value;

/// One post as the page extractor found it. Every field optional: the DOM
/// gives what it gives.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct RawPost {
    pub id: String,
    pub text: String,
    pub handle: String,
    pub name: String,
    /// ISO 8601 from the post's `<time datetime>`.
    pub time: String,
    pub url: String,
    pub replies: Option<i64>,
    pub reposts: Option<i64>,
    pub likes: Option<i64>,
}

/// X status ids are snowflakes: long, digits only. Anything else came from a
/// promoted card, a "who to follow" module, or a markup change.
fn plausible_id(id: &str) -> bool {
    id.len() >= 15 && id.len() <= 25 && id.bytes().all(|b| b.is_ascii_digit())
}

/// Extract the status id from a permalink, since the extractor may only have
/// found the link.
fn id_from_url(url: &str) -> Option<String> {
    let after = url.split("/status/").nth(1)?;
    let id: String = after.chars().take_while(char::is_ascii_digit).collect();
    plausible_id(&id).then_some(id)
}

/// Turn extracted posts into ranked-feed items.
///
/// `fetched_at` stands in for a missing timestamp. Posts without a usable id,
/// permalink or text are dropped rather than guessed at.
pub fn normalize(json: &str, binding: &str, fetched_at: i64) -> Vec<Item> {
    let Ok(raw) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let posts: Vec<RawPost> = raw
        .get("posts")
        .and_then(|p| serde_json::from_value(p.clone()).ok())
        .or_else(|| serde_json::from_value(raw.clone()).ok())
        .unwrap_or_default();

    let mut out: Vec<Item> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    for p in posts {
        let text = p.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            continue;
        }
        let id = if plausible_id(&p.id) {
            p.id.clone()
        } else if let Some(id) = id_from_url(&p.url) {
            id
        } else {
            // No trustworthy identity: a promoted slot or changed markup.
            continue;
        };
        if seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());

        let handle = p.handle.trim().trim_start_matches('@').to_string();
        let url = if p.url.starts_with("https://") {
            p.url.clone()
        } else if !handle.is_empty() {
            format!("https://x.com/{handle}/status/{id}")
        } else {
            format!("https://x.com/i/status/{id}")
        };

        let published = crate::feed::date::parse(&p.time).unwrap_or(fetched_at);
        let metrics = [
            ("likes", p.likes),
            ("reposts", p.reposts),
            ("replies", p.replies),
        ]
        .into_iter()
        .filter_map(|(label, n)| n.filter(|v| *v > 0).map(|v| format!("{v} {label}")))
        .collect::<Vec<_>>();

        out.push(Item {
            id: format!("x:{id}"),
            title: text,
            url,
            source: if handle.is_empty() {
                "X".into()
            } else {
                format!("@{handle}")
            },
            published,
            summary: (!metrics.is_empty()).then(|| metrics.join(" · ")),
            binding: binding.to_string(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_788_048_000;

    const SAMPLE: &str = r#"{"posts":[
      {"id":"1799887766554433221","text":"microduck  is\nshipping tonight",
       "handle":"@builder","name":"Builder","time":"2026-08-30T04:00:00.000Z",
       "url":"https://x.com/builder/status/1799887766554433221",
       "replies":3,"reposts":7,"likes":42},
      {"id":"","text":"Promoted nonsense","handle":"@ad","time":"","url":"https://x.com/ad"},
      {"id":"1799887766554433221","text":"a duplicate of the first",
       "handle":"@builder","time":"2026-08-30T04:00:00.000Z",
       "url":"https://x.com/builder/status/1799887766554433221"},
      {"id":"","text":"link only","handle":"@someone","time":"2026-08-30T03:00:00.000Z",
       "url":"https://x.com/someone/status/1799887766554433999"}
    ]}"#;

    #[test]
    fn maps_a_scraped_post_to_an_item() {
        let items = normalize(SAMPLE, "xscrape", NOW);
        assert_eq!(items[0].id, "x:1799887766554433221");
        assert_eq!(
            items[0].title, "microduck is shipping tonight",
            "whitespace is collapsed"
        );
        assert_eq!(items[0].source, "@builder");
        assert_eq!(
            items[0].summary.as_deref(),
            Some("42 likes · 7 reposts · 3 replies")
        );
        assert_eq!(
            items[0].published,
            crate::feed::date::parse("2026-08-30T04:00:00Z").unwrap()
        );
    }

    #[test]
    fn a_post_with_no_trustworthy_id_is_dropped_not_guessed() {
        // Promoted slots and "who to follow" cards render as articles too.
        let items = normalize(SAMPLE, "xscrape", NOW);
        assert!(items.iter().all(|i| i.title != "Promoted nonsense"));
    }

    #[test]
    fn the_id_can_come_from_the_permalink_alone() {
        let items = normalize(SAMPLE, "xscrape", NOW);
        assert!(items.iter().any(|i| i.id == "x:1799887766554433999"));
    }

    #[test]
    fn duplicates_within_one_scrape_collapse() {
        // Virtualised lists re-render the same post as you scroll.
        let items = normalize(SAMPLE, "xscrape", NOW);
        assert_eq!(
            items
                .iter()
                .filter(|i| i.id == "x:1799887766554433221")
                .count(),
            1
        );
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn implausible_ids_are_rejected() {
        assert!(plausible_id("1799887766554433221"));
        assert!(!plausible_id("123"));
        assert!(!plausible_id("abcdefghijklmnop"));
        assert!(!plausible_id(""));
        assert!(!plausible_id("17998877665544332211799887766554433221"));
    }

    #[test]
    fn a_missing_timestamp_falls_back_rather_than_dropping_the_post() {
        let j = r#"{"posts":[{"id":"1799887766554433221","text":"no time",
                   "handle":"a","time":"","url":""}]}"#;
        let items = normalize(j, "xscrape", NOW);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].published, NOW);
        assert_eq!(items[0].url, "https://x.com/a/status/1799887766554433221");
    }

    #[test]
    fn markup_that_changed_yields_nothing_rather_than_garbage() {
        // The loud failure: if the selectors stop matching, the group empties
        // and says so, instead of filling with fragments.
        for bad in ["", "null", "{}", "[]", "<html>", r#"{"posts":"nope"}"#] {
            assert!(normalize(bad, "x", NOW).is_empty(), "on {bad}");
        }
    }

    #[test]
    fn a_bare_array_is_accepted_too() {
        let j = r#"[{"id":"1799887766554433221","text":"hi","handle":"a",
                    "time":"2026-08-30T04:00:00Z","url":""}]"#;
        assert_eq!(normalize(j, "x", NOW).len(), 1);
    }
}
