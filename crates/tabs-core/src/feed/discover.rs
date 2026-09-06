//! Feed discovery — paste any URL and get a feed (milestone M6).
//!
//! Ranking candidates matters more than finding them. Verified against
//! `mingtiandi.com`, which advertises two feeds in its `<head>`: the site
//! feed and a *comments* feed. Naive discovery offers both, the user picks
//! the wrong one, and the topic fills with comment threads.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Candidate {
    pub url: String,
    pub title: String,
    /// Higher is better. Ordering is what the UI presents.
    pub score: i32,
}

/// Paths to try when a page advertises nothing. Ordered by how common they
/// are: WordPress, then Ghost/Hugo/Jekyll, then the query form.
pub const WELL_KNOWN: &[&str] = &[
    "/feed/",
    "/rss",
    "/feed.xml",
    "/rss.xml",
    "/atom.xml",
    "/index.xml",
    "/feeds/posts/default",
    "/?feed=rss2",
];

/// Does this document look like a feed rather than a web page?
pub fn looks_like_feed(body: &str) -> bool {
    let head = &body[..body.len().min(1024)].to_lowercase();
    head.contains("<rss") || head.contains("<feed") || head.contains("<rdf:rdf")
}

fn demote(url: &str, title: &str, base_path: &str) -> i32 {
    let u = url.to_lowercase();
    let t = title.to_lowercase();
    let mut score = 0;

    // The mingtiandi case: a comments feed is never what was wanted.
    if u.contains("comment") || t.contains("comment") {
        score -= 100;
    }
    for noise in ["/author", "/podcast", "itunes", "/comments"] {
        if u.contains(noise) {
            score -= 20;
        }
    }

    // Someone who pasted a *section* URL wants that section's feed.
    //
    // TechCrunch advertises both `/feed/` and
    // `/category/artificial-intelligence/feed/`. Preferring the shorter path
    // hands back the firehose when the person explicitly asked for AI — so a
    // candidate sitting under the pasted path outranks the site-wide one.
    let bp = base_path.trim_end_matches('/').to_lowercase();
    if bp.len() > 1 && crate::url::parse(&u).is_some_and(|p| p.path.to_lowercase().starts_with(&bp))
    {
        score += 60;
    } else {
        // Otherwise the shorter path is more likely to be the main feed.
        score -= (u.matches('/').count() as i32).saturating_sub(3) * 3;
    }
    score
}

/// Read `<link rel="alternate" type="application/rss+xml">` out of an HTML
/// document, resolve relative hrefs against `base`, and rank.
pub fn from_html(html: &str, base: &str) -> Vec<Candidate> {
    let base_path = crate::url::parse(base)
        .map(|p| p.path)
        .unwrap_or_else(|| "/".into());
    let mut out: Vec<Candidate> = Vec::new();
    for link in crate::feed::xml::elements(html, "link") {
        let rel = link.attr("rel").unwrap_or("").to_lowercase();
        let ty = link.attr("type").unwrap_or("").to_lowercase();
        if !ty.contains("rss") && !ty.contains("atom") {
            continue;
        }
        if !rel.is_empty() && !rel.contains("alternate") {
            continue;
        }
        let Some(href) = link.attr("href") else {
            continue;
        };
        let Some(url) = crate::url::resolve(base, href) else {
            continue;
        };
        let title = link.attr("title").map(str::to_string).unwrap_or_default();
        let mut score = 100 + demote(&url, &title, &base_path);
        // Atom slightly preferred: better date handling in practice.
        if ty.contains("atom") {
            score += 2;
        }
        if out.iter().any(|c| c.url == url) {
            continue;
        }
        out.push(Candidate { url, title, score });
    }
    // Declaration order is a weak signal that the first is the main feed.
    for (i, c) in out.iter_mut().enumerate() {
        c.score -= i as i32;
    }
    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.url.cmp(&b.url)));
    out
}

/// The URLs to try, in order, for a pasted address that was not itself a
/// feed and advertised none.
pub fn well_known_for(base: &str) -> Vec<String> {
    let Some(p) = crate::url::parse(base) else {
        return Vec::new();
    };
    let authority = match p.port {
        Some(n) => format!("{}:{}", p.host, n),
        None => p.host.clone(),
    };
    let origin = format!("{}://{}", p.scheme, authority);
    let mut out = Vec::new();

    // A pasted section URL gets its own feed tried first: WordPress serves
    // one per category, and it is what the person actually asked for.
    let path = p.path.trim_end_matches('/');
    if path.len() > 1 {
        for suffix in ["/feed/", "/rss", "/feed.xml"] {
            out.push(format!("{origin}{path}{suffix}"));
        }
    }
    out.extend(WELL_KNOWN.iter().map(|w| format!("{origin}{w}")));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // The real <head> shape, taken from mingtiandi.com.
    const MINGTIANDI: &str = r#"<html><head>
      <link rel="alternate" type="application/rss+xml" title="Mingtiandi &raquo; Feed" href="https://www.mingtiandi.com/feed/" />
      <link rel="alternate" type="application/rss+xml" title="Mingtiandi &raquo; Comments Feed" href="https://www.mingtiandi.com/comments/feed/" />
      <link rel="EditURI" type="application/rsd+xml" href="https://www.mingtiandi.com/xmlrpc.php?rsd" />
    </head></html>"#;

    #[test]
    fn the_comments_feed_never_wins() {
        let c = from_html(MINGTIANDI, "https://www.mingtiandi.com/");
        assert_eq!(c.len(), 2, "rsd is not a feed type");
        assert_eq!(c[0].url, "https://www.mingtiandi.com/feed/");
        assert!(c[1].url.contains("comments"));
    }

    #[test]
    fn relative_hrefs_resolve_against_the_page() {
        let h = r#"<link rel="alternate" type="application/rss+xml" href="/feed/">"#;
        let c = from_html(h, "https://a.test/blog/post");
        assert_eq!(c[0].url, "https://a.test/feed/");
    }

    #[test]
    fn a_link_with_no_rel_still_counts() {
        let h = r#"<link type="application/atom+xml" href="https://a.test/atom.xml">"#;
        assert_eq!(from_html(h, "https://a.test/").len(), 1);
    }

    #[test]
    fn stylesheets_and_icons_are_not_feeds() {
        let h = r#"<link rel="stylesheet" href="/s.css"><link rel="icon" href="/i.png">"#;
        assert!(from_html(h, "https://a.test/").is_empty());
    }

    #[test]
    fn duplicate_declarations_collapse() {
        let h = r#"<link rel="alternate" type="application/rss+xml" href="/f">
                   <link rel="alternate" type="application/rss+xml" href="/f">"#;
        assert_eq!(from_html(h, "https://a.test/").len(), 1);
    }

    #[test]
    fn feed_documents_are_recognised() {
        assert!(looks_like_feed(
            r#"<?xml version="1.0"?><rss version="2.0">"#
        ));
        assert!(looks_like_feed(
            r#"<feed xmlns="http://www.w3.org/2005/Atom">"#
        ));
        assert!(looks_like_feed("<rdf:RDF>"));
        assert!(!looks_like_feed("<!DOCTYPE html><html><head>"));
    }

    #[test]
    fn well_known_paths_are_built_from_the_origin() {
        let v = well_known_for("https://a.test/deep/page?x=1");
        assert!(v.contains(&"https://a.test/feed/".to_string()));
        // The pasted section's own feed is tried before the site-wide one.
        assert_eq!(v[0], "https://a.test/deep/page/feed/");
    }

    #[test]
    fn a_section_url_prefers_that_sections_feed() {
        // TechCrunch advertises both; someone pasting the AI category page
        // wants AI, not the firehose.
        let html = r#"
          <link rel="alternate" type="application/rss+xml" title="TechCrunch &raquo; Feed"
                href="https://techcrunch.com/feed/" />
          <link rel="alternate" type="application/rss+xml" title="TechCrunch &raquo; AI Category Feed"
                href="https://techcrunch.com/category/artificial-intelligence/feed/" />"#;
        let c = from_html(
            html,
            "https://techcrunch.com/category/artificial-intelligence/",
        );
        assert_eq!(
            c[0].url,
            "https://techcrunch.com/category/artificial-intelligence/feed/"
        );
    }

    #[test]
    fn a_homepage_url_still_prefers_the_site_feed() {
        let html = r#"
          <link rel="alternate" type="application/rss+xml" href="https://techcrunch.com/feed/" />
          <link rel="alternate" type="application/rss+xml" href="https://techcrunch.com/category/ai/feed/" />"#;
        let c = from_html(html, "https://techcrunch.com/");
        assert_eq!(c[0].url, "https://techcrunch.com/feed/");
    }
}
