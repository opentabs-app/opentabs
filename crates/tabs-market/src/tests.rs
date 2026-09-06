use super::*;

const HOUR: i64 = 3600;
const NOW: i64 = 1_788_048_000;

fn listing(id: &str, published_hours_ago: i64, likes: u64, installs: u64) -> Listing {
    Listing {
        id: id.into(),
        kind: "group".into(),
        name: id.into(),
        description: format!("A pack called {id} for testing."),
        author: "someone".into(),
        tags: vec!["ai".into()],
        image: None,
        video: None,
        published: NOW - published_hours_ago * HOUR,
        updated: NOW - published_hours_ago * HOUR,
        likes,
        installs,
        hidden: false,
    }
}

// ---------- trending ----------

#[test]
fn newer_wins_when_engagement_is_equal() {
    let old = listing("old", 200, 10, 10);
    let new = listing("new", 2, 10, 10);
    assert!(trending_score(&new, NOW) > trending_score(&old, NOW));
}

#[test]
fn more_engagement_wins_when_age_is_equal() {
    let quiet = listing("quiet", 10, 1, 0);
    let loud = listing("loud", 10, 40, 20);
    assert!(trending_score(&loud, NOW) > trending_score(&quiet, NOW));
}

#[test]
fn an_install_counts_for_more_than_a_like() {
    // A like costs a click; an install means someone put it on the page they
    // look at fifty times a day.
    let liked = listing("liked", 10, 3, 0);
    let installed = listing("installed", 10, 0, 3);
    assert!(trending_score(&installed, NOW) > trending_score(&liked, NOW));
}

#[test]
fn a_brand_new_listing_cannot_take_the_page_with_one_like() {
    // Without an age floor this divides by almost nothing.
    let seconds_old = listing("fresh", 0, 1, 0);
    let established = listing("solid", 6, 40, 30);
    assert!(trending_score(&established, NOW) > trending_score(&seconds_old, NOW));
}

#[test]
fn engagement_fades_rather_than_falling_off_a_cliff() {
    // A windowed "most liked this week" cliffs when the window slides; a
    // decay is continuous, which is the point of using one.
    let l = listing("x", 0, 50, 20);
    let a = trending_score(&l, NOW);
    let b = trending_score(&l, NOW + 24 * HOUR);
    let c = trending_score(&l, NOW + 48 * HOUR);
    assert!(a > b && b > c);
    assert!(c > 0.0, "it fades, it does not vanish");
}

#[test]
fn a_listing_published_in_the_future_does_not_score_infinity() {
    // Clock skew between a publisher's machine and the server is normal.
    let mut l = listing("skewed", 0, 5, 5);
    l.published = NOW + 10 * HOUR;
    assert!(trending_score(&l, NOW).is_finite());
    assert!(trending_score(&l, NOW) <= trending_score(&listing("now", 0, 5, 5), NOW));
}

// ---------- browse ----------

#[test]
fn hidden_listings_never_appear() {
    let mut hidden = listing("bad", 1, 999, 999);
    hidden.hidden = true;
    let all = vec![hidden, listing("good", 1, 1, 1)];
    for sort in [Sort::Trending, Sort::Top, Sort::New] {
        let out = browse(&all, "", None, sort, NOW, 0, 50);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "good");
    }
}

#[test]
fn top_ignores_age_and_new_ignores_engagement() {
    let all = vec![
        listing("old-popular", 900, 500, 500),
        listing("new-quiet", 1, 0, 0),
    ];
    assert_eq!(
        browse(&all, "", None, Sort::Top, NOW, 0, 9)[0].id,
        "old-popular"
    );
    assert_eq!(
        browse(&all, "", None, Sort::New, NOW, 0, 9)[0].id,
        "new-quiet"
    );
}

#[test]
fn every_search_word_must_match_not_merely_one() {
    // With any-of, adding a word widens the search, which is the opposite of
    // what typing more words means.
    let mut a = listing("a", 1, 0, 0);
    a.name = "AI research".into();
    a.description = "Papers and industry news.".into();
    let mut b = listing("b", 1, 0, 0);
    b.name = "Real estate".into();
    b.description = "Listings and rates.".into();
    b.tags = vec!["property".into()];

    let all = vec![a, b];
    assert_eq!(
        browse(&all, "ai research", None, Sort::New, NOW, 0, 9).len(),
        1
    );
    assert_eq!(
        browse(&all, "ai estate", None, Sort::New, NOW, 0, 9).len(),
        0
    );
    assert_eq!(browse(&all, "", None, Sort::New, NOW, 0, 9).len(), 2);
}

#[test]
fn search_covers_the_author_and_the_tags_too() {
    let mut l = listing("x", 1, 0, 0);
    l.author = "darius".into();
    l.tags = vec!["semiconductors".into()];
    let all = vec![l];
    assert_eq!(browse(&all, "darius", None, Sort::New, NOW, 0, 9).len(), 1);
    assert_eq!(
        browse(&all, "semiconductors", None, Sort::New, NOW, 0, 9).len(),
        1
    );
}

#[test]
fn a_tag_filter_is_exact_rather_than_a_substring() {
    let mut a = listing("a", 1, 0, 0);
    a.tags = vec!["ai".into()];
    let mut b = listing("b", 1, 0, 0);
    b.tags = vec!["ai-safety".into()];
    let all = vec![a, b];
    let out = browse(&all, "", Some("ai"), Sort::New, NOW, 0, 9);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, "a");
}

#[test]
fn paging_never_shows_the_same_listing_twice() {
    // Equal scores need a total order, or a page boundary duplicates.
    let all: Vec<Listing> = (0..10)
        .map(|i| listing(&format!("p{i}"), 5, 0, 0))
        .collect();
    let first = browse(&all, "", None, Sort::Trending, NOW, 0, 4);
    let second = browse(&all, "", None, Sort::Trending, NOW, 4, 4);
    let third = browse(&all, "", None, Sort::Trending, NOW, 8, 4);
    let mut seen: Vec<&str> = first
        .iter()
        .chain(&second)
        .chain(&third)
        .map(|l| l.id.as_str())
        .collect();
    let total = seen.len();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), total, "a listing appeared on two pages");
    assert_eq!(total, 10);
}

#[test]
fn a_caller_cannot_ask_for_the_whole_database_in_one_page() {
    let all: Vec<Listing> = (0..300)
        .map(|i| listing(&format!("p{i}"), 5, 0, 0))
        .collect();
    assert_eq!(browse(&all, "", None, Sort::New, NOW, 0, 10_000).len(), 100);
}

#[test]
fn sort_parses_unknown_values_as_trending() {
    assert_eq!(Sort::parse("top"), Sort::Top);
    assert_eq!(Sort::parse("new"), Sort::New);
    assert_eq!(Sort::parse("nonsense"), Sort::Trending);
}

// ---------- tags ----------

#[test]
fn popular_tags_are_counted_and_stable() {
    let mut a = listing("a", 1, 0, 0);
    a.tags = vec!["ai".into(), "news".into()];
    let mut b = listing("b", 1, 0, 0);
    b.tags = vec!["ai".into()];
    let mut c = listing("c", 1, 0, 0);
    c.tags = vec!["zed".into()];
    let tags = popular_tags(&[a, b, c], 10);
    assert_eq!(tags[0], ("ai".into(), 2));
    // Equal counts break alphabetically, so the row does not reshuffle.
    assert_eq!(tags[1].0, "news");
    assert_eq!(tags[2].0, "zed");
}

#[test]
fn hidden_listings_do_not_contribute_tags() {
    let mut h = listing("h", 1, 0, 0);
    h.hidden = true;
    h.tags = vec!["spam".into()];
    assert!(popular_tags(&[h], 10).is_empty());
}

// ---------- likes ----------

#[test]
fn a_like_token_is_stable_for_the_same_pair() {
    let s = b"server-secret";
    assert_eq!(like_token(s, "acct-1", "ai"), like_token(s, "acct-1", "ai"));
}

#[test]
fn different_accounts_and_packs_give_different_tokens() {
    let s = b"server-secret";
    assert_ne!(like_token(s, "acct-1", "ai"), like_token(s, "acct-2", "ai"));
    assert_ne!(like_token(s, "acct-1", "ai"), like_token(s, "acct-1", "re"));
}

#[test]
fn the_token_cannot_be_reproduced_without_the_server_secret() {
    // This is the whole privacy argument: a database of tokens plus a list of
    // every account id still yields nothing without the key.
    assert_ne!(
        like_token(b"secret-a", "acct-1", "ai"),
        like_token(b"secret-b", "acct-1", "ai")
    );
}

#[test]
fn the_separator_stops_two_different_pairs_colliding() {
    // Without a delimiter, ("ab","c") and ("a","bc") would hash the same and
    // liking one pack would silently consume the like for another.
    let s = b"k";
    assert_ne!(like_token(s, "ab", "c"), like_token(s, "a", "bc"));
}

#[test]
fn a_token_is_a_fixed_length_hex_digest() {
    let t = like_token(b"k", "acct", "pack");
    assert_eq!(t.len(), 64);
    assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn a_long_secret_is_handled_rather_than_truncated_silently() {
    // HMAC hashes an over-long key; the point is that it still works and
    // still separates two different long keys.
    let a = vec![b'a'; 200];
    let b = vec![b'b'; 200];
    assert_ne!(like_token(&a, "x", "y"), like_token(&b, "x", "y"));
    assert_eq!(like_token(&a, "x", "y").len(), 64);
}

// ---------- publishing allowance ----------

#[test]
fn publishing_is_allowed_until_the_daily_count_is_reached() {
    let recent: Vec<i64> = (0..PUBLISH_PER_DAY - 1)
        .map(|i| NOW - i as i64 * 60)
        .collect();
    assert!(may_publish(&recent, NOW));
    let full: Vec<i64> = (0..PUBLISH_PER_DAY).map(|i| NOW - i as i64 * 60).collect();
    assert!(!may_publish(&full, NOW));
}

#[test]
fn yesterday_s_publishing_does_not_count_against_today() {
    let old: Vec<i64> = (0..50).map(|i| NOW - 86_400 - i as i64 * 60).collect();
    assert!(may_publish(&old, NOW));
}

#[test]
fn an_empty_history_may_publish() {
    assert!(may_publish(&[], NOW));
}
