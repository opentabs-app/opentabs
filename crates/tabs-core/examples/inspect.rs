//! Run the real pipeline over real feeds and print what it made of them.
//!
//!     cargo run --release -p tabs-core --example inspect
//!     cargo run --release -p tabs-core --example inspect -- https://hnrss.org/frontpage
//!
//! Fixtures pass while real files break. Every parser in this crate has a
//! green unit test against a document somebody wrote by hand to exercise it;
//! none of those documents has a CDATA block wrapping an entity-encoded title
//! inside a namespaced element, because nobody writes that on purpose. Real
//! publishers do it constantly.
//!
//! So this fetches what the product actually fetches, runs the same
//! `feed::parse` and `rank::rank` the extension runs, and prints the result
//! adversarially: are the counts plausible, are the titles sentences or
//! `<*> <*> <*>`, did dedupe find the story two outlets both ran, and does
//! the top item answer the question the topic exists for.
//!
//! Nothing here is a test. It is a thing to read.

use std::collections::HashMap;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tabs_core::feed::{
    self,
    rank::{rank, RankOpts},
};
use tabs_core::trending;

/// Feeds a reader would plausibly configure, across the three shapes the
/// parser has to cope with: Atom, RSS 2.0, and RSS with namespaced extras.
const DEFAULT_FEEDS: &[(&str, &str)] = &[
    ("hn", "https://hnrss.org/frontpage"),
    ("arxiv", "http://export.arxiv.org/rss/cs.LG"),
    ("verge", "https://www.theverge.com/rss/index.xml"),
    ("bbc", "https://feeds.bbci.co.uk/news/technology/rss.xml"),
];

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn get(url: &str) -> Result<String, String> {
    ureq::get(url)
        .set("User-Agent", "OpenTabs-inspect/0.1 (+https://opentabs.app)")
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

/// Does this read like a sentence, or like the parser handed back markup?
fn looks_wrong(s: &str) -> Option<&'static str> {
    if s.is_empty() {
        return Some("empty");
    }
    if s.contains('<') && s.contains('>') {
        return Some("contains markup");
    }
    if s.contains("&amp;") || s.contains("&lt;") || s.contains("&#") {
        return Some("double-encoded entity");
    }
    if s.contains("CDATA") {
        return Some("CDATA leaked through");
    }
    if s.trim() != s {
        return Some("untrimmed");
    }
    None
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let feeds: Vec<(String, String)> = if args.is_empty() {
        DEFAULT_FEEDS
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    } else {
        args.iter()
            .enumerate()
            .map(|(i, u)| (format!("arg{i}"), u.clone()))
            .collect()
    };

    let fetched_at = now();
    let mut all = Vec::new();
    let mut suspect = 0usize;

    println!("== feeds ==\n");
    for (binding, url) in &feeds {
        let t0 = Instant::now();
        let body = match get(url) {
            Ok(b) => b,
            Err(e) => {
                println!("  {binding:<8} FETCH FAILED  {url}\n           {e}\n");
                continue;
            }
        };
        let fetch_ms = t0.elapsed().as_millis();

        let t1 = Instant::now();
        let parsed = feed::parse(&body, binding, fetched_at);
        let parse_ms = t1.elapsed().as_millis();

        let bytes = body.len();
        let dated = parsed
            .items
            .iter()
            .filter(|i| i.published != fetched_at)
            .count();
        let summarised = parsed.items.iter().filter(|i| i.summary.is_some()).count();

        println!(
            "  {binding:<8} {n:>3} items  {bytes:>7} B  fetch {fetch_ms:>4}ms  parse {parse_ms:>3}ms",
            n = parsed.items.len()
        );
        println!("           title: {}", parsed.title);
        // A date that fell back to fetch time is a date the parser did not
        // understand. A feed where *every* date fell back is a bug, not a
        // publisher quirk — and it ranks as if everything arrived at once.
        println!(
            "           dates parsed {dated}/{n}   summaries {summarised}/{n}   hosts: {hosts}",
            n = parsed.items.len(),
            hosts = {
                let mut h: Vec<_> = parsed
                    .items
                    .iter()
                    .map(|i| i.source.as_str())
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect();
                h.truncate(4);
                h.join(", ")
            }
        );

        for it in parsed.items.iter().take(30) {
            if let Some(why) = looks_wrong(&it.title) {
                println!("           SUSPECT TITLE ({why}): {:?}", it.title);
                suspect += 1;
            }
            if it.url.is_empty() || !it.url.starts_with("http") {
                println!("           SUSPECT URL: {:?}  ({})", it.url, it.title);
                suspect += 1;
            }
        }
        if let Some(first) = parsed.items.first() {
            println!("           first: {}", first.title);
        }
        println!();
        all.extend(parsed.items);
    }

    // ---- ranking, across every source at once ----
    println!("== ranked, all sources together ==\n");
    let opts = RankOpts {
        half_life_hours: 12.0,
        weights: HashMap::new(),
        exclude: Vec::new(),
        include: Vec::new(),
        max_age_hours: 72.0,
        limit: 12,
    };
    let t = Instant::now();
    let ranked = rank(&all, &opts, fetched_at);
    let rank_ms = t.elapsed().as_millis();
    println!(
        "  {} items in, {} out, {rank_ms}ms\n",
        all.len(),
        ranked.len()
    );

    let corroborated = ranked.iter().filter(|r| r.corroboration > 1).count();
    for (i, r) in ranked.iter().enumerate() {
        let also = if r.also_in.is_empty() {
            String::new()
        } else {
            format!("   also in {}", r.also_in.join(", "))
        };
        let age = (fetched_at - r.item.published) as f64 / 3600.0;
        println!(
            "  {:>2}. [{:>6.3}] {:<9} {:>4.0}h  {}{}",
            i + 1,
            r.score,
            r.item.source.chars().take(9).collect::<String>(),
            age,
            r.item.title.chars().take(72).collect::<String>(),
            also
        );
    }
    println!(
        "\n  corroborated across sources: {corroborated}/{}",
        ranked.len()
    );

    // ---- the scraped page, which is the fragile one ----
    println!("\n== github trending (scraped HTML, not an API) ==\n");
    match get("https://github.com/trending") {
        Err(e) => println!("  FETCH FAILED: {e}"),
        Ok(html) => {
            let t = Instant::now();
            let repos = trending::parse(&html);
            println!(
                "  {} B in, {} repos, {}ms",
                html.len(),
                repos.len(),
                t.elapsed().as_millis()
            );
            if repos.is_empty() {
                println!("  PARSED NOTHING — the page markup changed. This is the failure");
                println!("  mode that shows up as a silently empty card, not as an error.");
            }
            for r in repos.iter().take(5) {
                println!(
                    "    {:<38} {:>6} today  {:>7} total  {}",
                    r.repo,
                    r.stars_today,
                    r.stars_total,
                    r.description
                        .as_deref()
                        .unwrap_or("(none)")
                        .chars()
                        .take(46)
                        .collect::<String>()
                );
            }
        }
    }

    println!("\n== summary ==");
    println!("  items parsed      {}", all.len());
    println!("  suspect fields    {suspect}");
    println!("  ranked out        {}", ranked.len());
    if suspect > 0 {
        println!("\n  Read the SUSPECT lines above. Each one is a real publisher");
        println!("  document this parser mishandled, which no fixture covers.");
    }
}
