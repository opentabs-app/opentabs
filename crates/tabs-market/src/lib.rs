//! The marketplace: listings, ranking, and the one hard privacy problem.
//!
//! # The constraint this crate exists under
//!
//! OpenTabs stores **nothing about a reader on a server**. No config, no
//! preferences, no history — that is the whole reason the extension keeps its
//! configuration in the browser and syncs it as a string the reader copies.
//!
//! A marketplace appears to contradict that, and mostly does not:
//!
//!   * A **listing** is content someone deliberately published. Storing it is
//!     not storing a reader's preferences; it is hosting a document they
//!     asked the world to see. A pack is stripped of secrets and of anything
//!     personal before it leaves the machine (see `tabs_core::pack`).
//!   * A **download** is a counter. Nobody's identity is involved.
//!   * A **like** is the hard one, and is solved rather than waved at.
//!
//! # Likes without a table of who likes what
//!
//! "One like per account" needs the server to recognise a returning account,
//! which naively means a row saying *this person liked that pack*. That row is
//! a preference, and it is exactly what must not exist.
//!
//! So the server stores an opaque token instead:
//!
//! ```text
//! token = HMAC-SHA256(server_secret, account_id || ":" || pack_id)
//! ```
//!
//! It can check whether a token is already present, which is all "one like per
//! account" requires. It cannot go the other way: without the account id there
//! is nothing to hash, and the secret never leaves the server, so the token
//! cannot be brute-forced from a list of accounts either. Ask the database
//! "what has this person liked" and there is no query that answers — not
//! because it is forbidden, because the data is not there.
//!
//! Everything here is pure. Storage and HTTP live in the server binary.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub mod moderation;

/// What the marketplace holds about one published pack.
///
/// The pack document itself is `tabs_core::pack::Pack`; this is the record
/// around it. `author` is a display handle the publisher chose — never an
/// email, never the account id.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Listing {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub author: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<String>,
    /// Unix seconds.
    pub published: i64,
    /// Unix seconds; equals `published` until it is edited.
    #[serde(default)]
    pub updated: i64,
    pub likes: u64,
    pub installs: u64,
    /// Hidden by moderation. Kept rather than deleted so a mistake is undoable.
    #[serde(default)]
    pub hidden: bool,
}

/// How a list was asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    Trending,
    Top,
    New,
}

impl Sort {
    pub fn parse(s: &str) -> Sort {
        match s {
            "top" => Sort::Top,
            "new" => Sort::New,
            _ => Sort::Trending,
        }
    }
}

/// Weight of a like relative to an install.
///
/// A like costs a click; an install means someone put it on the page they
/// look at fifty times a day. Rating them equally would let a listing be
/// promoted by the cheaper signal, which is also the easier one to fake.
const LIKE_WEIGHT: f64 = 1.0;
const INSTALL_WEIGHT: f64 = 3.0;

/// How fast attention decays. 1.8 is steeper than a day and gentler than an
/// hour, which suits a page someone visits weekly rather than hourly.
const GRAVITY: f64 = 1.8;

/// Hours before a brand-new listing stops being treated as brand-new.
///
/// Without this a listing published seconds ago divides by almost nothing and
/// takes the top of the page with a single like.
const AGE_FLOOR_HOURS: f64 = 4.0;

/// Trending: engagement against age, in the shape a link aggregator uses.
///
/// Deliberately not "most liked this week", which needs a windowed count and
/// then cliffs when the window slides. A decaying score is continuous: a
/// listing fades instead of falling off.
pub fn trending_score(l: &Listing, now: i64) -> f64 {
    let hours = ((now - l.published).max(0) as f64) / 3600.0;
    let engagement = l.likes as f64 * LIKE_WEIGHT + l.installs as f64 * INSTALL_WEIGHT;
    // `+1` so a listing with no engagement scores zero rather than something
    // that still beats another with none but a worse age.
    (engagement + 1.0) / (hours + AGE_FLOOR_HOURS).powf(GRAVITY)
}

/// All-time weight, for "top".
pub fn top_score(l: &Listing) -> f64 {
    l.likes as f64 * LIKE_WEIGHT + l.installs as f64 * INSTALL_WEIGHT
}

/// Does this listing match a search?
///
/// Every word must appear somewhere — name, description, author or a tag.
/// All-of rather than any-of: with any-of, adding a word to a search widens
/// it, which is the opposite of what typing more words means.
pub fn matches(l: &Listing, query: &str) -> bool {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return true;
    }
    let hay = format!(
        "{} {} {} {}",
        l.name.to_lowercase(),
        l.description.to_lowercase(),
        l.author.to_lowercase(),
        l.tags.join(" ").to_lowercase()
    );
    q.split_whitespace().all(|w| hay.contains(w))
}

/// Filter, sort and page a set of listings.
///
/// Hidden listings never appear. Ties break on `published` descending, so the
/// order is total and a page boundary cannot show the same listing twice.
pub fn browse(
    listings: &[Listing],
    query: &str,
    tag: Option<&str>,
    sort: Sort,
    now: i64,
    offset: usize,
    limit: usize,
) -> Vec<Listing> {
    let mut out: Vec<Listing> = listings
        .iter()
        .filter(|l| !l.hidden)
        .filter(|l| matches(l, query))
        .filter(|l| tag.is_none_or(|t| l.tags.iter().any(|x| x == t)))
        .cloned()
        .collect();

    out.sort_by(|a, b| {
        let key = match sort {
            Sort::Trending => trending_score(b, now).partial_cmp(&trending_score(a, now)),
            Sort::Top => top_score(b).partial_cmp(&top_score(a)),
            Sort::New => b.published.partial_cmp(&a.published),
        };
        key.unwrap_or(std::cmp::Ordering::Equal)
            .then(b.published.cmp(&a.published))
            .then(a.id.cmp(&b.id))
    });

    out.into_iter().skip(offset).take(limit.min(100)).collect()
}

/// Every tag in use, most-used first — the filter row on the browse page.
pub fn popular_tags(listings: &[Listing], limit: usize) -> Vec<(String, usize)> {
    let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
    for l in listings.iter().filter(|l| !l.hidden) {
        for t in &l.tags {
            *counts.entry(t.as_str()).or_default() += 1;
        }
    }
    let mut v: Vec<(String, usize)> = counts
        .into_iter()
        .map(|(k, n)| (k.to_string(), n))
        .collect();
    // Count descending, then alphabetically, so the row is stable between
    // loads rather than reshuffling among equal counts.
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v.truncate(limit);
    v
}

/// The opaque token that stands in for "this account liked this pack".
///
/// HMAC rather than a plain salted hash: the salt in a salted hash has to be
/// stored beside the value, so anyone holding the database and a list of
/// account ids can confirm a guess. The HMAC key is a server secret that is
/// never written next to the tokens, so the same attack has nothing to work
/// with.
pub fn like_token(secret: &[u8], account_id: &str, pack_id: &str) -> String {
    // HMAC-SHA256, written out rather than pulled in: one dependency fewer in
    // a crate that has to be auditable, and the construction is four lines.
    const BLOCK: usize = 64;
    let mut key = [0u8; BLOCK];
    if secret.len() > BLOCK {
        let d = Sha256::digest(secret);
        key[..d.len()].copy_from_slice(&d);
    } else {
        key[..secret.len()].copy_from_slice(secret);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= key[i];
        opad[i] ^= key[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(account_id.as_bytes());
    inner.update(b":");
    inner.update(pack_id.as_bytes());
    let inner = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    hex(&outer.finalize())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// A publish attempt, checked before anything is written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PublishRejected {
    pub field: String,
    pub message: String,
}

/// How many listings one account may publish per day.
///
/// Not a security boundary — an account is cheap — but it turns "flood the
/// marketplace" from a script into a chore, which is the honest ceiling for
/// something with no cost of entry.
pub const PUBLISH_PER_DAY: usize = 10;

/// Is this account within its publishing allowance?
pub fn may_publish(recent_publish_times: &[i64], now: i64) -> bool {
    recent_publish_times
        .iter()
        .filter(|t| now - **t < 86_400)
        .count()
        < PUBLISH_PER_DAY
}

#[cfg(test)]
mod tests;
