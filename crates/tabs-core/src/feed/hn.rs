//! Hacker News via the Algolia search API, which answers JSON rather than
//! RSS. Normalised into the same `Item` so a HN binding ranks and dedupes
//! alongside every other source — the topic engine must not care where an
//! item came from.

use super::Item;
use serde_json::Value;

/// `points` and `num_comments` stand in for corroboration, which HN has no
/// equivalent of: a story with 400 points is carried as strongly as one
/// several outlets ran. Scaled to sit in the same range as a source count.
fn engagement_sources(points: i64, comments: i64) -> Vec<String> {
    let n = (((points + comments * 2) as f64).max(1.0).log10().floor() as usize).min(3);
    (0..=n).map(|i| format!("hn:{i}")).collect()
}

pub fn parse(json: &str, binding: &str, fetched_at: i64) -> Vec<Item> {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let Some(hits) = v.get("hits").and_then(Value::as_array) else {
        return Vec::new();
    };
    hits.iter()
        .filter_map(|h| {
            let title = h.get("title").and_then(Value::as_str)?.trim();
            if title.is_empty() {
                return None;
            }
            let object_id = h.get("objectID").and_then(Value::as_str).unwrap_or("");
            // An Ask/Show HN post has no external url; link to the thread.
            let url = h
                .get("url")
                .and_then(Value::as_str)
                .filter(|u| u.contains("://"))
                .map(str::to_string)
                .unwrap_or_else(|| format!("https://news.ycombinator.com/item?id={object_id}"));
            let published = h
                .get("created_at_i")
                .and_then(Value::as_i64)
                .or_else(|| {
                    h.get("created_at")
                        .and_then(Value::as_str)
                        .and_then(super::date::parse)
                })
                .unwrap_or(fetched_at);
            let points = h.get("points").and_then(Value::as_i64).unwrap_or(0);
            let comments = h.get("num_comments").and_then(Value::as_i64).unwrap_or(0);

            Some(Item {
                id: crate::url::identity(&url),
                title: title.to_string(),
                url,
                source: "Hacker News".into(),
                published,
                summary: (points > 0).then(|| format!("{points} points · {comments} comments")),
                binding: binding.to_string(),
            })
        })
        .collect()
}

/// The synthetic source names used to express HN engagement as
/// corroboration. Exposed so the ranker can be given them explicitly.
pub fn weight_hint(points: i64, comments: i64) -> Vec<String> {
    engagement_sources(points, comments)
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_788_048_000;

    const SAMPLE: &str = r#"{"hits":[
      {"title":"A real story","url":"https://example.test/a","objectID":"1",
       "points":320,"num_comments":88,"created_at_i":1788040000},
      {"title":"Ask HN: how do you X?","url":null,"objectID":"2",
       "points":15,"num_comments":40,"created_at_i":1788041000},
      {"title":"","url":"https://x.test","objectID":"3"}
    ]}"#;

    #[test]
    fn maps_hits_to_items() {
        let items = parse(SAMPLE, "hn", NOW);
        assert_eq!(items.len(), 2, "the empty title is dropped");
        assert_eq!(items[0].title, "A real story");
        assert_eq!(items[0].url, "https://example.test/a");
        assert_eq!(items[0].source, "Hacker News");
        assert_eq!(items[0].published, 1788040000);
    }

    #[test]
    fn ask_hn_posts_link_to_the_thread() {
        let items = parse(SAMPLE, "hn", NOW);
        assert_eq!(items[1].url, "https://news.ycombinator.com/item?id=2");
    }

    #[test]
    fn points_and_comments_show_as_the_summary() {
        assert_eq!(
            parse(SAMPLE, "hn", NOW)[0].summary.as_deref(),
            Some("320 points · 88 comments")
        );
    }

    #[test]
    fn malformed_json_is_empty_not_a_panic() {
        assert!(parse("not json", "hn", NOW).is_empty());
        assert!(parse("{}", "hn", NOW).is_empty());
        assert!(parse(r#"{"hits":"nope"}"#, "hn", NOW).is_empty());
    }

    #[test]
    fn engagement_scales_sub_linearly() {
        assert!(weight_hint(5, 1).len() <= weight_hint(5000, 900).len());
    }
}
