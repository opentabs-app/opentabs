//! Ranking and dedupe — decision D10.
//!
//! "The top 5–10 stories with headlines and links" is a ranking problem, not
//! a summarisation one, so there is no model here. Three signals, in order of
//! how much they matter:
//!
//! 1. **Corroboration.** A story four outlets carry outranks one only a
//!    single blog ran. This is the signal that makes a wide query source
//!    (Google News returns ~100 items, heavily duplicated) an asset instead
//!    of noise — but it is worthless unless URL identity is right, which is
//!    why `crate::url::identity` unwraps Google News redirects.
//! 2. **Recency**, with a half-life rather than a cliff, so a strong story
//!    from this morning still beats a weak one from ten minutes ago.
//! 3. **Source weight**, so a curated newsletter can be trusted above a
//!    broad search.

use super::Item;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankOpts {
    /// Recency half-life in hours. At 12h a story loses half its recency
    /// score every twelve hours.
    pub half_life_hours: f64,
    /// Per-binding multipliers. Absent bindings weigh 1.0.
    #[serde(default)]
    pub weights: HashMap<String, f64>,
    /// Lowercase substrings that disqualify an item outright.
    #[serde(default)]
    pub exclude: Vec<String>,
    /// If non-empty, an item must contain at least one of these.
    #[serde(default)]
    pub include: Vec<String>,
    /// Hard cutoff in hours. `0` means no limit.
    ///
    /// Recency decay alone is not enough. A source carrying its whole archive
    /// — a newsletter's full back catalogue, say — fills a topic with
    /// years-old posts whenever the other sources are failing, because
    /// something has to rank first. A window says "these are not news".
    #[serde(default)]
    pub max_age_hours: f64,
    pub limit: usize,
}

impl Default for RankOpts {
    fn default() -> Self {
        Self {
            half_life_hours: 12.0,
            weights: HashMap::new(),
            exclude: Vec::new(),
            include: Vec::new(),
            max_age_hours: 0.0,
            limit: 10,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ranked {
    /// True when this item is older than the window and is shown only
    /// because nothing inside the window survived. The UI labels it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub outside_window: bool,
    #[serde(flatten)]
    pub item: Item,
    /// How many distinct sources carried this story.
    pub corroboration: usize,
    /// Other outlets that ran it, for the "also in" line.
    pub also_in: Vec<String>,
    pub score: f64,
}

/// Normalise a headline for near-duplicate detection: lowercase, drop
/// punctuation, drop the outlet suffix publishers append (" - Reuters").
fn title_key(title: &str) -> String {
    let cut = title
        .rfind(" - ")
        .or_else(|| title.rfind(" | "))
        .map_or(title, |i| &title[..i]);
    let mut out: Vec<String> = cut
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .filter(|w| w.len() > 2 && !STOPWORDS.contains(w))
        .map(str::to_string)
        .collect();
    // Word-set rather than word-order: two outlets rarely phrase a headline
    // identically, but they do use the same nouns.
    out.sort();
    out.dedup();
    out.truncate(8);
    out.join(" ")
}

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "from", "that", "this", "says", "will", "has", "have", "its",
    "was", "are", "but", "not", "you", "how", "why", "what", "new", "after", "over", "into",
];

fn matches_filters(item: &Item, opts: &RankOpts) -> bool {
    let hay = format!(
        "{} {} {}",
        item.title.to_lowercase(),
        item.source.to_lowercase(),
        item.summary.as_deref().unwrap_or("").to_lowercase()
    );
    if opts
        .exclude
        .iter()
        .any(|e| !e.is_empty() && hay.contains(&e.to_lowercase()))
    {
        return false;
    }
    if !opts.include.is_empty()
        && !opts
            .include
            .iter()
            .any(|i| i.is_empty() || hay.contains(&i.to_lowercase()))
    {
        return false;
    }
    true
}

/// Collapse duplicates and rank. `now` is Unix seconds.
///
/// Items are merged when they share a URL identity *or* a normalised title
/// key. The survivor is the earliest-published copy — first to report — and
/// it inherits the corroboration count of the whole cluster.
pub fn rank(items: &[Item], opts: &RankOpts, now: i64) -> Vec<Ranked> {
    let mut clusters: Vec<Vec<&Item>> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut by_title: HashMap<String, usize> = HashMap::new();

    for item in items.iter().filter(|i| matches_filters(i, opts)) {
        let tkey = title_key(&item.title);
        let existing = by_id.get(&item.id).copied().or_else(|| {
            (!tkey.is_empty())
                .then(|| by_title.get(&tkey).copied())
                .flatten()
        });
        match existing {
            Some(idx) => clusters[idx].push(item),
            None => {
                let idx = clusters.len();
                clusters.push(vec![item]);
                by_id.insert(item.id.clone(), idx);
                if !tkey.is_empty() {
                    by_title.insert(tkey, idx);
                }
            }
        }
    }

    let mut out: Vec<Ranked> = clusters
        .into_iter()
        .map(|group| {
            let lead = group
                .iter()
                .min_by_key(|i| (i.published, i.title.clone()))
                .copied()
                .expect("cluster is never empty");

            let mut sources: Vec<String> = group.iter().map(|i| i.source.clone()).collect();
            sources.sort();
            sources.dedup();
            sources.retain(|s| !s.is_empty());
            let corroboration = sources.len().max(1);

            let age_hours = ((now - lead.published).max(0) as f64) / 3600.0;
            let recency = 0.5f64.powf(age_hours / opts.half_life_hours.max(0.1));
            let weight = group
                .iter()
                .map(|i| opts.weights.get(&i.binding).copied().unwrap_or(1.0))
                .fold(f64::MIN, f64::max)
                .max(1.0);
            // Sub-linear in corroboration: the jump from one outlet to two is
            // real signal, from eight to nine is not.
            let score = recency * weight * (1.0 + (corroboration as f64).ln());

            let also_in = sources
                .iter()
                .filter(|s| **s != lead.source)
                .cloned()
                .collect();
            Ranked {
                item: lead.clone(),
                corroboration,
                also_in,
                score,
                outside_window: false,
            }
        })
        .collect();

    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            // Deterministic tie-break, so the page does not reshuffle.
            .then(b.item.published.cmp(&a.item.published))
            .then(a.item.id.cmp(&b.item.id))
    });

    if opts.max_age_hours > 0.0 {
        let cutoff = now - (opts.max_age_hours * 3600.0) as i64;
        let inside: Vec<Ranked> = out
            .iter()
            .filter(|r| r.item.published >= cutoff)
            .cloned()
            .collect();
        if inside.is_empty() {
            // Nothing inside the window. An empty card reads as broken, so
            // show the newest few and label them rather than going blank: a
            // quiet week and a failure are different, and the reader can only
            // tell them apart if we say which it is.
            out.sort_by_key(|r| std::cmp::Reverse(r.item.published));
            out.truncate(3);
            for r in out.iter_mut() {
                r.outside_window = true;
            }
        } else {
            out = inside;
        }
    }

    out.truncate(opts.limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_788_048_000;

    fn item(title: &str, url: &str, source: &str, age_h: i64) -> Item {
        Item {
            title: title.into(),
            url: url.into(),
            id: crate::url::identity(url),
            source: source.into(),
            published: NOW - age_h * 3600,
            summary: None,
            binding: "gnews".into(),
        }
    }

    #[test]
    fn one_story_from_four_outlets_becomes_one_row() {
        let items = vec![
            item("Nvidia beats earnings", "https://a.test/1", "Reuters", 2),
            item(
                "Nvidia beats earnings - CNBC",
                "https://b.test/2",
                "CNBC",
                1,
            ),
            item("Nvidia Beats Earnings!", "https://c.test/3", "FT", 3),
            item(
                "Something unrelated entirely",
                "https://d.test/4",
                "Wired",
                1,
            ),
        ];
        let r = rank(&items, &RankOpts::default(), NOW);
        assert_eq!(r.len(), 2, "three reports of one story must collapse");
        assert_eq!(r[0].corroboration, 3);
        assert_eq!(r[0].also_in.len(), 2);
    }

    #[test]
    fn corroborated_story_outranks_a_slightly_fresher_lone_one() {
        let items = vec![
            item("Big thing happened", "https://a.test/1", "Reuters", 3),
            item("Big Thing Happened - AP", "https://b.test/2", "AP", 3),
            item("Big thing happened | BBC", "https://c.test/3", "BBC", 3),
            item(
                "Minor blog post nobody else ran",
                "https://d.test/4",
                "Blog",
                1,
            ),
        ];
        let r = rank(&items, &RankOpts::default(), NOW);
        assert_eq!(r[0].corroboration, 3);
    }

    #[test]
    fn recency_beats_corroboration_once_the_story_is_old() {
        let items = vec![
            item("Ancient but widely covered", "https://a.test/1", "A", 240),
            item(
                "Ancient but widely covered - B",
                "https://b.test/2",
                "B",
                240,
            ),
            item(
                "Ancient but widely covered | C",
                "https://c.test/3",
                "C",
                240,
            ),
            item("Fresh single report", "https://d.test/4", "D", 0),
        ];
        let r = rank(&items, &RankOpts::default(), NOW);
        assert_eq!(r[0].item.title, "Fresh single report");
    }

    #[test]
    fn google_news_wrappers_dedupe_across_query_sources() {
        let u = "https://news.google.com/rss/articles/CBMiVWh0dHBzOi8vZXhhbXBsZQ";
        let items = vec![
            item("Story", &format!("{u}?oc=5"), "Reuters", 1),
            item("Story", &format!("{u}?oc=9&hl=en"), "Reuters", 1),
        ];
        let r = rank(&items, &RankOpts::default(), NOW);
        assert_eq!(r.len(), 1, "one wrapper id, one story");
    }

    #[test]
    fn the_lead_is_the_first_outlet_to_report() {
        let items = vec![
            item("Scoop lands here", "https://late.test/1", "Late", 1),
            item(
                "Scoop Lands Here - Wire",
                "https://early.test/2",
                "Early",
                5,
            ),
        ];
        let r = rank(&items, &RankOpts::default(), NOW);
        assert_eq!(r[0].item.source, "Early");
    }

    #[test]
    fn exclude_and_include_filters_apply() {
        let items = vec![
            item("Sponsored: buy this", "https://a.test/1", "A", 1),
            item("Real robotics news", "https://b.test/2", "B", 1),
        ];
        let opts = RankOpts {
            exclude: vec!["sponsored".into()],
            ..Default::default()
        };
        let r = rank(&items, &opts, NOW);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].item.title, "Real robotics news");

        let opts = RankOpts {
            include: vec!["robotics".into()],
            ..Default::default()
        };
        assert_eq!(rank(&items, &opts, NOW).len(), 1);
    }

    #[test]
    fn source_weights_lift_a_curated_binding() {
        let mut items = vec![
            item("Curated pick", "https://a.test/1", "TLDR", 4),
            item("Search result", "https://b.test/2", "Random", 4),
        ];
        items[0].binding = "tldr".into();
        let mut weights = HashMap::new();
        weights.insert("tldr".to_string(), 3.0);
        let opts = RankOpts {
            weights,
            ..Default::default()
        };
        assert_eq!(rank(&items, &opts, NOW)[0].item.title, "Curated pick");
    }

    #[test]
    fn ranking_is_deterministic_and_respects_the_limit() {
        let items: Vec<Item> = (0..30)
            .map(|i| {
                item(
                    &format!("Headline concerning subject{i} today"),
                    &format!("https://s.test/{i}"),
                    "S",
                    i % 6,
                )
            })
            .collect();
        let opts = RankOpts {
            limit: 5,
            ..Default::default()
        };
        let a = rank(&items, &opts, NOW);
        let b = rank(&items, &opts, NOW);
        assert_eq!(a.len(), 5);
        let ida: Vec<&str> = a.iter().map(|r| r.item.id.as_str()).collect();
        let idb: Vec<&str> = b.iter().map(|r| r.item.id.as_str()).collect();
        assert_eq!(ida, idb);
    }

    #[test]
    fn a_window_drops_items_older_than_it() {
        let items = vec![
            item("Fresh this morning", "https://a.test/1", "A", 3),
            item("Yesterday evening", "https://b.test/2", "B", 20),
            item("From three weeks ago", "https://c.test/3", "C", 24 * 21),
            item("From last year", "https://d.test/4", "D", 24 * 400),
        ];
        let opts = RankOpts {
            max_age_hours: 24.0,
            ..Default::default()
        };
        let r = rank(&items, &opts, NOW);
        assert_eq!(r.len(), 2, "only the two inside 24h survive");
        assert!(r.iter().all(|x| !x.outside_window));
    }

    #[test]
    fn an_archive_cannot_swamp_a_topic() {
        // The reported symptom: one source carrying its whole back catalogue
        // while the others fail, so the card fills with years-old posts.
        let mut items: Vec<Item> = (1..=60)
            .map(|d| {
                item(
                    &format!("Archive post number {d}"),
                    &format!("https://arch.test/{d}"),
                    "Archive",
                    d * 24,
                )
            })
            .collect();
        items.push(item("Actual news today", "https://news.test/x", "Wire", 2));
        let opts = RankOpts {
            max_age_hours: 24.0,
            limit: 10,
            ..Default::default()
        };
        let r = rank(&items, &opts, NOW);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].item.title, "Actual news today");
    }

    #[test]
    fn a_quiet_topic_shows_the_newest_few_and_says_they_are_old() {
        let items = vec![
            item("Older but relevant", "https://a.test/1", "A", 24 * 5),
            item("Older still today", "https://b.test/2", "B", 24 * 9),
            item("Ancient history here", "https://c.test/3", "C", 24 * 40),
            item("Even more ancient stuff", "https://d.test/4", "D", 24 * 90),
        ];
        let opts = RankOpts {
            max_age_hours: 24.0,
            ..Default::default()
        };
        let r = rank(&items, &opts, NOW);
        assert_eq!(r.len(), 3, "the newest three, not an empty card");
        assert!(r.iter().all(|x| x.outside_window), "and labelled as old");
        assert_eq!(r[0].item.title, "Older but relevant", "newest first");
    }

    #[test]
    fn zero_means_no_window_at_all() {
        let items = vec![item("Ancient", "https://a.test/1", "A", 24 * 400)];
        let r = rank(&items, &RankOpts::default(), NOW);
        assert_eq!(r.len(), 1);
        assert!(!r[0].outside_window);
    }

    #[test]
    fn the_window_applies_after_dedupe_so_a_running_story_is_kept_whole() {
        // A story first reported 30h ago and re-run 2h ago is one cluster led
        // by the earliest report. It must not silently vanish.
        let items = vec![
            item("Big story breaks", "https://a.test/1", "First", 30),
            item("Big Story Breaks - Wire", "https://b.test/2", "Second", 2),
        ];
        let opts = RankOpts {
            max_age_hours: 24.0,
            ..Default::default()
        };
        let r = rank(&items, &opts, NOW);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].corroboration, 2);
    }

    #[test]
    fn empty_input_is_empty_output_not_a_panic() {
        assert!(rank(&[], &RankOpts::default(), NOW).is_empty());
    }
}
