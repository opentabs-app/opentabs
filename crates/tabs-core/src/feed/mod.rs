//! Feed parsing and the topic engine's item model.
//!
//! Three dialects reach the same `Item`: RSS 2.0 (`<item>`), Atom
//! (`<entry>`), and RDF/RSS 1.0 (`<item>` at the document root). They differ
//! in where the link lives and what the date element is called, and in
//! nothing else that matters here.

pub mod date;
pub mod discover;
pub mod hn;
pub mod rank;
pub mod social;
pub mod xml;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub title: String,
    pub url: String,
    /// Dedupe key: the Google News wrapper id, or the canonical URL.
    pub id: String,
    /// Host shown to the reader. For a Google News wrapper this is the
    /// publisher from `<source>`, not `news.google.com`.
    pub source: String,
    /// Unix seconds. Never `None` — unparseable dates fall back to fetch
    /// time, because dropping an item for a malformed date loses real news.
    pub published: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Which configured binding produced this. Used for source weighting and
    /// for showing the user where a story came from.
    #[serde(default)]
    pub binding: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Feed {
    pub title: String,
    pub items: Vec<Item>,
}

fn first_text(inner: &str, names: &[&str]) -> Option<String> {
    names.iter().find_map(|n| {
        xml::child(inner, n)
            .map(|e| xml::text(e.inner))
            .filter(|s| !s.is_empty())
    })
}

/// Atom puts the URL in `<link href>` and may carry several, distinguished
/// by `rel`. `alternate` (or absent, which means alternate) is the article;
/// `self` is the feed and must never be used as an item link.
fn atom_link(inner: &str) -> Option<String> {
    let links = xml::elements(inner, "link");
    links
        .iter()
        .find(|l| {
            l.attr("rel")
                .is_none_or(|r| r.eq_ignore_ascii_case("alternate"))
        })
        .or_else(|| links.first())
        .and_then(|l| l.attr("href").map(str::to_string))
}

fn item_link(inner: &str) -> Option<String> {
    let links = xml::elements(inner, "link");
    // Atom style: hrefs present, so `rel` decides. Doing this before the
    // body check is what stops rel="self" — the feed's own address — being
    // returned as the article link when it happens to be declared first.
    if links.iter().any(|l| l.attr("href").is_some()) {
        if let Some(u) = atom_link(inner) {
            return Some(u);
        }
    }
    // RSS style: the URL is the element body.
    if let Some(body) = links.first().map(|e| xml::text(e.inner)) {
        if body.contains("://") {
            return Some(body);
        }
    }
    first_text(inner, &["guid", "id"]).filter(|g| g.contains("://"))
}

/// Parse a feed document. `fetched_at` is the fallback publication time and
/// `binding` labels which configured source produced these items.
pub fn parse(doc: &str, binding: &str, fetched_at: i64) -> Feed {
    let title = xml::elements(doc, "channel")
        .first()
        .and_then(|c| first_text(c.inner, &["title"]))
        .or_else(|| first_text(doc, &["title"]))
        .unwrap_or_default();

    // Atom uses <entry>; RSS and RDF use <item>.
    let mut raw = xml::elements(doc, "entry");
    if raw.is_empty() {
        raw = xml::elements(doc, "item");
    }

    let items = raw
        .into_iter()
        .filter_map(|e| {
            let title = first_text(e.inner, &["title"])?;
            let url = item_link(e.inner)?;
            if title.is_empty() || !url.contains("://") {
                return None;
            }
            let published = first_text(
                e.inner,
                &[
                    "pubDate",
                    "published",
                    "updated",
                    "date",
                    "created",
                    "issued",
                ],
            )
            .and_then(|d| date::parse(&d))
            .unwrap_or(fetched_at);

            // Google News names the publisher in <source>; without it the
            // whole topic would read as coming from news.google.com.
            let source = xml::child(e.inner, "source")
                .map(|s| xml::text(s.inner))
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    crate::url::parse(&url).map(|p| p.host.trim_start_matches("www.").to_string())
                })
                .unwrap_or_default();

            let summary = first_text(e.inner, &["description", "summary", "content"])
                .map(|s| truncate_words(&s, 40))
                .filter(|s| !s.is_empty());

            Some(Item {
                id: crate::url::identity(&url),
                title,
                url,
                source,
                published,
                summary,
                binding: binding.to_string(),
            })
        })
        .collect();

    Feed { title, items }
}

fn truncate_words(s: &str, max_words: usize) -> String {
    let mut out = String::new();
    for (i, w) in s.split_whitespace().enumerate() {
        if i >= max_words {
            out.push('…');
            break;
        }
        if i > 0 {
            out.push(' ');
        }
        out.push_str(w);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_788_048_000;

    #[test]
    fn parses_rss_two() {
        let x = r#"<rss><channel><title>Site</title>
          <item><title>First</title><link>https://a.test/1</link>
            <pubDate>Sat, 30 Aug 2026 10:00:00 GMT</pubDate>
            <description><![CDATA[<p>Body &amp; more</p>]]></description></item>
        </channel></rss>"#;
        let f = parse(x, "b", NOW);
        assert_eq!(f.title, "Site");
        assert_eq!(f.items.len(), 1);
        assert_eq!(f.items[0].title, "First");
        assert_eq!(f.items[0].url, "https://a.test/1");
        assert_eq!(f.items[0].source, "a.test");
        assert_eq!(f.items[0].summary.as_deref(), Some("Body & more"));
    }

    #[test]
    fn parses_atom_and_never_uses_the_self_link() {
        let x = r#"<feed><title>Blog</title>
          <entry><title>Post</title>
            <link rel="self" href="https://a.test/feed.xml"/>
            <link rel="alternate" href="https://a.test/post"/>
            <updated>2026-08-30T10:00:00Z</updated></entry></feed>"#;
        let f = parse(x, "b", NOW);
        assert_eq!(f.items[0].url, "https://a.test/post");
    }

    #[test]
    fn atom_link_without_rel_is_the_article() {
        let x = r#"<feed><entry><title>P</title>
            <link href="https://a.test/p"/></entry></feed>"#;
        assert_eq!(parse(x, "b", NOW).items[0].url, "https://a.test/p");
    }

    #[test]
    fn parses_rdf_rss_one() {
        let x = r#"<rdf:RDF><channel><title>Old</title></channel>
          <item><title>Legacy</title><link>https://a.test/l</link>
            <dc:date>2026-08-30T09:00:00Z</dc:date></item></rdf:RDF>"#;
        let f = parse(x, "b", NOW);
        assert_eq!(f.items.len(), 1);
        assert_eq!(f.items[0].title, "Legacy");
    }

    #[test]
    fn google_news_items_show_the_publisher_not_google() {
        let x = r#"<rss><channel><item>
            <title>Story</title>
            <link>https://news.google.com/rss/articles/CBMiVWh0dHBzOi8vZXhhbXBsZQ?oc=5</link>
            <source url="https://reuters.com">Reuters</source>
            <pubDate>Sat, 30 Aug 2026 10:00:00 GMT</pubDate>
        </item></channel></rss>"#;
        let f = parse(x, "gnews", NOW);
        assert_eq!(f.items[0].source, "Reuters");
        assert!(f.items[0].id.starts_with("gnews:"));
    }

    #[test]
    fn an_unparseable_date_falls_back_rather_than_dropping_the_item() {
        let x = r#"<rss><channel><item><title>T</title>
            <link>https://a.test/x</link><pubDate>whenever</pubDate></item></channel></rss>"#;
        let f = parse(x, "b", NOW);
        assert_eq!(f.items.len(), 1, "a bad date must not lose the story");
        assert_eq!(f.items[0].published, NOW);
    }

    #[test]
    fn items_without_a_usable_link_are_dropped() {
        let x = "<rss><channel><item><title>No link</title></item></channel></rss>";
        assert!(parse(x, "b", NOW).items.is_empty());
    }

    #[test]
    fn a_guid_url_stands_in_for_a_missing_link() {
        let x = r#"<rss><channel><item><title>T</title>
            <guid isPermaLink="true">https://a.test/g</guid></item></channel></rss>"#;
        assert_eq!(parse(x, "b", NOW).items[0].url, "https://a.test/g");
    }
}
