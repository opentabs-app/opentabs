//! What a listing may say.
//!
//! A marketplace with no moderation becomes a link farm within a week, and
//! the failure is not dramatic: it is a slow filling-up with listings whose
//! description is a wall of keywords and whose sources are one affiliate
//! feed. So this is deliberately dull and mechanical — it catches the shapes
//! that spam has, not the opinions it holds.
//!
//! It is **not** a content filter, and it is not trying to be. Judging what a
//! listing is *about* is a job for a person, and pretending an algorithm can
//! do it produces confident nonsense in both directions.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Flag {
    pub reason: String,
    /// Enough on its own to hold the listing back.
    ///
    /// Most signals are weak — a listing can be shouty because someone was
    /// excited. A few are not: a description that is nothing but links is not
    /// an enthusiastic description, it is a link farm, and waiting for a
    /// second signal before acting on it means publishing it.
    #[serde(default)]
    pub decisive: bool,
}

fn flag(reason: &str) -> Flag {
    Flag {
        reason: reason.into(),
        decisive: false,
    }
}

fn decisive(reason: &str) -> Flag {
    Flag {
        reason: reason.into(),
        decisive: true,
    }
}

/// How many links a description may carry before it is a link farm rather
/// than a description.
const MAX_LINKS: usize = 2;
/// Past this, no second opinion is needed.
const FLAGRANT_LINKS: usize = 4;

/// Shapes that mean spam regardless of subject.
pub fn flags(name: &str, description: &str, tags: &[String]) -> Vec<Flag> {
    let mut out = Vec::new();
    let text = format!("{name}\n{description}");

    let links = text.matches("http").count();
    if links >= FLAGRANT_LINKS {
        out.push(decisive("The description is a list of links."));
    } else if links > MAX_LINKS {
        out.push(flag("The description is mostly links."));
    }

    // Shouting. Measured over letters only, so "AI ETF" is not shouting and
    // "BEST FREE CRYPTO SIGNALS" is.
    let letters: Vec<char> = text.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() > 20 {
        let upper = letters.iter().filter(|c| c.is_uppercase()).count();
        if upper * 100 / letters.len() > 70 {
            out.push(flag("Mostly capital letters."));
        }
    }

    // A wall of keywords: many tags, none of them used in the description.
    if tags.len() >= 5 {
        let lower = description.to_lowercase();
        let unused = tags
            .iter()
            .filter(|t| !lower.contains(&t.to_lowercase()))
            .count();
        if unused == tags.len() {
            out.push(flag("The tags have nothing to do with the description."));
        }
    }

    // Repetition: the same word over and over is keyword stuffing.
    let words: Vec<String> = description
        .to_lowercase()
        .split_whitespace()
        .filter(|w| w.len() > 3)
        .map(str::to_string)
        .collect();
    if words.len() >= 12 {
        let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
        for w in &words {
            *counts.entry(w.as_str()).or_default() += 1;
        }
        if let Some((_, n)) = counts.iter().max_by_key(|(_, n)| **n) {
            if *n * 100 / words.len() > 30 {
                out.push(flag("One word repeated over and over."));
            }
        }
    }

    out
}

/// Should this listing be held back from the public lists?
///
/// One flag is a badly written listing; several together is spam. Being
/// generous here is deliberate — a false positive silences someone who did
/// the work, and there is a human queue behind this.
pub fn should_hold(flags: &[Flag]) -> bool {
    flags.iter().any(|f| f.decisive) || flags.len() >= 2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn an_ordinary_listing_is_not_flagged() {
        let f = flags(
            "AI research",
            "Twelve sources covering AI research and industry news, ranked by how \
             often the same story appears across them.",
            &tags(&["ai", "research"]),
        );
        assert!(f.is_empty(), "{f:?}");
    }

    #[test]
    fn a_wall_of_links_is_held_without_needing_a_second_opinion() {
        // Waiting for another signal before acting on a pure link farm means
        // publishing it.
        let f = flags(
            "Deals",
            "http://a.test http://b.test http://c.test http://d.test",
            &tags(&["deals"]),
        );
        assert!(f.iter().any(|x| x.reason.contains("links")));
        assert!(should_hold(&f));
    }

    #[test]
    fn a_description_with_a_couple_of_links_is_left_alone() {
        // Two links in a real description is normal — a source and a sample.
        let f = flags(
            "AI research",
            "Sources I follow, mostly https://arxiv.org and https://news.ycombinator.com              for the discussion around them.",
            &tags(&["ai"]),
        );
        assert!(!should_hold(&f), "{f:?}");
    }

    #[test]
    fn shouting_is_flagged_but_an_acronym_is_not() {
        let shout = flags(
            "BEST FREE CRYPTO SIGNALS NOW",
            "JOIN TODAY FOR THE BEST FREE CRYPTO SIGNALS AND MAKE MONEY FAST",
            &tags(&["crypto"]),
        );
        assert!(shout.iter().any(|x| x.reason.contains("capital")));

        let fine = flags(
            "AI and ETF news",
            "Sources covering AI, ETF flows and the SEC filings that move them.",
            &tags(&["ai"]),
        );
        assert!(!fine.iter().any(|x| x.reason.contains("capital")));
    }

    #[test]
    fn tags_unrelated_to_the_description_are_flagged() {
        let f = flags(
            "Stuff",
            "A collection of things I like reading in the morning with coffee.",
            &tags(&["crypto", "forex", "casino", "loans", "insurance"]),
        );
        assert!(f.iter().any(|x| x.reason.contains("tags")));
    }

    #[test]
    fn keyword_stuffing_is_flagged() {
        let f = flags(
            "Crypto",
            "crypto crypto crypto crypto crypto crypto news about crypto and crypto \
             plus crypto",
            &tags(&["crypto"]),
        );
        assert!(f.iter().any(|x| x.reason.contains("repeated")));
    }

    #[test]
    fn one_flag_is_a_bad_listing_and_two_is_spam() {
        // A false positive silences someone who did the work, so a single
        // signal is never enough on its own.
        assert!(!should_hold(&[flag("one")]));
        assert!(should_hold(&[flag("one"), flag("two")]));
        assert!(should_hold(&[decisive("beyond doubt")]));
    }

    #[test]
    fn a_short_description_is_never_flagged_for_repetition() {
        // Too little text to draw a conclusion from.
        let f = flags("Note", "ai ai ai", &tags(&["ai"]));
        assert!(!f.iter().any(|x| x.reason.contains("repeated")));
    }
}
