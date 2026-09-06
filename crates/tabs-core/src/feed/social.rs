//! Keyless social search: Bluesky and Mastodon.
//!
//! These exist because X does not. `x.com/search` serves a JavaScript shell
//! with no results in it, Nitter is `410 Gone`, and X ended free API reads in
//! February 2026 — so watching a keyword on X costs money per post, and this
//! product does not spend the reader's money by default.
//!
//! Bluesky's `searchPosts` and Mastodon's `/api/v2/search` need no key and no
//! account. Both answer JSON, so they are normalised here into the same
//! `Item` every other source produces and rank alongside them.
//!
//! Bluesky refuses datacenter addresses (403) while answering browsers
//! normally — the same shape as Yahoo and Reddit, and the reason these are
//! fetched from the reader's own browser rather than proxied.

use super::Item;
use serde_json::Value;

/// `app.bsky.feed.searchPosts`.
pub fn parse_bluesky(json: &str, binding: &str, fetched_at: i64) -> Vec<Item> {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let Some(posts) = v.get("posts").and_then(Value::as_array) else {
        return Vec::new();
    };
    posts
        .iter()
        .filter_map(|p| {
            let text = p.get("record")?.get("text")?.as_str()?.trim();
            if text.is_empty() {
                return None;
            }
            let author = p.get("author")?;
            let handle = author
                .get("handle")
                .and_then(Value::as_str)
                .unwrap_or("bsky");
            // at://did:plc:xxx/app.bsky.feed.post/<rkey> -> a web permalink.
            let uri = p.get("uri").and_then(Value::as_str).unwrap_or("");
            let rkey = uri.rsplit('/').next().unwrap_or("");
            let url = format!("https://bsky.app/profile/{handle}/post/{rkey}");
            let published = p
                .get("indexedAt")
                .or_else(|| p.get("record").and_then(|r| r.get("createdAt")))
                .and_then(Value::as_str)
                .and_then(super::date::parse)
                .unwrap_or(fetched_at);
            let likes = p.get("likeCount").and_then(Value::as_i64).unwrap_or(0);
            let reposts = p.get("repostCount").and_then(Value::as_i64).unwrap_or(0);

            Some(Item {
                id: format!("bsky:{rkey}"),
                title: text.split_whitespace().collect::<Vec<_>>().join(" "),
                url,
                source: format!("@{handle}"),
                published,
                summary: (likes > 0 || reposts > 0)
                    .then(|| format!("{likes} likes · {reposts} reposts")),
                binding: binding.to_string(),
            })
        })
        .collect()
}

/// Mastodon `/api/v2/search?type=statuses`, which answers a bare array under
/// `statuses`.
pub fn parse_mastodon(json: &str, binding: &str, fetched_at: i64) -> Vec<Item> {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let statuses = v
        .get("statuses")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| v.as_array().cloned())
        .unwrap_or_default();

    statuses
        .iter()
        .filter_map(|s| {
            // `content` is HTML; reuse the feed scanner rather than a second
            // tag stripper.
            let text = super::xml::text(s.get("content")?.as_str()?);
            if text.trim().is_empty() {
                return None;
            }
            let url = s
                .get("url")
                .or_else(|| s.get("uri"))
                .and_then(Value::as_str)?
                .to_string();
            let acct = s
                .get("account")
                .and_then(|a| a.get("acct"))
                .and_then(Value::as_str)
                .unwrap_or("mastodon");
            let published = s
                .get("created_at")
                .and_then(Value::as_str)
                .and_then(super::date::parse)
                .unwrap_or(fetched_at);
            let favs = s
                .get("favourites_count")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let boosts = s.get("reblogs_count").and_then(Value::as_i64).unwrap_or(0);

            Some(Item {
                id: crate::url::identity(&url),
                title: text,
                url,
                source: format!("@{acct}"),
                published,
                summary: (favs > 0 || boosts > 0)
                    .then(|| format!("{favs} favourites · {boosts} boosts")),
                binding: binding.to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_788_048_000;

    const BSKY: &str = r#"{"posts":[
      {"uri":"at://did:plc:abc/app.bsky.feed.post/3kxyz",
       "author":{"handle":"nasa.bsky.social","displayName":"NASA"},
       "record":{"text":"Launch window opens tonight","createdAt":"2026-08-30T04:00:00Z"},
       "indexedAt":"2026-08-30T04:01:00Z","likeCount":120,"repostCount":30},
      {"uri":"at://did:plc:def/app.bsky.feed.post/3kabc",
       "author":{"handle":"someone.bsky.social"},
       "record":{"text":"   ","createdAt":"2026-08-30T04:00:00Z"}}
    ]}"#;

    #[test]
    fn bluesky_posts_become_items_with_web_permalinks() {
        let items = parse_bluesky(BSKY, "bluesky", NOW);
        assert_eq!(items.len(), 1, "the blank post is dropped");
        assert_eq!(items[0].title, "Launch window opens tonight");
        assert_eq!(
            items[0].url,
            "https://bsky.app/profile/nasa.bsky.social/post/3kxyz"
        );
        assert_eq!(items[0].source, "@nasa.bsky.social");
        assert_eq!(items[0].summary.as_deref(), Some("120 likes · 30 reposts"));
    }

    #[test]
    fn bluesky_dates_are_read_not_guessed() {
        let items = parse_bluesky(BSKY, "bluesky", NOW);
        assert_ne!(items[0].published, NOW, "indexedAt must be used");
        assert_eq!(
            items[0].published,
            super::super::date::parse("2026-08-30T04:01:00Z").unwrap()
        );
    }

    const MASTO: &str = r#"{"statuses":[
      {"url":"https://mastodon.social/@a/1","created_at":"2026-08-30T04:00:00Z",
       "content":"<p>Robots are <b>everywhere</b> &amp; growing</p>",
       "account":{"acct":"a@mastodon.social"},"favourites_count":9,"reblogs_count":2}
    ]}"#;

    #[test]
    fn mastodon_html_becomes_plain_text() {
        let items = parse_mastodon(MASTO, "mastodon", NOW);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Robots are everywhere & growing");
        assert_eq!(items[0].source, "@a@mastodon.social");
    }

    #[test]
    fn the_tag_timeline_shape_is_a_bare_array() {
        // /api/v1/timelines/tag/:tag answers an array, not {statuses:[...]}.
        // This is the endpoint actually used, because unauthenticated
        // full-text search on mastodon.social returns nothing.
        let bare = r#"[
          {"url":"https://mastodon.social/@b/2","created_at":"2026-08-30T07:00:00Z",
           "content":"<p>Tagged post</p>","account":{"acct":"b@bsd.cafe"}}
        ]"#;
        let items = parse_mastodon(bare, "mastodon", NOW);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Tagged post");
        assert_eq!(items[0].source, "@b@bsd.cafe");
    }

    #[test]
    fn malformed_payloads_are_empty_not_panics() {
        for bad in ["", "null", "{}", "[]", r#"{"posts":"nope"}"#, "<html>"] {
            assert!(parse_bluesky(bad, "b", NOW).is_empty(), "bluesky: {bad}");
            assert!(parse_mastodon(bad, "m", NOW).is_empty(), "mastodon: {bad}");
        }
    }
}
