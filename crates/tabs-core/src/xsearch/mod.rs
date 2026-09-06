//! X (Twitter) advanced search, as structured fields.
//!
//! # Why this is not a scraper
//!
//! `x.com/search` answers 200 with ~289 KB of JavaScript shell: zero
//! `<article>` elements, and the search term does not appear anywhere in the
//! body. Results are fetched client-side from an authenticated internal
//! endpoint. There is nothing to parse, Nitter is `410 Gone`, and X removed
//! its free API tier in February 2026.
//!
//! What does work is `api.x.com/2/tweets/search/recent` with the reader's own
//! bearer token — it answers a clean `401` unauthenticated, so the endpoint is
//! live and a key is the only missing piece.
//!
//! # The trap this module exists to avoid
//!
//! **The web UI's query syntax and the API's are not the same language.**
//! Pasting an advanced-search URL's `q=` straight into the API gives errors or,
//! worse, quietly different results:
//!
//! | Intent | Web (`x.com/search`) | API v2 |
//! |---|---|---|
//! | has a link | `filter:links` | `has:links` |
//! | not a reply | `-filter:replies` | `-is:reply` |
//! | not a retweet | `-filter:retweets` | `-is:retweet` |
//! | date range | `since:` / `until:` | `start_time` / `end_time` **params** |
//! | minimum likes | `min_faves:` | *unsupported* |
//!
//! So one structured [`XQuery`] emits both dialects, and the caller picks.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct XQuery {
    /// All of these words.
    pub all: String,
    /// This exact phrase.
    pub phrase: String,
    /// Any of these words.
    pub any: String,
    /// None of these words.
    pub none: String,
    /// These hashtags, with or without the leading `#`.
    pub hashtags: String,
    /// Sent from these accounts.
    pub from: String,
    /// Sent in reply to these accounts.
    pub to: String,
    /// Mentioning these accounts.
    pub mentions: String,
    /// Two-letter language code; empty means any.
    pub lang: String,
    /// `any` (default), `only` (replies only) or `none` (exclude replies).
    pub replies: String,
    /// `any` (default), `only` (must have a link) or `none`.
    pub links: String,
    /// Exclude retweets. On by default in the UI, because a feed of retweets
    /// is mostly duplicates of things already in it.
    pub exclude_retweets: bool,
    pub min_replies: u32,
    pub min_likes: u32,
    pub min_reposts: u32,
    /// Inclusive `YYYY-MM-DD`. Ignored when `window_days` is set.
    pub since: String,
    /// Exclusive `YYYY-MM-DD`. Ignored when `window_days` is set.
    pub until: String,
    /// A rolling window instead of fixed dates: `1` means yesterday to today.
    ///
    /// This is the sane default for a saved search. A literal `since:` written
    /// once is correct for a day and then quietly wrong forever — the card
    /// keeps showing the same window while the world moves on, and nothing
    /// about it looks broken.
    pub window_days: u32,
}

fn words(s: &str) -> Vec<String> {
    s.split_whitespace().map(str::to_string).collect()
}

/// Strip a leading `@` so both `@nasa` and `nasa` work in the account fields.
fn handle(s: &str) -> String {
    s.trim().trim_start_matches('@').to_string()
}

fn or_group(prefix: &str, raw: &str) -> Option<String> {
    let items: Vec<String> = raw
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| !w.trim().is_empty())
        .map(|w| format!("{prefix}{}", handle(w)))
        .collect();
    match items.len() {
        0 => None,
        1 => Some(items.into_iter().next().unwrap()),
        _ => Some(format!("({})", items.join(" OR "))),
    }
}

/// `YYYY-MM-DD` for a Unix timestamp, UTC.
fn ymd(t: i64) -> String {
    const CUM: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let leap = |y: i64| (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let mut days = t.div_euclid(86_400);
    let mut y = 1970i64;
    loop {
        let len = if leap(y) { 366 } else { 365 };
        if days >= len {
            days -= len;
            y += 1;
        } else if days < 0 {
            y -= 1;
            days += if leap(y) { 366 } else { 365 };
        } else {
            break;
        }
    }
    let mut m = 0usize;
    while m < 11 {
        let next = CUM[m + 1] + if m + 1 >= 2 && leap(y) { 1 } else { 0 };
        if days < next {
            break;
        }
        m += 1;
    }
    let before = CUM[m] + if m >= 2 && leap(y) { 1 } else { 0 };
    format!("{y:04}-{:02}-{:02}", m + 1, days - before + 1)
}

impl XQuery {
    /// A copy with a rolling window turned into concrete dates.
    ///
    /// Everything that emits a query goes through this, so a saved search
    /// cannot drift out of date: the dates are computed each time rather than
    /// stored.
    pub fn resolved(&self, now: i64) -> XQuery {
        if self.window_days == 0 {
            return self.clone();
        }
        let mut q = self.clone();
        q.until = ymd(now);
        q.since = ymd(now - (self.window_days as i64) * 86_400);
        q
    }

    /// The parts both dialects share.
    fn common(&self, out: &mut Vec<String>) {
        for w in words(&self.all) {
            out.push(w);
        }
        if !self.phrase.trim().is_empty() {
            out.push(format!("\"{}\"", self.phrase.trim()));
        }
        if let Some(g) = or_group("", &self.any) {
            out.push(g);
        }
        for w in words(&self.none) {
            out.push(format!("-{w}"));
        }
        for h in words(&self.hashtags) {
            out.push(format!("#{}", h.trim_start_matches('#')));
        }
        if let Some(g) = or_group("from:", &self.from) {
            out.push(g);
        }
        if let Some(g) = or_group("to:", &self.to) {
            out.push(g);
        }
        if let Some(g) = or_group("@", &self.mentions) {
            out.push(g);
        }
        if !self.lang.trim().is_empty() {
            out.push(format!("lang:{}", self.lang.trim()));
        }
    }

    /// Query string for `x.com/search?q=…` — what a browser understands.
    pub fn to_web(&self) -> String {
        let mut out = Vec::new();
        self.common(&mut out);

        match self.replies.as_str() {
            "only" => out.push("filter:replies".into()),
            "none" => out.push("-filter:replies".into()),
            _ => {}
        }
        match self.links.as_str() {
            "only" => out.push("filter:links".into()),
            "none" => out.push("-filter:links".into()),
            _ => {}
        }
        if self.exclude_retweets {
            out.push("-filter:retweets".into());
        }
        // Engagement thresholds exist only in the web UI.
        for (n, op) in [
            (self.min_replies, "min_replies"),
            (self.min_likes, "min_faves"),
            (self.min_reposts, "min_retweets"),
        ] {
            if n > 0 {
                out.push(format!("{op}:{n}"));
            }
        }
        // Dates are query operators on the web, request params in the API.
        if !self.since.trim().is_empty() {
            out.push(format!("since:{}", self.since.trim()));
        }
        if !self.until.trim().is_empty() {
            out.push(format!("until:{}", self.until.trim()));
        }
        out.join(" ")
    }

    /// Query string for `api.x.com/2/tweets/search/recent`.
    ///
    /// Dates are deliberately absent — they travel as `start_time` and
    /// `end_time`, which [`Self::api_time_params`] returns.
    pub fn to_api(&self) -> String {
        let mut out = Vec::new();
        self.common(&mut out);

        match self.replies.as_str() {
            "only" => out.push("is:reply".into()),
            "none" => out.push("-is:reply".into()),
            _ => {}
        }
        match self.links.as_str() {
            "only" => out.push("has:links".into()),
            "none" => out.push("-has:links".into()),
            _ => {}
        }
        if self.exclude_retweets {
            out.push("-is:retweet".into());
        }
        out.join(" ")
    }

    /// `(start_time, end_time)` as RFC 3339, for the API's own parameters.
    pub fn api_time_params(&self) -> (Option<String>, Option<String>) {
        let day = |d: &str, end: bool| {
            let d = d.trim();
            (!d.is_empty() && d.len() == 10)
                .then(|| format!("{d}T{}", if end { "23:59:59Z" } else { "00:00:00Z" }))
        };
        (day(&self.since, false), day(&self.until, true))
    }

    /// Anything the API silently cannot honour, so the UI can say so instead
    /// of returning quietly different results.
    pub fn api_limitations(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.min_likes > 0 || self.min_replies > 0 || self.min_reposts > 0 {
            out.push(
                "Engagement thresholds (minimum likes, replies or reposts) are a web-search \
                 feature and are ignored by the API."
                    .into(),
            );
        }
        if !self.since.trim().is_empty() || !self.until.trim().is_empty() {
            out.push(
                "The recent-search endpoint only covers the last 7 days; older dates return \
                 nothing."
                    .into(),
            );
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        self.to_api().trim().is_empty()
    }

    /// A ready-to-open advanced-search URL.
    pub fn web_url(&self) -> String {
        format!(
            "https://x.com/search?q={}&f=live",
            crate::config::encode(&self.to_web())
        )
    }

    /// Parse the `q=` of an advanced-search URL back into fields, so someone
    /// can paste a search they already built in X rather than rebuilding it.
    pub fn from_web_query(q: &str) -> Self {
        let mut x = XQuery::default();
        let mut all: Vec<String> = Vec::new();
        let mut none: Vec<String> = Vec::new();
        let mut hashtags: Vec<String> = Vec::new();
        let mut from: Vec<String> = Vec::new();
        let mut to: Vec<String> = Vec::new();
        let mut mentions: Vec<String> = Vec::new();

        for tok in tokenize(q) {
            let t = tok.as_str();
            if let Some(rest) = t.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
                x.phrase = rest.to_string();
            } else if let Some(v) = t.strip_prefix("since:") {
                x.since = v.to_string();
            } else if let Some(v) = t.strip_prefix("until:") {
                x.until = v.to_string();
            } else if let Some(v) = t.strip_prefix("lang:") {
                x.lang = v.to_string();
            } else if let Some(v) = t.strip_prefix("from:") {
                // `from:@nasa` and `from:nasa` are the same search; store the
                // bare handle so the field round-trips to itself.
                from.push(handle(v));
            } else if let Some(v) = t.strip_prefix("to:") {
                to.push(handle(v));
            } else if let Some(v) = t.strip_prefix("min_faves:") {
                x.min_likes = v.parse().unwrap_or(0);
            } else if let Some(v) = t.strip_prefix("min_replies:") {
                x.min_replies = v.parse().unwrap_or(0);
            } else if let Some(v) = t.strip_prefix("min_retweets:") {
                x.min_reposts = v.parse().unwrap_or(0);
            } else if t == "-filter:retweets" {
                x.exclude_retweets = true;
            } else if t == "filter:replies" {
                x.replies = "only".into();
            } else if t == "-filter:replies" {
                x.replies = "none".into();
            } else if t == "filter:links" {
                x.links = "only".into();
            } else if t == "-filter:links" {
                x.links = "none".into();
            } else if let Some(v) = t.strip_prefix('#') {
                hashtags.push(v.to_string());
            } else if let Some(v) = t.strip_prefix('@') {
                mentions.push(v.to_string());
            } else if let Some(v) = t.strip_prefix('-') {
                none.push(v.to_string());
            } else if !t.is_empty() {
                all.push(t.to_string());
            }
        }
        x.all = all.join(" ");
        x.none = none.join(" ");
        x.hashtags = hashtags.join(" ");
        x.from = from.join(" ");
        x.to = to.join(" ");
        x.mentions = mentions.join(" ");
        x
    }
}

/// Split on whitespace, keeping quoted phrases together.
fn tokenize(q: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in q.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                cur.push(c);
            }
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn micro() -> XQuery {
        // The user's own example, field by field.
        XQuery {
            all: "microduck".into(),
            none: "crypto contract gem".into(),
            since: "2026-08-29".into(),
            until: "2026-08-30".into(),
            ..Default::default()
        }
    }

    // 2026-08-30T12:00:00Z
    const NOW: i64 = 1_788_048_000 + 12 * 3600;

    #[test]
    fn a_rolling_window_becomes_yesterday_to_today() {
        let q = XQuery {
            all: "microduck".into(),
            window_days: 1,
            ..Default::default()
        };
        let r = q.resolved(NOW);
        assert_eq!(r.since, "2026-08-29");
        assert_eq!(r.until, "2026-08-30");
        assert_eq!(
            r.to_web(),
            "microduck since:2026-08-29 until:2026-08-30",
            "the same search the user built by hand, but self-updating"
        );
    }

    #[test]
    fn the_window_moves_with_the_clock() {
        let q = XQuery {
            all: "x".into(),
            window_days: 1,
            ..Default::default()
        };
        let today = q.resolved(NOW);
        let tomorrow = q.resolved(NOW + 86_400);
        assert_ne!(
            today.until, tomorrow.until,
            "a saved search must not go stale"
        );
        assert_eq!(tomorrow.since, today.until);
    }

    #[test]
    fn a_wider_window_reaches_further_back() {
        let q = XQuery {
            all: "x".into(),
            window_days: 7,
            ..Default::default()
        };
        assert_eq!(q.resolved(NOW).since, "2026-08-23");
    }

    #[test]
    fn ymd_handles_month_and_year_boundaries() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(946_684_800), "2000-01-01");
        // 2024 is a leap year: 29 February must exist.
        assert_eq!(ymd(1_709_164_800), "2024-02-29");
        assert_eq!(ymd(1_709_251_200), "2024-03-01");
        assert_eq!(ymd(1_788_048_000), "2026-08-30");
    }

    #[test]
    fn explicit_dates_still_win_when_no_window_is_set() {
        let q = micro(); // window_days defaults to 0
        let r = q.resolved(NOW);
        assert_eq!(r.since, "2026-08-29");
        assert_eq!(r.until, "2026-08-30");
    }

    #[test]
    fn reproduces_the_web_search_that_was_asked_for() {
        assert_eq!(
            micro().to_web(),
            "microduck -crypto -contract -gem since:2026-08-29 until:2026-08-30"
        );
    }

    #[test]
    fn the_api_dialect_drops_dates_into_parameters_instead() {
        let q = micro();
        assert_eq!(q.to_api(), "microduck -crypto -contract -gem");
        let (start, end) = q.api_time_params();
        assert_eq!(start.as_deref(), Some("2026-08-29T00:00:00Z"));
        assert_eq!(end.as_deref(), Some("2026-08-30T23:59:59Z"));
    }

    #[test]
    fn filter_operators_differ_between_the_two_dialects() {
        // Sending web syntax to the API is the mistake this prevents.
        let q = XQuery {
            all: "robots".into(),
            replies: "none".into(),
            links: "only".into(),
            exclude_retweets: true,
            ..Default::default()
        };
        let web = q.to_web();
        assert!(web.contains("-filter:replies") && web.contains("filter:links"));
        assert!(web.contains("-filter:retweets"));

        let api = q.to_api();
        assert!(api.contains("-is:reply") && api.contains("has:links"));
        assert!(api.contains("-is:retweet"));
        assert!(
            !api.contains("filter:"),
            "no web-only operator may reach the API"
        );
    }

    #[test]
    fn engagement_thresholds_are_web_only_and_declared_as_such() {
        let q = XQuery {
            all: "launch".into(),
            min_likes: 280,
            ..Default::default()
        };
        assert!(q.to_web().contains("min_faves:280"));
        assert!(
            !q.to_api().contains("min_faves"),
            "the API has no such operator"
        );
        assert!(q.api_limitations().iter().any(|l| l.contains("Engagement")));
    }

    #[test]
    fn multiple_accounts_become_an_or_group() {
        let q = XQuery {
            from: "@nasa esa".into(),
            ..Default::default()
        };
        assert_eq!(q.to_api(), "(from:nasa OR from:esa)");
        // A single account needs no parentheses.
        let one = XQuery {
            from: "nasa".into(),
            ..Default::default()
        };
        assert_eq!(one.to_api(), "from:nasa");
    }

    #[test]
    fn any_of_these_words_becomes_an_or_group() {
        let q = XQuery {
            any: "cats dogs".into(),
            ..Default::default()
        };
        assert_eq!(q.to_web(), "(cats OR dogs)");
    }

    #[test]
    fn an_exact_phrase_is_quoted() {
        let q = XQuery {
            phrase: "happy hour".into(),
            ..Default::default()
        };
        assert_eq!(q.to_web(), "\"happy hour\"");
    }

    #[test]
    fn a_pasted_advanced_search_url_round_trips() {
        // Straight from the address bar, decoded.
        let q = "microduck -crypto -contract -gem until:2026-08-30 since:2026-08-29";
        let parsed = XQuery::from_web_query(q);
        assert_eq!(parsed.all, "microduck");
        assert_eq!(parsed.none, "crypto contract gem");
        assert_eq!(parsed.since, "2026-08-29");
        assert_eq!(parsed.until, "2026-08-30");
        // And rebuilding gives back an equivalent search.
        assert_eq!(parsed.to_api(), micro().to_api());
    }

    #[test]
    fn parsing_keeps_quoted_phrases_whole() {
        let parsed = XQuery::from_web_query("\"happy hour\" -crypto from:@nasa lang:en");
        assert_eq!(parsed.phrase, "happy hour");
        assert_eq!(parsed.none, "crypto");
        assert_eq!(parsed.from, "nasa");
        assert_eq!(parsed.lang, "en");
    }

    #[test]
    fn parsing_recognises_web_filter_operators() {
        let p =
            XQuery::from_web_query("x -filter:replies filter:links -filter:retweets min_faves:5");
        assert_eq!(p.replies, "none");
        assert_eq!(p.links, "only");
        assert!(p.exclude_retweets);
        assert_eq!(p.min_likes, 5);
    }

    #[test]
    fn the_seven_day_limit_is_declared_when_dates_are_used() {
        assert!(micro()
            .api_limitations()
            .iter()
            .any(|l| l.contains("7 days")));
    }

    #[test]
    fn an_empty_query_is_recognised_rather_than_fetched() {
        assert!(XQuery::default().is_empty());
        assert!(!micro().is_empty());
        // Dates alone are not a search: the API would reject it.
        let dates_only = XQuery {
            since: "2026-08-29".into(),
            ..Default::default()
        };
        assert!(dates_only.is_empty());
    }

    #[test]
    fn the_web_url_is_openable_and_encoded() {
        let u = micro().web_url();
        assert!(u.starts_with("https://x.com/search?q="));
        assert!(u.contains("microduck"));
        assert!(!u.contains(' '), "spaces must be encoded");
    }
}
